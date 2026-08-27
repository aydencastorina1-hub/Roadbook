#!/usr/bin/env node
'use strict';
/* Wipe and re-seed the shared board. Development tool only — it talks to
   the same KV the app does, so DO NOT point it at a live hunt.

   Usage:  node scripts/seed.js [baseUrl]        default http://localhost:4321
           node scripts/seed.js <url> --wipe     wipe only, seed nothing   */

const BASE = process.argv[2] && process.argv[2].indexOf('http') === 0
  ? process.argv[2].replace(/\/$/, '') : 'http://localhost:4321';
const WIPE_ONLY = process.argv.indexOf('--wipe') >= 0;
/* Never defaulted. This repo is public, and a hard-coded fallback here
   would publish the admin code to anyone who reads it. Pull it from the
   environment instead:
     vercel env pull .env.local     (then run via `node -r` or export it)
     ADMIN_CODE=… node scripts/seed.js https://…                        */
const CODE = process.env.ADMIN_CODE || readEnvLocal('ADMIN_CODE');
if (!CODE) {
  console.error('seed: no ADMIN_CODE. Set it in the environment, or run\n' +
                '      `vercel env pull .env.local` so this can read it from there.');
  process.exit(1);
}
function readEnvLocal(key) {
  try {
    const raw = require('fs').readFileSync(require('path').join(__dirname, '..', '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$').exec(line);
      if (!m) continue;
      let v = m[1].trim();
      if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch (e) { /* no .env.local — fall through to the error above */ }
  return '';
}

const H = { 'Content-Type': 'application/json', 'x-rb-admin': CODE };
async function j(path, method, body) {
  const res = await fetch(BASE + path, {
    method: method || 'GET', headers: H,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(path + ' -> ' + res.status + ' ' + (out.error || ''));
  return out;
}

/* Real North Shore places, so the OSRM legs and the drive times in the
   projection are the genuine article rather than made-up coordinates. */
const PLACES = [
  { name: 'Bayville Bridge', address: 'Bayville Bridge, Bayville NY', lat: 40.9063, lng: -73.5589,
    desc: 'Park in the marina lot and walk to the sign.',
    chals: [
      { name: 'Photo with the bridge sign', pts: 10, need: 2, desc: 'Everyone in the frame, sign readable.' },
      { name: 'Sing the anthem on the seawall', pts: 35, need: 3, desc: 'Full verse, filmed, no laughing.' }
    ] },
  { name: 'Garvies Point Museum', address: 'Garvies Point Museum, Glen Cove NY', lat: 40.8703, lng: -73.6533,
    desc: 'Beach access is down the wooden stairs.',
    chals: [
      { name: 'Find a fossil and photograph it', pts: 20, need: 1, desc: 'Beach side, below the bluff.' }
    ] },
  { name: 'Theodore Roosevelt Park', address: 'Theodore Roosevelt Memorial Park, Oyster Bay NY', lat: 40.8757, lng: -73.5321,
    desc: 'Dock at the far end of the lot.',
    chals: [
      { name: 'Row the dinghy to the buoy', pts: 15, need: 2, desc: 'Both of you in the boat.' },
      { name: 'Interview a stranger about TR', pts: 25, need: 2, desc: 'Thirty seconds of usable footage.' }
    ] },
  { name: 'Locust Valley Station', address: 'Locust Valley LIRR Station, Locust Valley NY', lat: 40.8767, lng: -73.5946,
    chals: [
      { name: 'Human pyramid on the platform', pts: 40, need: 4, desc: 'Three up, one on top. Stay behind the line.' }
    ] },
  { name: 'Muttontown Preserve', address: 'Muttontown Preserve, East Norwich NY', lat: 40.8265, lng: -73.5399,
    desc: 'Gate closes at dusk — check before you commit.',
    chals: [
      { name: 'Photo at the ruined mansion', pts: 30, need: 2 }
    ] }
];

(async () => {
  console.log('board:', BASE);

  const cur = await j('/api/team');
  for (const l of cur.locations) {
    await j('/api/locations?id=' + encodeURIComponent(l.id), 'DELETE');
    console.log('  wiped', l.name);
  }
  await fetch(BASE + '/api/route', { method: 'DELETE', headers: H });
  if (WIPE_ONLY) { console.log('wiped only.'); return; }

  // The hunt window: next Saturday, 7pm to midnight.
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((6 - d.getDay()) + 7) % 7);
  const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
               '-' + String(d.getDate()).padStart(2, '0');
  await j('/api/event', 'POST', {
    date, startTime: '19:00', endTime: '00:00',
    start: { lat: 40.9096, lng: -73.5626, label: 'Bayville VFW, Bayville NY' }
  });
  console.log('  event', date, '19:00 -> 00:00, start line set');

  for (const p of PLACES) {
    const { location } = await j('/api/locations', 'POST', p);
    for (const c of p.chals) await j('/api/locations/' + location.id + '/challenges', 'POST', c);
    console.log('  +', location.name, '(' + p.chals.length + ')');
  }

  const s = await j('/api/team');
  console.log('seeded:', s.locations.length, 'locations,', s.challenges.length, 'challenges,',
    s.challenges.reduce((a, c) => a + c.pts, 0), 'points on the board');
})().catch(e => { console.error('seed failed:', e.message); process.exit(1); });
