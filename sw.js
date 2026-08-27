/* Roadbook service worker ------------------------------------------------

   THE UPDATE STORY (read this before changing anything below).

   A browser decides whether to install a new worker by comparing the
   BYTES OF THIS FILE with the copy it already has. Ship a new
   index.html and leave sw.js untouched and nothing happens: the old
   worker stays, and it keeps answering from a cache that nobody ever
   invalidates. Chrome papers over this with aggressive update checks.
   Safari does not — which is exactly why the app looked frozen on
   iPhone while it updated fine on a laptop.

   Three things make an update actually land, and all three are needed:

     1. BUILD below is rewritten on every deploy by scripts/stamp.js
        with a hash of the real shell files, so this file's bytes change
        whenever the app changes. It also names the cache, so a new
        build cannot be served yesterday's HTML out of an old cache.
     2. skipWaiting() in install + clients.claim() in activate, so the
        new worker takes over immediately. Without these it sits in
        "waiting" until every tab of the app is closed, which on a phone
        home-screen app is approximately never.
     3. The page listens for controllerchange and reloads once (see
        initPwa() in index.html). Claiming a client mid-life leaves the
        DOM on the old build; the reload is what puts the new one on
        screen.

   Also: sw.js is served with `no-store` (see vercel.json) so the update
   check itself can never be answered from the HTTP cache.

   WHAT WORKS WITH NO CONNECTION
     yes  the app shell — HTML/CSS/JS, manifest, icons (precached here)
     yes  map tiles already viewed, or pulled down in Gear (IndexedDB in
          the page, plus the bounded mirror this worker keeps)
     yes  the last synced team state, and every check-in / completion /
          skip made offline — they queue in IndexedDB and replay
     yes  GPS and the compass: they read the chip, not the network
     NO   tiles for an area never viewed, OSRM legs not already cached,
          Nominatim address search, and live sync with the other cars
   ----------------------------------------------------------------------- */

const BUILD = '09ce4e69359e';

const SHELL_CACHE = 'roadbook-shell-' + BUILD;
const TILE_CACHE  = 'roadbook-tiles-v1';   // deliberately NOT build-stamped:
                                           // an app update must not throw away
                                           // a map downloaded on wifi.

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

/* Tiles are ~15 KB each, so this mirror tops out around 18 MB. It is a
   safety net, not the primary store: the page saves every tile it draws
   into IndexedDB, which is what the MAP chip counts. The mirror earns
   its keep in private browsing, where IndexedDB is unavailable. */
const TILE_CAP = 1200;

const isTile = url =>
  (url.hostname === 'server.arcgisonline.com' && url.pathname.indexOf('/MapServer/tile/') !== -1) ||
  /(^|\.)basemaps\.cartocdn\.com$/.test(url.hostname);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // One by one, not addAll: a single 404 must not void the whole precache.
    await Promise.all(SHELL.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => {})
    ));
    // Do not wait for old tabs to close. See the header comment.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k === SHELL_CACHE || k === TILE_CACHE) return null;
      if (k.indexOf('roadbook-') !== 0) return null;      // leave other apps alone
      return caches.delete(k);                            // includes every older shell
    }));
    await self.clients.claim();
    // Belt and braces: claiming fires controllerchange in the page, but an
    // explicit message means the page can act even if it missed that event.
    const cs = await self.clients.matchAll({ type: 'window' });
    cs.forEach(c => c.postMessage({ type: 'RB_ACTIVATED', build: BUILD }));
  })());
});

/* Trim oldest-first. Cache.keys() returns insertion order, so the head of
   the list is the least recently added. Throttled — trimming on every
   tile would cost more than the storage it saves. */
let putsSinceTrim = 0;
async function trimTiles(cache) {
  if (++putsSinceTrim < 60) return;
  putsSinceTrim = 0;
  const keys = await cache.keys();
  const over = keys.length - TILE_CAP;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}

async function tileStrategy(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;                        // cache-first: the only thing
                                              // that works in a dead zone
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).then(() => trimTiles(cache), () => {});
    return res;
  } catch (err) {
    // Let the page decide what a missing tile looks like — it paints its
    // own "no data" backdrop rather than showing a broken image.
    return new Response('', { status: 504, statusText: 'Offline — tile not cached' });
  }
}

/* Shell: cache-first, and that is now safe because SHELL_CACHE is named
   after BUILD. A new deploy is a new worker, a new cache and a fresh
   precache, so "cache-first" can never mean "yesterday's app" the way it
   did when one cache outlived every version. */
async function shellStrategy(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && req.method === 'GET') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    // Offline with nothing cached under this exact URL — a navigation
    // still deserves the app rather than the browser's dinosaur.
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html', { ignoreSearch: true });
      if (fallback) return fallback;
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (isTile(url)) { event.respondWith(tileStrategy(req)); return; }

  if (url.origin !== self.location.origin) return;

  /* /api/* IS NEVER TOUCHED. This is live team state — a check-in another
     car made thirty seconds ago is the entire product. A stale cached
     answer here would be worse than an honest failure, and the page
     already knows how to run from its own last-known copy when the
     request fails. */
  if (url.pathname.indexOf('/api/') === 0) return;

  event.respondWith(shellStrategy(req));
});

self.addEventListener('message', async e => {
  const msg = e.data || {};
  if (msg.type === 'RB_SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'RB_BUILD' && e.source) e.source.postMessage({ type: 'RB_BUILD', build: BUILD });
  if (msg.type === 'RB_CLEAR_TILES') {
    const ok = await caches.delete(TILE_CACHE).catch(() => false);
    if (e.source) e.source.postMessage({ type: 'RB_TILES_CLEARED', ok });
  }
});
