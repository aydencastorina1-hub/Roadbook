#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------
   Stamp the service worker with a content hash of the app shell.

   THIS IS THE FIX FOR "pushed changes never show up on my iPhone".

   A browser only installs a new service worker if the BYTES OF sw.js
   ITSELF changed. Ship a new index.html without touching sw.js and
   Safari keeps the old worker, which keeps serving the old cached
   index.html — forever, because nothing ever invalidates it. Chrome
   hides this most of the time by being aggressive about update checks;
   Safari does not, which is why it looked like an iPhone-only bug.

   So: every deploy runs this, it hashes the real shell files, and
   writes that hash into sw.js. Change one character of the app and
   sw.js changes too, the update check sees a different worker, and
   (with skipWaiting + clients.claim in sw.js) it takes over on the
   spot instead of waiting for every tab to close — which on a phone
   is never.

   Runs as `vercel-build`, so it cannot be forgotten. Safe to run by
   hand as well: it is idempotent and rewrites one line.
   ------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const SW = path.join(root, 'sw.js');

/* Everything the worker precaches. If a file is in the offline shell it
   belongs in the hash — otherwise updating it would not produce a new
   worker and the old copy would be served from cache indefinitely. */
const SHELL = [
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png'
];

const h = crypto.createHash('sha256');
let counted = 0;
for (const f of SHELL) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  h.update(f);
  h.update(fs.readFileSync(p));
  counted++;
}
if (!counted) {
  console.error('stamp: found none of the shell files — refusing to write a meaningless hash');
  process.exit(1);
}
const build = h.digest('hex').slice(0, 12);

let sw = fs.readFileSync(SW, 'utf8');
const line = /const BUILD = '[^']*';/;
if (!line.test(sw)) {
  console.error("stamp: sw.js has no `const BUILD = '…';` line to stamp");
  process.exit(1);
}
const before = sw;
sw = sw.replace(line, "const BUILD = '" + build + "';");
if (sw !== before) fs.writeFileSync(SW, sw);

console.log('stamp: sw.js BUILD = ' + build + ' (' + counted + ' shell files hashed)');
