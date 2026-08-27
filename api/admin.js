'use strict';
/* POST /api/admin — check an admin code.
   Exists so the admin screen can say "wrong code" without the code ever
   living in the page. Writes are re-checked on their own endpoints; this
   is a convenience, not the security boundary. */

const kv = require('./_kv');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return kv.fail(res, 405, 'POST only');
  const body = await kv.readBody(req);
  const want = process.env.ADMIN_CODE || '';
  const got = kv.str(body.code, 120);
  if (!want) return kv.fail(res, 500, 'ADMIN_CODE is not set on the server');
  // Constant-ish time isn't meaningful here (the code is a shared party
  // password over TLS), but a slow-down on failure discourages guessing.
  if (got !== want) {
    await new Promise(r => setTimeout(r, 400));
    return kv.fail(res, 403, 'Wrong code');
  }
  kv.send(res, 200, { ok: true });
};
