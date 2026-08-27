/* The real thing: a live push-and-reopen against production.

   Same shape as test-sw-update.js but it actually deploys, because the
   local harness cannot prove that Vercel serves sw.js with the headers
   the update check needs. Costs three production deploys and leaves the
   tree exactly as it found it.

   Usage:  node scripts/test-prod-update.js [https://your-app.vercel.app]  */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = (process.argv[2] || 'https://roadbook-indol.vercel.app').replace(/\/$/, '');
const root = path.join(__dirname, '..');
const IDX = path.join(root, 'index.html');
const SW = path.join(root, 'sw.js');
const log = (...a) => console.log('  ', ...a);

const swBuild = () => (/const BUILD = '([^']*)';/.exec(fs.readFileSync(SW, 'utf8')) || [])[1];
function setMarker(v) {
  let s = fs.readFileSync(IDX, 'utf8');
  if (/<meta name="rb-build-marker"/.test(s))
    s = v === null
      ? s.replace(/<meta name="rb-build-marker" content="[^"]*">\n/, '')
      : s.replace(/<meta name="rb-build-marker" content="[^"]*">/, `<meta name="rb-build-marker" content="${v}">`);
  else if (v !== null)
    s = s.replace('<title>Roadbook</title>', `<meta name="rb-build-marker" content="${v}">\n<title>Roadbook</title>`);
  fs.writeFileSync(IDX, s);
  execFileSync(process.execPath, [path.join(__dirname, 'stamp.js')], { stdio: 'pipe' });
}
function deploy(label) {
  log('deploying (' + label + ')…');
  const out = execFileSync('npx', ['--yes', 'vercel@latest', 'deploy', '--prod', '--yes'],
    { cwd: root, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const m = /"readyState":\s*"(\w+)"/.exec(out);
  log('  ->', m ? m[1] : 'deployed');
}
const marker = page => page.evaluate(() => {
  const m = document.querySelector('meta[name=rb-build-marker]');
  return m ? m.content : '(none)';
});

(async () => {
  const browser = await chromium.launch();
  // One context throughout: the registration and caches must persist
  // between visits, exactly like a phone that never closes the app.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  console.log('\n=== VISIT 1 — install the worker ===');
  setMarker('PROD-ONE');
  deploy('PROD-ONE, build ' + swBuild());
  let p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
    null, { timeout: 30000 });
  log('controller :', await p.evaluate(() => !!navigator.serviceWorker.controller));
  log('marker     :', await marker(p));
  log('caches     :', JSON.stringify(await p.evaluate(() => caches.keys())));
  await p.close();

  console.log('\n=== PUSH — change the app, redeploy ===');
  const before = swBuild();
  setMarker('PROD-TWO');
  log('sw BUILD', before, '->', swBuild());
  deploy('PROD-TWO');
  const liveSw = await (await fetch(BASE + '/sw.js', { cache: 'no-store' })).text();
  log('sw.js live BUILD:', (/const BUILD = '([^']*)';/.exec(liveSw) || [])[1]);

  console.log('\n=== VISIT 2 — reopen, same browser profile ===');
  p = await ctx.newPage();
  let navs = 0;
  p.on('framenavigated', f => { if (f === p.mainFrame()) navs++; });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  log('first paint:', await marker(p));
  await p.waitForTimeout(8000);
  const shown = await marker(p);
  log('settled    :', shown, shown === 'PROD-TWO' ? '  <-- UPDATE LANDED' : '  <-- STILL STALE');
  log('navigations:', navs);
  log('caches     :', JSON.stringify(await p.evaluate(() => caches.keys())));
  await p.close();

  console.log('\n=== CLEAN UP — remove the marker, deploy the real build ===');
  setMarker(null);
  log('final sw BUILD:', swBuild());
  deploy('clean');
  const finalSw = await (await fetch(BASE + '/sw.js', { cache: 'no-store' })).text();
  log('live BUILD now:', (/const BUILD = '([^']*)';/.exec(finalSw) || [])[1]);
  log('marker gone from local index:', !/rb-build-marker/.test(fs.readFileSync(IDX, 'utf8')));

  console.log('\n=== RESULT: ' + (shown === 'PROD-TWO' ? 'PASS' : 'FAIL') + ' ===');
  await browser.close();
  process.exit(shown === 'PROD-TWO' ? 0 : 1);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
