'use strict';
/* GET /api/team — the entire shared hunt state, in one shot.
   This is what every phone polls; see api/_kv.js for why it is one
   Redis command and why nothing here is per-player. */

const kv = require('./_kv');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return kv.send(res, 204, {});
  if (req.method !== 'GET') return kv.fail(res, 405, 'GET only');
  try {
    kv.send(res, 200, await kv.readState());
  } catch (e) {
    kv.fail(res, 500, String(e.message || e));
  }
};
