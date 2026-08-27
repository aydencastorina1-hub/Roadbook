'use strict';
/* Challenges: the admin creates them, everyone else acts on them.

   ADMIN (x-rb-admin), on the bare path:
     POST   /api/challenges              create / edit  { id?, name, pts, need, desc, locId? }
     DELETE /api/challenges?id=…         delete + cascade

   ANYONE on the roster, on the action paths (rewritten by vercel.json
   into ?id=…&action=…):
     POST /api/challenges/:id/checkin    { player, on, at }
     POST /api/challenges/:id/complete   { player, on, at }
     POST /api/challenges/:id/skip       { player, on, at }
     POST /api/challenges/:id/locate     { player, locId }  attach to an existing pin
                                         { player, name, lat, lng, address? }  drop a new one
                                         { player, locId: null }  detach
     POST /api/challenges/:id/select     { player, on, at }  on = NOT selected

   WHY LOCATING IS NOT ADMIN-GATED. The admin writes the challenge list
   before the hunt, often without knowing where half of them will
   happen. The people who work that out are the ones standing in the
   car park. So creating a challenge is admin-only and attaching a
   location to one is not — those are genuinely different acts.

   `on` IS ALWAYS SENT BY THE CLIENT for the toggles, and is the state
   the player wants, never "flip it". A flip is not idempotent: replay a
   queued flip twice after a dead zone and the player ends up backed out
   of a challenge they joined. `at` is when the player actually tapped,
   which is what the newest-wins rule in kv.toggle() compares — so two
   phones replaying out of order still converge on whichever tap really
   happened last.

   Nothing here rejects a check-in for being "too late". The UI gates
   that. A server-side refusal would silently swallow a write that had
   been sitting in an offline queue since before the state changed, and
   an extra body on a challenge is harmless; a missing one is not. */

const kv = require('./_kv');

const TOGGLES = { checkin: 'I', complete: 'D', skip: 'S', select: 'N' };

function cleanChallenge(body, prev, locations) {
  const name = kv.str(body.name, 140) || (prev && prev.name) || '';
  if (!name) return null;

  let need = Math.round(kv.num(body.need, prev ? prev.need : 1));
  if (!isFinite(need)) need = 1;
  need = Math.max(1, Math.min(kv.PLAYERS.length, need));

  let pts = Math.round(kv.num(body.pts, prev ? prev.pts : 10));
  if (!isFinite(pts)) pts = 0;
  pts = Math.max(0, Math.min(9999, pts));

  /* locId is OPTIONAL and explicitly nullable. `undefined` means "leave
     it as it was" (so editing the points of a located challenge does
     not silently strip its pin); an explicit null detaches it. */
  let locId = prev ? (prev.locId || null) : null;
  if (body.locId === null) locId = null;
  else if (body.locId !== undefined) {
    const want = kv.str(body.locId, 40);
    locId = want && locations.some(l => l.id === want) ? want : locId;
  }

  return {
    id: (prev && prev.id) || kv.str(body.id, 40) || kv.uid(),
    locId,
    name,
    desc: kv.str(body.desc, 800),
    pts, need,
    at: (prev && prev.at) || Date.now()
  };
}

function chalFields(cid) {
  const out = ['C:' + cid, 'S:' + cid, 'N:' + cid];
  for (const p of kv.PLAYERS) { out.push('I:' + cid + ':' + p); out.push('D:' + cid + ':' + p); }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return kv.send(res, 204, {});

    const url = new URL(req.url, 'http://x');
    const cid = kv.str(url.searchParams.get('id'), 40);
    const action = kv.str(url.searchParams.get('action'), 20);

    /* ---------------- admin CRUD (no action segment) ---------------- */
    if (!action) {
      if (req.method !== 'POST' && req.method !== 'DELETE') return kv.fail(res, 405, 'POST or DELETE');
      if (!kv.isAdmin(req)) return kv.fail(res, 403, 'Admin only');
      const state = await kv.readState();

      if (req.method === 'DELETE') {
        if (!state.challenges.some(c => c.id === cid)) return kv.fail(res, 404, 'No such challenge');
        await kv.delFields(chalFields(cid));
        return kv.send(res, 200, { ok: true, deleted: cid, state: await kv.readState() });
      }

      const body = await kv.readBody(req);
      const prev = kv.str(body.id, 40) ? state.challenges.find(c => c.id === body.id) : null;
      const chal = cleanChallenge(body, prev || null, state.locations);
      if (!chal) return kv.fail(res, 400, 'A challenge needs a name');
      await kv.setField('C:' + chal.id, JSON.stringify(chal));
      return kv.send(res, 200, { ok: true, challenge: chal, state: await kv.readState() });
    }

    /* ---------------- player actions ---------------- */
    if (req.method !== 'POST') return kv.fail(res, 405, 'POST only');
    if (!cid) return kv.fail(res, 400, 'Missing challenge id');

    const body = await kv.readBody(req);
    const player = kv.str(body.player, 40);
    if (!kv.isPlayer(player)) return kv.fail(res, 400, 'Unknown player');

    // Clock skew is real — a phone left on airplane mode for a week comes
    // back with a wrong clock — so a timestamp from the future is pulled
    // back to now rather than winning every write forever.
    const now = Date.now();
    let at = kv.num(body.at, now);
    if (!isFinite(at) || at > now + 60000 || at < 0) at = now;

    if (action === 'locate') {
      const state = await kv.readState();
      const chal = state.challenges.find(c => c.id === cid);
      if (!chal) return kv.fail(res, 404, 'No such challenge');

      let locId = null;
      if (body.locId === null) {
        locId = null;                                   // detach
      } else if (kv.str(body.locId, 40)) {
        locId = kv.str(body.locId, 40);
        if (!state.locations.some(l => l.id === locId)) return kv.fail(res, 404, 'No such location');
      } else {
        // A brand-new pin, dropped by a player.
        const lat = kv.num(body.lat, NaN), lng = kv.num(body.lng, NaN);
        if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180)
          return kv.fail(res, 400, 'A pin needs a lat and lng');
        const loc = {
          id: kv.uid(),
          name: kv.str(body.name, 120) || chal.name,
          address: kv.str(body.address, 240),
          desc: '',
          lat, lng,
          by: player,
          at: Date.now()
        };
        await kv.setField('L:' + loc.id, JSON.stringify(loc));
        locId = loc.id;
      }

      // Locating something also un-rejects it: you do not pin a stop you
      // have decided not to do.
      await kv.setField('C:' + cid, JSON.stringify(Object.assign({}, chal, { locId })));
      if (locId) await kv.toggle('N:' + cid, false, at, player);
      return kv.send(res, 200, { ok: true, locId, state: await kv.readState() });
    }

    const prefix = TOGGLES[action];
    if (!prefix) return kv.fail(res, 404, 'Unknown action');

    /* The challenge has to exist. A 404 here is not a problem for an
       offline replay: the client drops any queued write that comes back
       4xx, which is exactly right when the challenge was deleted while
       the phone was in a dead zone. Without the check, a stale replay
       leaves an orphan field in KV that nothing will ever clear. */
    {
      const state = await kv.readState();
      if (!state.challenges.some(c => c.id === cid)) return kv.fail(res, 404, 'No such challenge');
    }

    const on = body.on === undefined ? true : !!body.on;
    // skip and select belong to the stop, not to one player, so they are
    // keyed by challenge alone and just record who decided.
    const perPlayer = (prefix === 'I' || prefix === 'D');
    const field = perPlayer ? prefix + ':' + cid + ':' + player : prefix + ':' + cid;
    const applied = await kv.toggle(field, on, at, perPlayer ? '' : player);

    // Always return the fresh state so the phone that acted gets the
    // authoritative answer immediately instead of waiting for its poll.
    kv.send(res, 200, { ok: true, applied, state: await kv.readState() });

  } catch (e) {
    kv.fail(res, 500, String(e.message || e));
  }
};
