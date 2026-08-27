'use strict';
/* GET  /api/route  — the single shared roadbook
   POST /api/route  — publish a newly optimised one (any player)
   DELETE /api/route — clear it (any player)

   There is exactly ONE route for the whole team, not one per phone, so
   this is a plain last-writer-wins string. The optimising itself happens
   on the phone that tapped "Optimize Team Route" — it already has the
   OSRM matrix, the leg cache and the map; the server only has to hold
   the answer so the other five cars see the same order.

   Deliberately NOT admin-gated: §5 of the spec says any player can
   trigger a re-optimise, and the whole point of the Skip button is that
   the car actually standing at a locked gate can re-plan without phoning
   the person holding the admin code. */

const kv = require('./_kv');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return kv.send(res, 204, {});

    if (req.method === 'GET') {
      const state = await kv.readState();
      return kv.send(res, 200, { route: state.route });
    }

    if (req.method === 'DELETE') {
      await kv.delFields(['route']);
      return kv.send(res, 200, { ok: true, route: null });
    }

    if (req.method !== 'POST') return kv.fail(res, 405, 'GET, POST or DELETE');

    const body = await kv.readBody(req);
    const by = kv.str(body.by, 40);
    if (!kv.isPlayer(by)) return kv.fail(res, 400, 'Unknown player');

    const order = Array.isArray(body.order)
      ? body.order.map(id => kv.str(id, 40)).filter(Boolean).slice(0, 80) : [];
    const legs = Array.isArray(body.legs)
      ? body.legs.slice(0, 81).map(l => ({
          dur: Math.max(0, kv.num(l && l.dur, 0)),
          dist: Math.max(0, kv.num(l && l.dist, 0))
        })) : [];
    const ret = body.ret && typeof body.ret === 'object'
      ? { dur: Math.max(0, kv.num(body.ret.dur, 0)), dist: Math.max(0, kv.num(body.ret.dist, 0)) }
      : null;

    // legs[i] is the drive INTO order[i], so there must be one per stop.
    if (legs.length !== order.length) return kv.fail(res, 400, 'legs must match order');

    const route = {
      order, legs, ret,
      engine: kv.str(body.engine, 12) || 'EST',
      startSec: Math.max(0, kv.num(body.startSec, 0)),
      by, at: Date.now()
    };
    await kv.setField('route', JSON.stringify(route));
    kv.send(res, 200, { ok: true, route });

  } catch (e) {
    kv.fail(res, 500, String(e.message || e));
  }
};
