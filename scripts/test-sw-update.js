/* Does a redeploy actually reach a browser that already has the old
   service worker? This is §11 of the brief, simulated end to end:

     1. open the app cold, let the worker install and take control
     2. "deploy": change index.html and re-stamp sw.js
     3. re-open the app IN THE SAME BROWSER PROFILE — same registration,
        same caches, exactly the state a phone is in
     4. the new content must be on screen

   Step 3 is the part that was broken: with an unchanged sw.js the old
   worker keeps answering from its cache forever.                       */
const { chromium } = require('playwright');
const fs = require('fs');
const { execFileSync } = require('child_process');
const BASE = 'http://localhost:4321';
const IDX = require("path").join(__dirname, "..", "index.html");
const log = (...a) => console.log('  ', ...a);

const marker = () => {
  const s = fs.readFileSync(IDX, 'utf8');
  const m = /<meta name="rb-build-marker" content="([^"]*)">/.exec(s);
  return m ? m[1] : null;
};
function setMarker(v) {
  let s = fs.readFileSync(IDX, 'utf8');
  if (/<meta name="rb-build-marker"/.test(s)) s = s.replace(/<meta name="rb-build-marker" content="[^"]*">/, `<meta name="rb-build-marker" content="${v}">`);
  else s = s.replace('<title>Roadbook</title>', `<meta name="rb-build-marker" content="${v}">\n<title>Roadbook</title>`);
  fs.writeFileSync(IDX, s);
  execFileSync(process.execPath, [require('path').join(__dirname,'stamp.js')], { stdio: 'pipe' });
}
const swBuild = () => (/const BUILD = '([^']*)';/.exec(fs.readFileSync(require('path').join(__dirname,'..','sw.js'), 'utf8')) || [])[1];

(async () => {
  const browser = await chromium.launch();
  // One persistent-ish context for the whole test: the SW registration
  // and its caches must survive between "visits", like a phone.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  console.log('\n=== DEPLOY 1 ===');
  setMarker('BUILD-ONE');
  log('index marker:', marker(), '| sw BUILD:', swBuild());
  const p1 = await ctx.newPage();
  await p1.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p1.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
  log('controller after first visit:', await p1.evaluate(() => !!navigator.serviceWorker.controller));
  log('on screen:', await p1.evaluate(() => document.querySelector('meta[name=rb-build-marker]').content));
  const cachesA = await p1.evaluate(() => caches.keys());
  log('caches:', JSON.stringify(cachesA));
  await p1.close();

  console.log('\n=== DEPLOY 2 (edit + restamp, then reopen) ===');
  const swBefore = swBuild();
  setMarker('BUILD-TWO');
  log('index marker:', marker(), '| sw BUILD:', swBefore, '->', swBuild(),
      swBefore === swBuild() ? '!! UNCHANGED — this is the bug' : '(changed, good)');

  const p2 = await ctx.newPage();
  const reloads = [];
  p2.on('framenavigated', f => { if (f === p2.mainFrame()) reloads.push(1); });
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  log('first paint shows :', await p2.evaluate(() => document.querySelector('meta[name=rb-build-marker]').content));
  // Give the update check + skipWaiting + claim + auto-reload time to run.
  await p2.waitForTimeout(6000);
  const shown = await p2.evaluate(() => document.querySelector('meta[name=rb-build-marker]').content);
  log('after settling    :', shown, shown === 'BUILD-TWO' ? '  <-- UPDATE LANDED' : '  <-- STILL STALE');
  log('navigations       :', reloads.length, '(1 = no reload needed, 2 = auto-reloaded once)');
  log('caches now        :', JSON.stringify(await p2.evaluate(() => caches.keys())));
  const bar = await p2.evaluate(() => {
    const el = document.querySelector('#a2hs');
    return el && el.classList.contains('show') ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  log('update banner     :', bar || '(none — it reloaded instead)');
  await p2.close();

  console.log('\n=== DEPLOY 3 (third build, prove it is repeatable) ===');
  setMarker('BUILD-THREE');
  log('sw BUILD:', swBuild());
  const p3 = await ctx.newPage();
  await p3.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(6000);
  const shown3 = await p3.evaluate(() => document.querySelector('meta[name=rb-build-marker]').content);
  log('after settling    :', shown3, shown3 === 'BUILD-THREE' ? '  <-- UPDATE LANDED' : '  <-- STILL STALE');
  await p3.close();

  console.log('\n=== OFFLINE COLD START (radios off, app must still open) ===');
  await ctx.setOffline(true);
  const p4 = await ctx.newPage();
  await p4.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(e => log('goto threw:', e.message));
  await p4.waitForTimeout(3000);
  log('title           :', await p4.title());
  log('marker          :', await p4.evaluate(() => {
    const m = document.querySelector('meta[name=rb-build-marker]'); return m ? m.content : 'NO HTML';
  }));
  log('who picker up   :', await p4.evaluate(() => !document.querySelector('#who').hidden));
  log('net chip        :', await p4.evaluate(() => document.querySelector('#chNet').textContent.trim()));
  await p4.close();
  await ctx.setOffline(false);

  // Leave the tree clean.
  let s = fs.readFileSync(IDX, 'utf8').replace(/<meta name="rb-build-marker" content="[^"]*">\n/, '');
  fs.writeFileSync(IDX, s);
  execFileSync(process.execPath, [require('path').join(__dirname,'stamp.js')], { stdio: 'pipe' });
  console.log('\n   (marker removed, sw restamped to', swBuild() + ')');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
