#!/usr/bin/env node
'use strict';
/* Local dev server. Serves the static files and dispatches /api/* to the
   same handlers Vercel runs, with the same rewrites vercel.json applies —
   so a bug found here is a bug in production, not in the harness.

   Reads .env.local (written by `vercel env pull`) for the KV credentials.

   Usage:  node scripts/dev.js [port]        default 4321               */

const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/* --- .env.local --------------------------------------------------- */
try {
  const raw = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch (e) { console.warn('dev: no .env.local — KV calls will fail'); }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/* The same two rewrites vercel.json declares. */
function rewrite(url) {
  let m = /^\/api\/locations\/([^/?]+)\/challenges(\?.*)?$/.exec(url);
  if (m) return '/api/locations?id=' + m[1] + '&sub=challenges' +
    (m[2] ? '&' + m[2].slice(1) : '');
  m = /^\/api\/challenges\/([^/?]+)\/(checkin|complete|skip|locate|select)(\?.*)?$/.exec(url);
  if (m) return '/api/challenges?id=' + m[1] + '&action=' + m[2] +
    (m[3] ? '&' + m[3].slice(1) : '');
  return url;
}

const server = http.createServer(async (req, res) => {
  const url = rewrite(req.url);
  req.url = url;

  if (url.indexOf('/api/') === 0) {
    const name = url.slice(5).split('?')[0].split('/')[0];
    const file = path.join(root, 'api', name + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"no such route"}'); }
    delete require.cache[require.resolve(file)];      // pick up edits
    try {
      await require(file)(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  let p = url.split('?')[0];
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(root, p.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  if (p === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.argv[2]) || 4321;
server.listen(port, () => console.log('roadbook dev on http://localhost:' + port));
