'use strict';
/* Player actions on a challenge. No admin code required — any of the six
   can do any of these, to any challenge. That is the point of the app.

     POST /api/challenges/:id/checkin    { player, on, at }
     POST /api/challenges/:id/complete   { player, on, at }
     POST /api/challenges/:id/skip       { player, on, at }

   (vercel.json rewrites the path into ?id=…&action=….)

   `on` IS ALWAYS SENT BY THE CLIENT and is the state the player wants,
   never "flip it". A flip is not idempotent: replay a queued flip twice
   after a dead zone and the player ends up backed out of a challenge
   they joined. `at` is when the player actually tapped, which is what
   the newest-wins rule in kv.toggle() compares — so two phones replaying
   out of order still converge on whichever tap really happened last.

   Nothing here rejects a check-in for being "too late" (past the needed
   headcount, or after the challenge was confirmed). The UI is what gates
   that. A server-side refusal would silently swallow a write that had
   been sitting in an offline queue since before the state changed, and
   an extra body on a challenge is harmless anyway — a missing one is
   not. */

const kv = require('./_kv');

const ACTIONS = { checkin: 'I', complete: 'D', skip: 'S' };

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return kv.send(res, 204, {});
    if (req.method !== 'POST') return kv.fail(res, 405, 'POST only');

    const url = new URL(req.url, 'http://x');
    const cid = kv.str(url.searchParams.get('id'), 40);
    const action = kv.str(url.searchParams.get('action'), 20);
    const prefix = ACTIONS[action];
    if (!cid) return kv.fail(res, 400, 'Missing challenge id');
    if (!prefix) return kv.fail(res, 404, 'Unknown action');

    const body = await kv.readBody(req);
    const player = kv.str(body.player, 40);
    if (!kv.isPlayer(player)) return kv.fail(res, 400, 'Unknown player');

    // Clock skew is real (a phone left on airplane mode for a week comes
    // back with a wrong clock), so a timestamp from the future is pulled
    // back to now rather than being allowed to win every future write.
    const now = Date.now();
    let at = kv.num(body.at, now);
    if (!isFinite(at) || at > now + 60000 || at < 0) at = now;

    const on = body.on === undefined ? true : !!body.on;

    // Skip is a property of the stop, not of one player, so it is keyed
    // by challenge alone and just records who pulled it.
    const field = prefix === 'S' ? 'S:' + cid : prefix + ':' + cid + ':' + player;
    const applied = await kv.toggle(field, on, at, prefix === 'S' ? player : '');

    // Always return the fresh state: the phone that acted gets the
    // authoritative answer immediately instead of waiting for its next
    // poll, which is what makes a tap feel instant even on a slow link.
    const state = await kv.readState();
    kv.send(res, 200, { ok: true, applied, state });

  } catch (e) {
    kv.fail(res, 500, String(e.message || e));
  }
};
