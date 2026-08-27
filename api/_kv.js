'use strict';
/* =====================================================================
   ROADBOOK — shared team state (Upstash Redis over REST)
   =====================================================================

   THE WHOLE HUNT LIVES IN ONE REDIS HASH: `rb:v1:team`.

   That is a deliberate shape, not laziness. Seven phones poll this every
   15 seconds for five hours; if the read fanned out over a handful of
   keys, every poll would cost a handful of commands against a shared
   Upstash store. One HGETALL is ONE command, so a whole hunt costs
   roughly 7k commands total.

   Field naming inside the hash:

     event              JSON  — date, start/end time, start-line pin
     route              JSON  — the single shared roadbook (order + legs)
     L:<locId>          JSON  — a location
     C:<chalId>         JSON  — a challenge (carries locId)
     I:<chalId>:<name>  "<at>|<0|1>"          — a player's check-in
     D:<chalId>:<name>  "<at>|<0|1>"          — a player's part marked done
     S:<chalId>         "<at>|<0|1>|<name>"   — the stop was skipped

   WHY CHECK-INS ARE ONE FIELD PER (CHALLENGE, PLAYER) rather than a list
   on the challenge: two players checking into the same challenge write
   two different fields, so they can never clobber each other — no
   read-modify-write, no lost update, no locking. It is the whole reason
   the offline queue can replay in any order and land on the right state.

   WHY THE VALUE CARRIES A TIMESTAMP AND A FLAG instead of the field just
   existing/not existing: a delete leaves no tombstone, so a stale
   "I'm in" replayed from a phone that was offline for twenty minutes
   would silently resurrect a check-in the player had already backed out
   of. Storing `<at>|<0|1>` keeps the negative, and toggle() below refuses
   any write older than what is already there. Last-write-wins, where
   "last" means when the player actually tapped, not when the packet
   happened to arrive.

   Keys are prefixed `rb:v1:` because this Upstash store is shared with
   another project. Nothing here touches anything outside that prefix. */

const KEY = 'rb:v1:team';

/* Both the Upstash-native names and Vercel's KV_* aliases are accepted —
   which pair you get depends on how the store was connected. */
function envPair() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) throw new Error('KV is not configured (missing REST url/token)');
  return { url: url.replace(/\/$/, ''), token };
}

async function cmd(args) {
  const cfg = envPair();
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error('KV ' + res.status + ' ' + ((body && body.error) || 'request failed'));
  }
  return body.result;
}

/* ------------------------------------------------------------ players */
/* The roster is fixed and lives on the server too: a check-in is only
   ever attributed to one of these, whatever a client sends. Keep it in
   step with PLAYERS in index.html — "people needed" is clamped to this
   length, so adding someone widens the challenge form automatically. */
const PLAYERS = ['Will', 'Nicole', 'Lucas', 'Marchesa', 'Daniel', 'Kenzy', 'Cris'];
const isPlayer = n => PLAYERS.indexOf(n) >= 0;

/* ------------------------------------------------------------- read */

function parseFlag(v) {
  // "<at>|<0|1>[|extra]"
  const p = String(v == null ? '' : v).split('|');
  return { at: Number(p[0]) || 0, on: p[1] === '1', extra: p[2] || '' };
}
function jparse(v, fallback) {
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

/* HGETALL over REST comes back as a flat [field, value, field, value…]. */
function pairsToObj(flat) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

const DEFAULT_EVENT = {
  date: '',
  startTime: '19:00',
  endTime: '00:00',
  start: null            // { lat, lng, label } — the start/finish line
};

/* The one read every client makes. ONE Redis command. */
async function readState() {
  const raw = pairsToObj(await cmd(['HGETALL', KEY]));

  const locations = [];
  const challenges = [];
  const checkins = {};
  const done = {};
  const skips = {};

  for (const field of Object.keys(raw)) {
    const v = raw[field];
    if (field.charCodeAt(1) !== 58 /* ':' */) continue;   // event / route handled below
    const kind = field[0];
    const rest = field.slice(2);

    if (kind === 'L') {
      const o = jparse(v, null);
      if (o && o.id) locations.push(o);
    } else if (kind === 'C') {
      const o = jparse(v, null);
      if (o && o.id) challenges.push(o);
    } else if (kind === 'I' || kind === 'D') {
      const cut = rest.lastIndexOf(':');
      if (cut < 0) continue;
      const cid = rest.slice(0, cut), who = rest.slice(cut + 1);
      const f = parseFlag(v);
      if (!f.on || !isPlayer(who)) continue;
      const bag = kind === 'I' ? checkins : done;
      (bag[cid] || (bag[cid] = [])).push(who);
    } else if (kind === 'S') {
      const f = parseFlag(v);
      if (f.on) skips[rest] = { by: f.extra, at: f.at };
    }
  }

  // Stable order so two phones render the same list in the same order.
  locations.sort((a, b) => (a.at || 0) - (b.at || 0));
  challenges.sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const k of Object.keys(checkins)) checkins[k].sort();
  for (const k of Object.keys(done)) done[k].sort();

  return {
    event: Object.assign({}, DEFAULT_EVENT, jparse(raw.event, null) || {}),
    locations, challenges, checkins, done, skips,
    route: jparse(raw.route, null),
    players: PLAYERS,
    at: Date.now()        // server clock, so a phone with a wrong clock still
                          // measures "synced Xs ago" against something real
  };
}

/* ------------------------------------------------------------ writes */

async function setField(field, value) { return cmd(['HSET', KEY, field, value]); }
async function delFields(fields) {
  if (!fields.length) return 0;
  return cmd(['HDEL', KEY].concat(fields));
}

/* Newest-wins toggle, atomic in one command.

   Deliberately NOT cjson: Upstash's Lua sandbox is not guaranteed to
   expose it, and the value format here is simple enough to parse with
   string.find, which is always there. */
const TOGGLE_LUA = [
  "local cur = redis.call('HGET', KEYS[1], ARGV[1])",
  "if cur then",
  "  local sep = string.find(cur, '|', 1, true)",
  "  if sep then",
  "    local curAt = tonumber(string.sub(cur, 1, sep - 1))",
  "    local newAt = tonumber(ARGV[2])",
  "    if curAt and newAt and curAt > newAt then return 0 end",
  "  end",
  "end",
  "redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])",
  "return 1"
].join('\n');

/* on/off with an explicit client timestamp. The client always sends the
   state it wants, never "flip it" — a flip is not idempotent and would
   land wrong the moment a queued write is replayed twice. */
async function toggle(field, on, at, extra) {
  const stamp = Number(at) || Date.now();
  const value = stamp + '|' + (on ? '1' : '0') + (extra ? '|' + extra : '');
  const applied = await cmd(['EVAL', TOGGLE_LUA, '1', KEY, field, String(stamp), value]);
  return applied === 1 || applied === '1';
}

/* --------------------------------------------------------- http bits */

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(jparse(req.body, {}));
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 200000) req.destroy(); });
    req.on('end', () => resolve(jparse(s, {})));
    req.on('error', () => resolve({}));
  });
}

/* Every response is uncacheable on purpose: this is live event state, and
   an intermediate cache holding it for even thirty seconds would show one
   car a check-in another car had already backed out of. */
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.end(JSON.stringify(obj));
}
function fail(res, status, msg) { send(res, status, { error: msg }); }

/* The admin code is the only gate on destructive writes. It is never
   embedded in the page — the player types it, the server compares it. */
function isAdmin(req) {
  const want = process.env.ADMIN_CODE || '';
  const got = req.headers['x-rb-admin'] || '';
  return !!want && String(got) === want;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const num = (v, d) => {
  const n = Number(v);
  return isFinite(n) ? n : d;
};
const str = (v, max) => String(v == null ? '' : v).slice(0, max || 200).trim();

module.exports = {
  KEY, PLAYERS, isPlayer, DEFAULT_EVENT,
  cmd, readState, setField, delFields, toggle,
  readBody, send, fail, isAdmin, uid, num, str, jparse
};
