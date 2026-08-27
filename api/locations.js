'use strict';
/* Locations, and the challenges that hang off them.

     GET    /api/locations                        list
     POST   /api/locations                        create / edit      (admin)
     DELETE /api/locations?id=…                   delete + cascade   (admin)

     GET    /api/locations/:id/challenges         list for one place
     POST   /api/locations/:id/challenges         create / edit      (admin)
     DELETE /api/locations/:id/challenges?cid=…   delete + cascade   (admin)

   The two `/challenges` forms arrive here through a rewrite in
   vercel.json, which turns the path segment into ?id=…&sub=challenges.

   CASCADE MATTERS. Deleting a location has to take its challenges with
   it, and deleting a challenge has to take every check-in, completion
   and skip recorded against it — otherwise a phone that was offline
   during the delete replays a check-in for a challenge nobody can see
   and the team's point total quietly disagrees between cars. */

const kv = require('./_kv');

/* Locations carry a point; challenges do not. "people needed" runs from
   1 to the size of the whole team — it replaced the old individual/group
   flag and the per-challenge minute estimate. Clamped against
   kv.PLAYERS.length so adding someone to the roster is a one-line change
   in api/_kv.js and nothing here goes stale. */
function cleanLocation(body, prev) {
  const lat = kv.num(body.lat, prev ? prev.lat : NaN);
  const lng = kv.num(body.lng, prev ? prev.lng : NaN);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const name = kv.str(body.name, 120) || (prev && prev.name) || '';
  if (!name) return null;
  return {
    id: (prev && prev.id) || kv.str(body.id, 40) || kv.uid(),
    name,
    address: kv.str(body.address, 240),
    desc: kv.str(body.desc, 600),
    lat, lng,
    at: (prev && prev.at) || Date.now()
  };
}

function cleanChallenge(body, locId, prev) {
  const name = kv.str(body.name, 140) || (prev && prev.name) || '';
  if (!name) return null;
  let need = Math.round(kv.num(body.need, prev ? prev.need : 1));
  if (!isFinite(need)) need = 1;
  need = Math.max(1, Math.min(kv.PLAYERS.length, need));   // 1..the whole roster
  let pts = Math.round(kv.num(body.pts, prev ? prev.pts : 10));
  if (!isFinite(pts)) pts = 0;
  pts = Math.max(0, Math.min(9999, pts));
  return {
    id: (prev && prev.id) || kv.str(body.id, 40) || kv.uid(),
    locId,
    name,
    desc: kv.str(body.desc, 800),
    pts, need,
    at: (prev && prev.at) || Date.now()
  };
}

/* Every field recorded against a challenge, so a delete leaves nothing
   behind for an offline replay to reattach to. */
function chalFields(state, cid) {
  const out = ['C:' + cid, 'S:' + cid, 'N:' + cid];
  for (const p of kv.PLAYERS) { out.push('I:' + cid + ':' + p); out.push('D:' + cid + ':' + p); }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const locId = kv.str(url.searchParams.get('id'), 40);
    const isSub = url.searchParams.get('sub') === 'challenges';
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') return kv.send(res, 204, {});

    /* ------------------------------------------------------------ GET */
    if (method === 'GET') {
      const state = await kv.readState();
      if (isSub) {
        return kv.send(res, 200, {
          locId,
          challenges: state.challenges.filter(c => c.locId === locId)
        });
      }
      return kv.send(res, 200, { locations: state.locations });
    }

    if (method !== 'POST' && method !== 'DELETE') return kv.fail(res, 405, 'Unsupported method');
    if (!kv.isAdmin(req)) return kv.fail(res, 403, 'Admin only');

    const body = method === 'POST' ? await kv.readBody(req) : {};
    const state = await kv.readState();

    /* -------------------------------------------------- challenges/:id */
    if (isSub) {
      const loc = state.locations.find(l => l.id === locId);
      if (!loc) return kv.fail(res, 404, 'No such location');

      if (method === 'POST') {
        const prev = kv.str(body.id, 40)
          ? state.challenges.find(c => c.id === body.id) : null;
        const chal = cleanChallenge(body, locId, prev || null);
        if (!chal) return kv.fail(res, 400, 'A challenge needs a name');
        await kv.setField('C:' + chal.id, JSON.stringify(chal));
        return kv.send(res, 200, { ok: true, challenge: chal });
      }

      const cid = kv.str(url.searchParams.get('cid'), 40);
      const chal = state.challenges.find(c => c.id === cid);
      if (!chal) return kv.fail(res, 404, 'No such challenge');
      await kv.delFields(chalFields(state, cid));
      return kv.send(res, 200, { ok: true, deleted: cid });
    }

    /* ------------------------------------------------------- locations */
    if (method === 'POST') {
      const prev = kv.str(body.id, 40)
        ? state.locations.find(l => l.id === body.id) : null;
      const loc = cleanLocation(body, prev || null);
      if (!loc) return kv.fail(res, 400, 'A location needs a name and a map point');
      await kv.setField('L:' + loc.id, JSON.stringify(loc));
      return kv.send(res, 200, { ok: true, location: loc });
    }

    // DELETE — the location, then every challenge on it, then everything
    // recorded against those challenges.
    const loc = state.locations.find(l => l.id === locId);
    if (!loc) return kv.fail(res, 404, 'No such location');
    let fields = ['L:' + locId];
    for (const c of state.challenges) {
      if (c.locId === locId) fields = fields.concat(chalFields(state, c.id));
    }
    await kv.delFields(fields);

    // …and take it out of the shared route. The clients already skip an
    // order entry whose location has gone, so this is belt and braces —
    // but leaving a dangling id in KV means the stored route disagrees
    // with the board, and the next thing to read it raw would be wrong.
    // The legs are dropped rather than re-stitched: the drive time into
    // the NEXT stop is now measured from somewhere else entirely, and a
    // plausible-looking wrong number is worse than an honest estimate.
    const rt = state.route;
    if (rt && Array.isArray(rt.order) && rt.order.indexOf(locId) >= 0) {
      const keep = [];
      rt.order.forEach((id, i) => { if (id !== locId) keep.push({ id, leg: (rt.legs || [])[i] }); });
      if (!keep.length) await kv.delFields(['route']);
      else await kv.setField('route', JSON.stringify(Object.assign({}, rt, {
        order: keep.map(k => k.id),
        legs: keep.map(k => k.leg || { dur: 0, dist: 0 }),
        stale: true
      })));
    }
    return kv.send(res, 200, { ok: true, deleted: locId });

  } catch (e) {
    kv.fail(res, 500, String(e.message || e));
  }
};
