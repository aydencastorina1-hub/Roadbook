'use strict';
/* GET  /api/event   — the hunt window and the start/finish line
   POST /api/event   — set it (admin only)

   The window is stored as a calendar date plus two wall-clock times, not
   as a duration: the whole app rebuilds real Date objects from it on
   every tick, so a phone that slept through midnight comes back to the
   right number instead of an accumulated one. A finish at or before the
   start means the hunt runs past midnight (19:00 → 00:00 is five hours).

   The start line lives here because §5 of the spec measures "can we
   still make it" against being back AT THE START by the end time — with
   no start pin there is no return leg and no honest projection. */

const kv = require('./_kv');

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return kv.send(res, 204, {});

    if (req.method === 'GET') {
      const state = await kv.readState();
      return kv.send(res, 200, { event: state.event });
    }
    if (req.method !== 'POST') return kv.fail(res, 405, 'GET or POST');
    if (!kv.isAdmin(req)) return kv.fail(res, 403, 'Admin only');

    const body = await kv.readBody(req);
    const prev = (await kv.readState()).event;

    const date = DATE.test(body.date || '') ? body.date : prev.date;
    const startTime = TIME.test(body.startTime || '') ? body.startTime : prev.startTime;
    const endTime = TIME.test(body.endTime || '') ? body.endTime : prev.endTime;

    let start = prev.start;
    if (body.start === null) start = null;
    else if (body.start && typeof body.start === 'object') {
      const lat = kv.num(body.start.lat, NaN), lng = kv.num(body.start.lng, NaN);
      if (isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        start = { lat, lng, label: kv.str(body.start.label, 200) || 'Start line' };
      }
    }

    const event = { date, startTime, endTime, start };
    await kv.setField('event', JSON.stringify(event));
    kv.send(res, 200, { ok: true, event });

  } catch (e) {
    kv.fail(res, 500, String(e.message || e));
  }
};
