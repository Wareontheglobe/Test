// End-to-end test suite for Pathwarden.
// Run from the repo root:  node tests/run.js
// Needs Playwright with Chromium available (require('playwright')).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const results = [];
let current = '';
function check(cond, msg) { results.push({ test: current, ok: !!cond, msg }); if (!cond) console.log(`  FAIL [${current}] ${msg}`); }

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 390, height: 780 }, deviceScaleFactor: 1, hasTouch: true, isMobile: opts.isMobile !== false, serviceWorkers: opts.sw ? 'allow' : 'block' });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.goto(`${BASE}/index.html`);
  await page.waitForTimeout(250);
  return { ctx, page };
}
const G = (page, fn, arg) => page.evaluate(fn, arg);
async function tapTile(page, c, r) {
  const b = await page.$eval('#cv', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
  const T = b.w / 9;
  await page.mouse.click(b.x + (c + 0.5) * T, b.y + (r + 0.5) * T);
}
const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());
const hidden = (page, sel) => page.$eval(sel, el => el.hidden || getComputedStyle(el).display === 'none');
// Right after Main menu, road cards and Continue ignore taps for 350ms (a double tap must not land on a card). Wait that out.
const menuReady = page => G(page, () => new Promise(r => setTimeout(r, window.__pw.menuGuardLeft())));
async function startMap(page, i) { await menuReady(page); await page.click(`.mapbtn >> nth=${i}`); await page.waitForTimeout(80); }
// Tap the wave button. At wave 0 with no towers the wave-1 guard only warns ('Send anyway?'), so tap it a second time,
// as a separate tap: the second half of a quick double tap is ignored.
async function sendWave(page) { await page.click('#bWave'); if ((await text(page, '#bWave')) === 'Send anyway?') { await page.waitForTimeout(450); await page.click('#bWave'); } }
// Touch-tap the centre of an element twice, `gap` ms apart.
async function doubleTap(page, sel, gap = 90) {
  const p = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(gap); await page.touchscreen.tap(p.x, p.y);
  return p;
}
async function runUntilCalm(page, maxSec = 400) {
  return G(page, max => { const W = window.__pw; let t = 0; while ((W.G.spawnQ.length || W.G.enemies.length) && !W.G.over && t < max) { W.step(1 / 30); t += 1 / 30; } return t; }, maxSec);
}

let BASE;
(async () => {
  await new Promise(r => server.listen(0, r));
  BASE = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();

  // ---------------------------------------------------------------
  current = 'boot & menu';
  {
    const { ctx, page } = await newPage(browser);
    check(!(await hidden(page, '#menu')), 'menu visible on load');
    check((await page.$$('.mapbtn')).length === 3, 'three roads listed');
    check(await hidden(page, '#bContinue'), 'no Continue without a save');
    check((await text(page, '#bMute')) === 'Sound: on', 'sound on by default');
    check(page.errors.length === 0, 'no console errors on load: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'build / select / upgrade / target / sell';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1); // Meadow Bend
    check(await hidden(page, '#menu'), 'menu closes on road pick');
    check((await text(page, '#sGold span')) === '200' && (await text(page, '#sLives span')) === '20', 'HUD starts at 200 gold / 20 lives');
    check((await G(page, () => window.__pw.G.towers.length)) === 0, 'demo towers cleared for new game');

    await tapTile(page, 1, 3); // path tile
    check((await G(page, () => window.__pw.G.sel)) === null, 'tapping the road selects nothing');
    check(await page.$$eval('.tw', els => els.length === 5 && els.every(el => !el.classList.contains('dim'))), 'no .tw has .dim');
    await page.click('.tw[data-t="bolt"]');
    check((await page.$eval('.tw[data-t="bolt"]', el => el.classList.contains('armed'))) && (await text(page, '#info')).includes('Tap grass'), 'palette tap without a tile arms the tower and says to tap grass');
    await page.click('.tw[data-t="bolt"]');
    check((await G(page, () => window.__pw.G.pending)) === null, 'tapping the armed tower again disarms it');

    await tapTile(page, 2, 2);
    check(JSON.stringify(await G(page, () => window.__pw.G.sel)) === '{"c":2,"r":2}', 'grass tile selected');
    await page.click('.tw[data-t="bolt"]');
    check(await page.$eval('.tw[data-t="bolt"]', el => el.classList.contains('armed')), 'first tap arms the tower');
    check((await G(page, () => window.__pw.G.towers.length)) === 0, 'first tap does not build');
    await page.click('.tw[data-t="bolt"]');
    check((await G(page, () => window.__pw.G.towers.length)) === 1, 'second tap builds');
    check((await text(page, '#sGold span')) === '150', 'gold deducted (150)');

    // tap same tile again → selects tower
    await tapTile(page, 2, 2);
    check(!(await hidden(page, '#tview')) && (await hidden(page, '#palette')), 'tapping a tower opens its panel');
    check((await text(page, '#tvName')) === 'Bolt · Level 1', 'tower panel names tower and level');
    await page.click('#bUp');
    check((await G(page, () => window.__pw.G.towers[0].level)) === 2, 'upgrade to level 2 with 150 gold (cost 40)');
    await G(page, () => { window.__pw.G.gold = 10; });
    await page.waitForTimeout(50);
    await page.click('#bUp');
    check((await G(page, () => window.__pw.G.towers[0].level)) === 2, 'upgrade refused when too poor');
    check((await text(page, '#toast')).startsWith('Need'), 'shows how much gold is missing');
    await G(page, () => { window.__pw.G.gold = 500; });
    await page.waitForTimeout(50);
    await page.click('#bUp');
    check((await G(page, () => window.__pw.G.towers[0].level)) === 3, 'upgrade to level 3');
    check(await page.$eval('#bUp', el => el.disabled && el.textContent.includes('Max level')), 'upgrade disabled at max');

    const modes = [];
    for (let i = 0; i < 3; i++) { await page.click('#bMode'); modes.push(await page.$eval('#bMode small', el => el.textContent)); }
    check(modes.join(',') === 'Toughest,Fliers,First', 'target cycles Toughest→Fliers→First (' + modes + ')');

    const spent = await G(page, () => window.__pw.G.towers[0].spent);
    const goldBefore = await G(page, () => window.__pw.G.gold);
    await page.click('#bSell');
    check((await G(page, () => window.__pw.G.towers.length)) === 1 && (await text(page, '#bSell')).startsWith('Confirm'), 'first sell tap asks to confirm');
    await page.click('#bSell');
    check((await G(page, () => window.__pw.G.towers.length)) === 0, 'second sell tap sells');
    check(spent === 160 && (await G(page, () => window.__pw.G.gold)) === goldBefore + spent, 'built and upgraded before wave 1, so the refund is everything spent (' + spent + ')');
    check((await G(page, () => window.__pw.G.grid[2 * 9 + 2])) === 0, 'tile is free again after selling');

    // double-tap tile to build
    await tapTile(page, 3, 2); await page.click('.tw[data-t="frost"]'); await tapTile(page, 3, 2);
    check((await G(page, () => window.__pw.G.towers.map(t => t.type).join())) === 'frost', 'tap tile again with tower armed builds it');

    // too poor to build
    await G(page, () => { window.__pw.G.gold = 10; });
    await tapTile(page, 5, 5); await page.click('.tw[data-t="long"]'); await page.click('.tw[data-t="long"]');
    check((await G(page, () => window.__pw.G.towers.length)) === 1, 'cannot build without gold');
    check(await page.$eval('.tw[data-t="long"]', el => el.classList.contains('poor')), 'unaffordable towers marked');

    // sell arm resets when choosing another action
    await G(page, () => { window.__pw.G.gold = 500; });
    await tapTile(page, 3, 2); await page.click('#bSell'); await page.click('#bMode');
    check(!(await text(page, '#bSell')).startsWith('Confirm'), 'sell confirmation cancels on other action');
    await tapTile(page, 0, 0);
    check((await G(page, () => window.__pw.G.selTower)) === null, 'tapping elsewhere closes tower panel');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'waves, early call, save & continue';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 0);
    await G(page, () => { const W = window.__pw; W.G.gold = 2000; [[2, 2], [4, 2], [3, 3], [5, 5], [2, 5], [4, 8], [3, 9]].forEach(([c, r], i) => W.build(i % 2 ? 'arc' : 'bolt', c, r)); });
    await page.click('#bWave');
    check((await text(page, '#sWave')).replace(/\s/g, '') === 'Wave1/30', 'HUD shows wave 1/30');
    check(await page.$eval('#bWave', el => el.disabled), 'wave button disabled while spawning');
    await G(page, () => { const W = window.__pw; while (W.G.spawnQ.length) W.step(1 / 30); });
    await page.waitForTimeout(50);
    const label = await text(page, '#bWave');
    const enemiesLeft = await G(page, () => window.__pw.G.enemies.length);
    if (enemiesLeft) {
      check(/^Call 2 early\s*\+36$/.test(label), 'offers early call once wave fully arrived, with its bonus (' + label + ')');
      // Hold the run still, so no kill lands between reading the gold and the tap.
      const g0 = await G(page, () => { window.__pw.G.running = false; return window.__pw.G.gold; });
      await page.click('#bWave');
      check((await G(page, () => { window.__pw.G.running = true; return window.__pw.G.gold; })) === g0 + 36, 'early call pays a bonus of 36');
    }
    await runUntilCalm(page);
    await page.waitForTimeout(50);
    const saved = await G(page, () => JSON.parse(localStorage.getItem('pathwarden.v1')).saves.switch);
    check(saved && saved.wave === (enemiesLeft ? 2 : 1), 'run saved after waves clear');
    check(saved && saved.towers.length === 7, 'save includes towers');
    const before = await G(page, () => ({ gold: window.__pw.G.gold, lives: window.__pw.G.lives, wave: window.__pw.G.wave }));
    await page.reload(); await page.waitForTimeout(250);
    check(!(await hidden(page, '#bContinue')), 'Continue offered after reload');
    check((await text(page, '#bContinue')).includes('Long Switchback'), 'Continue names the road');
    await page.click('#bContinue');
    const after = await G(page, () => ({ gold: window.__pw.G.gold, lives: window.__pw.G.lives, wave: window.__pw.G.wave, towers: window.__pw.G.towers.length, map: window.__pw.G.map.id }));
    check(after.gold === before.gold && after.lives === before.lives && after.wave === before.wave && after.towers === 7 && after.map === 'switch', 'Continue restores gold, lives, wave, towers, road');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'speed / pause / restart / menu';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const sp = [];
    for (let i = 0; i < 3; i++) { await page.click('#bSpeed'); sp.push(await text(page, '#bSpeed')); }
    check(sp.join() === '2×,3×,1×', 'speed cycles 2×,3×,1×');
    await page.click('#bSpeed'); // now 2×
    await page.click('#bPause');
    check(!(await hidden(page, '#pauseOv')), 'pause overlay opens');
    const t0 = await G(page, () => window.__pw.G.time); await page.waitForTimeout(300);
    check((await G(page, () => window.__pw.G.time)) === t0, 'time frozen while paused');
    await page.click('#bResume');
    await page.waitForTimeout(200);
    check((await G(page, () => window.__pw.G.time)) > t0, 'time runs after resume');
    await page.click('#bPause'); await page.click('#bRestart'); await page.click('#bRestart');
    const spd = await G(page, () => window.__pw.G.speed);
    check((await text(page, '#bSpeed')) === spd + '×', `speed label matches game speed after restart (label ${await text(page, '#bSpeed')}, speed ${spd})`);
    check(await hidden(page, '#pauseOv'), 'restart closes pause overlay');
    // auto-pause when app goes to background
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    check((await G(page, () => window.__pw.G.paused)) && !(await hidden(page, '#pauseOv')), 'auto-pauses when app is backgrounded');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
    await page.click('#bMenu');
    check(!(await hidden(page, '#menu')), 'Main menu returns to road list');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'game over';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 2);
    await G(page, () => { window.__pw.G.lives = 1; });
    await sendWave(page);
    await runUntilCalm(page);
    check(await G(page, () => window.__pw.G.over), 'game ends at 0 lives');
    await page.waitForTimeout(1000); // the end screen follows a 900ms beat
    check(!(await hidden(page, '#endOv')) && (await text(page, '#endTitle')) === 'The keep has fallen', 'loss screen shown');
    check((await G(page, () => JSON.parse(localStorage.getItem('pathwarden.v1')).saves.quarry)) === undefined, 'save cleared on loss');
    check((await text(page, '#sLives span')) === '0', 'HUD shows 0 lives');
    await tapTile(page, 2, 2);
    check((await G(page, () => window.__pw.G.sel)) === null, 'board ignores taps after game over');
    await page.click('#bEndMain');
    check((await G(page, () => !window.__pw.G.over && window.__pw.G.lives === 20 && window.__pw.G.map.id === 'quarry')), 'Try again restarts same road');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'victory & endless';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await G(page, () => { const g = window.__pw.G; g.wave = 29; g.cleared = 29; });
    await page.click('#bWave');
    await G(page, () => { const W = window.__pw; let t = 0; while ((W.G.spawnQ.length || W.G.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } });
    await page.waitForTimeout(80);
    check(!(await hidden(page, '#endOv')) && (await text(page, '#endTitle')) === 'The road holds', 'victory screen after wave 30');
    check((await G(page, () => JSON.parse(localStorage.getItem('pathwarden.v1')).best.meadow)) === 30, 'best wave recorded');
    await page.click('#bEndMain');
    check(!(await G(page, () => window.__pw.G.paused)), 'Keep going resumes play');
    await page.click('#bWave');
    const hud = (await text(page, '#sWave')).replace(/\s/g, '');
    check(!hud.includes('31/30'), 'HUD does not read "31/30" in endless mode (' + hud + ')');
    await G(page, () => { const W = window.__pw; let t = 0; while ((W.G.spawnQ.length || W.G.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } });
    check(await hidden(page, '#endOv'), 'victory screen not shown again in endless');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'mechanics';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    // mortar cannot hit fliers
    const r1 = await G(page, () => { const W = window.__pw, g = W.G; g.gold = 9999; W.build('mortar', 2, 2); g.wave = 5; W.spawn('wisp', 3); const e = g.enemies[0]; const hp = e.hp; for (let i = 0; i < 60; i++) W.step(1 / 30); return { hp, after: e.hp }; });
    check(r1.after === r1.hp, 'mortar does not damage fliers');
    // armor: bolt vs brute reduced, longshot pierces
    const r2 = await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.towers = []; g.grid = W.MAPS[1].grid.slice(); g.W = {}; g.wave = 4; W.spawn('brute', 5); const e = g.enemies[0]; const hp = e.hp; e.armor = 3; return { hp }; });
    check(r2.hp > 0, 'brute spawned');
    // splitter: children appear on death, mortar blast does not instantly hit them
    const r3 = await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.projs = []; g.W = {}; g.wave = 7; W.spawn('splitter', 6); const e = g.enemies[0]; e.hp = 1; g.projs.push({ k: 'shell', x0: 0, y0: 0, tx: e.x, ty: e.y, t: 0, dur: 0.01, dmg: 25, splash: 1 }); W.step(1 / 30); const kids = g.enemies.filter(x => x.type === 'scout'); return { n: kids.length, full: kids.every(k => k.hp === k.max) }; });
    check(r3.n === 2, 'splitter bursts into two scouts');
    check(r3.full, 'scouts from a splitter are not hit by the blast that freed them');
    // frost slows, boss slowed half as much
    const r4 = await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.projs = []; g.towers = []; g.grid = W.MAPS[1].grid.slice(); g.W = {}; g.wave = 10; W.build('frost', 2, 2); W.spawn('grunt', 2.5); W.spawn('boss', 2.6); for (let i = 0; i < 40; i++) W.step(1 / 30); return g.enemies.map(e => [e.type, +e.slow.toFixed(2)]); });
    const grunt = r4.find(x => x[0] === 'grunt'), boss = r4.find(x => x[0] === 'boss');
    check(grunt && grunt[1] > 0.3, 'frost slows grunts (' + JSON.stringify(r4) + ')');
    check(boss && boss[1] > 0 && boss[1] < grunt[1], 'boss is slowed less');
    // leak costs lives by type
    const r5 = await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.towers = []; g.W = {}; g.lives = 20; g.wave = 4; W.spawn('brute', g.map.path.len - 0.3); for (let i = 0; i < 30; i++) W.step(1 / 30); return g.lives; });
    check(r5 === 18, 'brute leaking costs 2 lives');
    // arc chain does not hit enemies still off the board
    const r6 = await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.towers = []; g.grid = W.MAPS[1].grid.slice(); g.W = {}; g.wave = 1; W.build('arc', 2, 0); W.spawn('grunt', 0.5); W.spawn('grunt', -0.6); const [on, off] = g.enemies; const hp0 = on.hp, hp = off.hp; off.spd = 0; for (let i = 0; i < 12; i++) W.step(1 / 30); return on.hp < hp0 && off.hp === hp; });
    check(r6, 'arc does not chain to enemies that have not entered yet');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'storage edge cases';
  {
    const { ctx, page } = await newPage(browser, { init: () => { Storage.prototype.getItem = () => { throw new Error('blocked'); }; Storage.prototype.setItem = () => { throw new Error('blocked'); }; } });
    await startMap(page, 1);
    await sendWave(page);
    await page.waitForTimeout(300);
    check((await G(page, () => window.__pw.G.wave)) === 1, 'wave 1 starts with storage blocked');
    check(page.errors.length === 0, 'plays with storage blocked (private mode): ' + page.errors.join('|'));
    await ctx.close();
  }
  for (const bad of ['5', 'not json', 'null', '{"best":5}', '{"save":{"map":"meadow","wave":3,"gold":100,"lives":20,"towers":[{"type":"laser","c":0,"r":0},{"type":"bolt","c":1,"r":3},{"type":"bolt","c":99,"r":-4}]}}']) {
    current = 'corrupt save ' + bad.slice(0, 20);
    const { ctx, page } = await newPage(browser);
    await page.evaluate(v => localStorage.setItem('pathwarden.v1', v), bad); await page.reload(); await page.waitForTimeout(250);
    check(!(await hidden(page, '#menu')) && (await page.$$('.mapbtn')).length === 3, 'menu still loads with roads listed');
    if (bad.startsWith('{"save"')) {
      check(!(await hidden(page, '#bContinue')), 'old single save migrates and offers Continue');
      await page.click('#bContinue'); await page.waitForTimeout(100);
      const g = await G(page, () => ({ map: window.__pw.G.map.id, wave: window.__pw.G.wave, towers: window.__pw.G.towers.length }));
      check(g.map === 'meadow' && g.wave === 3 && g.towers === 0, 'Continue resumes the migrated run, bad towers dropped ' + JSON.stringify(g));
    } else if (!(await hidden(page, '#bContinue'))) { await page.click('#bContinue'); await page.waitForTimeout(100); }
    else { await startMap(page, 1); }
    await sendWave(page); await page.waitForTimeout(200);
    check(page.errors.length === 0, 'no crash: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  for (const [name, vp] of [['small phone 320x568', { width: 320, height: 568 }], ['phone landscape 844x390', { width: 844, height: 390 }], ['tablet 820x1180', { width: 820, height: 1180 }], ['desktop 1280x800', { width: 1280, height: 800 }]]) {
    current = 'layout ' + name;
    const { ctx, page } = await newPage(browser, { viewport: vp, isMobile: !name.startsWith('desktop') });
    // menu: every road button reachable by scrolling
    const reach = await page.evaluate(() => { const ov = document.querySelector('#menu'); const btns = [...document.querySelectorAll('.mapbtn')]; ov.scrollTop = 0; const top = btns[0].getBoundingClientRect().top; const title = document.querySelector('#menu .title').getBoundingClientRect().top; ov.scrollTop = 99999; const last = btns[2].getBoundingClientRect().bottom; return { titleTop: title, lastBottom: last, vh: innerHeight }; });
    check(reach.titleTop >= 0, `menu title reachable (top ${Math.round(reach.titleTop)})`);
    check(reach.lastBottom <= reach.vh + 1, `last road reachable (bottom ${Math.round(reach.lastBottom)} / ${reach.vh})`);
    await page.evaluate(() => { document.querySelector('#menu').scrollTop = 0; });
    await page.click('.mapbtn >> nth=1');
    await page.waitForTimeout(150);
    const lay = await page.evaluate(() => {
      const r = s => document.querySelector(s).getBoundingClientRect();
      const cv = r('#cv'), st = r('#stage'), pn = r('#panel'), hud = r('#hud');
      return { cv: [cv.left, cv.top, cv.right, cv.bottom], st: [st.top, st.bottom], pn: [pn.left, pn.top, pn.right, pn.bottom], hud: [hud.top, hud.bottom, hud.right], vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, tile: cv.width / 9 };
    });
    check(lay.cv[0] >= 0 && lay.cv[2] <= lay.vw && lay.cv[1] >= 0 && lay.cv[3] <= lay.vh, 'board fully on screen ' + JSON.stringify(lay.cv.map(Math.round)));
    check(lay.pn[3] <= lay.vh + 1 && lay.pn[2] <= lay.vw + 1, 'controls fully on screen ' + JSON.stringify(lay.pn.map(Math.round)));
    const overlap = !(lay.cv[3] <= lay.pn[1] || lay.cv[2] <= lay.pn[0] || lay.cv[0] >= lay.pn[2] || lay.cv[1] >= lay.pn[3]);
    check(!overlap, 'board does not overlap controls');
    check(lay.tile >= 22, `tiles big enough to tap (${lay.tile.toFixed(1)}px)`);
    check(lay.sw <= lay.vw, 'no horizontal scroll');
    await page.screenshot({ path: path.join(__dirname, 'out', `layout-${name.split(' ')[0]}-${vp.width}x${vp.height}.png`) });
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }


  current = 'frame rate (busy wave at 3x, hi-res screen)';
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(); await page.goto(`${BASE}/index.html`); await page.waitForTimeout(250);
    await page.click('.mapbtn >> nth=1');
    await page.evaluate(() => { const W = window.__pw, g = W.G; g.gold = 1e6; const ty = Object.keys(W.TD); let i = 0;
      for (let r = 0; r < W.ROWS; r++) for (let c = 0; c < W.COLS; c++) if (!g.grid[r * W.COLS + c] && (r + c) % 3 === 0) W.build(ty[i++ % 5], c, r);
      g.wave = 25; g.speed = 3; W.startWave(); });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => new Promise(res => { const ts = []; const f = t => { ts.push(t); if (ts.length < 150) requestAnimationFrame(f); else { const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]); d.sort((a, b) => a - b); res({ fps: 1000 * (ts.length - 1) / (ts[ts.length - 1] - ts[0]), p95: d[Math.floor(d.length * 0.95)], n: window.__pw.G.enemies.length }); } }; requestAnimationFrame(f); }));
    check(r.fps > 50, `holds ~60fps (${r.fps.toFixed(1)} fps, p95 ${r.p95.toFixed(1)}ms, ${r.n} enemies)`);
    await ctx.close();
  }

  current = 'saves between-wave changes';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await page.reload(); await page.waitForTimeout(250);
    check(!(await hidden(page, '#bContinue')), 'a tower built before wave 1 survives closing the app');
    await page.click('#bContinue');
    check((await G(page, () => window.__pw.G.towers.length)) === 1 && (await G(page, () => window.__pw.G.gold)) === 150, 'restored with the tower and the gold spent');
    await ctx.close();
  }
  // ---------------------------------------------------------------
  // save-safety: one saved run per road, two-tap restart, mid-wave menu warning, sell arm timeout.
  const stored = page => G(page, () => JSON.parse(localStorage.getItem('pathwarden.v1')));
  const card = (page, i) => text(page, `.mapbtn >> nth=${i}`);
  const killWaves = (page, n) => G(page, n => { const W = window.__pw, g = W.G; for (let w = 0; w < n; w++) { W.startWave(); let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } } return { wave: g.wave, calm: !g.spawnQ.length && !g.enemies.length && !Object.keys(g.W).length }; }, n);

  current = 'save-safety: old single save migrates to its road';
  {
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ save: { map: 'quarry', wave: 4, gold: 100, lives: 20, towers: [] }, best: { quarry: 4 } })));
    await page.reload(); await page.waitForTimeout(250);
    const st = await G(page, () => { const S = window.__pw.S; return { wave: S.saves.quarry && S.saves.quarry.wave, save: S.save, hasKey: 'save' in S, last: S.last }; });
    check(st.wave === 4, 'S.saves.quarry.wave === 4 (' + st.wave + ')');
    check(st.save === undefined && !st.hasKey, 'S.save is undefined after migration');
    check(st.last === 'quarry', 'S.last points at the migrated road');
    const ls = await stored(page);
    check(ls.save === undefined && ls.saves.quarry.wave === 4, 'migrated storage is written back without the old key');
    check((await card(page, 2)).includes('In progress · wave 5'), 'Quarry card reads "In progress · wave 5" (' + (await card(page, 2)) + ')');
    check(await page.$eval('.mapbtn >> nth=2', el => { const md = el.querySelector('.md'); return md.classList.contains('prog') && getComputedStyle(md).color === 'rgb(227, 173, 69)'; }), 'in-progress line uses class prog in brass');
    check(!(await card(page, 0)).includes('In progress') && !(await card(page, 1)).includes('In progress'), 'other roads show no run in progress');
    check(!(await hidden(page, '#bContinue')) && (await text(page, '#bContinue')).includes('Quarry Run'), 'Continue names Quarry Run (' + (await text(page, '#bContinue')) + ')');
    check((await text(page, '#bContinue')) === 'Continue · Quarry Run, wave 5', 'Continue label format');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: one slot per road, cards resume, two-tap restart';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1); // Meadow Bend
    const built = await G(page, () => { const W = window.__pw; W.G.gold = 1000; return [W.build('bolt', 2, 2), W.build('bolt', 4, 2), W.build('arc', 3, 5)].every(Boolean); });
    check(built, 'built 3 towers on Meadow');
    const run = await killWaves(page, 2);
    check(run.wave === 2 && run.calm, 'two waves run until calm ' + JSON.stringify(run));
    await page.click('#bPause');
    check(!(await text(page, '#bMenu')).includes('restarts'), 'calm pause: Main menu has no restart warning');
    await page.click('#bMenu');
    check(!(await hidden(page, '#menu')), 'back on the road list');
    check((await card(page, 1)).includes('In progress · wave 3'), 'Meadow card shows its run (' + (await card(page, 1)) + ')');
    await startMap(page, 0); // Switchback: no save, so a fresh run
    check((await G(page, () => window.__pw.G.map.id === 'switch' && window.__pw.G.wave === 0 && window.__pw.G.towers.length === 0)), 'Switchback card starts a fresh run');
    await page.click('#bPause'); await page.click('#bMenu');
    let ls = await stored(page);
    check(ls.saves.meadow && ls.saves.meadow.wave === 2 && ls.saves.meadow.towers.length === 3, 'localStorage saves.meadow.wave === 2 survives starting another road');
    check(ls.saves.switch === undefined, 'a road left at wave 0 with no towers writes no save');
    check((await card(page, 1)).includes('In progress · wave 3'), 'Meadow card still shows "In progress · wave 3"');
    check(!(await card(page, 0)).includes('In progress'), 'Switchback card shows no run');
    check((await text(page, '#bContinue')) === 'Continue · Meadow Bend, wave 3', 'Continue offers the Meadow run (' + (await text(page, '#bContinue')) + ')');

    await startMap(page, 1); // tap the Meadow card: resumes
    const res = await G(page, () => ({ map: window.__pw.G.map.id, towers: window.__pw.G.towers.length, wave: window.__pw.G.wave, running: window.__pw.G.running }));
    check(res.map === 'meadow' && res.towers === 3 && res.wave === 2 && res.running, 'Meadow card resumes the saved run ' + JSON.stringify(res));

    // Restart road takes two taps.
    await page.click('#bPause');
    await page.click('#bRestart');
    let g = await G(page, () => ({ wave: window.__pw.G.wave, towers: window.__pw.G.towers.length }));
    check(g.wave === 2 && g.towers === 3, 'one tap on Restart road changes nothing ' + JSON.stringify(g));
    check((await text(page, '#bRestart')) === 'Tap again to restart', 'first tap asks to tap again (' + (await text(page, '#bRestart')) + ')');
    check(await page.$eval('#bRestart', el => el.classList.contains('armed') && getComputedStyle(el).fontSize === '13px'), 'armed restart is styled as a warning');
    check(!(await hidden(page, '#pauseOv')), 'pause overlay stays open after one tap');
    await page.waitForTimeout(3600);
    check((await text(page, '#bRestart')) === 'Restart road' && !(await page.$eval('#bRestart', el => el.classList.contains('armed'))), 'restart disarms after 3.5s');
    check((await stored(page)).saves.meadow.wave === 2, 'save untouched by an expired restart tap');
    await page.click('#bRestart'); await page.click('#bResume'); await page.click('#bPause');
    check((await text(page, '#bRestart')) === 'Restart road', 'restart disarms on Resume and when pause reopens');
    await page.click('#bRestart'); await page.click('#bRestart');
    g = await G(page, () => ({ wave: window.__pw.G.wave, towers: window.__pw.G.towers.length, map: window.__pw.G.map.id }));
    check(g.wave === 0 && g.towers === 0 && g.map === 'meadow', 'two taps restart the road at wave 0 ' + JSON.stringify(g));
    check(await hidden(page, '#pauseOv'), 'restart closes the pause overlay');
    ls = await stored(page);
    check(ls.saves.meadow === undefined, 'restart deletes saves.meadow');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: mid-wave menu warning and sell timeout';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await G(page, () => window.__pw.startWave());
    await page.click('#bPause');
    check((await text(page, '#bMenu')).includes('Wave 1 restarts'), 'pause mid-wave: Main menu warns "Wave 1 restarts" (' + (await text(page, '#bMenu')) + ')');
    check(await page.$eval('#bMenu small', el => { const cs = getComputedStyle(el); return cs.display === 'block' && cs.fontSize === '11px' && cs.color === 'rgb(167, 177, 153)'; }), 'warning is a muted 11px second line');
    await page.click('#bResume');
    check((await G(page, () => { const W = window.__pw, g = W.G; let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } return g.wave === 1 && !g.spawnQ.length && !Object.keys(g.W).length; })), 'wave 1 cleared');
    await page.click('#bPause');
    check((await text(page, '#bMenu')) === 'Main menu', 'pause while calm: no restart warning (' + (await text(page, '#bMenu')) + ')');
    await page.click('#bResume');

    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await tapTile(page, 2, 2);
    await page.click('#bSell');
    check((await text(page, '#bSell')).startsWith('Confirm'), 'first Sell tap arms');
    await page.waitForTimeout(3700);
    check((await text(page, '#bSell')).startsWith('Undo'), 'Sell disarms after 3.5s, back to Undo for a tower built between waves (' + (await text(page, '#bSell')) + ')');
    check((await G(page, () => !window.__pw.G.sellArm && window.__pw.G.towers.length === 1)), 'tower kept, arm cleared');
    await page.click('#bSell');
    check((await text(page, '#bSell')).startsWith('Confirm'), 'Sell can be armed again after the timeout');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: a loss clears only that road';
  {
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { map: 'meadow', wave: 5, gold: 100, lives: 20, towers: [{ type: 'bolt', c: 2, r: 2 }] }, switch: { map: 'switch', wave: 2, gold: 80, lives: 20, towers: [] }, quarry: { map: 'meadow', wave: 9, gold: 1, lives: 1, towers: [] } }, last: 'meadow' })));
    await page.reload(); await page.waitForTimeout(250);
    check((await G(page, () => window.__pw.S.saves.quarry)) === undefined, 'a slot whose map does not match its road is dropped');
    check((await text(page, '#bContinue')) === 'Continue · Meadow Bend, wave 6', 'Continue follows S.last (' + (await text(page, '#bContinue')) + ')');
    await startMap(page, 2); // Quarry: fresh
    await tapTile(page, 0, 0); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    check(((await stored(page)).saves.quarry || {}).wave === 0, 'building before wave 1 saves the Quarry run');
    const over = await G(page, () => { const W = window.__pw, g = W.G; g.lives = 1; W.spawn('grunt', g.map.path.len - 0.3); for (let i = 0; i < 30 && !g.over; i++) W.step(1 / 30); return g.over; });
    check(over, 'Quarry run lost');
    const ls = await stored(page);
    check(ls.saves.quarry === undefined, 'loss deletes saves.quarry');
    check(ls.saves.meadow && ls.saves.meadow.wave === 5 && ls.saves.switch && ls.saves.switch.wave === 2, 'saves for other roads survive the loss');
    await page.waitForTimeout(1000); // the end screen follows a 900ms beat
    await page.click('#bEndAlt');
    check((await card(page, 1)).includes('In progress · wave 6') && (await card(page, 0)).includes('In progress · wave 3') && !(await card(page, 2)).includes('In progress'), 'cards reflect the remaining runs');
    check((await text(page, '#bContinue')) === 'Continue · Long Switchback, wave 3', 'Continue falls back to the first road with a save (' + (await text(page, '#bContinue')) + ')');
    await menuReady(page); await page.click('#bContinue');
    check((await G(page, () => window.__pw.G.map.id === 'switch' && window.__pw.G.wave === 2)), 'Continue resumes the fallback road');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: armed restart fits a 320px phone';
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(page, 1);
    await G(page, () => window.__pw.startWave());
    await page.click('#bPause'); await page.click('#bRestart');
    const fit = await page.evaluate(() => [...document.querySelectorAll('#bRestart,#bMenu')].map(b => ({ h: b.getBoundingClientRect().height, sh: b.scrollHeight, ch: b.clientHeight, sw: b.scrollWidth, cw: b.clientWidth })));
    check(fit.every(f => f.h === 46 && f.sh <= f.ch && f.sw <= f.cw), 'armed Restart and two-line Main menu fit their 46px buttons ' + JSON.stringify(fit));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: after early calls, Main menu names every wave that restarts, and the best wave is kept';
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(page, 1);
    const st = await G(page, () => {
      const W = window.__pw, g = W.G; g.running = false; // no towers, so nothing dies unless the test kills it
      W.startWave(); let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; }
      W.startWave(); while (g.spawnQ.length) W.step(1 / 30);
      W.startWave(); while (g.spawnQ.length) W.step(1 / 30); // wave 3 called early
      for (const e of g.enemies) if (e.w === 2) e.hp = 0.1;
      W.hurtAll(0.5); // wave 2 clears while wave 3 is still on the road, so the board is never calm
      g.running = true;
      return { wave: g.wave, cleared: g.cleared, active: Object.keys(g.W).join(), slot: W.S.saves.meadow.wave, best: JSON.parse(localStorage.getItem('pathwarden.v1')).best.meadow };
    });
    check(st.wave === 3 && st.cleared === 2 && st.active === '3' && st.slot === 1, 'wave 2 cleared during an early-called wave 3; the saved run is still at wave 1 ' + JSON.stringify(st));
    check(st.best === 2, 'the best wave is recorded as soon as wave 2 clears, even with wave 3 still on the road (' + st.best + ')');
    await page.click('#bPause');
    check((await text(page, '#bMenu')) === 'Main menuWaves 2-3 restart', 'Main menu warns "Waves 2-3 restart", the waves really lost (' + (await text(page, '#bMenu')) + ')');
    const fit = await page.$eval('#bMenu', b => ({ h: b.getBoundingClientRect().height, sh: b.scrollHeight, ch: b.clientHeight, sw: b.scrollWidth, cw: b.clientWidth }));
    check(fit.h === 46 && fit.sh <= fit.ch && fit.sw <= fit.cw, 'the longer note fits the 46px button at 320px ' + JSON.stringify(fit));
    await page.click('#bMenu');
    check((await card(page, 1)).includes('In progress · wave 2'), 'the Meadow card then resumes before wave 2, as the note said (' + (await card(page, 1)) + ')');
    check((await stored(page)).best.meadow === 2, 'best wave 2 survives leaving mid-wave');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: empty runs are not restored';
  {
    const { ctx, page } = await newPage(browser);
    // 1.0 saved wave 0 with no towers whenever you left for the menu; a slot like that is an empty run too.
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ save: { map: 'meadow', wave: 0, gold: 200, lives: 20, towers: [] }, saves: { switch: { map: 'switch', wave: 0, gold: 150, lives: 20, towers: [] }, quarry: { map: 'quarry', wave: 0, gold: 150, lives: 20, towers: [{ type: 'bolt', c: 2, r: 2 }] } }, last: 'switch' })));
    await page.reload(); await page.waitForTimeout(250);
    const sv = await G(page, () => ({ keys: Object.keys(window.__pw.S.saves).join(), old: 'save' in window.__pw.S }));
    check(sv.keys === 'quarry' && !sv.old, 'empty wave-0 runs (old single save and slot) are dropped; a wave-0 run with a tower is kept ' + JSON.stringify(sv));
    check((await card(page, 1)).includes('Not yet played') && !(await card(page, 0)).includes('In progress'), 'Meadow and Switchback show no run in progress (' + (await card(page, 1)) + ' / ' + (await card(page, 0)) + ')');
    check((await text(page, '#bContinue')) === 'Continue · Quarry Run, wave 1', 'Continue offers only the real run (' + (await text(page, '#bContinue')) + ')');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'save-safety: a double tap on Main menu stays on the menu';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 0);
    await page.click('#bPause');
    const p = await doubleTap(page, '#bMenu');
    await page.waitForTimeout(100);
    const under = await page.evaluate(p => { const el = document.elementFromPoint(p.x, p.y); return !!(el && el.closest('.mapbtn,#bContinue')); }, p);
    check(under, 'the second tap lands where a road card or Continue now sits');
    check(!(await hidden(page, '#menu')) && (await G(page, () => !window.__pw.G.running && window.__pw.G.map.id === 'switch')), 'pause > Main menu tapped twice 90ms apart: the menu stays up and no road starts');
    await page.waitForTimeout(300);
    await page.touchscreen.tap(p.x, p.y);
    check(await hidden(page, '#menu') && (await G(page, () => window.__pw.G.running)), 'a tap there after 350ms opens the road as usual');
    // The game-over overlay's Main menu gets the same guard.
    await G(page, () => { const W = window.__pw, g = W.G; g.lives = 1; W.spawn('grunt', g.map.path.len - 0.3); for (let i = 0; i < 30 && !g.over; i++) W.step(1 / 30); });
    await page.waitForTimeout(1000); // the end screen follows a 900ms beat
    check(!(await hidden(page, '#endOv')), 'run lost');
    await doubleTap(page, '#bEndAlt');
    await page.waitForTimeout(100);
    check(!(await hidden(page, '#menu')) && (await G(page, () => !window.__pw.G.running)), 'game over > Main menu tapped twice: the menu stays up');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // phone-basics: reduced motion, toast at the bottom, dialogs and focus, keys, back gesture, remembered speed, toggles, labels.
  const rect = (page, sel) => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
  const active = page => G(page, () => { const a = document.activeElement; return { id: a.id, tag: a.tagName, inMenu: !!a.closest('#menu'), inPause: !!a.closest('#pauseOv'), inEnd: !!a.closest('#endOv'), ring: a.matches(':focus-visible') }; });
  // What the frame loop itself drew on a tile (no render call): wait two frames, then hash that tile.
  const frameHash = (page, c, r) => G(page, ([c, r]) => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => { const W = window.__pw, cv = document.querySelector('#cv'), T = cv.width / W.COLS; const d = cv.getContext('2d').getImageData(Math.round(c * T), Math.round(r * T), Math.round(T), Math.round(T)).data; let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } res(h >>> 0); }))), [c, r]);
  const tileHash = (page, c, r, t) => G(page, ([c, r, t]) => { const W = window.__pw; W.render(t === null ? undefined : t); const cv = document.querySelector('#cv'); const T = cv.width / W.COLS; const d = cv.getContext('2d').getImageData(Math.round(c * T), Math.round(r * T), Math.round(T), Math.round(T)).data; let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } return h >>> 0; }, [c, r, t]);

  current = 'phone-basics: toast, dialogs, focus and keys';
  {
    const { ctx, page } = await newPage(browser);
    check(await page.$eval('#toast', el => el.getAttribute('role') === 'status' && el.getAttribute('aria-live') === 'polite'), '#toast has role=status and aria-live=polite');
    const dlg = await page.evaluate(() => ['#menu', '#pauseOv', '#endOv'].map(s => { const o = document.querySelector(s), l = document.getElementById(o.getAttribute('aria-labelledby') || '-'); return o.getAttribute('role') === 'dialog' && o.getAttribute('aria-modal') === 'true' && !!l && o.contains(l) && l.textContent.trim().length > 0; }));
    check(dlg.every(Boolean), 'menu, pause and end overlays are labelled modal dialogs ' + JSON.stringify(dlg));
    check(await page.$eval('#menuTitle', el => el.textContent === 'Pathwarden') && await page.$eval('#pauseTitle', el => el.textContent === 'Paused'), 'dialog titles menuTitle and pauseTitle');
    let a = await active(page);
    check(a.inMenu && !a.ring, 'on load focus is in the menu with no focus ring ' + JSON.stringify(a));
    await page.keyboard.press('Tab');
    a = await active(page);
    check(a.inMenu && (await G(page, () => document.querySelector('#app').inert === true)), 'Tab on load: activeElement inside #menu and #app.inert ' + JSON.stringify(a));
    check(a.ring, 'keyboard focus shows a focus ring');
    await page.keyboard.press('Escape');
    check(!(await hidden(page, '#menu')) && !(await G(page, () => window.__pw.G.paused)), 'Escape on the menu does nothing');

    await startMap(page, 2); // Quarry Run
    check((await G(page, () => document.querySelector('#app').inert)) === false, 'starting a road clears #app.inert');
    await sendWave(page);
    await page.waitForTimeout(250);
    const ts = await rect(page, '#toast'), cv = await rect(page, '#cv');
    // Wave 1 now gets a banner on the board instead of a toast, so the wave-1 guard's warning is the toast still up here.
    check((await G(page, () => window.__pw.G.wave === 1 && window.__pw.G.banner && window.__pw.G.banner.s === 'WAVE 1')) && (await text(page, '#toast')) === 'No towers yet. Enemies will walk straight in.' && (await page.$eval('#toast', el => el.classList.contains('show'))), 'wave 1 started with its banner; the guard toast is showing');
    check(ts.top > cv.top + cv.height / 2 && ts.bottom <= cv.bottom, `toast sits in the bottom half of the board (toast ${Math.round(ts.top)}-${Math.round(ts.bottom)}, board ${Math.round(cv.top)}-${Math.round(cv.bottom)})`);
    check(Math.abs(ts.bottom - (cv.bottom - 10)) <= 1 && ts.left >= cv.left && ts.right <= cv.right, 'toast is 10px above the board bottom and inside it horizontally');
    check(await page.$eval('#toast', (el, w) => parseFloat(el.style.maxWidth) === w - 24 && getComputedStyle(el).textOverflow === 'ellipsis', cv.width), 'toast max-width is board width - 24 with ellipsis');

    await page.keyboard.press('Escape');
    a = await active(page);
    check((await G(page, () => window.__pw.G.paused)) && !(await hidden(page, '#pauseOv')), 'Escape pauses and shows #pauseOv');
    check(a.inPause && (await G(page, () => document.querySelector('#app').inert === true)), 'focus moves into #pauseOv and the game is inert ' + JSON.stringify(a));
    await page.keyboard.press('Escape');
    a = await active(page);
    check(!(await G(page, () => window.__pw.G.paused)) && (await hidden(page, '#pauseOv')), 'Escape again unpauses');
    check(a.id === 'bPause', 'closing pause focuses #bPause (' + a.id + ')');
    await page.keyboard.press('p');
    check((await G(page, () => window.__pw.G.paused)) && !(await hidden(page, '#pauseOv')), 'P pauses');
    await page.keyboard.press('P');
    check(!(await G(page, () => window.__pw.G.paused)), 'P again unpauses');
    await page.click('#bPause');
    check((await active(page)).id === 'bResume' && !(await active(page)).ring, 'tapping Pause focuses Resume without a ring');
    await page.click('#bResume');
    check((await active(page)).id === 'bPause', 'Resume returns focus to #bPause');

    // Keys 1-5 pick towers from the palette.
    await G(page, () => { document.activeElement.blur(); window.__pw.G.running = false; window.__pw.G.gold = 500; });
    await page.waitForTimeout(100); // let the HUD pick up the gold change before the hint is written
    await page.keyboard.press('2');
    check((await G(page, () => window.__pw.G.pending)) === 'mortar' && (await text(page, '#info')).startsWith('Mortar ready') && (await text(page, '#info')).includes('Tap grass'), 'key 2 with no tile arms Mortar (' + (await text(page, '#info')) + ')');
    await tapTile(page, 2, 2);
    await page.keyboard.press('3');
    check((await G(page, () => window.__pw.G.pending)) === 'frost', 'key 3 arms Frost');
    await page.keyboard.press('3');
    check((await G(page, () => window.__pw.G.towers.map(t => t.type).join())) === 'frost', 'key 3 again builds Frost');

    // Back while the end overlay is up does nothing; the end overlay takes focus.
    await G(page, () => { const W = window.__pw, g = W.G; g.running = true; g.lives = 1; W.spawn('grunt', g.map.path.len - 0.3); for (let i = 0; i < 30 && !g.over; i++) W.step(1 / 30); });
    await page.waitForTimeout(1000); // the end screen follows a 900ms beat
    a = await active(page);
    check((await G(page, () => window.__pw.G.over)) && a.id === 'bEndMain' && a.inEnd, 'game over moves focus to Try again ' + JSON.stringify(a));
    await page.keyboard.press('Escape');
    check(await hidden(page, '#pauseOv'), 'Escape does not pause behind the end overlay');
    await G(page, () => window.dispatchEvent(new PopStateEvent('popstate', { state: null })));
    check(await hidden(page, '#pauseOv') && !(await hidden(page, '#endOv')), 'popstate after game over does nothing');
    await page.click('#bEndMain');
    check((await G(page, () => history.state && history.state.pw)) === 'game' && !(await G(page, () => document.querySelector('#app').inert)), 'Try again keeps the run entry and clears inert');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'phone-basics: back gesture pauses instead of leaving';
  {
    const { ctx, page } = await newPage(browser);
    const len0 = await G(page, () => history.length);
    await startMap(page, 1);
    check((await G(page, () => history.state && history.state.pw)) === 'game', "starting a road pushes history.state.pw==='game'");
    const len1 = await G(page, () => history.length);
    const url = page.url();
    await page.goBack(); await page.waitForTimeout(80);
    check(!(await hidden(page, '#pauseOv')) && (await G(page, () => window.__pw.G.paused)), 'back pauses and shows #pauseOv');
    check(page.url() === url && (await G(page, () => !window.__pw.G.over)), 'URL unchanged and the run goes on (G.over false)');
    check((await G(page, () => history.state && history.state.pw)) === 'game', 'the run entry is pushed again after back');
    await page.goBack(); await page.waitForTimeout(80);
    check(!(await G(page, () => window.__pw.G.paused)) && (await hidden(page, '#pauseOv')), 'back again unpauses');
    check(page.url() === url && (await G(page, () => history.length)) === len1, 'still on the page with no extra history entries');
    await page.click('#bPause'); await page.click('#bMenu'); await page.waitForTimeout(80);
    check(!(await hidden(page, '#menu')) && (await G(page, () => history.state === null)), 'Main menu pops the run entry');
    await G(page, () => window.dispatchEvent(new PopStateEvent('popstate', { state: null })));
    check(!(await hidden(page, '#menu')) && (await hidden(page, '#pauseOv')), 'popstate on the menu does nothing');
    await startMap(page, 1);
    check((await G(page, () => history.state && history.state.pw)) === 'game' && (await G(page, () => history.length)) === len1, 'a second run reuses the entry instead of growing history');
    check(len1 === len0 + 1, `one entry per run (${len0} -> ${len1})`);
    // Reload mid-run: the stale run entry is popped on the menu, and Continue pushes it again.
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await page.reload(); await page.waitForTimeout(250);
    check(!(await hidden(page, '#menu')) && (await G(page, () => history.state === null)), 'after a reload the menu pops the stale run entry');
    await page.click('#bContinue'); await page.waitForTimeout(50);
    check((await G(page, () => history.state && history.state.pw)) === 'game' && (await G(page, () => history.length)) === len1, 'Continue pushes the run entry');
    await page.goBack(); await page.waitForTimeout(80);
    check(!(await hidden(page, '#pauseOv')) && page.url() === url, 'back pauses a continued run');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'phone-basics: remembered speed, labels and toggles';
  {
    const { ctx, page } = await newPage(browser, { init: () => { Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value: function (p) { (window.__vib = window.__vib || []).push(p); return true; } }); } });
    const mute = await rect(page, '#bMute');
    check(mute.height >= 40 && (await page.$eval('#bMute', el => el.textContent.trim())) === 'Sound: on', `#bMute is ${mute.height}px tall and reads "Sound: on"`);
    check(await page.$eval('#bMute', el => el.classList.contains('pill') && !!el.querySelector('svg[aria-hidden="true"]')), 'sound toggle is a pill with a hidden speaker icon');
    check(!(await hidden(page, '#bVibe')) && (await text(page, '#bVibe')) === 'Vibration: on' && (await rect(page, '#bVibe')).height >= 40, 'Vibration pill shown when the phone can vibrate');
    await page.click('#bMute');
    check((await text(page, '#bMute')) === 'Sound: off' && (await text(page, '#bMute2')) === 'Sound: off' && (await stored(page)).muted === true, 'sound toggles off, both pills agree, saved');
    await page.click('#bMute');
    await page.click('#bVibe');
    check((await text(page, '#bVibe')) === 'Vibration: off' && (await text(page, '#bVibe2')) === 'Vibration: off' && (await stored(page)).vibe === false, 'vibration toggles off and is saved as S.vibe=false');
    await page.click('#bVibe');
    check((await stored(page)).vibe === true, 'vibration back on');

    await startMap(page, 1);
    check(await page.$eval('#cv', el => el.getAttribute('role') === 'img'), '#cv has role=img');
    check(await page.$eval('#sLives', el => el.getAttribute('role') === 'img' && el.getAttribute('aria-label') === '20 lives') && await page.$eval('#sGold', el => el.getAttribute('role') === 'img' && el.getAttribute('aria-label') === '200 gold'), 'lives and gold have role=img with "20 lives" / "200 gold"');
    await G(page, () => { window.__pw.G.gold = 345; window.__pw.G.lives = 7; });
    await page.waitForTimeout(80);
    check((await page.$eval('#sGold', el => el.getAttribute('aria-label'))) === '345 gold' && (await page.$eval('#sLives', el => el.getAttribute('aria-label'))) === '7 lives', 'HUD labels follow lives and gold');
    check((await page.$eval('#bSpeed', el => el.getAttribute('aria-label'))).includes('1×'), '#bSpeed aria-label contains 1×');
    await page.click('#bSpeed');
    check((await page.$eval('#bSpeed', el => el.getAttribute('aria-label'))) === 'Game speed 2×', '#bSpeed aria-label after one click is "Game speed 2×"');
    await page.click('#bSpeed');
    check((await text(page, '#bSpeed')) === '3×' && (await stored(page)).speed === 3, 'speed 3× is saved as S.speed');

    // Leaks vibrate only while vibration is on.
    const leakOnce = () => G(page, () => { const W = window.__pw, g = W.G; g.running = false; g.lives = 20; W.spawn('grunt', g.map.path.len - 0.3); for (let i = 0; i < 30; i++) W.step(1 / 30); g.running = true; return (window.__vib || []).length; });
    check((await leakOnce()) === 1, 'a leak vibrates');
    await page.click('#bPause'); await page.click('#bVibe2'); await page.click('#bResume');
    check((await leakOnce()) === 1 && (await G(page, () => window.__pw.S.vibe)) === false, 'no vibration after turning it off in the pause menu');

    await page.reload(); await page.waitForTimeout(250);
    check((await text(page, '#bVibe')) === 'Vibration: off', 'vibration setting survives a reload');
    await startMap(page, 0);
    check((await text(page, '#bSpeed')) === '3×' && (await G(page, () => window.__pw.G.speed)) === 3 && (await page.$eval('#bSpeed', el => el.getAttribute('aria-label'))) === 'Game speed 3×', 'after reload a new road starts at the remembered 3×');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'phone-basics: no vibration pill without vibrate, pills at 320px';
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 568 }, init: () => { delete Navigator.prototype.vibrate; } });
    check((await hidden(page, '#bVibe')) && (await hidden(page, '#bVibe2')), 'Vibration pills hidden where vibrate is missing');
    await ctx.close();
    const r = await newPage(browser, { viewport: { width: 320, height: 568 } });
    const footFit = sel => r.page.$eval(sel, f => { const card = f.closest('.card').getBoundingClientRect(), pills = [...f.querySelectorAll('.pill')].map(p => p.getBoundingClientRect()), note = f.lastElementChild.getBoundingClientRect(); return { n: pills.length, inside: pills.every(p => p.left >= card.left + 19 && p.right <= card.right - 19), above: pills.every(p => p.bottom <= note.top), noScroll: f.scrollWidth <= f.clientWidth }; });
    let fit = await footFit('#menu .foot');
    check(fit.n === 2 && fit.inside && fit.above && fit.noScroll, 'menu at 320px: pills wrap inside the card, above "Saves after every wave" ' + JSON.stringify(fit));
    await startMap(r.page, 1); await r.page.click('#bPause');
    fit = await footFit('#pauseOv .foot');
    check(fit.n === 2 && fit.inside && fit.above && fit.noScroll, 'pause at 320px: pills wrap inside the card ' + JSON.stringify(fit));
    check((await r.page.evaluate(() => document.documentElement.scrollWidth)) <= 320, 'no horizontal scroll at 320px');
    check(r.page.errors.length === 0, 'no console errors: ' + r.page.errors.join('|'));
    await r.ctx.close();
  }

  current = 'phone-basics: reduced motion';
  {
    const { ctx, page } = await newPage(browser);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(await G(page, () => window.__pw.rm()), 'rm() reads prefers-reduced-motion');
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('frost', 2, 2); });
    const h1 = await tileHash(page, 2, 2, null);
    await page.waitForTimeout(1000);
    const h2 = await tileHash(page, 2, 2, null);
    check(h1 === h2, `reduced motion: two renders 1s apart give the same frost tile (${h1} / ${h2})`);
    check((await tileHash(page, 2, 2, 5)) === (await tileHash(page, 2, 2, 6.3)), 'reduced motion ignores the render clock');
    const zap = t => G(page, t => { const W = window.__pw, g = W.G; g.fx = [{ k: 'zap', pts: [{ x: 2.5, y: 4.3 }, { x: 5.5, y: 5.5 }], t, dur: 1e9, seed: 7 }]; return true; }, t);
    await zap(0); const z1 = await tileHash(page, 3, 4, 1);
    await zap(0.5); const z2 = await tileHash(page, 3, 4, 1);
    check(z1 === z2, 'reduced motion: lightning is one static bolt');
    const parts = await G(page, () => { const W = window.__pw, g = W.G; g.fx = []; g.wave = 1; W.spawn('grunt', 3); W.hurtAll(1e9); return g.fx.filter(f => f.k === 'p').length; });
    check(parts === 3, 'reduced motion: a kill bursts half the particles, 3 of 6 (' + parts + ')');
    check((await page.$eval('#toast', el => getComputedStyle(el).transitionDuration)).split(',').every(d => parseFloat(d) === 0), 'reduced motion: toast does not slide');
    // The same through real frames, with no render hook involved: frame() must not spin the frost either.
    const fr1 = await frameHash(page, 2, 2);
    await page.waitForTimeout(1000);
    const fr2 = await frameHash(page, 2, 2);
    check(fr1 === fr2, `reduced motion: real frames 1s apart draw the same frost tile (${fr1} / ${fr2})`);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check(!(await G(page, () => window.__pw.rm())), 'rm() follows the setting live');
    check((await tileHash(page, 2, 2, 5)) !== (await tileHash(page, 2, 2, 6.3)), 'full motion: the frost crystal turns');
    const fr3 = await frameHash(page, 2, 2);
    await page.waitForTimeout(1000);
    check(fr3 !== (await frameHash(page, 2, 2)), 'full motion: real frames 1s apart show the frost turning');
    await zap(0); const z3 = await tileHash(page, 3, 4, 1);
    await zap(0.5); const z4 = await tileHash(page, 3, 4, 1);
    check(z3 !== z4, 'full motion: lightning re-jitters');
    const parts2 = await G(page, () => { const W = window.__pw, g = W.G; g.fx = []; W.spawn('grunt', 3); W.hurtAll(1e9); return g.fx.filter(f => f.k === 'p').length; });
    check(parts2 === 6, 'full motion: a kill bursts 6 particles (enemy-readability: 8 -> 6) (' + parts2 + ')');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'phone-basics: Space and Enter start the wave';
  {
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { map: 'meadow', wave: 3, gold: 150, lives: 20, towers: [] } }, last: 'meadow' })));
    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue'); await page.waitForTimeout(50);
    check((await G(page, () => window.__pw.G.wave === 3 && window.__pw.G.towers.length === 0)) && (await active(page)).tag === 'BODY', 'wave 3 save with no towers resumed, nothing focused');
    await page.keyboard.press('Space');
    check((await G(page, () => window.__pw.G.wave)) === 4, 'Space with no overlay starts the wave (G.wave 3 -> ' + (await G(page, () => window.__pw.G.wave)) + ')');
    await page.keyboard.press('Space');
    check((await G(page, () => window.__pw.G.wave)) === 4, 'Space does nothing while the wave button is disabled');
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; while (g.spawnQ.length) W.step(1 / 30); W.refreshPanel(); });
    await page.keyboard.press('Enter');
    check((await G(page, () => window.__pw.G.wave)) === 5, 'Enter calls the next wave early');
    await page.focus('#bSpeed');
    const sp = await G(page, () => window.__pw.G.speed);
    await page.keyboard.press('Space');
    check((await G(page, () => window.__pw.G.speed)) !== sp && (await G(page, () => window.__pw.G.wave)) === 5, 'Space on a focused button clicks that button only');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'phone-basics: while enemies are out the toast covers no road';
  for (const vp of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 390, height: 780 }]) {
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    const msgs = ['Called early · +40 gold', 'Called early · +123 gold', 'Wave 27 cleared · +69 gold', 'Wave 100 cleared · +215 gold', 'Need 180 more gold', 'New record · wave 30'];
    const res = await G(page, msgs => {
      const W = window.__pw, el = document.querySelector('#toast'), out = [];
      for (let mi = 0; mi < 3; mi++) {
        W.newGame(mi); W.G.wave = 5; W.spawn('grunt', 3);
        const cv = document.querySelector('#cv').getBoundingClientRect(), T = cv.width / W.COLS, map = W.G.map;
        for (const m of msgs) {
          W.toast(m); el.style.transition = 'none'; void el.offsetWidth;
          const r = el.getBoundingClientRect(), road = [];
          el.style.transition = '';
          for (let rr = 0; rr < W.ROWS; rr++) for (let c = 0; c < W.COLS; c++) {
            if (map.grid[rr * W.COLS + c] !== 1) continue;
            const x0 = cv.left + c * T, y0 = cv.top + rr * T;
            if (r.right > x0 + 0.5 && r.left < x0 + T - 0.5 && r.bottom > y0 + 0.5 && r.top < y0 + T - 0.5) road.push(c + ',' + rr);
          }
          const inside = r.left >= cv.left && r.right <= cv.right && r.bottom <= cv.bottom;
          if (road.length || !inside || el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(`${map.id} "${m}" ${Math.round(r.width)}x${Math.round(r.height)} road ${road.join(' ')} inside ${inside} text ${el.scrollWidth}x${el.scrollHeight}/${el.clientWidth}x${el.clientHeight}`);
        }
      }
      // With the board calm the toast is the full-width pill again, centred on the board.
      W.G.enemies = []; W.toast('Changed your mind? Full refund until the next wave.');
      const cv = document.querySelector('#cv').getBoundingClientRect();
      return { bad: out, calm: el.style.maxWidth === (cv.width - 24) + 'px' && el.style.left === '' && !el.classList.contains('safe') };
    }, msgs);
    check(res.bad.length === 0, `${vp.width}x${vp.height}: with enemies out, every toast stays off the road on all three roads, inside the board, text uncut ` + JSON.stringify(res.bad.slice(0, 4)));
    check(res.calm, `${vp.width}x${vp.height}: a toast with no enemies out is the full-width centred pill`);
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    // In play: grunts on Meadow's last stretch, then 'Call N early'. None of them is under the toast.
    const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; W.startWave(); while (g.spawnQ.length) W.step(1 / 30); for (const e of g.enemies) e.dist = g.map.path.len - 0.6 - 0.45 * g.enemies.indexOf(e) % 3.5; W.step(1 / 60); W.refreshPanel(); });
    await page.click('#bWave');
    await page.waitForTimeout(300);
    const hid = await G(page, () => { const W = window.__pw, el = document.querySelector('#toast'), r = el.getBoundingClientRect(), cv = document.querySelector('#cv').getBoundingClientRect(), T = cv.width / W.COLS;
      return { toast: el.textContent, show: el.classList.contains('show'), n: W.G.enemies.length, under: W.G.enemies.filter(e => { const x = cv.left + e.x * T, y = cv.top + e.y * T; return x > r.left && x < r.right && y > r.top && y < r.bottom; }).length }; });
    check(hid.show && hid.toast.startsWith('Called early') && hid.n > 3 && hid.under === 0, "320px: 'Called early' with grunts walking to the keep hides none of them " + JSON.stringify(hid));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // sound-pass: master bus with limiter, pitch jitter, kill combo, named cues.
  // audioSpy (an init script) records every AudioParam.setValueAtTime as {v, t, type} (type is the owning oscillator's, '' for gains),
  // counts compressors and oscillators, lists what connects to the speakers, keeps every filter in __filt,
  // and lets a test pin the audio clock with window.__at so throttle and combo timing are deterministic.
  const audioSpy = () => {
    window.__rec = []; window.__comp = 0; window.__osc = 0; window.__dest = []; window.__filt = [];
    const own = new WeakMap();
    const co = BaseAudioContext.prototype.createOscillator;
    BaseAudioContext.prototype.createOscillator = function () { const o = co.call(this); own.set(o.frequency, o); window.__osc++; return o; };
    const cb = BaseAudioContext.prototype.createBiquadFilter;
    BaseAudioContext.prototype.createBiquadFilter = function () { const f = cb.call(this); window.__filt.push(f); return f; };
    const sv = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (v, t) { const o = own.get(this); window.__rec.push({ v, t, type: o ? o.type : '' }); return sv.call(this, v, t); };
    const cd = AudioContext.prototype.createDynamicsCompressor;
    AudioContext.prototype.createDynamicsCompressor = function () { window.__comp++; return cd.call(this); };
    const cn = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (d, ...r) { if (d instanceof AudioDestinationNode) window.__dest.push(this.constructor.name); return cn.call(this, d, ...r); };
    const ct = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime');
    Object.defineProperty(BaseAudioContext.prototype, 'currentTime', { configurable: true, get() { return window.__at != null ? window.__at : ct.get.call(this); } });
  };
  const recs = (page, type) => G(page, type => window.__rec.filter(r => type == null || r.type === type), type);
  const vals = (page, type) => recs(page, type).then(rs => rs.map(r => r.v));
  const near = (list, f) => list.some(v => Math.abs(v - f) < 0.5);
  // clearRec(page, at) also pins the audio clock at `at`, so each phase of a test starts clear of the per-cue throttle.
  const clearRec = (page, at) => G(page, at => { window.__rec = []; window.__filt = []; if (at != null) window.__at = at; }, at);
  // Play one cue at a pinned clock time and return what it scheduled, with times relative to the cue.
  const cue = (page, name, at) => G(page, ([name, at]) => { window.__rec = []; window.__filt = []; window.__at = at; window.__pw.sfx(name); return { rec: window.__rec.map(r => ({ v: r.v, dt: +(r.t - at).toFixed(3), type: r.type })), filt: window.__filt.map(f => ({ type: f.type, f: f.frequency.value })) }; }, [name, at]);
  const startsAt = (c, type, f, dt) => c.rec.some(r => r.type === type && Math.abs(r.v - f) < 0.5 && Math.abs(r.dt - dt) < 0.002);

  current = 'sound-pass: master bus and limiter';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    check((await G(page, () => window.__comp)) === 0 && (await G(page, () => window.__pw.AU.ctx)) === null, 'no audio context before the first tap');
    await startMap(page, 1);
    check((await G(page, () => window.__comp)) === 1, 'tapping a road card creates exactly one compressor (' + (await G(page, () => window.__comp)) + ')');
    const bus = await G(page, () => { const A = window.__pw.AU, k = A.comp; return { gain: A.master.gain.value, th: k.threshold.value, knee: k.knee.value, ratio: k.ratio.value, atk: k.attack.value, rel: k.release.value }; });
    const close = (a, b) => Math.abs(a - b) < 1e-5;
    check(close(bus.gain, 0.8) && close(bus.th, -14) && close(bus.knee, 6) && close(bus.ratio, 4) && close(bus.atk, 0.003) && close(bus.rel, 0.15), 'master gain 0.8 into a compressor at -14dB, knee 6, ratio 4, attack 0.003, release 0.15 ' + JSON.stringify(bus));
    // Every tower type fires and things die and leak through one wave; only the compressor may reach the speakers.
    await G(page, () => { const W = window.__pw; W.G.gold = 2000; [['bolt', 2, 2], ['mortar', 4, 2], ['frost', 2, 5], ['arc', 4, 5], ['long', 3, 9]].forEach(([k, c, r]) => W.build(k, c, r)); });
    await page.click('#bWave');
    // The audio clock follows the game clock here, so the 0.06s throttle lets a realistic number of voices through.
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; let t = 0; while ((g.spawnQ.length || g.enemies.length) && !g.over && t < 400) { W.step(1 / 30); t += 1 / 30; window.__at = 1 + t; } g.running = true; });
    await page.click('#bPause'); await page.click('#bMenu'); await startMap(page, 0); await sendWave(page);
    const wiring = await G(page, () => ({ osc: window.__osc, dest: window.__dest, comp: window.__comp }));
    check(wiring.osc > 20, `a wave made plenty of voices (${wiring.osc})`);
    check(wiring.dest.length === 1 && wiring.dest[0] === 'DynamicsCompressorNode', 'only the compressor connects to the speakers; every voice goes through the master bus ' + JSON.stringify(wiring.dest.slice(0, 5)));
    check(wiring.comp === 1, 'more taps, a second road and a new wave make no second compressor (' + wiring.comp + ')');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'sound-pass: upgrade, leak, game over and victory cues';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    await clearRec(page, 10);
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    let v = await vals(page, 'sine');
    check((await G(page, () => window.__pw.G.towers.length)) === 1 && near(v, 520), 'building a bolt plays the build cue (520Hz)');
    check(!near(await vals(page), 1175), 'building a bolt records no 1175Hz value');
    await tapTile(page, 2, 2);
    await clearRec(page, 20);
    await page.click('#bUp');
    v = await vals(page);
    check((await G(page, () => window.__pw.G.towers[0].level)) === 2 && near(v, 1175), 'upgrading via #bUp records 1175 (up2)');
    check(near(v, 523) && near(v, 784) && !near(v, 1568) && !near(v, 520), 'level 2 plays up2 (523, 784, 1175), not up3 and not the build cue ' + JSON.stringify(v.map(Math.round)));
    await clearRec(page, 30);
    await page.click('#bUp');
    v = await vals(page);
    check((await G(page, () => window.__pw.G.towers[0].level)) === 3 && near(v, 1568) && near(v, 1175), 'upgrading to level 3 records 1568 (up3)');

    // A leak that leaves lives still plays the leak tone; the leak that ends the run plays only the lose cue.
    await clearRec(page, 40);
    const lives = await G(page, () => { const W = window.__pw, g = W.G; g.lives = 5; W.spawn('grunt', g.map.path.len - 0.3); for (let i = 0; i < 30; i++) W.step(1 / 30); return g.lives; });
    check(lives === 4 && near(await vals(page, 'sawtooth'), 180), 'a leak that leaves lives plays the 180Hz leak tone');
    await clearRec(page, 50);
    const over = await G(page, () => { const W = window.__pw, g = W.G; g.lives = 1; W.spawn('grunt', g.map.path.len - 0.3); for (let i = 0; i < 30 && !g.over; i++) W.step(1 / 30); return g.over; });
    await page.waitForTimeout(1000); // the end screen follows a 900ms beat
    const endShown = !(await hidden(page, '#endOv'));
    v = await vals(page);
    const tri = await vals(page, 'triangle');
    check(over && endShown && near(tri, 262) && near(tri, 311) && near(tri, 392), 'game over records 262 (lose cue: 392, 311, 262) when the end overlay shows');
    check(!near(v, 180), 'no 180Hz leak tone at the moment of the end overlay ' + JSON.stringify(v.map(Math.round)));

    // Victory plays 'win' in place of 'clear'; an ordinary clear plays 'clear'.
    await page.click('#bEndMain');
    await G(page, () => { const g = window.__pw.G; g.wave = 29; g.cleared = 29; });
    await clearRec(page, 60);
    await G(page, () => { const W = window.__pw; W.startWave(); let t = 0; while ((W.G.spawnQ.length || W.G.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } });
    await page.waitForTimeout(80);
    let sine = await vals(page, 'sine');
    check(!(await hidden(page, '#endOv')) && (await text(page, '#endTitle')) === 'The road holds', 'victory screen after wave 30');
    // Wave 30's Warlords die here too; bossdown's own 523Hz note starts 0.25s in, so count only the notes that start with the cue (clock pinned at 60).
    const s523 = (await recs(page, 'sine')).filter(r => Math.abs(r.v - 523) < 0.5 && Math.abs(r.t - 60) < 0.002).length;
    check(near(sine, 1047) && s523 === 1, 'victory plays the win cue (523-1047) once, with no clear cue on top ' + JSON.stringify(sine.map(Math.round)));
    await page.click('#bEndMain');
    await clearRec(page, 70);
    const r31 = await killWaves(page, 1);
    sine = await vals(page, 'sine');
    // Nothing leaked in wave 31, so it is a flawless clear (wave-banners-warlord): 'flawless' plays clear's notes and then 1047.
    check(r31.wave === 31 && near(sine, 523) && near(sine, 659) && near(sine, 784) && near(sine, 1047), 'an ordinary wave cleared with no leaks plays flawless (523, 659, 784, 1047) ' + JSON.stringify(sine.map(Math.round)));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'sound-pass: pitch jitter, kill combo and throttle';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    // Single-enemy boards: one grunt, killed by hurtAll. The wave stays open (rem 99) so no clear cue plays.
    const killAt = (at, rnd) => G(page, ([at, rnd]) => { const W = window.__pw, g = W.G; window.__at = at; Math.random = () => rnd; W.spawn('grunt', 3); W.hurtAll(1e9); return { combo: W.AU.combo, n: g.enemies.length }; }, [at, rnd]);
    const dieStarts = async () => (await recs(page, 'triangle')).filter(r => r.v >= 380 && r.v <= 760).map(r => r.v);
    await G(page, () => { const g = window.__pw.G; g.running = false; g.enemies = []; g.towers = []; g.projs = []; g.wave = 1; g.W = { 1: { rem: 99, alive: 0 } }; window.__mr = Math.random; });
    await clearRec(page);
    for (let i = 0; i < 4; i++) await killAt(10 + i * 0.1, 0.5);
    let d = await dieStarts();
    check(d.length === 4 && d.every((x, i) => i === 0 || x > d[i - 1]), 'four kills 100ms apart: die start frequencies strictly increase ' + JSON.stringify(d.map(x => +x.toFixed(1))));
    check(Math.abs(d[0] - 420) < 0.5 && Math.abs(d[3] - 420 * Math.pow(1.0595, 3)) < 0.5 && (await G(page, () => window.__pw.AU.combo)) === 3, 'each kill in the combo is one semitone (x1.0595) up from 420Hz');
    await clearRec(page);
    await killAt(10.3 + 0.4, 0.5);
    d = await dieStarts();
    check(d.length === 1 && Math.abs(d[0] - 420) < 0.5 && (await G(page, () => window.__pw.AU.combo)) === 0, 'a kill 0.4s after the last resets the combo to 420Hz');
    await clearRec(page);
    for (let i = 1; i <= 12; i++) await killAt(10.7 + i * 0.1, 0.5);
    d = await dieStarts();
    check((await G(page, () => window.__pw.AU.combo)) === 8 && Math.abs(Math.max(...d) - 420 * Math.pow(1.0595, 8)) < 0.5, 'the combo stops climbing at 8 semitones (' + Math.round(Math.max(...d)) + 'Hz)');
    await clearRec(page);
    await killAt(30, 0.5); await killAt(30.03, 0.5); await killAt(30.07, 0.5);
    check((await dieStarts()).length === 2, 'die is throttled to one voice per 0.06s');
    // The combo keeps its first kill's jitter, so it climbs even when the next random draw is far lower.
    await clearRec(page);
    await killAt(35, 0.999); await killAt(35.1, 0); await killAt(35.2, 0); await killAt(35.3, 0.5);
    d = await dieStarts();
    check(d.length === 4 && d.every((x, i) => i === 0 || x > d[i - 1]) && Math.abs(d[0] - 420 * (0.94 + 0.999 * 0.12)) < 0.5 && Math.abs(d[3] - d[0] * Math.pow(1.0595, 3)) < 0.5, 'a combo starting at the top of the jitter (random 0.999, then 0) still climbs a semitone a kill ' + JSON.stringify(d.map(x => +x.toFixed(1))));

    // Jitter: j = 0.94 + random*0.12 on bolt, frost and die, and on the boom filter.
    let c = await cue(page, 'bolt', 40); const lo = c.rec.find(r => r.type === 'square' && r.dt === 0);
    await G(page, () => { Math.random = () => 0; });
    c = await cue(page, 'bolt', 41); const b0 = c.rec.find(r => r.type === 'square' && r.dt === 0).v;
    const f0 = (await cue(page, 'frost', 42)).rec.find(r => r.type === 'sine' && r.dt === 0).v;
    const boom0 = await cue(page, 'boom', 43);
    const die0 = (await killAt(44, 0)) && (await dieStarts()).pop();
    await G(page, () => { Math.random = () => 0.999; });
    const b1 = (await cue(page, 'bolt', 45)).rec.find(r => r.type === 'square' && r.dt === 0).v;
    const f1 = (await cue(page, 'frost', 46)).rec.find(r => r.type === 'sine' && r.dt === 0).v;
    const boom1 = await cue(page, 'boom', 47);
    await clearRec(page);
    const die1 = (await killAt(48, 0.999)) && (await dieStarts()).pop();
    check(lo && Math.abs(lo.v - 900) < 0.5 && Math.abs(b0 - 846) < 0.5 && Math.abs(b1 - 900 * (0.94 + 0.999 * 0.12)) < 0.5, `bolt pitch is jittered 0.94-1.06 (${Math.round(b0)} / ${Math.round(lo.v)} / ${Math.round(b1)}Hz)`);
    check(Math.abs(f0 - 1410) < 0.5 && Math.abs(f1 - 1500 * (0.94 + 0.999 * 0.12)) < 0.5, `frost pitch is jittered (${Math.round(f0)} / ${Math.round(f1)}Hz)`);
    check(Math.abs(die0 - 420 * 0.94) < 0.5 && Math.abs(die1 - 420 * (0.94 + 0.999 * 0.12)) < 0.5, `die pitch is jittered (${Math.round(die0)} / ${Math.round(die1)}Hz)`);
    check(boom0.filt.length === 1 && Math.abs(boom0.filt[0].f - 658) < 0.5 && Math.abs(boom1.filt[0].f - 700 * (0.94 + 0.999 * 0.12)) < 0.5, `boom filter is jittered around 700Hz (${Math.round(boom0.filt[0].f)} / ${Math.round(boom1.filt[0].f)}Hz)`);
    check(boom0.rec.some(r => r.type === '' && Math.abs(r.v - 0.10) < 1e-9) && !boom0.rec.some(r => Math.abs(r.v - 0.16) < 1e-9), 'boom is quieter: volume 0.10 (was 0.16)');

    // Throttle: 0.06s per cue, 0.12s for tink.
    const plays = async (name, ats, type, f) => { const p = []; for (const at of ats) { const k = await cue(page, name, at); p.push(k.rec.some(r => r.type === type && Math.abs(r.v - f) < 0.5 && r.dt === 0) ? 1 : 0); } return p.join(''); };
    const tk = await plays('tink', [60, 60.08, 60.13], 'square', 2600);
    check(tk === '101', 'tink is throttled to one per 0.12s: 60 plays, 60.08 dropped, 60.13 plays (' + tk + ')');
    const nk = await plays('no', [70, 70.03, 70.07], 'square', 160);
    check(nk === '101', 'other cues keep the 0.06s throttle: 70 plays, 70.03 dropped, 70.07 plays (' + nk + ')');
    check((await G(page, () => window.__pw.AU.gap.tink)) === 0.12, 'AU.gap = {tink: 0.12}');
    // Last, as the audio clock only moves forward: real jitter, no stub.
    const realCombos = await G(page, () => { const W = window.__pw; Math.random = window.__mr; let bad = 0, at = 200;
      for (let k = 0; k < 60; k++) { window.__rec = []; for (let i = 0; i < 4; i++) { window.__at = at; at += 0.1; W.spawn('grunt', 3); W.hurtAll(1e9); } at += 1;
        const d = window.__rec.filter(r => r.type === 'triangle' && r.v >= 380 && r.v <= 760).map(r => r.v); if (d.length !== 4 || !d.every((x, i) => i === 0 || x > d[i - 1])) bad++; }
      return bad; });
    check(realCombos === 0, 'with the real Math.random, 60 combos of 4 kills 100ms apart all climb (' + realCombos + ' did not)');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'sound-pass: named cues';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    let at = 100;
    const c = {};
    for (const n of ['up2', 'up3', 'clear', 'flawless', 'horn', 'bossdown', 'tink', 'lose', 'win']) { c[n] = await cue(page, n, at); at += 5; }
    check(startsAt(c.up2, 'sine', 523, 0) && startsAt(c.up2, 'sine', 784, 0.07) && near(c.up2.rec.map(r => r.v), 1175) && !near(c.up2.rec.map(r => r.v), 1568), 'up2: 523->784, then 784->1175 at +0.07');
    check(startsAt(c.up3, 'sine', 523, 0) && startsAt(c.up3, 'sine', 784, 0.07) && startsAt(c.up3, 'sine', 1175, 0.14) && near(c.up3.rec.map(r => r.v), 1568), 'up3: up2 plus 1175->1568 at +0.14');
    check(startsAt(c.clear, 'sine', 523, 0) && startsAt(c.clear, 'sine', 659, 0.07) && startsAt(c.clear, 'sine', 784, 0.14) && startsAt(c.clear, 'sine', 523 * 1.01, 0.09) && !near(c.clear.rec.map(r => r.v), 1047), 'clear: 523, 659, 784 at 0, 0.07, 0.14, each 0.09s gliding to f*1.01');
    check(startsAt(c.flawless, 'sine', 784, 0.14) && startsAt(c.flawless, 'sine', 1047, 0.21), 'flawless: clear plus 1047 at +0.21');
    check(startsAt(c.horn, 'sawtooth', 98, 0) && startsAt(c.horn, 'sawtooth', 147, 0) && c.horn.filt.length === 2 && c.horn.filt.every(f => f.type === 'lowpass' && f.f === 600), 'horn: two sawtooth voices (98, 147) through 600Hz lowpass filters ' + JSON.stringify(c.horn.filt));
    check(startsAt(c.bossdown, 'triangle', 392, 0) && startsAt(c.bossdown, 'sine', 523, 0.25) && startsAt(c.bossdown, 'sine', 659, 0.32) && startsAt(c.bossdown, 'sine', 784, 0.39) && c.bossdown.filt.some(f => f.f === 400), 'bossdown: triangle 392->98, 400Hz noise, then 523/659/784 at 0.25/0.32/0.39');
    check((await G(page, () => window.__pw.AU.noise.duration)) >= 0.5, "the noise buffer is long enough for bossdown's 0.5s noise (" + (await G(page, () => window.__pw.AU.noise.duration)) + 's)');
    check(startsAt(c.tink, 'square', 2600, 0) && startsAt(c.tink, 'square', 2000, 0.035), 'tink: square 2600->2000 over 0.035s');
    check(startsAt(c.lose, 'triangle', 392, 0) && startsAt(c.lose, 'triangle', 311, 0.25) && startsAt(c.lose, 'triangle', 262, 0.5), 'lose: triangle 392, 311, 262 at 0, 0.25, 0.5');
    check(startsAt(c.win, 'sine', 523, 0) && startsAt(c.win, 'sine', 659, 0.1) && startsAt(c.win, 'sine', 784, 0.2) && startsAt(c.win, 'sine', 1047, 0.3), 'win: sine 523, 659, 784, 1047 at 0, 0.1, 0.2, 0.3');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'sound-pass: muted through a full wave';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await page.click('#bMute');
    await startMap(page, 1);
    check((await G(page, () => window.__pw.AU.on)) === false && (await text(page, '#bMute')) === 'Sound: off', 'AU.on is false after muting');
    await G(page, () => { const W = window.__pw; W.G.gold = 2000; [['bolt', 2, 2], ['mortar', 4, 2], ['frost', 2, 5], ['arc', 4, 5], ['long', 3, 9]].forEach(([k, c, r]) => W.build(k, c, r)); });
    await page.click('#bWave');
    await page.waitForTimeout(300);
    const t = await runUntilCalm(page);
    await page.waitForTimeout(200);
    check(t > 5 && (await G(page, () => window.__pw.G.wave === 1 && !window.__pw.G.enemies.length && !window.__pw.G.spawnQ.length)), 'a full wave ran to the end while muted');
    check((await G(page, () => window.__osc)) === 0, 'muted: no voices are made (' + (await G(page, () => window.__osc)) + ')');
    check(page.errors.length === 0, 'no console errors with sound muted through a full wave: ' + page.errors.join('|'));
    await page.click('#bPause'); await page.click('#bMute2'); await page.click('#bResume');
    await G(page, () => window.__pw.sfx('build'));
    check((await G(page, () => window.__osc)) === 1, 'unmuting brings sound back');
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // build-flow-onboarding: the palette never dims, towers can be armed before a tile (with a double-tap guard),
  // a ready pulse and short-gold flash, first-run coaching with hint tiles, the wave-1 guard, and a full refund until the next wave.
  const cls = (page, sel, c) => page.$eval(sel, (el, c) => el.classList.contains(c), c);
  // Set gold, then give the frame loop time to run refreshPanel on the change.
  const setGold = async (page, v) => { await G(page, v => { window.__pw.G.gold = v; }, v); await page.waitForTimeout(100); };

  current = 'build-flow-onboarding: palette look and tower-first arming';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1); // Meadow Bend
    check(await page.$$eval('.tw', els => els.length === 5 && els.every(el => !el.classList.contains('dim') && getComputedStyle(el).opacity === '1')), 'no .tw has class dim, and the palette is fully opaque with nothing selected');
    await setGold(page, 60);
    const look = await page.evaluate(() => { const cs = (s, p) => getComputedStyle(document.querySelector(s), p); return { arc: cs('.tw[data-t=arc] canvas').filter, bolt: cs('.tw[data-t=bolt] canvas').filter, cost: cs('.tw[data-t=arc] .cost').color, dot: cs('.tw[data-t=arc] .cost', '::before').backgroundColor, boltCost: cs('.tw[data-t=bolt] .cost').color }; });
    check(look.arc.includes('grayscale') && look.bolt === 'none', 'gold 60: the Arc icon filter has grayscale and the Bolt icon filter is none ' + JSON.stringify(look));
    check(look.cost === 'rgb(255, 154, 133)' && look.dot === 'rgb(255, 154, 133)' && look.boltCost === 'rgb(227, 173, 69)', 'an unaffordable price and its dot are #ff9a85; an affordable one stays brass');
    await setGold(page, 200);

    await page.click('.tw[data-t="bolt"]');
    check((await G(page, () => window.__pw.G.pending)) === 'bolt' && (await cls(page, '.tw[data-t="bolt"]', 'armed')), "tap Bolt with nothing selected: G.pending === 'bolt' and it has .armed");
    const ready = await text(page, '#infoMsg');
    check(ready.startsWith('Bolt ready. Tap grass to place it.') && ready.endsWith('Dmg 11 · Range 2.4 · 1.8/s') && (await page.$eval('#infoMsg', el => el.innerHTML.includes('<b>Bolt</b> ready.') && el.innerHTML.includes('<br>'))), '#infoMsg: "<b>Bolt</b> ready. Tap grass to place it.<br>" and the Bolt stats (' + ready + ')');
    await G(page, () => new Promise(res => { let n = 0; const f = () => { if (n % 15 === 0) window.__pw.G.gold = 100 + n; if (++n < 120) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); }));
    await page.waitForTimeout(100);
    check((await text(page, '#info')).includes('ready') && (await G(page, () => window.__pw.G.gold)) === 205, 'gold set 8 times over 120 frames: #info still includes "ready" (' + (await text(page, '#info')) + ')');
    await setGold(page, 200);

    // Tower-first: a tile tap selects, a second tap on it builds, and the tower stays armed for the next one.
    await tapTile(page, 2, 5);
    check(JSON.stringify(await G(page, () => window.__pw.G.sel)) === '{"c":2,"r":5}' && (await G(page, () => window.__pw.G.towers.length)) === 0, 'a grass tap with Bolt armed selects the tile and builds nothing yet');
    const ghost = await tileHash(page, 3, 5, 0);
    await G(page, () => { window.__pw.G._p = window.__pw.G.pending; window.__pw.G.pending = null; });
    const noGhost = await tileHash(page, 3, 5, 0);
    await G(page, () => { window.__pw.G.pending = window.__pw.G._p; });
    check(ghost !== noGhost, 'the range ring of the armed tower shows around the selected tile');
    await page.waitForTimeout(300); await tapTile(page, 2, 5);
    check((await G(page, () => window.__pw.G.towers.length)) === 1 && (await G(page, () => window.__pw.G.pending)) === 'bolt', "tapTile(2,5), wait 300ms, tapTile(2,5): towers.length === 1 and G.pending === 'bolt'");
    check((await G(page, () => window.__pw.G.sel)) === null && (await cls(page, '.tw[data-t="bolt"]', 'armed')), 'after the build only the tile clears; Bolt stays armed');
    check((await text(page, '#infoMsg')) === 'Next wave:' && !(await hidden(page, '#chips')), 'a tower kept armed after a build leaves #info to the wave preview: "Next wave:" and the chips (' + (await text(page, '#infoMsg')) + ')');
    await tapTile(page, 4, 5); await page.waitForTimeout(300); await tapTile(page, 4, 5);
    check((await G(page, () => window.__pw.G.towers.length)) === 2, 'tapTile(4,5), wait 300ms, tapTile(4,5): towers.length === 2');

    // Double-tap guard: only for a tile picked while a tower was already armed.
    await tapTile(page, 5, 9); await page.waitForTimeout(60); await tapTile(page, 5, 9);
    check((await G(page, () => window.__pw.G.towers.length)) === 2, 'with Bolt armed, tapTile(5,9) twice 60ms apart builds nothing');
    await page.waitForTimeout(300); await tapTile(page, 5, 9);
    check((await G(page, () => window.__pw.G.towers.length)) === 3, 'a tap on the same tile after 250ms builds it');
    await setGold(page, 500);
    await tapTile(page, 1, 3);
    check((await G(page, () => window.__pw.G.pending === null && window.__pw.G.sel === null)), 'tapping road disarms');
    await tapTile(page, 2, 9); await page.click('.tw[data-t="frost"]'); await tapTile(page, 2, 9);
    check((await G(page, () => window.__pw.G.towers.map(t => t.type).join())) === 'bolt,bolt,bolt,frost', 'tile, tower, tile builds at once: no guard when the tower is picked after the tile');

    // Disarming.
    await page.click('.tw[data-t="frost"]');
    check((await G(page, () => window.__pw.G.pending)) === null && !(await cls(page, '.tw[data-t="frost"]', 'armed')), 'tap the armed button with no tile selected: G.pending === null');
    await page.click('.tw[data-t="bolt"]'); await tapTile(page, 2, 5);
    check((await G(page, () => window.__pw.G.pending === null && !!window.__pw.G.selTower && window.__pw.G.selTower.c === 2)), 'tapping a tower selects it and disarms');
    await tapTile(page, 2, 5);
    await page.click('.tw[data-t="bolt"]');
    await G(page, () => document.querySelector('#stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    check((await G(page, () => window.__pw.G.pending)) === null && !(await cls(page, '.tw[data-t="bolt"]', 'armed')), 'tapping beside the board disarms');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    // A kept arm never hides the wave preview: between waves, while a wave marches in, and once it is cleared.
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await page.click('.tw[data-t="bolt"]'); await tapTile(page, 6, 5); await page.waitForTimeout(300); await tapTile(page, 6, 5);
    check((await G(page, () => window.__pw.G.towers.length === 1 && window.__pw.G.pending === 'bolt')), 'built with Bolt kept armed');
    await page.click('#bWave');
    check((await text(page, '#infoMsg')) === 'Wave 1 is marching in. Next:' && !(await hidden(page, '#chips')) && (await cls(page, '.tw[data-t="bolt"]', 'armed')), 'during the wave #infoMsg says the wave is marching in over the next-wave chips, and the palette still shows Bolt armed (' + (await text(page, '#infoMsg')) + ')');
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } g.running = true; });
    await page.waitForTimeout(100);
    check((await text(page, '#infoMsg')) === 'Next wave:' && !(await hidden(page, '#chips')) && (await G(page, () => window.__pw.G.pending)) === 'bolt', 'after the wave the next-wave preview is back (' + (await text(page, '#infoMsg')) + ')');
    await tapTile(page, 2, 5);
    check((await text(page, '#info')).startsWith('Bolt · ') && (await text(page, '#info')).includes('Tap again to build.'), 'a grass tap with the kept arm shows the placing line');
    await page.waitForTimeout(300); await tapTile(page, 2, 5);
    check((await G(page, () => window.__pw.G.towers.length)) === 2, 'and a second tap builds the next Bolt');
    await page.click('.tw[data-t="frost"]');
    check((await text(page, '#info')).startsWith('Frost ready. Tap grass to place it.'), 'picking a tower on purpose shows its ready line (' + (await text(page, '#info')) + ')');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'build-flow-onboarding: the ready line fits narrow phones';
  for (const vp of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 780 }]) {
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    const res = await G(page, () => {
      const W = window.__pw, g = W.G, info = document.querySelector('#infoMsg'), bw = document.querySelector('#bWave'), out = [];
      g.running = false; g.gold = 500;
      const states = {
        'Start wave 1': () => { g.wave = 0; g.W = {}; g.spawnQ = []; g.sendArmAt = 0; },
        'Send anyway?': () => { g.wave = 0; g.W = {}; g.spawnQ = []; g.sendArmAt = performance.now(); },
        'Start wave 12': () => { g.wave = 11; g.W = {}; g.spawnQ = []; g.sendArmAt = 0; },
        'Call 12 early': () => { g.wave = 11; g.W = { 11: { rem: 0, alive: 1 } }; g.spawnQ = []; },
      };
      const trait = { bolt: 'Dmg 11', mortar: 'Ground only', frost: 'Slow 42%', arc: 'Chains 3', long: 'Dmg 78' };
      for (const [label, set] of Object.entries(states)) for (const k of Object.keys(W.TD)) {
        set(); g.sel = null; g.pending = null; document.querySelector(`.tw[data-t=${k}]`).click();
        const tx = info.textContent, head = `${W.TD[k].name} ready. Tap grass to place it.`;
        out.push({ label: bw.textContent, k, fits: info.scrollHeight <= info.clientHeight + 1, head: tx.startsWith(head), trait: tx.includes(trait[k]), stats: tx.slice(head.length) });
      }
      return out;
    });
    const bad = res.filter(r => !r.fits || !r.head || !r.trait);
    check(bad.length === 0 && res.length === 20, `${vp.width}px: for every tower beside every wave button label, the ready line fits #infoMsg's 3 lines and keeps the tower's name, the instruction and its trait ` + JSON.stringify(bad.slice(0, 3)));
    if (vp.width === 390) { const full = { bolt: 'Dmg 11 · Range 2.4 · 1.8/s', mortar: 'Dmg 30 · Range 2.4 · 0.7/s · Splash 0.9 · Ground only', frost: 'Dmg 5 · Range 2.0 · 1.0/s · Slow 42%', arc: 'Dmg 21 · Range 2.2 · 0.9/s · Chains 3', long: 'Dmg 78 · Range 4.6 · 0.5/s' };
      check(res.filter(r => r.label === 'Start wave 1').every(r => r.stats === full[r.k]), '390px beside Start wave 1: the ready line is the full stat line in spec order ' + JSON.stringify(res.filter(r => r.label === 'Start wave 1').map(r => r.stats))); }
    if (vp.width === 320) check(res.find(r => r.k === 'mortar' && r.label === 'Send anyway?').stats.startsWith('Ground only'), "320px: Mortar's line leads with 'Ground only' when the stats must be cut");
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'build-flow-onboarding: ready pulse and short gold';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    check(await page.$$eval('.tw', els => els.every(el => !el.classList.contains('ready'))), 'a new run starts with no pulse');
    await setGold(page, 120);
    check(!(await cls(page, '.tw[data-t="arc"]', 'ready')) && (await cls(page, '.tw[data-t="arc"]', 'poor')), 'gold 120: Arc (130) is poor and not ready');
    await setGold(page, 135);
    const pulse = await page.evaluate(() => { const b = document.querySelector('.tw[data-t=arc]'); return { ready: b.classList.contains('ready'), shadow: getComputedStyle(b).boxShadow, anim: getComputedStyle(b.querySelector('.cost')).animationName, all: [...document.querySelectorAll('.tw.ready')].map(x => x.dataset.t).join() }; });
    check(pulse.ready && pulse.shadow.includes('rgb(227, 173, 69)') && pulse.shadow.includes('0px 0px 0px 2px'), "G.gold=120, then 135: Arc gains 'ready' with a 2px brass ring " + JSON.stringify(pulse));
    check(pulse.anim === 'pop' && pulse.all === 'arc', 'its price pops, and only Arc pulses (the others were already affordable)');
    await page.waitForTimeout(700);
    check(!(await cls(page, '.tw[data-t="arc"]', 'ready')), "Arc loses 'ready' after 700ms");
    await setGold(page, 10);
    await G(page, () => window.__pw.newGame(1));
    await page.waitForTimeout(100);
    check(await page.$$eval('.tw', els => els.every(el => !el.classList.contains('ready') && !el.classList.contains('poor'))), 'newGame resets the memory without pulsing (10 gold, then a new run at 200)');

    // #bUp pulses when the selected tower's upgrade becomes affordable.
    await G(page, () => { window.__pw.G.running = true; window.__pw.build('bolt', 2, 2); });
    await tapTile(page, 2, 2);
    await setGold(page, 10);
    check((await cls(page, '#bUp', 'poor')) && (await page.$eval('#bUp small', el => getComputedStyle(el).color)) === 'rgb(255, 154, 133)', 'an unaffordable upgrade price is #ff9a85');
    await page.click('#bUp');
    const sh = await page.evaluate(() => { const g = document.querySelector('#sGold'), cs = getComputedStyle(g); return { short: g.classList.contains('short'), color: cs.color, anim: cs.animationName, n: cs.animationIterationCount }; });
    check((await text(page, '#toast')) === 'Need 30 more gold' && sh.short && sh.color === 'rgb(255, 138, 117)' && sh.anim === 'shake' && sh.n === '3', "a failed upgrade toasts 'Need 30 more gold' and #sGold gets 'short': #ff8a75, shaking 3 times " + JSON.stringify(sh));
    await page.waitForTimeout(300);
    check(!(await cls(page, '#sGold', 'short')), "'short' is gone after 240ms");
    await setGold(page, 100);
    check((await cls(page, '#bUp', 'ready')) && (await page.$eval('#bUp', el => getComputedStyle(el).boxShadow)).includes('rgb(227, 173, 69)') && (await page.$eval('#bUp small', el => getComputedStyle(el).animationName)) === 'pop', "#bUp gains 'ready' when its upgrade becomes affordable");
    await page.waitForTimeout(700);
    check(!(await cls(page, '#bUp', 'ready')), "#bUp loses 'ready' after 600ms");
    await tapTile(page, 2, 2); // close the tower panel
    await setGold(page, 10);
    await tapTile(page, 4, 2); await page.click('.tw[data-t="long"]'); await page.click('.tw[data-t="long"]');
    check((await G(page, () => window.__pw.G.towers.length)) === 1 && (await text(page, '#toast')) === 'Need 110 more gold' && (await cls(page, '#sGold', 'short')), "a failed build toasts 'Need 110 more gold' and flashes #sGold");

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.click('.tw[data-t="long"]');
    const rmS = await page.evaluate(() => { const g = document.querySelector('#sGold'), cs = getComputedStyle(g); return { short: g.classList.contains('short'), color: cs.color, anim: cs.animationName }; });
    check(rmS.short && rmS.color === 'rgb(255, 138, 117)' && rmS.anim === 'none', 'reduced motion: short gold is color only ' + JSON.stringify(rmS));
    await tapTile(page, 1, 3);
    await setGold(page, 10); await setGold(page, 135);
    const rmP = await page.evaluate(() => { const b = document.querySelector('.tw[data-t=arc]'); return { ready: b.classList.contains('ready'), shadow: getComputedStyle(b).boxShadow, anim: getComputedStyle(b.querySelector('.cost')).animationName }; });
    check(rmP.ready && rmP.shadow.includes('rgb(227, 173, 69)') && rmP.anim === 'none', 'reduced motion: the ready ring shows and the price does not scale ' + JSON.stringify(rmP));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'build-flow-onboarding: first-run coaching';
  {
    const { ctx, page } = await newPage(browser);
    check((await G(page, () => window.__pw.G.hintTiles.length)) === 0, 'the demo board behind the menu has no hint tiles');
    await startMap(page, 1);
    const coach = await page.evaluate(() => { const i = document.querySelector('#infoMsg'); return { text: i.textContent, html: i.innerHTML, color: getComputedStyle(i).color }; });
    check(coach.text === 'Build first: tap a grass tile beside the road.' && coach.html.startsWith('<b>Build first:</b>') && coach.color === 'rgb(240, 233, 210)', 'fresh storage: #infoMsg reads "Build first: tap a grass tile beside the road." in ink, not muted ' + JSON.stringify(coach));
    const hint = await G(page, () => {
      const W = window.__pw, g = W.G, m = g.map, pts = [];
      for (let i = 0; i <= Math.round(m.path.len * 10); i++) { const p = m.path.at(i / 10); if (p.x >= 0 && p.x < W.COLS && p.y >= 0 && p.y < W.ROWS) pts.push(p); }
      const all = [];
      for (let r = 0; r < W.ROWS; r++) for (let c = 0; c < W.COLS; c++) if (m.grid[r * W.COLS + c] === 0) all.push({ c, r, n: pts.filter(p => Math.hypot(p.x - c - 0.5, p.y - r - 0.5) <= 2.4 + 1e-9).length });
      all.sort((a, b) => b.n - a.n || a.r - b.r || a.c - b.c);
      return { tiles: g.hintTiles, grass: g.hintTiles.every(h => m.grid[h.r * W.COLS + h.c] === 0), want: all.slice(0, 2).map(({ c, r }) => ({ c, r })), others: [0, 2].map(i => JSON.stringify(W.hintTiles(i))) };
    });
    check(hint.tiles.length === 2 && hint.grass, 'G.hintTiles.length === 2 and both are grass tiles ' + JSON.stringify(hint.tiles));
    check(JSON.stringify(hint.tiles) === JSON.stringify(hint.want), 'they are the grass tiles with the most road within 2.4, ties to the lower row then col (' + JSON.stringify(hint.want) + ')');
    check(hint.others[0] === '[{"c":5,"r":2},{"c":5,"r":3}]' && hint.others[1] === '[{"c":2,"r":2},{"c":3,"r":2}]', 'Switchback and Quarry hints break ties by row then col ' + hint.others.join(' '));
    const h0 = hint.tiles[0];
    const a = await tileHash(page, h0.c, h0.r, 0), b = await tileHash(page, h0.c, h0.r, 0.3);
    await G(page, () => { const g = window.__pw.G; g._h = g.hintTiles; g.hintTiles = []; });
    const none = await tileHash(page, h0.c, h0.r, 0.3);
    await G(page, () => { const g = window.__pw.G; g.hintTiles = g._h; });
    check(a !== b && b !== none, 'the hint tile is drawn and breathes over time');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check((await tileHash(page, h0.c, h0.r, 0)) === (await tileHash(page, h0.c, h0.r, 0.3)), 'reduced motion: the hint holds still');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await page.click('.tw[data-t="bolt"]');
    check(!(await text(page, '#infoMsg')).includes('Build first') && !(await cls(page, '#infoMsg', 'coach')), 'arming a tower replaces the coaching line');
    await page.click('.tw[data-t="bolt"]');
    check((await text(page, '#info')).includes('Build first'), 'disarming brings it back');
    await tapTile(page, h0.c, h0.r);
    check((await text(page, '#infoMsg')) === 'Pick a tower to place here.', 'a selected tile replaces it too');
    await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    const after = await G(page, () => ({ hints: window.__pw.G.hintTiles.length, done: window.__pw.S.tutorialDone, tip: window.__pw.S.refundTip, towers: window.__pw.G.towers.length }));
    check(after.towers === 1 && after.hints === 0 && after.done === true, 'after the first build G.hintTiles is empty and S.tutorialDone === true ' + JSON.stringify(after));
    const ls = await stored(page);
    check(ls.tutorialDone === true && ls.refundTip === true, 'tutorialDone and refundTip are saved');
    check((await text(page, '#toast')) === 'Changed your mind? Full refund until the next wave.' && after.tip === true, 'the first build toasts "Changed your mind? Full refund until the next wave."');
    check(!(await text(page, '#infoMsg')).includes('Build first') && !(await cls(page, '#infoMsg', 'coach')), 'the coaching line is gone once a tower stands');
    await G(page, () => { document.querySelector('#toast').textContent = ''; });
    await tapTile(page, 2, 2); await page.waitForTimeout(300); await tapTile(page, 2, 2);
    check((await G(page, () => window.__pw.G.towers.length)) === 2 && (await text(page, '#toast')) === '', 'a second build shows no tip');
    await page.click('#bPause'); await page.click('#bMenu');
    await startMap(page, 2);
    check((await G(page, () => window.__pw.G.hintTiles.length)) === 0 && (await text(page, '#info')).includes('Build first'), 'after the first build a new road has no hint tiles, but still the Build first line');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ best: { switch: 3 } })));
    await page.reload(); await page.waitForTimeout(250);
    await startMap(page, 1);
    check((await G(page, () => window.__pw.G.hintTiles.length)) === 0, 'a player with a best wave gets no hint tiles');
    await ctx.close();
  }

  current = 'build-flow-onboarding: wave-1 guard';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    await clearRec(page, 10);
    await page.click('#bWave');
    const t1 = await page.evaluate(() => { const t = document.querySelector('#toast'); return { wave: window.__pw.G.wave, toast: t.textContent, bad: t.classList.contains('bad'), show: t.classList.contains('show'), label: document.querySelector('#bWave').textContent }; });
    check(t1.wave === 0 && t1.toast === 'No towers yet. Enemies will walk straight in.' && t1.bad && t1.show && t1.label === 'Send anyway?', "one #bWave tap at wave 0 with no towers: G.wave stays 0, the 'No towers' toast and the label 'Send anyway?' " + JSON.stringify(t1));
    check(near(await vals(page, 'square'), 160), "the guard plays the 'no' cue");
    await page.waitForTimeout(1500);
    await page.click('#bWave');
    check((await G(page, () => window.__pw.G.wave)) === 1, 'a second tap within 3s sets G.wave === 1');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 2);
    await page.click('#bWave');
    check((await text(page, '#bWave')) === 'Send anyway?', 'armed on Quarry');
    await page.waitForTimeout(3150);
    check((await text(page, '#bWave')) === 'Start wave 1' && !(await G(page, () => window.__pw.G.sendArmAt)), "after 3000ms the label is back to 'Start wave 1'");
    await page.click('#bWave');
    check((await G(page, () => window.__pw.G.wave)) === 0 && (await text(page, '#bWave')) === 'Send anyway?', 'a tap after the arm lapsed only warns again');
    await tapTile(page, 0, 0); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    check((await G(page, () => window.__pw.G.towers.length === 1 && !window.__pw.G.sendArmAt)) && (await text(page, '#bWave')) === 'Start wave 1', "building a tower clears the arm and the label reads 'Start wave 1'");
    await page.click('#bWave');
    check((await G(page, () => window.__pw.G.wave)) === 1, 'with a tower, one tap starts wave 1');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await doubleTap(page, '#bWave');
    check((await G(page, () => window.__pw.G.wave)) === 0 && (await text(page, '#bWave')) === 'Send anyway?', "a double tap (90ms) on 'Start wave 1' with no towers only warns: G.wave stays 0");
    await page.waitForTimeout(450);
    await page.click('#bWave');
    check((await G(page, () => window.__pw.G.wave)) === 1, 'a separate tap 450ms later sends wave 1');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    // A returning player (no first-build tip) builds right after the warning: the warning goes away with the arm.
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ refundTip: true, tutorialDone: true })));
    await page.reload(); await page.waitForTimeout(250);
    await startMap(page, 1);
    await page.click('#bWave');
    check((await text(page, '#toast')) === 'No towers yet. Enemies will walk straight in.' && (await cls(page, '#toast', 'show')), 'the warning toast is up');
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await page.waitForTimeout(300);
    check((await G(page, () => window.__pw.G.towers.length)) === 1 && !(await cls(page, '#toast', 'show')) && (await text(page, '#bWave')) === 'Start wave 1', "building a tower takes down the 'No towers yet' toast along with the arm");
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'build-flow-onboarding: full refund until the next wave';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const sellBtn = () => page.$eval('#bSell', el => ({ label: el.firstChild.textContent, small: el.querySelector('small').textContent, color: getComputedStyle(el.querySelector('small')).color }));
    const g0 = await G(page, () => window.__pw.G.gold);
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await tapTile(page, 2, 2);
    let sb = await sellBtn();
    check(sb.label === 'Undo' && sb.small === '+50' && sb.color === 'rgb(159, 211, 106)', "a bolt built at wave 0, selected: #bSell reads 'Undo' with '+50' in green " + JSON.stringify(sb));
    await page.click('#bSell');
    sb = await sellBtn();
    check(sb.label === 'Confirm' && sb.small === '+50' && (await G(page, () => window.__pw.G.towers.length)) === 1, "the first tap only arms it ('Confirm')");
    await page.click('#bSell');
    check((await G(page, () => window.__pw.G.towers.length)) === 0 && (await G(page, () => window.__pw.G.gold)) === g0, 'selling twice returns gold to its prior value (' + g0 + ')');

    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await G(page, () => { window.__pw.G.running = false; window.__pw.startWave(); });
    await tapTile(page, 2, 2);
    sb = await sellBtn();
    check(sb.label === 'Sell' && sb.small === '+35' && sb.color === 'rgb(243, 184, 171)', "after startWave the same tower shows 'Sell' '+35' " + JSON.stringify(sb));
    await tapTile(page, 2, 2);
    await tapTile(page, 4, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await tapTile(page, 4, 2);
    sb = await sellBtn();
    check(sb.label === 'Sell' && sb.small === '+35' && (await G(page, () => window.__pw.G.selTower.refund)) === 0, "a bolt built mid-wave shows 'Sell' '+35'");
    await page.click('#bUp');
    check((await sellBtn()).small === '+' + Math.floor(90 * 0.7), 'an upgrade mid-wave earns no refund: Math.floor(90*0.7) (' + (await sellBtn()).small + ')');

    const calm = await G(page, () => { const W = window.__pw, g = W.G; let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } return !g.spawnQ.length && !Object.keys(g.W).length; });
    check(calm, 'wave 1 cleared');
    await G(page, () => { window.__pw.G.running = true; });
    await setGold(page, 500);
    await tapTile(page, 2, 2);
    await page.click('#bUp');
    sb = await sellBtn();
    check(sb.label === 'Sell' && sb.small === '+75', "an upgrade between waves is refunded in full: 40 + 70% of 50 is '+75' " + JSON.stringify(sb));
    await tapTile(page, 2, 2);
    await tapTile(page, 4, 5); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await tapTile(page, 4, 5); await page.click('#bUp');
    sb = await sellBtn();
    check(sb.label === 'Undo' && sb.small === '+90', "built and upgraded between waves: 'Undo' '+90' " + JSON.stringify(sb));
    check((await G(page, () => { const W = window.__pw; W.build('bolt', 6, 1); return W.G.towers.find(t => t.c === 6 && t.r === 1).refund; })) === 0, '__pw.build towers have refund 0');

    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue');
    const loaded = await G(page, () => window.__pw.G.towers.map(t => t.refund));
    check(loaded.length >= 3 && loaded.every(r => r === 0), 'towers loaded from a save have refund 0 ' + JSON.stringify(loaded));
    await tapTile(page, 4, 5);
    sb = await sellBtn();
    check(sb.label === 'Sell' && sb.small === '+' + Math.floor(90 * 0.7), 'after a reload the same tower sells at 70% (Sell) ' + JSON.stringify(sb));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // leak-feedback: the keep draws over leaking enemies, which fade out; a red vignette, '-N' over the keep,
  // a hurt flash and low-lives heartbeat on the HUD heart, a red keep flag at 5 lives or fewer, and a 900ms beat before the loss screen.
  // px(page, x, y, t): render (t null = clock) and read one canvas pixel. A leak is driven by __pw.step, so frames never interleave.
  const px = (page, x, y, t = 0) => G(page, ([x, y, t]) => { const W = window.__pw; W.render(t === null ? undefined : t); return [...document.querySelector('#cv').getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3); }, [x, y, t]);
  const near3 = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

  current = 'leak-feedback: a leak shows -N over the keep, flashes the heart and tints the board edges';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const edgeY = await G(page, () => document.querySelector('#cv').height / 2);
    const calm = await px(page, 2, edgeY);
    // A single 1/30s step moves a grunt 0.033 tiles, so from path.len-0.25 it crosses the leak line (path.len-0.2) on the second step.
    const a = await G(page, () => {
      const W = window.__pw; W.newGame(1); const g = W.G; g.running = true; g.enemies = [];
      W.spawn('grunt', g.map.path.len - 0.25);
      W.step(1 / 30); const l1 = g.lives;
      W.step(1 / 30);
      const kp = W.keep(), t = g.fx.find(f => f.k === 'text' && f.s === '-1'), el = document.querySelector('#sLives'), cs = getComputedStyle(el.querySelector('svg'));
      // Render in the same task as the leak, so no frame has faded the vignette yet.
      W.render(0); const cv = document.querySelector('#cv'), edge = [...cv.getContext('2d').getImageData(2, cv.height / 2, 1, 1).data].slice(0, 3);
      return { l1, lives: g.lives, t, kp, edge, hurt: el.classList.contains('hurt'), hurtT: g.hurtT, hurtDur: g.hurtDur, span: getComputedStyle(el.querySelector('span')).color, anim: cs.animationName, dur: cs.animationDuration, label: el.getAttribute('aria-label') };
    });
    check(a.l1 === 20 && a.lives === 19, `newGame(1); G.running=true; spawn('grunt', path.len-0.25); step(1/30) until it crosses the leak line: G.lives === 19 (${a.l1} -> ${a.lives})`);
    check(!!a.t, "G.fx has a text effect with s === '-1'");
    check(a.t && a.t.c === '#ff8a75' && a.t.sz === 1.25 && a.t.dur === 1 && a.t.t < 0.04 && a.t.x === a.kp.x && Math.abs(a.t.y - (a.kp.y - 0.5)) < 1e-9, "the text is #ff8a75, size 1.25, 1s long, at the keep and 0.5 tile above it " + JSON.stringify(a.t) + ' keep ' + JSON.stringify(a.kp));
    check(a.hurt && a.span === 'rgb(255, 138, 117)' && a.anim === 'lifehit' && a.label === '19 lives', "#sLives has class 'hurt': the count is #ff8a75 and the heart runs its scale keyframes " + JSON.stringify(a));
    check(a.hurtT === 0.45 && a.hurtDur === 0.45, 'a grunt leak sets G.hurtT = G.hurtDur = 0.45');
    const full = a.edge;
    check(full[0] > full[1] + 40, `after __pw.render() following a leak, the pixel at (2, cv.height/2) has red > green+40 (${full} / before the leak ${calm})`);
    check(calm[1] > calm[0], 'before the leak that pixel is grass green ' + JSON.stringify(calm));
    const kf = await G(page, () => { const k = [...document.styleSheets].flatMap(s => [...s.cssRules]).find(r => r.type === CSSRule.KEYFRAMES_RULE && r.name === 'lifehit'); return { peak: k ? [...k.cssRules].map(r => r.keyText + ' ' + r.style.transform).join() : '' }; });
    kf.dur = a.dur;
    check(kf.dur === '0.45s' && kf.peak.includes('scale(1.35)') && kf.peak.includes('scale(1)'), 'the hurt keyframes scale the heart 1 -> 1.35 -> 1 over 0.45s ' + JSON.stringify(kf));
    await page.waitForTimeout(600);
    check(!(await cls(page, '#sLives', 'hurt')), "'hurt' is gone after 450ms");
    // The vignette fades by real time in frame(), not by sim time: the run is at 3x here.
    const dec = await G(page, () => new Promise(res => {
      const W = window.__pw, g = W.G; g.speed = 3; g.enemies = []; W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30);
      const h0 = g.hurtT; let n = 0, t0 = 0, a0 = 0;
      const f = ts => { if (n === 0) { t0 = ts; a0 = g.hurtT; } if (++n < 12) requestAnimationFrame(f); else res({ h0, a0, a1: g.hurtT, el: (ts - t0) / 1000 }); };
      requestAnimationFrame(f);
    }));
    check(dec.h0 === 0.45 && dec.el > 0.1 && dec.a0 - dec.a1 > dec.el * 0.6 && dec.a0 - dec.a1 < dec.el * 1.1, `at 3x the vignette fades by real time: ${(dec.a0 - dec.a1).toFixed(3)}s gone in ${dec.el.toFixed(3)}s of frames`);
    await page.waitForTimeout(500);
    const after = await G(page, () => window.__pw.G.hurtT);
    check(after === 0 && near3(await px(page, 2, edgeY), calm, 2), 'once it has faded (hurtT 0) the edge is grass again');
    // Repeated leaks refresh the vignette and never stack.
    const st = await G(page, () => {
      const W = window.__pw, g = W.G, leak = (type, d) => { W.spawn(type, g.map.path.len - (d || 0.21)); W.step(1 / 30); };
      g.running = false; g.speed = 1; g.lives = 20; g.enemies = [];
      g.hurtT = 0.2; leak('grunt'); const r1 = g.hurtT;
      leak('grunt'); const r2 = g.hurtT;
      g.wave = 10; leak('boss', 0.205); const boss = { t: g.hurtT, d: g.hurtDur, txt: g.fx.some(f => f.k === 'text' && f.s === '-5' && f.sz === 1.25) };
      g.hurtT = 0.6; leak('grunt'); const r3 = { t: g.hurtT, d: g.hurtDur };
      W.render(0); const cv = document.querySelector('#cv'), edge = [...cv.getContext('2d').getImageData(2, cv.height / 2, 1, 1).data].slice(0, 3);
      return { r1, r2, boss, r3, edge, lives: g.lives };
    });
    check(st.r1 === 0.45 && st.r2 === 0.45, 'a leak while the vignette is fading refreshes it to 0.45, and a second leak does not stack it ' + JSON.stringify(st));
    check(st.boss.t === 0.8 && st.boss.d === 0.8 && st.boss.txt, "a Warlord leak sets hurtDur 0.8 and shows '-5' " + JSON.stringify(st.boss));
    check(st.r3.t === 0.6 && st.r3.d === 0.45, 'a grunt leak right after keeps the longer vignette (max, not a sum) ' + JSON.stringify(st.r3));
    check(near3(st.edge, full, 2), 'and its edges are no stronger than a single leak: a stays at 0.55 at most ' + JSON.stringify(st.edge));
    // The 'text' fx takes a colour (default #f3d27a) and a size (default 1) on the 0.34T font.
    const tx = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; g.hurtT = 0; g.gateFlash = 0; g.banner = null; // the Warlord leak above raised a banner, drawn over fx at this height
      const count = (fx, want) => { g.fx = [fx]; W.render(0); const d = c.getImageData(Math.round(3 * T), Math.round(4 * T), Math.round(3 * T), Math.round(2 * T)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - want[0]) < 30 && Math.abs(d[i + 1] - want[1]) < 30 && Math.abs(d[i + 2] - want[2]) < 30) n++; return n; };
      const one = count({ k: 'text', x: 4.5, y: 5.3, t: 0, dur: 1e9, s: '88', c: '#20ff20' }, [32, 255, 32]);
      const two = count({ k: 'text', x: 4.5, y: 5.3, t: 0, dur: 1e9, s: '88', c: '#20ff20', sz: 2 }, [32, 255, 32]);
      const def = count({ k: 'text', x: 4.5, y: 5.3, t: 0, dur: 1e9, s: '88' }, [243, 210, 122]);
      g.fx = []; return { one, two, def };
    });
    check(tx.one > 10 && tx.two > tx.one * 2.5 && tx.def > 10, "text fx: f.c sets the colour, f.sz scales the font, and the default is still #f3d27a " + JSON.stringify(tx));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'leak-feedback: the keep is drawn over leaking enemies, which fade out';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const k = await G(page, () => { const W = window.__pw, g = W.G, T = document.querySelector('#cv').width / W.COLS, kp = W.keep(); g.running = false; g.enemies = []; g.wave = 10; return { T, kp, door: [kp.x * T, (kp.y + 0.1) * T], flag: [(kp.x + 0.32) * T, (kp.y - 0.54) * T] }; });
    const door0 = await px(page, k.door[0], k.door[1]);
    check(near3(door0, [0x2b, 0x24, 0x1c], 3), "the keep's door centre is the door colour #2b241c " + JSON.stringify(door0));
    const cover = await G(page, () => { const W = window.__pw, g = W.G, kp = W.keep(); W.spawn('boss', g.map.path.len - 0.4); const e = g.enemies[0]; return { d: Math.hypot(e.x - kp.x, e.y - kp.y - 0.1), r: e.r * 0.85, dist: g.map.path.len - e.dist }; });
    check(cover.d < cover.r && Math.abs(cover.dist - 0.4) < 1e-9, 'a Warlord at path.len-0.4 has its body over the door centre ' + JSON.stringify(cover));
    const door1 = await px(page, k.door[0], k.door[1]);
    check(near3(door1, door0, 1) && !near3(door1, [0x6a, 0x3d, 0x8f], 40), 'drawn under the keep: the door centre still matches the keep colour, not the enemy colour ' + JSON.stringify(door1));
    // Fade: alpha = clamp((path.len-0.2-dist)/0.9, 0, 1), drawing only. Set dist without stepping, so the grunt stays where it was drawn.
    const fade = await G(page, () => {
      const W = window.__pw, g = W.G, c = document.querySelector('#cv').getContext('2d'), T = document.querySelector('#cv').width / W.COLS, L = g.map.path.len;
      g.enemies = []; g.wave = 1; W.spawn('grunt', 3); const e = g.enemies[0], x = Math.round(e.x * T), y = Math.round(e.y * T);
      const at = d => { e.dist = d; W.render(0); return [...c.getImageData(x, y, 1, 1).data].slice(0, 3); };
      const solid = at(L - 1.1), half = at(L - 0.65), gone = at(L - 0.2), early = at(3);
      g.enemies = []; W.render(0); const bg = [...c.getImageData(x, y, 1, 1).data].slice(0, 3);
      return { solid, half, gone, early, bg, leaked: g.lives };
    });
    const mid = fade.solid.map((v, i) => (v + fade.bg[i]) / 2);
    check(near3(fade.solid, [0xc9, 0x58, 0x3a], 3) && near3(fade.early, fade.solid, 1), 'a grunt is fully drawn up to 0.9 tile before the leak line ' + JSON.stringify(fade));
    check(near3(fade.half, mid, 4), 'halfway through the fade it is drawn at half alpha ' + JSON.stringify({ half: fade.half, mid }));
    check(near3(fade.gone, fade.bg, 1) && fade.leaked === 20, 'at the leak line it is not drawn at all, and setting dist alone leaks nothing');
    const wisp = await G(page, () => { const W = window.__pw, g = W.G, c = document.querySelector('#cv').getContext('2d'), T = document.querySelector('#cv').width / W.COLS; g.enemies = []; g.wave = 5; W.spawn('wisp', 3); const e = g.enemies[0], x = Math.round(e.x * T), y = Math.round((e.y - 0.25) * T);
      W.render(0); const on = [...c.getImageData(x, y, 1, 1).data].slice(0, 3); e.dist = g.map.path.len - 0.2; W.render(0); const off = [...c.getImageData(x, y, 1, 1).data].slice(0, 3); g.enemies = []; W.render(0); return { on, off, bg: [...c.getImageData(x, y, 1, 1).data].slice(0, 3) }; });
    check(!near3(wisp.on, wisp.bg, 10) && near3(wisp.off, wisp.bg, 1), 'fliers fade out the same way ' + JSON.stringify(wisp));
    // Leak distance is unchanged: path.len-0.2.
    const ld = await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.lives = 20; g.wave = 1; W.spawn('grunt', g.map.path.len - 0.25); const e = g.enemies[0]; e.spd = 0.045 * 30; W.step(1 / 30); const a = g.lives; e.spd = 0.006 * 30; W.step(1 / 30); return [a, g.lives]; });
    check(ld[0] === 20 && ld[1] === 19, 'the leak line is still path.len-0.2 (at -0.205 no leak, at -0.199 a leak) ' + JSON.stringify(ld));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'leak-feedback: low lives';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const flagAt = await G(page, () => { const W = window.__pw, T = document.querySelector('#cv').width / W.COLS, kp = W.keep(); W.G.running = false; W.G.gold = 100; return [(kp.x + 0.33) * T, (kp.y - 0.54) * T]; });
    const flag20 = await px(page, flagAt[0], flagAt[1]);
    check(!(await cls(page, '#sLives', 'low')) && near3(flag20, [0xe3, 0xad, 0x45], 12), 'at 20 lives: no low class and a brass keep flag ' + JSON.stringify(flag20));
    await G(page, () => { window.__pw.G.lives = 6; }); await page.waitForTimeout(100);
    check(!(await cls(page, '#sLives', 'low')), 'at 6 lives #sLives has no low class');
    await G(page, () => { window.__pw.G.lives = 5; }); await page.waitForTimeout(100);
    const low = await page.$eval('#sLives svg', el => { const cs = getComputedStyle(el); return { low: el.parentNode.classList.contains('low'), anim: cs.animationName, dur: cs.animationDuration, n: cs.animationIterationCount }; });
    check(low.low && low.anim === 'heartbeat' && low.dur === '1.1s' && low.n === 'infinite', "with lives<=5, #sLives has class 'low': a 1.1s heartbeat loop on the heart " + JSON.stringify(low));
    const flag5 = await px(page, flagAt[0], flagAt[1]);
    check(near3(flag5, [0xe3, 0x64, 0x4f], 12), 'and the keep flag is #e3644f instead of brass ' + JSON.stringify(flag5));
    await G(page, () => { const W = window.__pw, g = W.G; g.lives = 3; W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30); });
    const both = await page.$eval('#sLives svg', el => ({ low: el.parentNode.classList.contains('low'), hurt: el.parentNode.classList.contains('hurt'), anim: getComputedStyle(el).animationName }));
    check(both.low && both.hurt && both.anim === 'lifehit', 'a leak at low lives plays the hurt jump over the heartbeat ' + JSON.stringify(both));
    await page.waitForTimeout(600);
    check((await page.$eval('#sLives svg', el => getComputedStyle(el).animationName)) === 'heartbeat', 'then the heartbeat resumes');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rmLow = await page.$eval('#sLives svg', el => getComputedStyle(el).animationName);
    check(rmLow === 'none', 'reduced motion: no heartbeat (' + rmLow + ')');
    await G(page, () => { const W = window.__pw, g = W.G; W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30); });
    const rmHurt = await page.$eval('#sLives', el => ({ hurt: el.classList.contains('hurt'), anim: getComputedStyle(el.querySelector('svg')).animationName, span: getComputedStyle(el.querySelector('span')).color }));
    check(rmHurt.hurt && rmHurt.anim === 'none', "emulateMedia reducedMotion 'reduce': the computed animation-name on '#sLives svg' is 'none' during 'hurt' " + JSON.stringify(rmHurt));
    check(rmHurt.span === 'rgb(255, 138, 117)', 'reduced motion: only the colour changes (#ff8a75)');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await G(page, () => { window.__pw.newGame(1); });
    await page.waitForTimeout(100);
    check(!(await cls(page, '#sLives', 'low')), 'a new run at 20 lives clears low');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'leak-feedback: a beat before the loss screen';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    check(((await stored(page)).saves.meadow || {}).wave === 0, 'a run with a tower is saved');
    const o = await G(page, () => { const W = window.__pw, g = W.G; g.lives = 1; g.cleared = 3; g.enemies = []; W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30); window.__overAt = performance.now();
      return { over: g.over, running: g.running, hurtT: g.hurtT, lives: g.lives, save: W.S.saves.meadow, best: JSON.parse(localStorage.getItem('pathwarden.v1')).best.meadow, text: g.fx.some(f => f.k === 'text' && f.s === '-1') }; });
    check(o.over && !o.running && o.lives === 0, 'G.lives=1 then a leak: the run is over at once');
    check(o.save === undefined && o.best === 3, "gameOver still records the best wave and deletes the road's save right away " + JSON.stringify(o));
    check(o.hurtT === 0.9 && o.text, "gameOver sets G.hurtT to 0.9, and the '-1' still shows");
    await page.waitForTimeout(100);
    const hold = await G(page, () => ({ el: performance.now() - window.__overAt, hidden: document.querySelector('#endOv').hidden, inert: document.querySelector('#app').inert, hurtT: window.__pw.G.hurtT }));
    check(hold.hidden && hold.el < 900, `#endOv is still hidden after 100ms (${Math.round(hold.el)}ms)`);
    check(hold.hurtT > 0 && hold.hurtT < 0.9 && hold.inert, 'during the hold the vignette keeps fading after game over, and the run takes no input (#app is inert) ' + JSON.stringify(hold));
    await tapTile(page, 4, 2);
    await G(page, () => document.querySelector('#bPause').click());
    check((await G(page, () => window.__pw.G.sel)) === null && (await hidden(page, '#pauseOv')), 'board taps and Pause do nothing during the hold');
    const left = await G(page, () => 1000 - (performance.now() - window.__overAt));
    if (left > 0) await page.waitForTimeout(left);
    check(!(await hidden(page, '#endOv')) && (await text(page, '#endTitle')) === 'The keep has fallen', '#endOv is visible after 1000ms');
    const a = await active(page);
    check(a.id === 'bEndMain' && (await G(page, () => document.querySelector('#app').inert)), 'the loss screen takes focus and makes the game inert ' + JSON.stringify(a));
    // A run started during the hold never gets the old loss screen.
    await page.click('#bEndMain');
    await G(page, () => { const W = window.__pw, g = W.G; g.lives = 1; W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30); W.newGame(1); window.__pw.G.running = true; });
    await page.waitForTimeout(1000);
    check((await hidden(page, '#endOv')) && (await G(page, () => !window.__pw.G.over)), 'a new run started during the hold does not show the old loss screen');
    check((await G(page, () => document.querySelector('#app').inert)) === false, 'and that new run takes input again (#app is not inert)');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'leak-feedback: the lost run takes no input during the beat, and what was on the board plays out';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    await tapTile(page, 2, 2);
    check(!(await hidden(page, '#tview')), 'the bolt is selected and its panel is open');
    // Where the panel buttons and the first palette tile are, measured before the loss (the palette is hidden behind the panel).
    const spots = await G(page, () => Object.fromEntries(['#bUp', '#bSell', '#bMode', '#bSpeed', '#bWave'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, { x: r.left + r.width / 2, y: r.top + r.height / 2 }]; })));
    // The fatal leak lands while a WAVE banner is up and a CLEARED banner waits behind it.
    const o = await G(page, () => { const W = window.__pw, g = W.G; g.gold = 500; g.lives = 1; g.enemies = []; g.fx = []; g.gateFlash = 0;
      g.banner = { s: 'WAVE 4', sub: '', c: '#f0e9d2', t: 0.3, dur: 1.3 }; g.bannerNext = { s: 'CLEARED +23', sub: '', c: '#e3ad45', t: 0, dur: 1 };
      W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30); window.__overAt = performance.now();
      return { over: g.over, inert: document.querySelector('#app').inert, banner: g.banner && g.banner.s, cut: g.banner && g.banner.cut, next: g.bannerNext, text: g.fx.find(f => f.k === 'text' && f.s === '-1'), gate: g.gateFlash, speed: g.speed }; });
    check(o.over && o.inert, 'the fatal leak makes #app inert at once ' + JSON.stringify(o));
    check(o.banner === 'WAVE 4' && o.cut === 0.4 && o.next === null, 'the WAVE banner on the board starts a 0.4s fade-out and nothing waits behind it ' + JSON.stringify(o));
    await clearRec(page, 50);
    for (const s of ['#bUp', '#bSell', '#bSell', '#bMode', '#bSpeed']) { await page.mouse.click(spots[s].x, spots[s].y); await page.waitForTimeout(30); }
    await page.keyboard.press('1'); await page.keyboard.press('Space');
    // A script click still reaches a button in an inert tree, so the handlers check G.over themselves.
    await G(page, () => { for (const s of ['#bUp', '#bMode', '#bSell', '#bSell', '#bWave']) document.querySelector(s).click(); document.querySelector('.tw[data-t="frost"]').click(); });
    const h = await G(page, () => { const g = window.__pw.G, t = g.towers[0]; return { towers: g.towers.length, level: t && t.level, mode: t && t.mode, gold: g.gold, rings: g.fx.filter(f => f.k === 'ring').length, pending: g.pending, speed: g.speed, wave: g.wave, sel: !!g.selTower, banner: g.banner && { a: g.banner.cut, t: g.banner.t } }; });
    check(h.towers === 1 && h.level === 1 && h.mode === 'first' && h.gold === 500 && h.rings === 0, 'Upgrade, Sell and Target do nothing to the lost run during the beat (tapped, then clicked by script) ' + JSON.stringify(h));
    check(h.pending === null && h.speed === o.speed && h.wave === 0, 'neither do the palette (tap, key 1), Speed or the wave button (Space, script) ' + JSON.stringify(h));
    const cues = await G(page, () => window.__rec.length);
    check(cues === 0, 'and no cue plays over the game-over jingle (' + cues + ' tones)');
    await page.waitForTimeout(450);
    const mid = await G(page, () => { const g = window.__pw.G, f = g.fx.find(f => f.k === 'text' && f.s === '-1'); return { banner: g.banner, el: performance.now() - window.__overAt, gate: g.gateFlash, textT: f ? f.t : null, endHidden: document.querySelector('#endOv').hidden }; });
    check(mid.banner === null && mid.endHidden, `the banner is gone by ${Math.round(mid.el)}ms, before the end screen ` + JSON.stringify(mid));
    check(mid.textT > 0.3 && mid.gate < o.gate, "the '-1' over the keep and the keep flash keep playing out in real time instead of freezing " + JSON.stringify({ mid, gate0: o.gate }));
    const left = await G(page, () => 1050 - (performance.now() - window.__overAt));
    if (left > 0) await page.waitForTimeout(left);
    const end = await G(page, () => { const g = window.__pw.G; return { shown: !document.querySelector('#endOv').hidden, banner: g.banner, next: g.bannerNext, fx: g.fx.length }; });
    check(end.shown && end.banner === null && end.next === null, 'the end screen shows with no banner behind it ' + JSON.stringify(end));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // wave-banners-warlord: a banner on the board for wave start, clear (FLAWLESS) and the Warlord; the Warlord's entrance, a pinned
  // boss bar with a white damage trail, and a real boss death (rings, a big burst and '+gold', WARLORD DOWN, a board shake, bossdown).
  // toastLog(page): from now on, record every text #toast shows in window.__toasts. clearAll(page): run the board to calm with hurtAll.
  const toastLog = page => G(page, () => { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast').textContent; if (t) window.__toasts.push(t); }).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true }); });
  const toasts = page => G(page, () => window.__toasts);
  const clearAll = page => G(page, () => { const W = window.__pw, g = W.G; let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } return { calm: !g.spawnQ.length && !Object.keys(g.W).length, banner: g.banner && { s: g.banner.s, sub: g.banner.sub, c: g.banner.c, dur: g.banner.dur } }; });

  current = 'wave-banners-warlord: wave banners replace the wave toasts';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); });
    await toastLog(page);
    await page.click('#bWave');
    const b1 = await G(page, () => window.__pw.G.banner);
    check(b1 && b1.s === 'WAVE 1' && b1.sub === '' && b1.c === '#f0e9d2' && b1.dur === 1.3 && b1.t === 0, "after startWave(): G.banner is {s:'WAVE 1', sub:'', c:'#f0e9d2', dur:1.3} " + JSON.stringify(b1));
    await page.waitForTimeout(150);
    check(!(await toasts(page)).some(t => t.includes('Wave 1')) && !(await cls(page, '#toast', 'show')), 'no #toast text "Wave 1" appears ' + JSON.stringify(await toasts(page)));

    // Wave 1 to calm with no leaks: CLEARED with FLAWLESS, the flawless cue, and the gold counter pops as the bonus pays.
    await clearRec(page, 10);
    const c1 = await clearAll(page);
    const gain = await page.$eval('#sGold', el => ({ on: el.classList.contains('gain'), anim: getComputedStyle(el).animationName, shadow: getComputedStyle(el.querySelector('span')).textShadow }));
    check(c1.calm && c1.banner && c1.banner.s.includes('CLEARED') && c1.banner.sub === 'FLAWLESS', 'wave 1 run to calm with no leaks: the banner includes CLEARED and has sub FLAWLESS ' + JSON.stringify(c1));
    check(c1.banner.s === 'CLEARED +17' && c1.banner.c === '#e3ad45' && c1.banner.dur === 1, "it reads 'CLEARED +17' (the 15 + 2x1 bonus) in brass for 1.0s");
    let sine = await vals(page, 'sine');
    check(near(sine, 523) && near(sine, 1047), "a flawless clear plays 'flawless' (523 up to 1047Hz) instead of 'clear'");
    check(gain.on && gain.anim === 'pop' && gain.shadow.includes('227, 173, 69'), "#sGold gets class 'gain' as the clear pays out: the pop keyframes (scale 1.15) and a brass glow " + JSON.stringify(gain));
    await page.waitForTimeout(320);
    check(!(await cls(page, '#sGold', 'gain')), "'gain' is gone after 250ms");
    check(!(await toasts(page)).some(t => /cleared/i.test(t)), 'no "Wave N cleared" toast ' + JSON.stringify(await toasts(page)));

    // One forced leak: CLEARED with no sub, and the plain clear cue.
    await clearRec(page, 20);
    const lk = await G(page, () => { const W = window.__pw, g = W.G; W.startWave(); W.spawn('grunt', g.map.path.len - 0.25); W.step(1 / 30); W.step(1 / 30); return { lives: g.lives, leaked: g.W[2] && g.W[2].leaked }; });
    check(lk.lives === 19 && lk.leaked === 1, 'leak() counts the leak on its wave: G.W[2].leaked === 1 ' + JSON.stringify(lk));
    const c2 = await clearAll(page);
    check(c2.calm && c2.banner && c2.banner.s === 'CLEARED +19' && !c2.banner.sub, 'with one forced leak (spawn at path.len-0.25) the CLEARED banner has no sub ' + JSON.stringify(c2));
    sine = await vals(page, 'sine');
    check(near(sine, 784) && !near(sine, 1047), "a clear with a leak plays 'clear', not 'flawless'");

    // Overlapping waves: wave 3 clears while wave 4 (called early) is on its way, so no banner and only the clear cue.
    const ov = await G(page, () => { const W = window.__pw, g = W.G; W.startWave(); while (g.spawnQ.length) W.step(1 / 30); W.refreshPanel(); return { label: document.querySelector('#bWave').textContent, n: g.enemies.length, gold: g.gold }; });
    check(/^Call 4 early\s*\+42$/.test(ov.label) && ov.n > 0, 'wave 3 is all on the road ' + JSON.stringify(ov));
    await page.click('#bWave');
    const early = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, banner: window.__pw.G.banner.s, gain: document.querySelector('#sGold').classList.contains('gain'), gold: window.__pw.G.gold }));
    check(early.toast.includes('Called early') && early.toast === 'Called early · +42 gold', "the #bWave early-call toast still includes 'Called early' (targeting-early-call: 3x(10+4) = 42) (" + early.toast + ')');
    check(early.banner === 'WAVE 4' && early.gain && early.gold === ov.gold + 42, "an early call also shows the WAVE 4 banner, and #sGold pops as the bonus pays " + JSON.stringify(early));
    await clearRec(page, 30);
    const o3 = await G(page, () => { const W = window.__pw, g = W.G; for (const e of g.enemies) if (e.w === 3) e.hp = 0.1; W.hurtAll(0.5); return { w3: !!g.W[3], w4: !!g.W[4], banner: g.banner.s, next: g.bannerNext }; });
    check(!o3.w3 && o3.w4 && o3.banner === 'WAVE 4' && !o3.next, 'wave 3 cleared under wave 4: no CLEARED banner, the WAVE 4 banner stays ' + JSON.stringify(o3));
    sine = await vals(page, 'sine');
    check(near(sine, 784) && !near(sine, 1047), "and only the 'clear' cue plays, though nothing leaked");

    // A boss wave: purple, with its warning as the sub line.
    const b10 = await G(page, () => { const W = window.__pw, g = W.G; g.W = {}; g.spawnQ = []; g.enemies = []; g.wave = 9; W.startWave(); return g.banner; });
    check(b10.s === 'WAVE 10' && b10.c === '#a487ff' && b10.sub === 'A Warlord is coming', "startWave at a boss wave: {s:'WAVE 10', sub:'A Warlord is coming', c:'#a487ff'} " + JSON.stringify(b10));
    await page.waitForTimeout(100);
    check(!(await toasts(page)).some(t => t.startsWith('Wave ')), 'no "Wave N", "Wave N cleared" or "a Warlord approaches" toast in the whole run ' + JSON.stringify(await toasts(page)));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-banners-warlord: the Warlord arrives, and a pinned bar tracks it';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    await G(page, () => { const g = window.__pw.G; g.running = false; g.wave = 9; g.cleared = 9; });
    await clearRec(page, 40);
    const a = await G(page, () => {
      const W = window.__pw, g = W.G; W.startWave(); const t0 = g.time;
      const pre = window.__rec.some(r => r.type === 'sawtooth' && Math.abs(r.v - 98) < 0.5);
      let n = 0; while (!g.enemies.some(e => e.d.boss) && n++ < 1000) W.step(1 / 30);
      return { pre, after: g.time - t0, banner: g.banner, fx: g.fx.filter(f => f.k === 'bossin'), cave: W.cave() };
    });
    check(!a.pre, 'no 98Hz when wave 10 starts');
    check(Math.abs(a.after - 11.3) < 0.1, `the Warlord comes out ${a.after.toFixed(2)}s after wave 10 starts`);
    check(a.banner && a.banner.s === 'THE WARLORD' && a.banner.sub === 'Costs 5 lives if it gets through' && a.banner.c === '#a487ff' && a.banner.dur === 1.4, "as it spawns the banner is {s:'THE WARLORD', sub:'Costs 5 lives if it gets through', c:'#a487ff', dur:1.4} " + JSON.stringify(a.banner));
    check(a.fx.length === 1 && a.fx[0].x === a.cave.x && a.fx[0].y === a.cave.y && a.fx[0].dur === 0.6, "a 'bossin' fx at the cave, 0.6s long " + JSON.stringify(a.fx) + ' cave ' + JSON.stringify(a.cave));
    const saw = await vals(page, 'sawtooth');
    check(near(saw, 98) && near(saw, 147), 'an AudioParam setValueAtTime hook records 98Hz on boss spawn (the horn: 98 and 147Hz)');
    const rings = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), x = cv.getContext('2d'), T = cv.width / W.COLS, c = W.cave(), f = g.fx.find(f => f.k === 'bossin');
      const dark = () => { W.render(0); const d = x.getImageData(0, 0, Math.round(4 * T), Math.round(3 * T)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 110 && d[i + 1] < 80 && d[i + 2] > d[i + 1] + 15) n++; return n; }; // dark purple: grass, road and cave all have blue < green
      const on = dark(), t = f.t; f.t = 1; const off = dark(); f.t = t; return { on, off }; });
    check(rings.on > 30 && rings.off < rings.on / 4, 'the arrival draws dark #3e2356 rings around the cave ' + JSON.stringify(rings));

    // The pinned bar fades in over the first 0.3s after the Warlord leaves the cave.
    const fadeIn = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), DPR = cv.width / cv.getBoundingClientRect().width;
      const px = () => { W.render(0); return [...c.getImageData(Math.round(cv.width / 2), Math.round(9 * DPR), 1, 1).data].slice(0, 3); };
      const t0 = g.bossBar.t, p0 = px(); for (let i = 0; i < 10; i++) W.step(1 / 30); return { t0, p0, t1: g.bossBar.t, p1: px() }; });
    check(fadeIn.t0 < 0.05 && !(fadeIn.p0[2] > fadeIn.p0[1] + 40), 'as the Warlord leaves the cave the pinned bar is still faint ' + JSON.stringify(fadeIn));
    check(fadeIn.t1 >= 0.3 && fadeIn.p1[2] > fadeIn.p1[1] + 40, 'and 0.3s later it is fully in ' + JSON.stringify(fadeIn));

    // The acceptance pixel, then the bar's extent: x 6 to board-6, top 6px, Math.max(8, 0.2T) tall, or taller to hold its 0.28T labels.
    const pix = await G(page, () => { const W = window.__pw; W.newGame(1); const g = W.G; g.running = true; g.wave = 10;
      const cv = document.querySelector('#cv'), c = cv.getContext('2d'), DPR = cv.width / cv.getBoundingClientRect().width, T = cv.width / DPR / W.COLS, at = (x, y) => [...c.getImageData(Math.round(x * DPR), Math.round(y * DPR), 1, 1).data].slice(0, 3);
      W.render(); const before = at(cv.width / DPR / 2, 9);
      W.spawn('boss', 3); W.step(1 / 30); W.render();
      const after = at(cv.width / DPR / 2, 9), h = Math.max(8, 0.2 * T, Math.max(9, Math.round(0.28 * T)) + 4), Wd = cv.width / DPR;
      const r = { before, after, DPR, left: at(8, 9), right: at(Wd - 8, 9), outL: at(3, 9), top: at(Wd / 2, 4), bottom: at(Wd / 2, 6 + h - 2), below: at(Wd / 2, 6 + h + 1.5) };
      g.running = false; return r; });
    const purple = p => p[2] > p[1] + 40;
    check(purple(pix.after), `newGame(1); G.running=true; G.wave=10; spawn('boss',3); step(1/30); render(): canvas pixel (cv.width/2, 9*DPR) is purple-ish ${JSON.stringify(pix.after)}`);
    check(pix.before[1] > pix.before[2], 'with no Warlord that pixel is grass ' + JSON.stringify(pix.before));
    check(purple(pix.left) && purple(pix.right) && purple(pix.bottom) && !purple(pix.outL) && !purple(pix.top) && !purple(pix.below), 'the bar runs from x 6 to board-6, from y 6 down Math.max(8, 0.2T, label size + 4) ' + JSON.stringify(pix));
    // Its labels sit inside it: the band under the bar (where the cave and the first stretch of road are) is the same with the bar
    // as without it, and 'WARLORD' is drawn in cream inside the bar.
    const lab = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), DPR = cv.width / cv.getBoundingClientRect().width, T = cv.width / DPR / W.COLS;
      const fs = Math.max(9, Math.round(0.28 * T)), h = Math.max(8, 0.2 * T, fs + 4), b = g.enemies.find(e => e.d.boss); g.fx = []; g.banner = null;
      const strip = () => { W.render(0); return c.getImageData(0, Math.round((6 + h + 1) * DPR), cv.width, Math.round((fs + 6) * DPR)).data; };
      const on = strip(); b.dead = true; const off = strip(); b.dead = false;
      let diff = 0; for (let i = 0; i < on.length; i++) if (Math.abs(on[i] - off[i]) > 2) diff++;
      W.render(0); const d = c.getImageData(Math.round(6 * DPR), Math.round(6 * DPR), Math.round(2.5 * T * DPR), Math.round(h * DPR)).data; let cream = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 240) < 25 && Math.abs(d[i + 1] - 233) < 25 && Math.abs(d[i + 2] - 210) < 25) cream++;
      return { diff, cream, fs, h, T }; });
    check(lab.diff === 0 && lab.cream > 15, "the Warlord bar's labels are drawn inside it, and nothing under the bar changes " + JSON.stringify(lab));

    // The white trail lags the fill.
    const tr = await G(page, () => { const W = window.__pw, g = W.G, b = g.enemies.find(e => e.d.boss); const t0 = g.bossBar.trail; b.hp = b.max * 0.5; W.step(1 / 30); const t1 = g.bossBar.trail;
      const cv = document.querySelector('#cv'), c = cv.getContext('2d'), DPR = cv.width / cv.getBoundingClientRect().width, Wd = cv.width / DPR; W.render(0);
      const at = f => [...c.getImageData(Math.round((7 + (Wd - 14) * f) * DPR), Math.round(9 * DPR), 1, 1).data].slice(0, 3); const white = at(0.75), fill = at(0.25);
      for (let i = 0; i < 45; i++) W.step(1 / 30); return { t0, t1, t45: g.bossBar.trail, frac: g.bossBar.frac, white, fill }; });
    check(tr.t0 === 1 && tr.t1 > 0.5 && tr.t1 < 1, `set boss hp to 50%: after one step G.bossBar.trail is ${tr.t1.toFixed(3)} (> 0.5)`);
    check(Math.abs(tr.t45 - 0.5) < 0.02 && tr.frac === 0.5, `after 45 more steps |trail-0.5| < 0.02 (${tr.t45.toFixed(4)})`);
    check(tr.white.every(v => v > 200) && purple(tr.fill), 'the trail is drawn white beyond the purple fill ' + JSON.stringify(tr));

    // Two Warlords, kill one: the fallen one still counts until its wave ends, so the fill never jumps up.
    const two = await G(page, () => { const W = window.__pw; W.newGame(1); const g = W.G; g.wave = 20; W.spawn('boss', 3); W.spawn('boss', 2.5); W.step(1 / 30);
      const [a, b] = g.enemies; a.hp = 1; b.hp = b.max * 0.8; W.step(1 / 30);
      const f0 = g.bossBar.frac, n0 = W.bossInfo().n; W.hurtAll(2); W.step(1 / 30);
      const f1 = g.bossBar.frac, n1 = W.bossInfo().n, alive = g.enemies.filter(e => e.d.boss).length;
      W.hurtAll(1e9); W.step(1 / 30);
      return { f0, f1, n0, n1, alive, after: g.bossBar, w20: !!g.W[20] }; });
    check(two.alive === 1 && two.f1 <= two.f0, `two bosses, kill one: the bar fill fraction does not rise above its previous value (${two.f0.toFixed(3)} -> ${two.f1.toFixed(3)})`);
    check(two.f1 < 0.45 && two.n0 === 2 && two.n1 === 2, 'the fallen one still counts until its wave ends, and the label still says WARLORDS ×2 ' + JSON.stringify(two));
    check(two.after === null && !two.w20, 'once the last Warlord falls and the wave ends, the bar is gone');

    // A hurt Warlord draws no bar over its head; a hurt grunt still does.
    const own = await G(page, () => { const W = window.__pw; W.newGame(1); const g = W.G; g.wave = 10; const cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      const above = e => { W.render(0); const d = c.getImageData(Math.round((e.x - 0.6) * T), Math.round((e.y - 0.9) * T), Math.round(1.2 * T), Math.round(0.75 * T)).data; let h = 2166136261; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
      W.spawn('boss', 5); const b = g.enemies[0]; const full = above(b); b.hp = b.max * 0.5; const half = above(b);
      g.enemies = []; g.fx = []; g.wave = 1; W.spawn('grunt', 5); const gr = g.enemies[0]; const gf = above(gr); gr.hp = gr.max * 0.5; const gh = above(gr);
      return { boss: full === half, grunt: gf !== gh }; });
    check(own.boss && own.grunt, 'drawEnemy skips its own overhead bar for a hurt Warlord; a hurt grunt still has one ' + JSON.stringify(own));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-banners-warlord: a real Warlord death';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; g.wave = 10; W.spawn('boss', 3); W.step(1 / 30); g.fx = []; window.__mr = Math.random; });
    await clearRec(page, 70);
    const d = await G(page, () => { const W = window.__pw, g = W.G, e = g.enemies[0]; W.hurtAll(1e9);
      return { rings: g.fx.filter(f => f.k === 'ring'), texts: g.fx.filter(f => f.k === 'text'), parts: g.fx.filter(f => f.k === 'p'), banner: g.banner, next: g.bannerNext, shakeT: g.shakeT, gold: e.gold, color: e.d.color }; });
    check(d.rings.filter(r => r.r >= 2).length === 2, 'hurtAll(1e9) on a boss: G.fx has 2 ring entries with r>=2 ' + JSON.stringify(d.rings));
    check(d.rings.map(r => r.c).sort().join() === '#a487ff,#e3ad45' && d.rings.every(r => r.r === 2.2 && r.r0 === 0.3 && r.dur === 0.5), 'the rings are #e3ad45 and #a487ff, r 2.2, growing from 0.3 tiles over 0.5s');
    check(d.texts.some(t => t.sz >= 1.6 && t.s === '+' + d.gold), `and a '+${d.gold}' text with sz>=1.6 ` + JSON.stringify(d.texts));
    check(d.parts.length === 36 && d.parts.every(p => p.r >= 0.06 && p.r <= 0.14 && p.c === d.color), 'a burst of 36 particles of radius 0.06-0.14 tile (' + d.parts.length + ')');
    check(d.banner.s === 'WARLORD DOWN' && d.banner.c === '#e3ad45' && d.banner.dur === 1.2, "G.banner.s === 'WARLORD DOWN' " + JSON.stringify(d.banner));
    check(d.shakeT === 0.25, 'G.shakeT === 0.25');
    const tri = await vals(page, 'triangle'), filt = await G(page, () => window.__filt.map(f => f.frequency.value));
    check(near(tri, 392) && near(tri, 98) && filt.includes(400) && !filt.some(f => f > 600 && f < 800), "sfx('bossdown') plays instead of 'boom' (filters " + JSON.stringify(filt) + ')');
    check(d.next && d.next.s === 'CLEARED +35' && d.next.sub === 'FLAWLESS', 'the CLEARED banner raised by the same kill waits behind it ' + JSON.stringify(d.next));
    const seq = await G(page, () => { const W = window.__pw, g = W.G, out = []; for (let i = 0; i < 40; i++) { W.step(1 / 30); out.push(g.banner ? g.banner.s : '-'); } return out; });
    check(seq[33] === 'WARLORD DOWN' && seq[38] === 'CLEARED +35', 'WARLORD DOWN holds for 1.2s, then CLEARED +35 follows ' + JSON.stringify([seq[33], seq[38]]));

    // The shake: a random offset of up to 3px each frame while shakeT lasts, none under reduced motion. It decays in real time.
    // shaken(st): render one tile with Math.random pinned at 0, then at 0.999, with G.shakeT = st; true when the two frames differ.
    const shaken = async (st = 0.25) => { const one = rnd => G(page, ([st, rnd]) => { window.__pw.G.shakeT = st; Math.random = () => rnd; }, [st, rnd]);
      await one(0); const a = await tileHash(page, 4, 7, 0); await one(0.999); const b = await tileHash(page, 4, 7, 0); await G(page, () => { Math.random = window.__mr; }); return a !== b; };
    check(await shaken(), 'render shakes the board: two random draws give two different frames');
    check(!(await shaken(0)), 'with shakeT at 0 the board holds still');
    await G(page, () => { window.__pw.G.shakeT = 0.25; });
    await tapTile(page, 4, 5);
    check(JSON.stringify(await G(page, () => window.__pw.G.sel)) === '{"c":4,"r":5}', 'a tap during the shake picks the tile under the finger');
    await page.waitForTimeout(400);
    check((await G(page, () => window.__pw.G.shakeT)) === 0, 'shakeT runs out in real time (0.25s), with the run not stepping');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(!(await shaken()), 'reduced motion: no shake');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-banners-warlord: the winning moment leaves nothing to play after Keep going';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const w = await G(page, () => { const W = window.__pw, g = W.G; g.running = false; g.wave = 30; g.cleared = 29; g.W = {}; g.spawnQ = []; g.enemies = []; g.fx = [];
      W.spawn('boss', 3); W.step(1 / 30); g.banner = null; W.hurtAll(1e9);
      return { end: !document.querySelector('#endOv').hidden, title: document.querySelector('#endTitle').textContent, won: g.won, paused: g.paused, banner: g.banner, next: g.bannerNext, shakeT: g.shakeT }; });
    check(w.end && w.title === 'The road holds' && w.won && w.paused, 'killing the last Warlord of wave 30 wins the run ' + JSON.stringify(w));
    check(w.banner === null && w.next === null && w.shakeT === 0, 'no WARLORD DOWN or CLEARED banner waits behind the victory screen, and the board does not shake behind it ' + JSON.stringify(w));
    await page.waitForTimeout(200);
    await page.click('#bEndMain');
    const seen = () => G(page, () => new Promise(res => { const out = [], t0 = performance.now(); (function f() { const g = window.__pw.G; if (g.banner && !out.includes(g.banner.s)) out.push(g.banner.s); if (performance.now() - t0 < 500) requestAnimationFrame(f); else res({ out, paused: g.paused }); })(); }));
    const kg = await seen();
    check(!kg.paused && kg.out.length === 0, "after 'Keep going' no banner from the winning kill plays " + JSON.stringify(kg));
    // A leak that ends wave 30 wins it too: its CLEARED banner does not wait behind the victory screen either.
    const lk = await G(page, () => { const W = window.__pw; W.newGame(1); const g = W.G; g.running = false; g.wave = 30; g.cleared = 29; g.lives = 10;
      W.spawn('grunt', g.map.path.len - 0.21); W.step(1 / 30); return { end: !document.querySelector('#endOv').hidden, lives: g.lives, won: g.won, banner: g.banner, next: g.bannerNext }; });
    check(lk.end && lk.won && lk.lives === 9 && lk.banner === null && lk.next === null, 'a leak that ends wave 30: the victory screen, with no CLEARED banner behind it ' + JSON.stringify(lk));
    // In endless waves a Warlord kill still gets its banner.
    await page.click('#bEndMain');
    const en = await G(page, () => { const W = window.__pw, g = W.G; g.W = {}; g.enemies = []; g.wave = 40; W.spawn('boss', 3); W.step(1 / 30); W.hurtAll(1e9); return { banner: g.banner && g.banner.s, next: g.bannerNext && g.bannerNext.s, end: !document.querySelector('#endOv').hidden }; });
    check(!en.end && en.banner === 'WARLORD DOWN' && en.next === 'CLEARED +95', 'after the win, an endless Warlord kill still shows WARLORD DOWN, then CLEARED ' + JSON.stringify(en));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-banners-warlord: banners are read out to screen readers';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const sr = () => page.$eval('#sr', el => el.textContent);
    check(await page.$eval('#sr', el => { const r = el.getBoundingClientRect(); return el.getAttribute('role') === 'status' && el.getAttribute('aria-live') === 'polite' && r.width <= 1 && r.height <= 1 && !el.closest('[aria-hidden]'); }), '#sr is a polite status region, visually hidden');
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); });
    await page.click('#bWave');
    check((await sr()) === 'Wave 1', "starting wave 1 reads 'Wave 1' (" + (await sr()) + ')');
    await clearAll(page);
    check((await sr()) === 'Wave 1 cleared. +17 gold. Flawless', "a flawless clear reads 'Wave 1 cleared. +17 gold. Flawless' (" + (await sr()) + ')');
    await G(page, () => { const W = window.__pw, g = W.G; g.wave = 9; W.startWave(); });
    check((await sr()) === 'Wave 10. A Warlord is coming', "a boss wave reads 'Wave 10. A Warlord is coming' (" + (await sr()) + ')');
    await G(page, () => { const W = window.__pw, g = W.G; let n = 0; while (!g.enemies.some(e => e.d.boss) && n++ < 1000) W.step(1 / 30); });
    check((await sr()) === 'The Warlord. Costs 5 lives if it gets through', 'its arrival reads the banner and its warning (' + (await sr()) + ')');
    const k = await G(page, () => { const W = window.__pw, g = W.G; for (const e of g.enemies.filter(e => !e.d.boss)) W.hurt(e, 1e9, true); W.hurtAll(1e9);
      const down = document.querySelector('#sr').textContent; for (let i = 0; i < 40; i++) W.step(1 / 30); return { down, after: document.querySelector('#sr').textContent, q: g.spawnQ.length }; });
    check(k.down === 'Warlord down', "the kill reads 'Warlord down' " + JSON.stringify(k));
    check(/^Wave 10 cleared\. \+35 gold/.test(k.after), 'and the CLEARED banner waiting behind it is read when it shows ' + JSON.stringify(k));
    // The same line twice in a row still changes the region, so it is read again.
    const two = await G(page, () => { const W = window.__pw, g = W.G, el = document.querySelector('#sr'); g.wave = 20; W.spawn('boss', 1); const a = el.textContent; W.spawn('boss', 0.5); return [a, el.textContent]; });
    check(two[0] !== two[1] && two[0].trim() === two[1].trim(), 'a second Warlord changes the region text, so it is read again ' + JSON.stringify(two));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-banners-warlord: drawing the banner';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    // spot(b, c): render with banner b (or none) and find the pixels within 30 of colour c: how many, their centre in tiles, and their x extent.
    const spot = (b, c) => G(page, ([b, c]) => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), x = cv.getContext('2d'), T = cv.width / W.COLS;
      g.running = false; g.enemies = []; g.fx = []; g.hintTiles = []; g.banner = b; W.render(0);
      const d = x.getImageData(0, 0, cv.width, cv.height).data; let n = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - c[0]) < 30 && Math.abs(d[i + 1] - c[1]) < 30 && Math.abs(d[i + 2] - c[2]) < 30) { const p = i / 4, px = p % cv.width; n++; sx += px; sy += Math.floor(p / cv.width); minX = Math.min(minX, px); maxX = Math.max(maxX, px); }
      return { n, x: n ? sx / n / T : 0, y: n ? sy / n / T : 0, minX: minX / T, maxX: maxX / T }; }, [b, c]);
    const GRN = [32, 255, 32], INKY = [240, 233, 210], ban = (t, sub = '') => ({ s: 'WAVE 3', sub, c: '#20ff20', t, dur: 1.3 });
    const none = await spot(null, GRN), hold = await spot(ban(0.3), GRN), late = await spot(ban(0.85), GRN);
    check(none.n === 0 && hold.n > 200, 'a banner draws its main line in its colour c ' + JSON.stringify({ none: none.n, hold: hold.n }));
    const y0 = 14 * 0.38;
    check(Math.abs(hold.x - 4.5) < 0.15 && Math.abs(hold.y - (y0 - 0.3 * 0.3 / 1.3)) < 0.25, `centred on the board at 38% of its height (centre ${hold.x.toFixed(2)}, ${hold.y.toFixed(2)} tiles)`);
    check(Math.abs(late.n - hold.n) < hold.n * 0.15 && hold.y - late.y > 0.08 && hold.y - late.y < 0.18, `it holds, and rises 0.3 tile over its life (${(hold.y - late.y).toFixed(3)} tiles from t 0.3 to 0.85)`);
    const fadeIn = await spot(ban(0.05), GRN), fadeOut = await spot(ban(1.2), GRN), gone = await spot(ban(1.3), GRN);
    check(fadeIn.n < hold.n * 0.1 && fadeOut.n < hold.n * 0.1 && gone.n === 0, 'it fades in over 0.15s and out over the last 0.4s ' + JSON.stringify({ fadeIn: fadeIn.n, fadeOut: fadeOut.n, gone: gone.n }));
    const noSub = await spot(ban(0.3), INKY), sub = await spot(ban(0.3, 'FLAWLESS'), INKY);
    check(noSub.n === 0 && sub.n > 20 && Math.abs(sub.x - 4.5) < 0.15 && Math.abs(sub.y - (hold.y + 0.55)) < 0.2, `the sub line sits 0.55T below the main line (${(sub.y - hold.y).toFixed(2)} tiles)`);
    // Text only on the canvas: a tap where the banner is still picks the tile under it.
    await G(page, () => { window.__pw.G.banner = { s: 'WAVE 3', sub: 'FLAWLESS', c: '#e3ad45', t: 0.3, dur: 1e9 }; });
    await tapTile(page, 4, 5);
    check(JSON.stringify(await G(page, () => window.__pw.G.sel)) === '{"c":4,"r":5}', 'a tap on the banner picks the grass tile under it');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rm1 = await spot(ban(0.3), GRN), rm2 = await spot(ban(0.85), GRN);
    check(rm1.y === rm2.y && Math.abs(rm1.y - y0) < 0.25, `reduced motion: no rise (${rm1.y.toFixed(3)} / ${rm2.y.toFixed(3)} tiles)`);
    // Under reduced motion the gold counter only changes colour.
    await G(page, () => { const W = window.__pw, g = W.G; g.W = { 9: { rem: 0, alive: 1 } }; g.spawnQ = []; W.startWave(); });
    const rmGain = await page.$eval('#sGold', el => { const cs = getComputedStyle(el), sp = getComputedStyle(el.querySelector('span')); return { on: el.classList.contains('gain'), anim: cs.animationName, color: sp.color, shadow: sp.textShadow }; });
    check(rmGain.on && rmGain.anim === 'none' && rmGain.color === 'rgb(227, 173, 69)' && rmGain.shadow === 'none', "reduced motion: 'gain' is colour only " + JSON.stringify(rmGain));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();

    // 320px: 'WARLORD DOWN' at 0.9T fits inside 9T; a line wider than 8.6T drops to 0.7T.
    const r = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(r.page, 1);
    const wd = await G(r.page, () => { const W = window.__pw, g = W.G, T = document.querySelector('#cv').width / W.COLS; g.running = false;
      const fit = s => { g.banner = { s, sub: '', c: '#e3ad45', t: 0.5, dur: 1.2 }; W.render(0); return { fs: g.banner.fs / T, w: g.banner.w / T }; };
      return { T, down: fit('WARLORD DOWN'), the: fit('THE WARLORD'), long: fit('WARLORD DOWN WARLORD') }; });
    check(wd.T <= 26 && Math.abs(wd.down.fs - 0.9) < 1e-9 && wd.down.w <= 8.6 && wd.the.w <= 8.6, `320px (T=${wd.T}): 'WARLORD DOWN' at 0.9T is ${wd.down.w.toFixed(2)} tiles wide, inside 8.6T ` + JSON.stringify(wd));
    check(Math.abs(wd.long.fs - 0.7) < 1e-9, 'a line wider than 8.6T at 0.9T falls back to 0.7T ' + JSON.stringify(wd.long));
    const span = await G(r.page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), x = cv.getContext('2d'), T = cv.width / W.COLS;
      g.banner = { s: 'WARLORD DOWN', sub: 'Costs 5 lives if it gets through', c: '#20ff20', t: 0.5, dur: 1.2 }; W.render(0);
      const d = x.getImageData(0, 0, cv.width, cv.height).data; let minX = 1e9, maxX = -1;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 32) < 30 && Math.abs(d[i + 1] - 255) < 30 && Math.abs(d[i + 2] - 32) < 30) { const px = (i / 4) % cv.width; minX = Math.min(minX, px); maxX = Math.max(maxX, px); }
      return { minX: minX / T, maxX: maxX / T }; });
    check(span.minX > 0.1 && span.maxX < 8.9, `320px: the WARLORD DOWN line is drawn inside the board (${span.minX.toFixed(2)}-${span.maxX.toFixed(2)} tiles)`);
    check(r.page.errors.length === 0, 'no console errors: ' + r.page.errors.join('|'));
    await r.ctx.close();
  }

  // ---------------------------------------------------------------
  // enemy-readability: distinct silhouettes (teardrop Scout, cobalt twin-lobed Splitter, winged Wisp), a 30px minimum size on small boards,
  // HP bars in their own pass after the fliers, a white rim hit flash, a kill pop, and armor tinks (red rim for a Longshot that pierces).
  // Every board here is Meadow Bend with the run stopped (G.running=false), so only __pw.step moves anything.
  // calmBoard(page, wave): no enemies, towers, fx, banner or hint tiles. mask(d, bg): pixels that differ from the background by more than 30.
  const calmBoard = (page, wave) => G(page, wave => { const W = window.__pw, g = W.G; g.running = false; g.enemies = []; g.towers = []; g.projs = []; g.fx = []; g.banner = null; g.bannerNext = null; g.hintTiles = []; g.grid = W.MAPS[1].grid.slice(); g.W = {}; g.wave = wave; g.gold = 9999; }, wave);
  const lum = p => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

  current = 'enemy-readability: distinct silhouettes and a minimum size';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    check((await G(page, () => window.__pw.ED.splitter.color)) === '#4f86d9', "__pw.ED.splitter.color === '#4f86d9' (cobalt)");
    await calmBoard(page, 7);
    // Grunt, Scout and Splitter alone at dist 3.5 (walking down Meadow's first stretch), each on its own render: masks in a 1.4T box.
    const iou = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      const box = () => { const p = g.map.path.at(3.5); return [Math.round((p.x - 0.7) * T), Math.round((p.y - 0.7) * T), Math.round(1.4 * T), Math.round(1.4 * T)]; };
      const b = box(); W.render(0); const bg = c.getImageData(...b).data, m = {}, n = {};
      for (const t of ['grunt', 'scout', 'splitter']) {
        g.enemies = []; W.spawn(t, 3.5); W.render(0); const d = c.getImageData(...b).data, k = [];
        for (let i = 0; i < d.length; i += 4) k.push(Math.max(Math.abs(d[i] - bg[i]), Math.abs(d[i + 1] - bg[i + 1]), Math.abs(d[i + 2] - bg[i + 2])) > 30 ? 1 : 0);
        m[t] = k; n[t] = k.reduce((a, v) => a + v, 0);
      }
      const io = (a, b) => { let i = 0, u = 0; for (let j = 0; j < a.length; j++) { i += a[j] & b[j]; u += a[j] | b[j]; } return +(i / u).toFixed(3); };
      g.enemies = [];
      return { n, gs: io(m.grunt, m.scout), gp: io(m.grunt, m.splitter), sp: io(m.scout, m.splitter) };
    });
    check(iou.gs < 0.8 && iou.gp < 0.8 && iou.sp < 0.8 && Math.min(...Object.values(iou.n)) > 100, 'grunt, scout and splitter masks in a 1.4T box: every pairwise IoU < 0.8 ' + JSON.stringify(iou));
    // Scout: a teardrop, round head forward and a point 1.75r behind. Splitter: two lobes of 0.74r, 0.42r either side of its heading.
    const shape = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, at = (x, y) => [...c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
      const p = g.map.path.at(5), x = p.x * T, y = p.y * T; // Meadow row 3, walking right
      g.enemies = []; W.spawn('scout', 5); const r = W.drawR(g.enemies[0]); W.spawn('splitter', 5); const R = W.drawR(g.enemies[1]);
      g.enemies = []; W.render(0); const bg = { tail: at(x - r * 1.45, y), ahead: at(x + r * 1.45, y), lobe: at(x, y - R * 1.05), front: at(x + R * 1.05, y) };
      W.spawn('scout', 5); W.render(0); const sc = { tail: at(x - r * 1.45, y), ahead: at(x + r * 1.45, y) };
      g.enemies = []; W.spawn('splitter', 5); W.render(0); const sp = { lobe: at(x, y - R * 1.05), front: at(x + R * 1.05, y), col: at(x - R * 0.15, y - R * 0.75) };
      g.enemies = []; return { bg, sc, sp };
    });
    const differs = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 30;
    check(differs(shape.sc.tail, shape.bg.tail) && !differs(shape.sc.ahead, shape.bg.ahead), 'the scout is a teardrop: drawn 1.45r behind its centre (the point), not 1.45r ahead (the round head) ' + JSON.stringify(shape.sc));
    check(differs(shape.sp.lobe, shape.bg.lobe) && !differs(shape.sp.front, shape.bg.front) && near3(shape.sp.col, [0x4f, 0x86, 0xd9], 6), 'the splitter is twin cobalt lobes: it reaches 1.05r to the side of its heading but not ahead ' + JSON.stringify(shape.sp));

    // The Wisp: lifted 0.32 tile over a rgba(0,0,0,.3) shadow, with two wings that flap (spread and still under reduced motion).
    const wisp = t => G(page, t => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; const p = g.map.path.at(5), b = [Math.round((p.x - 1) * T), Math.round((p.y - 1.2) * T), Math.round(2 * T), Math.round(2 * T)];
      W.render(t); const bg = c.getImageData(...b).data, sh0 = [...c.getImageData(Math.floor(p.x * T), Math.floor((p.y + 0.05) * T), 1, 1).data].slice(0, 3);
      W.spawn('wisp', 5); const e = g.enemies[0]; e.bob = 0; W.render(t);
      const d = c.getImageData(...b).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - bg[i]), Math.abs(d[i + 1] - bg[i + 1]), Math.abs(d[i + 2] - bg[i + 2])) > 30) n++;
      const body = [...c.getImageData(Math.floor(p.x * T), Math.floor((p.y - W.LIFT) * T), 1, 1).data].slice(0, 3), sh = [...c.getImageData(Math.floor(p.x * T), Math.floor((p.y + 0.05) * T), 1, 1).data].slice(0, 3);
      g.enemies = []; return { n, body, sh, sh0, lift: W.LIFT };
    }, t);
    const w0 = await wisp(0), w1 = await wisp(Math.PI / 18), w2 = await wisp(Math.PI / 9);
    check(w0.lift === 0.32 && near3(w0.body, [0xbf, 0xe7, 0xff], 6), 'the wisp body is drawn 0.32 tile above the road (LIFT) ' + JSON.stringify(w0.body));
    check(near3(w0.sh, w0.sh0.map(v => v * 0.7), 3), 'its shadow on the road is rgba(0,0,0,.3) ' + JSON.stringify({ sh: w0.sh, road: w0.sh0 }));
    check(w1.n > w0.n * 1.05 && w2.n !== w1.n, `the wings flap: ${w0.n} px at the narrowest (flap 0.55), ${w1.n} fully spread (flap 1), ${w2.n} later`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const r0 = await wisp(0), r1 = await wisp(1.234);
    check(r0.n === r1.n && Math.abs(r0.n - w1.n) <= w1.n * 0.03, `reduced motion: the wings hold still and fully spread (flap 1): ${r0.n} / ${r1.n} px, ${w1.n} at flap 1 in full motion`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Grunt, Brute and Warlord keep their shapes; the outline is Math.max(1.5, 0.06T): at T=39 the grunt's ink ring is about 2.3px.
    const ring = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; W.spawn('grunt', 5); const e = g.enemies[0], R = W.drawR(e), x = Math.floor(e.x * T), y0 = e.y * T; W.render(0);
      let n = 0; for (let y = Math.floor(y0 - R - 3); y < y0 - R + 3; y++) { const p = c.getImageData(x, y, 1, 1).data; if (p[0] < 90 && p[1] < 90 && p[2] < 90) n++; } g.enemies = []; return { n, T, R }; });
    check(ring.n >= 2 && ring.n <= 3 && Math.abs(ring.R - 0.26 * ring.T) < 1e-9, `at T=${ring.T} the outline is about 0.06T thick (${ring.n} dark px across it) and the grunt is drawn at its own size (r ${ring.R.toFixed(2)})`);
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();

    // 320x568 (T=24): enemies are drawn at clamp(30/T, 1, 1.2) = 1.2x, so a scout's drawn radius is e.r*T*1.2.
    const s = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(s.page, 1);
    await calmBoard(s.page, 3);
    const sc = await G(s.page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, at = (x, y) => [...c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
      W.spawn('scout', 5); const e = g.enemies[0], x = e.x * T, y = e.y * T, er = e.r * T; // walking right: straight up is the side of its round head
      g.enemies = []; W.render(0); const bg = [at(x, y - 1.1 * er), at(x, y - er * 1.2 - 0.5), at(x + 1.1 * er, y)];
      g.enemies = [e]; W.render(0); const fg = [at(x, y - 1.1 * er), at(x, y - er * 1.2 - 0.5), at(x + 1.1 * er, y)];
      return { T, er, drawR: W.drawR(e), bg, fg };
    });
    const off = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 30;
    check(sc.T === 24 && Math.abs(sc.drawR - sc.er * 1.2) < 1e-9, `at 320x568 (T=${sc.T}) the scout's drawn radius is e.r*T*1.2 (${sc.drawR.toFixed(2)}px)`);
    check(off(sc.fg[0], sc.bg[0]) && off(sc.fg[2], sc.bg[2]), 'the pixel 1.1*e.r*T from its centre (above, and ahead) is not background ' + JSON.stringify(sc));
    check(off(sc.fg[1], sc.bg[1]), "and so is the pixel just past 1.2*e.r*T, which the scout's own size alone would not reach");
    check(s.page.errors.length === 0, 'no console errors: ' + s.page.errors.join('|'));
    await s.ctx.close();
  }

  current = 'enemy-readability: HP bars in their own pass';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await calmBoard(page, 10);
    // drawEnemy itself draws no bar: the same grunt at full and at half HP gives the same pixels on a spare canvas.
    const own = await G(page, () => {
      const W = window.__pw, g = W.G, T = document.querySelector('#cv').width / W.COLS, c = document.createElement('canvas'); c.width = 9 * T; c.height = 14 * T; const x = c.getContext('2d');
      W.spawn('grunt', 5); const e = g.enemies[0], draw = () => { x.clearRect(0, 0, c.width, c.height); W.drawEnemy(x, e, T, 0); let h = 2166136261; const d = x.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
      const full = draw(); e.hp = e.max * 0.5; const half = draw(); g.enemies = []; return { full, half };
    });
    check(own.full === own.half, 'a grunt damaged to 50%: drawEnemy draws no bar pixels (same drawing as at full HP)');
    const bar = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, at = (x, y) => [...c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
      const one = (t, f, d = 5) => { g.enemies = []; W.spawn(t, d); const e = g.enemies[0]; e.hp = e.max * f; W.render(0); return { e, bars: W.bars() }; };
      const out = {};
      out.full = one('grunt', 1).bars.length; out.h99 = one('grunt', 0.99).bars.length; out.h97 = one('grunt', 0.97).bars.length;
      const h = one('grunt', 0.5), b = h.bars[0], e = h.e, top = e.y * T - W.drawR(e) - Math.max(1.5, 0.06 * T) / 2;
      out.grunt = { n: h.bars.length, w: b.w, h: b.h, f: b.f, a: b.a, gap: top - (b.y + b.h + 1), fill: at(b.x + 2, b.y + b.h / 2), empty: at(b.x + b.w - 2, b.y + b.h / 2), edge: at(b.x + b.w / 2, b.y - 0.5) };
      out.brute = one('brute', 0.5).bars[0].w; out.splitter = one('splitter', 0.3).bars[0];
      const wi = one('wisp', 0.8); out.wisp = { bottom: wi.bars[0].y + wi.bars[0].h + 1, body: (wi.e.y - W.LIFT) * T - W.drawR(wi.e) - 0.05 * T, fill: at(wi.bars[0].x + 2, wi.bars[0].y + 1) };
      out.T = T; g.enemies = []; return out;
    });
    check(bar.full === 0 && bar.h99 === 0 && bar.h97 === 1, `a bar only below 98% HP: none at 100% or 99%, one at 97% (${bar.full}/${bar.h99}/${bar.h97})`);
    check(bar.grunt.n === 1 && Math.abs(bar.grunt.w - 0.45 * bar.T) < 1e-9 && bar.grunt.h === Math.round(Math.max(4, 0.09 * bar.T)) && bar.grunt.f === 0.5 && bar.grunt.a === 1, 'a grunt at 50% gets one bar from the bar pass, 0.45T by Math.max(4, 0.09T) ' + JSON.stringify(bar.grunt));
    check(near3(bar.grunt.fill, [0xe8, 0xc5, 0x47], 4) && lum(bar.grunt.empty) < 40 && lum(bar.grunt.edge) < 50, 'it is yellow at 50% with a dark empty part and a dark 1px border ' + JSON.stringify(bar.grunt));
    check(bar.grunt.gap >= 2, `it sits above the drawn sprite (${bar.grunt.gap.toFixed(1)}px clear of the outline)`);
    check(Math.abs(bar.brute - 0.6 * bar.T) < 1e-9 && Math.abs(bar.splitter.w - 0.6 * bar.T) < 1e-9 && bar.splitter.f === 0.3 && near3(bar.wisp.fill, [0x9f, 0xd3, 0x6a], 4), 'enemies with r >= 0.3 get 0.6T bars; fill colours stay green/yellow/red by fraction');
    check(bar.wisp.bottom <= bar.wisp.body, `a flier's bar sits above its lifted sprite (bar bottom ${bar.wisp.bottom.toFixed(1)}, body top ${bar.wisp.body.toFixed(1)})`);

    // A hurt Warlord: no bar of any kind over it. The 3px above its drawn top match the board with no Warlord at all.
    const boss = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; g.fx = []; g.banner = null; W.spawn('boss', 5); g.fx = []; g.banner = null; const e = g.enemies[0]; e.hp = e.max * 0.5;
      const R = W.drawR(e), top = Math.floor(e.y * T - 1.22 * R - Math.max(1.5, 0.06 * T) / 2), box = [Math.floor(e.x * T - 1.3 * R), top - 3, Math.ceil(2.6 * R), 3];
      W.render(0); const withB = [...c.getImageData(...box).data], bars = W.bars().length;
      g.enemies = []; W.render(0); const without = [...c.getImageData(...box).data];
      let worst = 0; for (let i = 0; i < withB.length; i++) worst = Math.max(worst, Math.abs(withB[i] - without[i]));
      return { bars, worst, box };
    });
    check(boss.bars === 0 && boss.worst <= 2, 'a Warlord at 50%: no bar is queued, and the 3px strip above it matches the background (the pinned bar is at the top instead) ' + JSON.stringify(boss));

    // Two damaged grunts 0.45 tile apart on Meadow's row-3 stretch: their bars meet, and the pixel at the midpoint is dark.
    const pair = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; W.spawn('grunt', 5); W.spawn('grunt', 5.45); for (const e of g.enemies) e.hp = e.max * 0.5; W.render(0);
      const [a, b] = g.enemies, bs = W.bars(), mx = (a.x + b.x) / 2 * T, my = bs[0].y + bs[0].h / 2, p = [...c.getImageData(Math.floor(mx), Math.floor(my), 1, 1).data].slice(0, 3);
      g.enemies = []; return { p, mx, my, meet: bs[1].x - (bs[0].x + bs[0].w) };
    });
    check(Math.abs(pair.meet) < 1e-6 && lum(pair.p) < 40, `two grunts at 50% 0.45 tile apart: the bars meet and the pixel at their midpoint is dark (luminance ${lum(pair.p).toFixed(1)} < 40) ` + JSON.stringify(pair));
    // Bars are drawn after the fliers: a wisp over a damaged grunt's bar does not hide it.
    const over = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; W.spawn('grunt', 5); W.spawn('wisp', 5); const [gr, wi] = g.enemies; gr.hp = gr.max * 0.5; wi.bob = 0; W.render(0);
      const b = W.bars()[0], x = b.x + 3, y = b.y + b.h / 2, inWisp = Math.hypot(x - wi.x * T, y - (wi.y - W.LIFT) * T) < W.drawR(wi) - 2;
      return { inWisp, p: [...c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3) };
    });
    check(over.inWisp && near3(over.p, [0xe8, 0xc5, 0x47], 4), 'a wisp flying over a damaged grunt does not cover its bar: bars are drawn after the flier loop ' + JSON.stringify(over));
    // Bars fade with their enemy near the keep: same alpha clamp((path.len-0.2-dist)/0.9, 0, 1), and none at the leak line.
    const fade = await G(page, () => { const W = window.__pw, g = W.G, L = g.map.path.len, out = [];
      for (const d of [L - 1.2, L - 0.65, L - 0.2]) { g.enemies = []; W.spawn('grunt', d); g.enemies[0].hp = g.enemies[0].max * 0.5; W.render(0); out.push(W.bars().map(b => +b.a.toFixed(3)).join()); }
      g.enemies = []; return out; });
    check(fade[0] === '1' && fade[1] === '0.5' && fade[2] === '', 'bars use the fade alpha: 1, then 0.5 halfway through the last 0.9 tile, then no bar at the leak line ' + JSON.stringify(fade));
    // A fading ground enemy walks in under the keep, and its bar goes under with it: where a hurt brute's bar overlaps the keep's
    // wall, the wall looks the same as with that brute at full HP (no bar).
    const under = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, kp = W.keep();
      g.enemies = []; g.fx = []; g.wave = 4; W.spawn('brute', g.map.path.len - 0.45); const e = g.enemies[0]; e.hp = e.max * 0.5; W.render(0); const b = W.bars()[0];
      const x0 = Math.ceil(Math.max(b.x - 1, (kp.x - 0.38) * T + 2)), x1 = Math.floor(Math.min(b.x + b.w + 1, (kp.x + 0.38) * T - 2));
      const y0 = Math.ceil(Math.max(b.y - 1, (kp.y - 0.22) * T + 2)), y1 = Math.floor(Math.min(b.y + b.h + 1, (kp.y + 0.3) * T - 2));
      const box = () => { W.render(0); return [...c.getImageData(x0, y0, x1 - x0, y1 - y0).data]; };
      const hurt = box(); e.hp = e.max; const full = box(); g.enemies = [];
      let worst = 0; for (let i = 0; i < hurt.length; i++) worst = Math.max(worst, Math.abs(hurt[i] - full[i]));
      return { a: +b.a.toFixed(3), under: b.under, w: x1 - x0, h: y1 - y0, worst }; });
    check(under.under && under.a < 1 && under.w > 4 && under.h > 2 && under.worst <= 2, "a hurt brute fading in at the keep: its bar is queued but drawn under the keep's wall " + JSON.stringify(under));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();

    const s = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(s.page, 1);
    await calmBoard(s.page, 3);
    const small = await G(s.page, () => { const W = window.__pw, g = W.G; W.spawn('grunt', 5); g.enemies[0].hp = 10; W.render(0); const b = W.bars()[0]; g.enemies = []; return { w: b.w, h: b.h, T: document.querySelector('#cv').width / W.COLS }; });
    check(small.T === 24 && small.w === 16 && small.h === 4, '320px: a grunt bar is at least 16 by 4 px ' + JSON.stringify(small));
    await s.ctx.close();
  }

  current = 'enemy-readability: rim hit flash and kill pop';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await calmBoard(page, 1);
    // rimAt(type, set): one enemy at dist 5 (walking right), with fields from `set`, rendered; returns the pixel at the top of its rim and one inside its body.
    const rimAt = (type, set) => G(page, ([type, set]) => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, at = (x, y) => [...c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
      g.enemies = []; g.fx = []; W.spawn(type, 5); const e = g.enemies[0]; Object.assign(e, set); const R = W.drawR(e), x = e.x * T, y = e.y * T; W.render(0);
      const r = { rim: at(x, y - R), body: at(x - 0.5 * R, y) }; g.enemies = []; return r; }, [type, set]);
    const hit = await G(page, () => { const W = window.__pw, g = W.G; W.spawn('grunt', 5); const e = g.enemies[0]; W.hurt(e, 5, false, 'bolt'); const r = { hitT: e.hitT, tinkT: e.tinkT, pierceT: e.pierceT }; g.enemies = []; return r; });
    check(hit.hitT === 0.05 && hit.tinkT === 0 && hit.pierceT === 0, 'a plain hit sets hitT = 0.05 ' + JSON.stringify(hit));
    const plain = await rimAt('grunt', {}), flash = await rimAt('grunt', { hitT: 0.05 });
    check(lum(plain.rim) < 60 && flash.rim.every(v => v > 235), 'the hit flash is a white rim at radius r: the ink outline turns white ' + JSON.stringify({ plain: plain.rim, flash: flash.rim }));
    check(near3(flash.body, [0xc9, 0x58, 0x3a], 4) && near3(flash.body, plain.body, 2), 'not a fill: the body keeps its colour (#c9583a) while it flashes ' + JSON.stringify(flash.body));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const soft = await rimAt('grunt', { hitT: 0.05 });
    check(lum(soft.rim) > lum(plain.rim) + 40 && lum(soft.rim) < lum(flash.rim) - 80, 'reduced motion: the rim is drawn at alpha 0.3 ' + JSON.stringify(soft.rim));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const pierce = await rimAt('brute', { pierceT: 0.08 });
    check(near3(pierce.rim, [0xff, 0x9a, 0x8a], 8), 'a pierce hit draws a #ff9a8a rim instead ' + JSON.stringify(pierce.rim));

    // Kill pop: a grunt killed by hurtAll adds a pop, 6 particles (3 of them #fff6dc) and its +gold: at most 8 fx.
    const kill = await G(page, () => { const W = window.__pw, g = W.G; g.fx = []; W.spawn('grunt', 5); const e = g.enemies[0]; W.hurtAll(1e6);
      const pop = g.fx.find(f => f.k === 'pop'), ps = g.fx.filter(f => f.k === 'p'); return { n: g.fx.length, pop, x: e.x, y: e.y, parts: ps.length, cream: ps.filter(p => p.c === '#fff6dc').length, own: ps.filter(p => p.c === e.d.color).length }; });
    check(!!kill.pop && kill.n <= 8, `spawn a grunt and hurtAll(1e6): G.fx has k==='pop', and that kill added ${kill.n} fx (at most 8)`);
    check(kill.pop && kill.pop.x === kill.x && kill.pop.y === kill.y && kill.pop.r === 0.26 && kill.pop.t === 0 && kill.pop.dur === 0.16, "the pop is {k:'pop', x, y, r:e.r, t:0, dur:0.16} " + JSON.stringify(kill.pop));
    check(kill.parts === 6 && kill.cream === 3 && kill.own === 3, `a normal kill bursts 6 particles, half of them #fff6dc (${kill.parts}: ${kill.cream} cream, ${kill.own} grunt)`);
    const flier = await G(page, () => { const W = window.__pw, g = W.G; g.fx = []; g.wave = 5; W.spawn('wisp', 5); const e = g.enemies[0]; W.hurtAll(1e6); const pop = g.fx.find(f => f.k === 'pop'); return { dy: e.y - pop.y, pdy: g.fx.filter(f => f.k === 'p').every(p => Math.abs(e.y - p.y - W.LIFT) < 1e-9), lift: W.LIFT }; });
    check(Math.abs(flier.dy - flier.lift) < 1e-9 && flier.pdy, 'a flier pops and bursts where it is drawn, LIFT (0.32) above the road ' + JSON.stringify(flier));
    // The pop swells: white disc 1 -> 1.6r, ring out to 2.2r. Under reduced motion both hold their size and only fade.
    const popArea = t => G(page, t => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.enemies = []; const p = g.map.path.at(5), b = [Math.round((p.x - 1.5) * T), Math.round((p.y - 1.5) * T), Math.round(3 * T), Math.round(3 * T)];
      g.fx = []; W.render(0); const bg = c.getImageData(...b).data; g.fx = [{ k: 'pop', x: p.x, y: p.y, r: 0.26, t, dur: 0.16 }]; W.render(0);
      const d = c.getImageData(...b).data; let n = 0, far = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - bg[i]), Math.abs(d[i + 1] - bg[i + 1]), Math.abs(d[i + 2] - bg[i + 2])) > 12) { n++; far = Math.max(far, Math.hypot(b[0] + (i / 4) % b[2] + 0.5 - p.x * T, b[1] + Math.floor(i / 4 / b[2]) + 0.5 - p.y * T)); }
      const ctr = [...c.getImageData(Math.floor(p.x * T), Math.floor(p.y * T), 1, 1).data].slice(0, 3); g.fx = []; return { n, far: +far.toFixed(2), r: 0.26 * T, ctr }; }, t);
    const p0 = await popArea(0), p1 = await popArea(0.08);
    check(p0.ctr.every(v => v > 230) && p1.n > p0.n * 1.6 && p1.far > p0.far + 0.4 * p0.r, `the pop is a white disc that swells, its ring growing (${p0.n} px out to ${p0.far}px at t 0, ${p1.n} px out to ${p1.far}px at t 0.08) ` + JSON.stringify(p0.ctr));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const q0 = await popArea(0), q1 = await popArea(0.08);
    check(Math.abs(q1.far - q0.far) <= 1 && q0.far > 1.5 * q0.r, `reduced motion: the pop holds its size and only fades (out to ${q0.far}px / ${q1.far}px)`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'enemy-readability: armor tink and Longshot pierce';
  {
    const { ctx, page } = await newPage(browser, { init: audioSpy });
    await startMap(page, 1);
    // Acceptance: G.wave=30; spawn('brute',5); a bolt beside it; step until the hit.
    await calmBoard(page, 30);
    await clearRec(page, 50);
    const bolt = await G(page, () => { const W = window.__pw, g = W.G; W.spawn('brute', 5); const e = g.enemies[0]; W.build('bolt', 2, 2);
      let n = 0, src = null; while (e.hp === e.max && n++ < 300) { W.step(1 / 30); const p = g.projs.find(p => p.k === 'bolt'); if (p) src = p.src; }
      return { hit: e.hp < e.max, tinkT: e.tinkT, hitT: e.hitT, src, armor: e.armor }; });
    check(bolt.hit && bolt.tinkT > 0 && bolt.hitT <= 0, 'G.wave=30; spawn brute at 5; a bolt beside it: after the hit brute.tinkT > 0 and hitT <= 0 ' + JSON.stringify(bolt));
    check(bolt.src === 'bolt', "the bolt's projectile carries its tower type (p.src === 'bolt')");
    check(near(await vals(page, 'square'), 2600), "the tink plays sfx('tink') (square 2600Hz)");
    await calmBoard(page, 30);
    const lng = await G(page, () => { const W = window.__pw, g = W.G; W.spawn('brute', 5); const e = g.enemies[0]; W.build('long', 2, 2);
      let n = 0; while (e.hp === e.max && n++ < 300) W.step(1 / 30); return { hit: e.hp < e.max, pierceT: e.pierceT, tinkT: e.tinkT, hitT: e.hitT }; });
    check(lng.hit && lng.pierceT > 0 && lng.tinkT === 0 && lng.hitT <= 0, 'a Longshot hit on a brute sets pierceT > 0 and tinkT === 0 (and no white flash) ' + JSON.stringify(lng));
    // The 40% rule, Frost's exemption and one spark set at a time (wave-30 brute: armor 3 x 1.87 = 5.61).
    await calmBoard(page, 30);
    const rule = await G(page, () => { const W = window.__pw, g = W.G; W.spawn('brute', 5); const e = g.enemies[0], out = {};
      const fresh = () => { e.tinkT = 0; e.hitT = 0; e.pierceT = 0; };
      const hit = (d, p, s) => { fresh(); W.hurt(e, d, p, s); return [+e.tinkT.toFixed(3), +e.hitT.toFixed(3), +e.pierceT.toFixed(3)].join(); };
      out.bolt1 = hit(11, false, 'bolt'); out.bolt2 = hit(17.6, false, 'bolt'); out.arc = hit(11, false, 'arc'); out.frost = hit(5, false, 'frost'); out.mortar = hit(30, false, 'mortar'); out.long = hit(78, true, 'long');
      fresh(); W.hurt(e, 11, false, 'bolt'); const a1 = e.tinkA; W.step(0.03); W.hurt(e, 11, false, 'bolt'); out.again = { same: e.tinkA === a1, t: +e.tinkT.toFixed(3) };
      for (let i = 0; i < 3; i++) W.step(0.03); out.ends = +Math.max(0, e.tinkT).toFixed(3); W.hurt(e, 11, false, 'bolt'); out.next = +e.tinkT.toFixed(3);
      out.armor = +e.armor.toFixed(2); return out; });
    check(rule.bolt1 === '0.1,0,0' && rule.arc === '0.1,0,0', 'a hit whose damage armor cuts by 40% or more (dmg-a < 0.6*dmg) tinks: tinkT 0.1 and no hitT ' + JSON.stringify(rule));
    check(rule.bolt2 === '0,0.05,0' && rule.mortar === '0,0.05,0', 'a hit armor cuts by less than 40% flashes white as usual (Bolt level 2, Mortar)');
    check(rule.frost === '0,0.05,0', "Frost never tinks, though armor eats its whole hit (src === 'frost')");
    check(rule.long === '0,0,0.08', 'a Longshot (pierce) hit sets pierceT 0.08 and nothing else');
    check(rule.again.same && rule.again.t < 0.1 && rule.next === 0.1, 'one spark set per enemy at a time: a tink while sparks show keeps that set; a new one starts after it ends ' + JSON.stringify(rule.again) + ' next ' + rule.next);
    // The sparks: three short #d6dbe0 lines off the armor ring.
    const sparks = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      const count = tink => { g.enemies = []; g.fx = []; W.spawn('brute', 5); const e = g.enemies[0]; e.tinkT = tink; e.tinkA = -Math.PI / 2; W.render(0);
        const R = W.drawR(e) * 1.12, x = e.x * T, y = e.y * T, b = [Math.floor(x - R - 0.3 * T), Math.floor(y - R - 0.3 * T), Math.ceil(2 * R + 0.6 * T), Math.ceil(2 * R + 0.6 * T)], d = c.getImageData(...b).data; let n = 0, far = 0;
        for (let i = 0; i < d.length; i += 4) { const px = b[0] + (i / 4) % b[2] + 0.5, py = b[1] + Math.floor(i / 4 / b[2]) + 0.5, r = Math.hypot(px - x, py - y);
          if (r > R + 2 && Math.abs(d[i] - 0xd6) < 24 && Math.abs(d[i + 1] - 0xdb) < 24 && Math.abs(d[i + 2] - 0xe0) < 24) { n++; far = Math.max(far, (r - R) / T); } }
        return { n, far: +far.toFixed(3) }; };
      const r = { off: count(0), on: count(0.1) }; g.enemies = []; return r; });
    check(sparks.off.n === 0 && sparks.on.n >= 6 && sparks.on.far > 0.08 && sparks.on.far < 0.16, 'tinkT > 0 draws #d6dbe0 sparks reaching about 0.12 tile off the armor ring ' + JSON.stringify(sparks));
    // Every projectile carries its tower type.
    await calmBoard(page, 1);
    const srcs = await G(page, () => { const W = window.__pw, g = W.G; W.spawn('grunt', 5); g.enemies[0].hp = 1e9; g.enemies[0].max = 1e9; g.enemies[0].spd = 0; W.build('frost', 2, 2); W.build('mortar', 3, 2); W.build('bolt', 4, 2); const seen = {};
      for (let i = 0; i < 120; i++) { W.step(1 / 30); for (const p of g.projs) seen[p.k] = p.src; } return seen; });
    check(srcs.bolt === 'bolt' && srcs.frost === 'frost' && srcs.shell === 'mortar', 'projectiles carry src: ' + JSON.stringify(srcs));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // tower-readability-range: a base shape per tower (Longshot diamond, Mortar octagon), bigger level pips, a brass plate edge from level 2,
  // the level 3 ring on every tower; an upgrade punch (scale, brass ring out to the new range) that keeps t.born; a range preview that
  // lights the road it covers with a dark-backed edge, 'Covers N tiles of road' in #info, and the next level's ring on a selected tower.
  // Boards are Meadow Bend with the run stopped (calmBoard), so only __pw.step moves anything.
  // brass(d, i, tol): pixel i of image data d is within tol of #e3ad45. ringDiff(page, rTiles, cx, cy, setOn, setOff): how many of 360
  // points on a circle differ by more than 20 in a channel between a render after setOn() and one after setOff().
  const BRASS_JS = 'const brass = (d, i, tol) => Math.abs(d[i] - 0xe3) <= tol && Math.abs(d[i + 1] - 0xad) <= tol && Math.abs(d[i + 2] - 0x45) <= tol;';

  current = 'tower-readability-range: tower shapes, pips, plate edge and the level 3 ring';
  {
    const { ctx, page } = await newPage(browser);
    // Acceptance: the palette icons masked to non-transparent pixels.
    const iou = await G(page, () => {
      const m = {}, n = {};
      for (const c of document.querySelectorAll('.tw canvas')) { const k = c.parentNode.dataset.t, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, a = []; for (let i = 3; i < d.length; i += 4) a.push(d[i] > 0 ? 1 : 0); m[k] = a; n[k] = a.reduce((s, v) => s + v, 0); }
      const io = (a, b) => { let i = 0, u = 0; for (let j = 0; j < a.length; j++) { i += a[j] & b[j]; u += a[j] | b[j]; } return +(i / u).toFixed(3); };
      return { n, bl: io(m.bolt, m.long), bm: io(m.bolt, m.mortar), ml: io(m.mortar, m.long), bf: io(m.bolt, m.frost), ba: io(m.bolt, m.arc) };
    });
    check(iou.bl < 0.85 && iou.bm < 0.9, 'palette canvases masked to non-transparent pixels: IoU(bolt,long) < 0.85 and IoU(bolt,mortar) < 0.9 ' + JSON.stringify(iou));
    check(Math.min(...Object.values(iou.n)) > 150 && iou.ml < 0.9 && iou.bf < 0.9 && iou.ba < 0.9, 'every icon is drawn, and no two silhouettes match closely');
    await startMap(page, 1);
    await calmBoard(page, 0);
    // Longshot's base is a diamond: solid red just below its centre, plate where a circle's edge would be (the diagonal).
    const dia = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, at = (x, y) => [...c.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
      W.build('long', 4, 5); g.towers[0].born = -10; W.render(0); const cx = 4.5 * T, cy = 5.48 * T; const r = { T, below: at(cx, cy + 0.18 * T), diag: at(cx + 0.17 * T, cy + 0.17 * T) }; g.towers = []; g.grid = W.MAPS[1].grid.slice(); return r; });
    check(near3(dia.below, [0xcf, 0x55, 0x47], 8) && near3(dia.diag, [0x6f, 0x67, 0x50], 8), 'the Longshot base is a red diamond: red 0.18T below its centre, the plate 0.24T out on the diagonal ' + JSON.stringify(dia));
    // Pips: radius Math.max(2, 0.065T), 0.2T apart. Brass blobs in the bottom 30% of the tile, by level.
    const blobsAt = new Function('lv', 'type', BRASS_JS + `
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      g.towers = []; g.grid = W.MAPS[1].grid.slice(); W.build(type || 'bolt', 4, 5); const t = g.towers[0]; for (let i = 1; i < lv; i++) W.upgrade(t); t.born = -10; W.render(0);
      const y0 = Math.ceil(5.7 * T), x0 = 4 * T, w = T, h = 6 * T - y0, d = c.getImageData(x0, y0, w, h).data, m = new Uint8Array(w * h), seen = new Uint8Array(w * h), out = [];
      for (let i = 0; i < w * h; i++) m[i] = brass(d, i * 4, 20) ? 1 : 0;
      for (let i = 0; i < w * h; i++) if (m[i] && !seen[i]) { let n = 0, sx = 0; const st = [i]; seen[i] = 1;
        while (st.length) { const j = st.pop(), x = j % w, y = (j / w) | 0; n++; sx += x;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) { const X = x + dx, Y = y + dy, k = Y * w + X; if (X >= 0 && Y >= 0 && X < w && Y < h && m[k] && !seen[k]) { seen[k] = 1; st.push(k); } } }
        out.push({ n, x: sx / n }); }
      g.towers = []; g.grid = W.MAPS[1].grid.slice(); return { T, all: out, big: out.filter(b => b.n >= 9) };`);
    const pp = [];
    for (const lv of [1, 2, 3]) pp.push(await G(page, blobsAt, lv));
    const gaps = pp[2].big.map(b => b.x).sort((a, b) => a - b);
    check(pp[0].big.length === 1 && pp[1].big.length === 2 && pp[2].big.length === 3, `390px: a level 1, 2 and 3 bolt show 1, 2 and 3 brass pips (${pp.map(p => p.big.length)})`);
    check(Math.abs(gaps[1] - gaps[0] - 0.2 * pp[0].T) < 1 && Math.abs(gaps[2] - gaps[1] - 0.2 * pp[0].T) < 1 && pp[0].big[0].n >= Math.floor(Math.PI * (0.065 * pp[0].T) ** 2 * 0.7), 'pips are 0.2T apart with radius 0.065T (' + JSON.stringify(pp[2].big) + ')');
    // From level 2 the outer plate is stroked #c99a3e instead of ink: its left edge, halfway down.
    const edge = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, out = {};
      for (const lv of [1, 2, 3]) { g.towers = []; g.grid = W.MAPS[1].grid.slice(); W.build('bolt', 4, 5); const t = g.towers[0]; for (let i = 1; i < lv; i++) W.upgrade(t); t.born = -10; W.render(0);
        const x = Math.floor(4.5 * T - 0.42 * T), y = Math.floor(5.51 * T), d = c.getImageData(x - 2, y, 5, 1).data; let best = null;
        for (let i = 0; i < 20; i += 4) { const p = [d[i], d[i + 1], d[i + 2]], e = Math.max(Math.abs(p[0] - 0xc9), Math.abs(p[1] - 0x9a), Math.abs(p[2] - 0x3e)); if (!best || e < best.e) best = { e, p }; }
        out['L' + lv] = best; }
      g.towers = []; g.grid = W.MAPS[1].grid.slice(); return out; });
    check(edge.L1.e > 60 && edge.L2.e <= 12 && edge.L3.e <= 12, 'the outer plate edge is #c99a3e at levels 2 and 3, and not at level 1 ' + JSON.stringify(edge));
    // Acceptance: a level 3 Frost draws the brass ring, at 0.35T (outside its hexagon). Level 2 has none; any level 3 tower has one.
    const ring = await G(page, new Function(BRASS_JS + `
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      const count = (type, lv, rad) => { g.towers = []; g.grid = W.MAPS[1].grid.slice(); W.build(type, 4, 5); const t = g.towers[0]; for (let i = 1; i < lv; i++) W.upgrade(t); t.born = -10; t.ang = Math.PI / 2; W.render(0);
        let n = 0; const N = 36; // the upper half of the circle, away from the pips (Bolt's barrel points down here)
        for (let i = 0; i < N; i++) { const a = Math.PI + (i + 0.5) / N * Math.PI, d = c.getImageData(Math.floor(4.5 * T + Math.cos(a) * rad * T), Math.floor(5.48 * T + Math.sin(a) * rad * T), 1, 1).data; if (brass(d, 0, 24)) n++; }
        return n; };
      const r = { f3: count('frost', 3, 0.35), f2: count('frost', 2, 0.35), f3in: count('frost', 3, 0.3), b3: count('bolt', 3, 0.3), b2: count('bolt', 2, 0.3), m3: count('mortar', 3, 0.3), l3: count('long', 3, 0.3) };
      g.towers = []; g.grid = W.MAPS[1].grid.slice(); return r;`));
    check(ring.f3 >= 30 && ring.f2 === 0, 'a level 3 Frost draws brass pixels at radius 0.35T (none at level 2) ' + JSON.stringify(ring));
    check(ring.f3in <= 3, 'the Frost ring is at 0.35T, not 0.3T inside its hexagon');
    check(ring.b3 >= 15 && ring.b2 === 0 && ring.m3 >= 15 && ring.l3 >= 15, 'every level 3 tower has the ring (Bolt, Mortar, Longshot at 0.3T)');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();

    // Acceptance at 320x568 (T=24): a level 2 bolt has 2 brass blobs of at least 9px in the bottom 30% of its tile.
    const s = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(s.page, 1);
    await calmBoard(s.page, 0);
    const small = [];
    for (const lv of [2, 3]) small.push(await G(s.page, blobsAt, lv));
    check(small[0].T === 24 && small[0].big.length === 2, `320px: build a bolt, __pw.upgrade it and set born=-10: the bottom 30% of the tile has 2 brass (#e3ad45 ±20) blobs of >=9px ` + JSON.stringify(small[0]));
    check(small[1].all.filter(b => b.n >= 6).length === 3, '320px: a level 3 bolt shows 3 separate pips ' + JSON.stringify(small[1].all));
    check(s.page.errors.length === 0, 'no console errors: ' + s.page.errors.join('|'));
    await s.ctx.close();
  }

  current = 'tower-readability-range: the upgrade punch';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await calmBoard(page, 0);
    // Build, let 1s of game time pass (so resetting born would show), select it, then upgrade with #bUp.
    const b0 = await G(page, () => { const W = window.__pw, g = W.G; W.build('bolt', 4, 5); W.step(1); return g.towers[0].born; });
    await tapTile(page, 4, 5);
    await page.click('#bUp');
    const up = await G(page, () => { const W = window.__pw, g = W.G, t = g.towers[0]; return { level: t.level, born: t.born, time: g.time, upT: t.upT, rings: g.fx.filter(f => f.k === 'ring').map(f => ({ ...f })), range: W.tstats('bolt', 2).range }; });
    check(up.level === 2 && up.born === b0 && up.time > b0 + 0.9, `upgrade via #bUp: towers[0].born is unchanged (${b0} -> ${up.born}, game time ${up.time})`);
    check(up.upT > 0 && Math.abs(up.upT - 0.22) < 1e-9, 'towers[0].upT > 0 (0.22) ' + up.upT);
    const rg = up.rings.find(r => Math.abs(r.r - up.range) < 0.05);
    check(!!rg, `G.fx has a ring with |r - tstats('bolt',2).range| < 0.05 (range ${up.range}) ` + JSON.stringify(up.rings));
    check(rg && rg.x === 4.5 && rg.y === 5.5 && rg.c === '#e3ad45' && rg.dur === 0.45 && Math.abs(rg.r0 - 0.4 * rg.r) < 1e-9 && rg.a === 0.8, 'the ring is brass, at the tower, grows from 0.4 to 1.0 of the new range over 0.45s, starting at alpha 0.8 ' + JSON.stringify(rg));
    // The punch: scale 1 + 0.22*sin(pi*(1-upT/0.22)), so 1 at the start and end and 1.22 halfway. Measured as the tower's drawn area.
    const area = () => G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, t = g.towers[0];
      g.selTower = null; g.sel = null; g.fx = []; const b = [Math.round(3.2 * T), Math.round(4.2 * T), Math.round(2.6 * T), Math.round(2.6 * T)];
      const keep = g.towers; g.towers = []; W.render(0); const bg = c.getImageData(...b).data; g.towers = keep;
      const n = upT => { t.upT = upT; W.render(0); const d = c.getImageData(...b).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - bg[i]), Math.abs(d[i + 1] - bg[i + 1]), Math.abs(d[i + 2] - bg[i + 2])) > 30) k++; return k; };
      const r = { start: n(0.22), mid: n(0.11), late: n(0.03), end: n(0) }; t.upT = 0; return r; });
    const pa = await area();
    check(pa.mid > pa.end * 1.3 && pa.late > pa.end && pa.late < pa.mid && Math.abs(pa.start - pa.end) <= pa.end * 0.02, 'in render the tower swells to 1.22x halfway through upT and is back to its size at both ends ' + JSON.stringify(pa));
    const dec = await G(page, () => { const W = window.__pw, t = W.G.towers[0]; t.upT = 0.22; W.step(0.1); const a = t.upT; W.step(0.2); return [+a.toFixed(4), t.upT]; });
    check(dec[0] === 0.12 && dec[1] === 0, 'step decays upT and stops at 0 ' + JSON.stringify(dec));
    // The ring fx: at t=0 it is at 0.4 of the new range; under reduced motion it holds at the full range.
    const ringAt = () => G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, r = W.tstats('bolt', 2).range;
      g.selTower = null; g.sel = null; g.fx = []; W.render(0); const bg = c.getImageData(0, 0, cv.width, cv.height).data;
      g.fx = [{ k: 'ring', x: 4.5, y: 5.5, t: 0, dur: 0.45, r, r0: r * 0.4, c: '#e3ad45', a: 0.8 }]; W.render(0); const d = c.getImageData(0, 0, cv.width, cv.height).data; g.fx = [];
      const on = rad => { let n = 0; for (let i = 0; i < 90; i++) { const a = i / 90 * Math.PI * 2, k = (Math.floor(5.5 * T + Math.sin(a) * rad * T) * cv.width + Math.floor(4.5 * T + Math.cos(a) * rad * T)) * 4; if (Math.max(Math.abs(d[k] - bg[k]), Math.abs(d[k + 1] - bg[k + 1]), Math.abs(d[k + 2] - bg[k + 2])) > 30) n++; } return n; };
      return { inner: on(0.4 * r), outer: on(r) }; });
    const rFull = await ringAt();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const rStill = await ringAt(), paStill = await area();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check(rFull.inner >= 80 && rFull.outer === 0, 'the ring starts at 0.4 of the new range ' + JSON.stringify(rFull));
    check(rStill.outer >= 80 && rStill.inner === 0, 'reduced motion: the ring sits at the new range and only fades ' + JSON.stringify(rStill));
    check(paStill.mid === paStill.end && paStill.start === paStill.end, 'reduced motion: no punch, the tower keeps its size ' + JSON.stringify(paStill));
    // A new build still grows in from 0.6.
    const grow = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, b = [Math.round(5.2 * T), Math.round(8.2 * T), Math.round(2.6 * T), Math.round(2.6 * T)];
      W.render(0); const bg = c.getImageData(...b).data; W.build('frost', 6, 9); const t = g.towers[g.towers.length - 1];
      const n = () => { W.render(0); const d = c.getImageData(...b).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(Math.abs(d[i] - bg[i]), Math.abs(d[i + 1] - bg[i + 1]), Math.abs(d[i + 2] - bg[i + 2])) > 30) k++; return k; };
      const fresh = n(); t.born = -10; return { fresh, grown: n() }; });
    check(grow.fresh < grow.grown * 0.5, 'a new tower still grows in from 0.6 ' + JSON.stringify(grow));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'tower-readability-range: the range preview lights the road it covers';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await G(page, () => { const g = window.__pw.G; g.running = false; g.hintTiles = []; });
    await tapTile(page, 4, 5); await page.click('.tw[data-t="bolt"]');
    await page.waitForTimeout(100);
    const info = await page.$eval('#infoMsg', el => ({ text: el.textContent, html: el.innerHTML, fits: el.scrollHeight <= el.clientHeight + 1 }));
    const want = await G(page, () => { const W = window.__pw, m = W.G.map, pts = []; for (let i = 0; i <= Math.round(m.path.len * 10); i++) { const p = m.path.at(i / 10); if (p.x >= 0 && p.x < W.COLS && p.y >= 0 && p.y < W.ROWS) pts.push(p); }
      const cov = pts.filter(p => Math.hypot(p.x - 4.5, p.y - 5.5) <= 2.4 + 1e-9).length * 0.1; return { cov, fn: W.coverage(4, 5, 2.4) }; });
    check(/Covers \d+\.\d tiles of road/.test(info.text), '#infoMsg matches /Covers \\d+\\.\\d tiles of road/ (' + info.text + ')');
    check(Math.abs(want.fn - want.cov) < 1e-9 && info.html === `<b>Bolt</b> · Fast shots. Hits fliers.<br>Covers ${want.cov.toFixed(1)} tiles of road. Tap again to build.` && info.fits, 'coverage() counts the on-board road samples (every 0.1 tile) within range; at 390px #infoMsg is the full spec line and fits (' + info.html + ')');
    // Acceptance: tap (4,5), then Bolt, and render. Pixels are picked where the plain board (no selection) shows bare road colour.
    const pv = await G(page, () => {
      const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, Wd = cv.width;
      const img = () => { W.render(0); return c.getImageData(0, 0, cv.width, cv.height).data; };
      const sel = g.sel, pend = g.pending; g.sel = null; g.pending = null; const bg = img(); g.sel = sel; g.pending = pend; const on = img();
      const hex = g.map.theme.path, road = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      const at = (d, x, y) => { const k = (Math.floor(y) * Wd + Math.floor(x)) * 4; return [d[k], d[k + 1], d[k + 2]]; };
      const bare = (x, y, tol) => at(bg, x, y).every((v, i) => Math.abs(v - road[i]) <= tol);
      const find = (tx, ty) => { for (let r = 0; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = tx * T + dx, y = ty * T + dy; if (bare(x, y, 2)) return [x, y]; } return null; };
      const warm = p => p[0] + p[1] - 2 * p[2], lum = p => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      const pin = find(4.5, 3.5), pout = find(2.0, 3.5); // both on Meadow's row-3 stretch: 2.0 and 3.2 tiles from the tile centre
      // The ring (radius 2.4T) where it crosses bare road: the darkest pixel there.
      const R = 2.4 * T, cx = 4.5 * T, cy = 5.5 * T; let n = 0, min = 1e9;
      for (let i = 0; i < 1440; i++) { const a = i / 1440 * Math.PI * 2, x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R; if (!bare(x, y, 8)) continue; n++; min = Math.min(min, lum(at(on, x, y))); }
      return { pin, pout, wIn: warm(at(on, ...pin)), wOut: warm(at(on, ...pout)), wOutBg: warm(at(bg, ...pout)), wInBg: warm(at(bg, ...pin)), roadLum: lum(road), n, min };
    });
    check(pv.pin && pv.pout && pv.wIn - pv.wOut >= 25, `a road pixel inside range is ${pv.wIn - pv.wOut} units warmer (R+G-2B) than one outside (>= 25) ` + JSON.stringify(pv));
    check(pv.wOut === pv.wOutBg && pv.wIn > pv.wInBg + 25, 'the glow is clipped to the range: road outside it is untouched');
    check(pv.n >= 20 && pv.min < pv.roadLum - 60, `the ring edge where it crosses the road has luminance ${pv.min.toFixed(1)} < road luminance ${pv.roadLum.toFixed(1)} - 60 (${pv.n} points on bare road)`);
    // The dash on top: #fff6d8 over the dark backing. Unaffordable: red fill and glow, #ff9a85 dash, and 'Not enough gold yet.'
    const dash = ok => G(page, ([ok, pin, pout]) => { const W = window.__pw, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS; W.render(0);
      const R = 2.4 * T, want = ok ? [0xff, 0xf6, 0xd8] : [0xff, 0x9a, 0x85]; let n = 0;
      for (let i = 0; i < 720; i++) { const a = i / 720 * Math.PI * 2, d = c.getImageData(Math.floor(4.5 * T + Math.cos(a) * R), Math.floor(5.5 * T + Math.sin(a) * R), 1, 1).data; if (Math.abs(d[0] - want[0]) <= 24 && Math.abs(d[1] - want[1]) <= 24 && Math.abs(d[2] - want[2]) <= 24) n++; }
      const p = q => [...c.getImageData(Math.floor(q[0]), Math.floor(q[1]), 1, 1).data].slice(0, 3); return { n, road: p(pin), out: p(pout) }; }, [ok, pv.pin, pv.pout]);
    const okD = await dash(true);
    await setGold(page, 10);
    const poorInfo = await text(page, '#infoMsg'), poorD = await dash(false);
    check(okD.n > 120 && poorD.n > 120, 'the edge is dashed #fff6d8, or #ff9a85 when the tower is unaffordable ' + JSON.stringify({ ok: okD.n, poor: poorD.n }));
    check(/Covers \d+\.\d tiles of road\. Not enough gold yet\.$/.test(poorInfo), 'unaffordable: "Covers N tiles of road. Not enough gold yet." (' + poorInfo + ')');
    check(poorD.road[1] < poorD.out[1] - 30 && poorD.road[0] >= poorD.out[0] - 5 && okD.road[2] < okD.out[2], 'and the covered road turns red instead of gold ' + JSON.stringify({ ok: okD, poor: poorD }));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 780 }]) {
    // The placing line beside every wave button label, for every tower, affordable or not: it fits #infoMsg and keeps the name and coverage.
    // (wave-intel: the instruction is the first thing dropped where space is short; see the 'placing line keeps each tower's trait' block.)
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    const res = await G(page, () => {
      const W = window.__pw, g = W.G, info = document.querySelector('#infoMsg'), bw = document.querySelector('#bWave'), out = [];
      g.running = false; g.hintTiles = [];
      const states = { 'Start wave 1': () => { g.wave = 0; g.W = {}; g.spawnQ = []; g.sendArmAt = 0; }, 'Send anyway?': () => { g.wave = 0; g.W = {}; g.spawnQ = []; g.sendArmAt = performance.now(); }, 'Call 12 early': () => { g.wave = 11; g.W = { 11: { rem: 0, alive: 1 } }; g.spawnQ = []; } };
      for (const gold of [9999, 0]) for (const [label, set] of Object.entries(states)) for (const k of Object.keys(W.TD)) {
        set(); g.gold = gold; g.selTower = null; g.sel = { c: 4, r: 5 }; g.pending = k; W.refreshPanel();
        const tx = info.textContent;
        out.push({ label: bw.textContent, k, fits: info.scrollHeight <= info.clientHeight + 1, name: tx.startsWith(W.TD[k].name), cov: /Covers \d+\.\d tiles of road\./.test(tx), full: tx.includes(W.TD[k].desc) });
      }
      g.sel = null; g.pending = null; g.W = {}; g.wave = 0; W.refreshPanel();
      return out;
    });
    const bad = res.filter(r => !r.fits || !r.name || !r.cov);
    check(bad.length === 0 && res.length === 30, `${vp.width}px: for every tower and wave button label, the placing line fits #infoMsg and keeps the name and 'Covers N tiles of road.' ` + JSON.stringify(bad.slice(0, 3)));
    if (vp.width === 390) check(res.filter(r => r.label === 'Start wave 1' && r.k !== 'long').every(r => r.full), '390px beside Start wave 1: the description is kept for every tower but Longshot');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'tower-readability-range: a selected tower shows where its next level reaches';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await calmBoard(page, 0);
    await G(page, () => { const W = window.__pw; W.build('bolt', 4, 5); W.G.towers[0].born = -10; });
    await tapTile(page, 4, 5);
    check(await G(page, () => window.__pw.G.selTower === window.__pw.G.towers[0]), 'the level 1 bolt is selected');
    // ringDiff(rad): of 360 points on a circle of rad tiles round the tower, how many differ (> 20 in a channel) from the frame with no selection.
    const ringDiff = rads => G(page, rads => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS, t = g.towers[0];
      const img = () => { W.render(0); return c.getImageData(0, 0, cv.width, cv.height).data; };
      const on = img(), s = g.selTower; g.selTower = null; const off = img(); g.selTower = s;
      return rads.map(rad => { let n = 0; for (let i = 0; i < 360; i++) { const a = i / 360 * Math.PI * 2, k = (Math.floor(t.y * T + Math.sin(a) * rad * T) * cv.width + Math.floor(t.x * T + Math.cos(a) * rad * T)) * 4;
        if (Math.max(Math.abs(on[k] - off[k]), Math.abs(on[k + 1] - off[k + 1]), Math.abs(on[k + 2] - off[k + 2])) > 20) n++; } return n; }); }, rads);
    const l1 = await ringDiff([2.4 + 0.3, 2.4 + 0.6]);
    check(l1[0] >= 120, `select a level 1 tower and render: pixels on radius range+0.3 differ from the frame with no selection (${l1[0]} of 360)`);
    check(l1[1] === 0, 'nothing is drawn further out (range+0.6) ' + l1[1]);
    const col = await G(page, () => { const W = window.__pw, g = W.G, cv = document.querySelector('#cv'), c = cv.getContext('2d'), T = cv.width / W.COLS;
      const img = () => { W.render(0); return c.getImageData(0, 0, cv.width, cv.height).data; }, on = img(), s = g.selTower; g.selTower = null; const off = img(); g.selTower = s;
      const goldish = (d, k) => d[k] > d[k + 2] + 60 && d[k + 1] > d[k + 2] + 30; let gold = 0;
      for (let i = 0; i < 360; i++) { const a = i / 360 * Math.PI * 2, k = (Math.floor(5.5 * T + Math.sin(a) * 2.7 * T) * cv.width + Math.floor(4.5 * T + Math.cos(a) * 2.7 * T)) * 4; if (goldish(on, k) && !goldish(off, k)) gold++; } return gold; });
    check(col >= 80, 'the next-level ring is a gold (#f3d27a) dash: points on grass that turn gold ' + col);
    await G(page, () => { const W = window.__pw; W.upgrade(W.G.towers[0]); });
    const l2 = await ringDiff([2.7 + 0.3, 2.7]);
    check(l2[0] >= 90 && l2[1] > 60, 'at level 2 the ring moves out to the level 3 range, and the current range is 2.7 ' + JSON.stringify(l2));
    await G(page, () => { const W = window.__pw; W.upgrade(W.G.towers[0]); });
    const l3 = await ringDiff([3.0 + 0.3]);
    check(l3[0] === 0, 'a level 3 tower has no next-level ring ' + l3[0]);
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'tower-readability-range: the placing and ready lines refit after a rotation';
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 667, height: 375 } });
    await startMap(page, 1);
    const fit = () => page.$eval('#infoMsg', el => ({ sh: el.scrollHeight, ch: el.clientHeight, w: el.clientWidth, t: el.textContent }));
    const rotate = async (w, h) => { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250); };
    await tapTile(page, 4, 5); await page.click('.tw[data-t="arc"]');
    const a = await fit();
    check(a.sh <= a.ch + 1 && /Covers \d+\.\d tiles of road\./.test(a.t), 'landscape 667x375: the placing line fits #infoMsg ' + JSON.stringify(a));
    await rotate(375, 667);
    const b = await fit();
    check(b.w !== a.w && b.sh <= b.ch + 1 && /^Arc · .*Covers \d+\.\d tiles of road\./.test(b.t), 'rotated to portrait 375x667: the placing line is refit to the new width, not cut off ' + JSON.stringify(b));
    await tapTile(page, 1, 0); await page.click('.tw[data-t="mortar"]');
    await rotate(844, 390);
    const c = await fit();
    check(c.t.startsWith('Mortar ready') && c.sh <= c.ch + 1, 'landscape 844x390: the ready line fits ' + JSON.stringify(c));
    await rotate(320, 568);
    const d = await fit();
    check(d.w < c.w && d.t.startsWith('Mortar ready') && d.sh <= d.ch + 1, 'rotated to a 320x568 portrait: the ready line is refit, not cut off ' + JSON.stringify(d));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // wave-intel: #info is a message (#infoMsg) over the next wave's chips (#chips): an icon and a count per enemy type. A tapped chip
  // shows that type for 4s; a type's first wave gets a one-time 'New:' intro (S.seen); the placing line keeps each tower's trait.
  // intel(page): #infoMsg's text and line classes, whether it fits, and the chips (shown, collapsed for a detail, one row, contents).
  const intel = page => G(page, () => { const m = document.querySelector('#infoMsg'), c = document.querySelector('#chips'), i = document.querySelector('#info');
    return { msg: m.textContent, html: m.innerHTML, l1: m.classList.contains('l1'), l2: m.classList.contains('l2'), coach: m.classList.contains('coach'), fits: m.scrollHeight <= m.clientHeight + 1,
      chips: !c.hidden && c.getBoundingClientRect().height > 0, off: c.classList.contains('off'), one: c.classList.contains('one'), types: [...c.querySelectorAll('.chip')].map(x => x.dataset.t + x.textContent).join(' '), infoSH: i.scrollHeight }; });

  current = 'wave-intel: next-wave chips with enemy icons';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    check(await page.$eval('#info', el => { const [m, c] = el.children; return el.children.length === 2 && m.id === 'infoMsg' && c.id === 'chips' && c.getAttribute('role') === 'button' && c.getAttribute('tabindex') === '0'; }), '#info holds <div id="infoMsg"> and <div id="chips" role="button" tabindex="0">');
    const css = await page.evaluate(() => { const cs = s => getComputedStyle(document.querySelector(s)), i = cs('#info'), c = cs('#chips'); return { clamp: i.webkitLineClamp, disp: i.display, max: i.maxHeight, ov: i.overflow, cDisp: c.display, wrap: c.flexWrap, gap: c.rowGap + ' ' + c.columnGap, lh: c.lineHeight, cOv: c.overflow }; });
    check(css.clamp === 'none' && css.disp === 'block' && css.max === '50px' && css.ov === 'hidden', '#info has no line clamp of its own and keeps max-height 50px, overflow hidden ' + JSON.stringify(css));
    check(css.cDisp === 'flex' && css.wrap === 'wrap' && css.gap === '2px 8px' && css.lh === '16px' && css.cOv === 'hidden', '#chips: display flex, flex-wrap wrap, gap 2px 8px, line-height 16px, overflow hidden ' + JSON.stringify(css));
    // Acceptance.
    // (themed-waves-balance: wave 5 is now a Swarm of Scouts and Splitters, so the flier outline is checked on wave 6.)
    const a1 = await G(page, () => { const W = window.__pw; W.newGame(1);
      const at = w => { W.G.wave = w - 1; W.refreshPanel(); const cv = [...document.querySelectorAll('#chips canvas')];
        return { cv, n: cv.length, want: new Set(W.buildWave(w).map(g => g[0])).size, fly: cv.filter(c => { const s = getComputedStyle(c); return s.outlineStyle === 'solid' && s.outlineWidth === '1px' && s.outlineColor === 'rgb(143, 208, 255)'; }).map(c => c.parentNode.dataset.t) }; };
      const w6 = at(6), w5 = at(5), cv = w5.cv;
      return { n: w5.n, want: w5.want, fly: w6.fly, n6: w6.n, want6: w6.want,
        radius: getComputedStyle(cv[0]).borderRadius, size: cv.map(c => [c.width, c.height, c.getBoundingClientRect().width, c.getBoundingClientRect().height].join()) }; });
    check(a1.n === a1.want && a1.n === 2 && a1.n6 === a1.want6 && a1.n6 === 4, `newGame(1); G.wave=4; refreshPanel(): the '#chips canvas' count (${a1.n}) equals the number of distinct types in __pw.buildWave(5) (${a1.want}), and so for wave 6 (${a1.n6})`);
    check(a1.fly.length === 1 && a1.fly[0] === 'wisp', 'before wave 6 one chip, the Wisp, has the 1px #8fd0ff flier outline ' + JSON.stringify(a1.fly));
    check(a1.size.every(s => s === '16,16,16,16') && a1.radius === '4px', 'each chip icon is a 16x16 css canvas with 4px corners ' + JSON.stringify(a1.size));
    // (review fix: the type the 'New' intro names leads the row. Fresh storage meets Scouts and Splitters in wave 5, and the intro names
    // the Splitter, so it comes first; with both met, the wave's own order.)
    const cnt = await G(page, () => { const W = window.__pw, m = {}; for (const [t, c] of W.buildWave(5)) m[t] = (m[t] || 0) + c; const list = () => [...document.querySelectorAll('#chips .chip')];
      const chips = list(), cs = getComputedStyle(chips[0].querySelector('span')), font = cs.fontSize + ' ' + cs.fontWeight + ' ' + cs.color, got = chips.map(c => c.dataset.t + c.textContent), keep = W.S.seen;
      W.S.seen = Object.keys(W.ED); W.refreshPanel(); const met = list().map(c => c.dataset.t + c.textContent); W.S.seen = keep; W.refreshPanel();
      const want = Object.entries(m).map(([t, c]) => t + '×' + c); return { got, met, want, lead: [want[1], want[0]], font }; });
    check(JSON.stringify(cnt.met) === JSON.stringify(cnt.want) && JSON.stringify(cnt.got) === JSON.stringify(cnt.lead), "each chip is its icon plus ×n, the count of its type in the wave, in the order the wave sends them, except that the type the 'New' intro names leads " + JSON.stringify(cnt));
    check(cnt.font === '12px 800 rgb(240, 233, 210)', 'the count is 12px, weight 800, in ink (' + cnt.font + ')');
    const outl = await G(page, () => { const W = window.__pw, o = w => { W.G.wave = w - 1; W.refreshPanel(); return Object.fromEntries([...document.querySelectorAll('#chips .chip')].map(c => { const s = getComputedStyle(c.querySelector('canvas')); return [c.dataset.t, s.outlineStyle === 'none' ? 'none' : s.outlineWidth + ' ' + s.outlineColor]; })); }; return { w6: o(6), w20: o(20) }; });
    check(outl.w6.brute === '1px rgb(214, 219, 224)' && outl.w6.grunt === 'none' && outl.w6.scout === 'none', 'the armored Brute chip has a 1px #d6dbe0 outline; Grunt and Scout have none ' + JSON.stringify(outl.w6));
    check(outl.w20.boss === '1px rgb(164, 135, 255)' && outl.w20.wisp === '1px rgb(143, 208, 255)', 'the Warlord chip has a 1px #a487ff outline ' + JSON.stringify(outl.w20));
    // The icons are the enemies themselves (drawEnemy), centred, with nothing cut off at the canvas edge.
    const ic = await G(page, () => { const W = window.__pw, out = {};
      for (const w of [6, 9, 20]) { W.G.wave = w - 1; W.refreshPanel();
        for (const c of document.querySelectorAll('#chips canvas')) { const d = c.getContext('2d').getImageData(0, 0, 16, 16).data, t = c.parentNode.dataset.t; let n = 0, edge = 0, sx = 0, sy = 0;
          for (let i = 0; i < 256; i++) { const x = i % 16, y = (i / 16) | 0; if (d[i * 4 + 3] > 40) { n++; sx += x + 0.5; sy += y + 0.5; if (x === 0 || y === 0 || x === 15 || y === 15) edge++; } }
          out[t] = { n, edge, cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), mid: [...d.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 3)] }; } }
      return out; });
    check(Object.keys(ic).length === 6 && Object.values(ic).every(v => v.n > 40 && v.edge === 0), 'every type draws an icon (Grunt, Scout, Brute, Wisp, Splitter, Warlord) and none touches the canvas edge ' + JSON.stringify(ic));
    check(near3(ic.grunt.mid, [0xc9, 0x58, 0x3a], 4) && Object.values(ic).every(v => Math.abs(v.cy - 8) < 1.2 && Math.abs(v.cx - 8) < 2.5), 'drawn with drawEnemy and centred: the Grunt chip is the grunt colour at its centre ' + JSON.stringify(ic.grunt));
    // aria-label: 'Next wave: ' + waveSummary. Acceptance: it includes '(air)' when the next wave has wisps.
    const lab = await G(page, () => { const W = window.__pw, l = w => { W.G.wave = w - 1; W.refreshPanel(); return document.querySelector('#chips').getAttribute('aria-label'); }; return { w6: l(6), w1: l(1), w5: l(5) }; });
    check(lab.w6 === 'Next wave: 14 Grunts, 7 Scouts, 1 Brute, 4 Wisps (air)', "#chips aria-label includes '(air)' when the next wave has wisps (" + lab.w6 + ')');
    check(lab.w1 === 'Next wave: 7 Grunts' && !lab.w5.includes('(air)'), 'and not for a wave with no fliers ' + JSON.stringify(lab));
    // The chips are rebuilt only when the road or the wave changes, not on every gold change.
    const cache = await G(page, () => new Promise(res => { const W = window.__pw; W.G.running = false; W.G.wave = 4; W.refreshPanel(); const c0 = document.querySelector('#chips canvas'); W.G.gold += 37;
      requestAnimationFrame(() => requestAnimationFrame(() => { const same = document.querySelector('#chips canvas') === c0, gold = document.querySelector('#sGold span').textContent; W.G.wave = 5; W.refreshPanel(); res({ same, gold, g: W.G.gold, rebuilt: document.querySelector('#chips canvas') !== c0 }); })); }));
    check(cache.same && cache.gold === String(cache.g) && cache.rebuilt, 'a gold change (refreshPanel) keeps the same chip canvases; a new wave rebuilds them ' + JSON.stringify(cache));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
    // DPR-scaled canvases.
    const hi = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const hp = await hi.newPage(); await hp.goto(`${BASE}/index.html`); await hp.waitForTimeout(250); await startMap(hp, 1);
    const dpr = await G(hp, () => [...document.querySelectorAll('#chips canvas')].map(c => c.width + 'x' + c.height + '/' + c.getBoundingClientRect().width));
    check(dpr.length === 1 && dpr.every(d => d === '32x32/16'), 'at DPR 2 each chip canvas is 32x32, shown at 16 css px ' + JSON.stringify(dpr));
    await hi.close();
  }

  current = 'wave-intel: what #infoMsg says, and when the chips show';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    let st = await intel(page);
    check(st.msg === 'Build first: tap a grass tile beside the road.' && st.coach && st.l2 && st.chips && st.one && st.fits && st.types === 'grunt×7', "wave 0 with no towers: the 'Build first' line, in ink on 2 lines, over one row of chips " + JSON.stringify(st));
    await tapTile(page, 2, 2);
    st = await intel(page);
    check(st.msg === 'Pick a tower to place here.' && !st.chips && !st.l1 && !st.l2, 'a selected tile hides the chips and the message has all 3 lines ' + JSON.stringify(st));
    await page.click('.tw[data-t="bolt"]');
    st = await intel(page);
    check(st.msg.startsWith('Bolt · ') && st.msg.includes('Covers') && !st.chips && st.fits, 'placing uses the full #info, as before ' + JSON.stringify(st));
    await page.waitForTimeout(300); await tapTile(page, 2, 2);
    st = await intel(page);
    check((await G(page, () => window.__pw.G.towers.length === 1 && window.__pw.G.pending === 'bolt')) && st.msg === 'Next wave:' && st.l1 && st.chips && !st.one, "built, with Bolt kept armed: 'Next wave:' on one line over the chips " + JSON.stringify(st));
    await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="frost"]');
    st = await intel(page);
    check(st.msg.startsWith('Frost ready. Tap grass to place it.') && !st.chips, 'a tower armed on purpose hides the chips for its ready line ' + JSON.stringify(st));
    await page.click('.tw[data-t="frost"]');
    // Acceptance: select a tower.
    await tapTile(page, 2, 2);
    st = await intel(page);
    check(st.chips && st.msg.startsWith('Next level') && st.l1 && st.fits && st.msg.includes('Dmg 18'), "select a tower: #chips is still visible and #infoMsg starts with 'Next level', on one line " + JSON.stringify(st));
    await tapTile(page, 2, 2);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.startWave(); W.refreshPanel(); });
    st = await intel(page);
    check(st.msg === 'Wave 1 is marching in. Next:' && st.html === 'Wave <b>1</b> is marching in. Next:' && st.chips && st.types === 'grunt×9', "while a wave spawns: 'Wave <b>1</b> is marching in. Next:' over wave 2's chips " + JSON.stringify(st));
    await clearAll(page); await G(page, () => window.__pw.refreshPanel());
    st = await intel(page);
    check(st.msg === 'Next wave:' && st.l1 && st.chips && st.types === 'grunt×9', "between waves: 'Next wave:' " + JSON.stringify(st));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = "wave-intel: a selected tower's line fits one line";
  for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 780 }]) {
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    await calmBoard(page, 30); // endless next: 'Start wave 31' is the widest label beside it
    const res = await G(page, () => { const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'), i = document.querySelector('#info'), out = [];
      for (const k of Object.keys(W.TD)) { g.towers = []; g.grid = W.MAPS[1].grid.slice(); W.build(k, 4, 5); const t = g.towers[0];
        for (const lv of [1, 2, 3]) { while (t.level < lv) W.upgrade(t); g.selTower = t; W.refreshPanel();
          const tx = m.textContent; out.push({ k, lv, t: tx, l1: m.classList.contains('l1'), fits: m.scrollHeight <= m.clientHeight + 1, info: i.scrollHeight, ok: lv < 3 ? tx.startsWith('Next level: Dmg ') : tx === W.TD[k].desc || tx === W.TD[k].key }); } }
      g.selTower = null; g.towers = []; W.refreshPanel(); return out; });
    const bad = res.filter(r => !r.l1 || !r.fits || r.info > 50 || !r.ok);
    check(bad.length === 0 && res.length === 15, `${vp.width}px beside 'Start wave 31': every tower's Next level line (levels 1-2) and max-level line (level 3) fits its one line ` + JSON.stringify(bad.slice(0, 3)));
    const mortar = res.find(r => r.k === 'mortar' && r.lv === 1);
    check(!mortar.t.includes('Ground') && mortar.t.includes('Dmg 48'), `${vp.width}px: the Mortar's Next level line drops 'Ground only' first (it never changes, and #tvStats shows it) instead of ending in 'Ground…' (${mortar.t})`);
    if (vp.width === 390) check(mortar.t === 'Next level: Dmg 48 · Splash 1.1', "390px: then the rate, then the range (the board's next-level ring shows it): 'Next level: Dmg 48 · Splash 1.1' (" + mortar.t + ')');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = "wave-intel: a one-time 'New' intro for each enemy type";
  {
    const { ctx, page } = await newPage(browser);
    check(JSON.stringify(await G(page, () => window.__pw.S.seen)) === '["grunt"]' && JSON.stringify((await stored(page)).seen) === '["grunt"]', 'fresh storage: S.seen is ["grunt"], and it is saved');
    await startMap(page, 1);
    // (themed-waves-balance: wave 5 is a Swarm and wave 7 an Air raid now, so this walks waves 6-7 and 9 instead of 5-6 and 7.)
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); W.G.wave = 5; W.refreshPanel(); });
    let st = await intel(page);
    check(st.msg.includes('New:') && st.msg.includes('Wisp'), "fresh storage at G.wave=5: #infoMsg includes 'New:' and 'Wisp' (" + st.msg + ')');
    check(st.html === "<b>New:</b> Wisp. Flies. Mortars can't hit it." && st.l2 && st.one && st.chips && st.fits, 'it is <b>New:</b> and the blurb, on 2 lines over one row of chips (Scouts and Brutes are new too; the type the game introduces last is named) ' + JSON.stringify(st));
    const sw = await G(page, () => { const W = window.__pw, g = W.G; W.startWave(); return { sub: g.banner.sub, sr: document.querySelector('#sr').textContent, seen: W.S.seen.slice(), ls: JSON.parse(localStorage.getItem('pathwarden.v1')).seen }; });
    check(sw.sub === 'New: Scout, Brute, Wisp' && sw.sr === 'Wave 6. New: Scout, Brute, Wisp', "the WAVE 6 banner's sub names what is new: 'New: Scout, Brute, Wisp' " + JSON.stringify(sw));
    check(sw.seen.includes('wisp') && sw.seen.includes('scout') && JSON.stringify(sw.ls) === JSON.stringify(sw.seen), 'startWave adds every type in the wave to S.seen and saves it ' + JSON.stringify(sw.ls));
    const nw = await G(page, () => { const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'); g.wave = 8; g.spawnQ = [{ at: 1e9, type: 'grunt', w: 8 }]; g.W = { 8: { rem: 1, alive: 0 } }; W.refreshPanel();
      const r = { msg: m.textContent, l2: m.classList.contains('l2') }; g.wave = 6; g.spawnQ = []; g.W = {}; W.refreshPanel(); return r; });
    check(nw.msg.startsWith('New: Splitter. Bursts') && nw.l2, "the 'New' intro outranks 'Wave 8 is marching in': wave 9 brings the first Splitter (" + nw.msg + ')');
    await page.reload(); await page.waitForTimeout(250);
    check((await G(page, () => window.__pw.S.seen)).includes('wisp'), 'after a reload S.seen includes wisp');
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.G.wave = 5; W.build('bolt', 6, 6); W.refreshPanel(); });
    st = await intel(page);
    check(!st.msg.includes('Wisp') && st.msg === 'Next wave:' && st.l1 && !st.one, 'and at G.wave=5 the New line no longer mentions Wisp: wave 6 has nothing new (' + st.msg + ')');
    // Each type once: the Brute's first wave (6), then the Warlord's (10). Waves 9 and 11 bring nothing new here.
    const seq = await G(page, () => { const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'), out = []; W.S.seen = ['grunt', 'scout', 'wisp', 'splitter'];
      const at = w => { g.W = {}; g.spawnQ = []; g.enemies = []; g.wave = w - 1; W.refreshPanel(); return m.textContent; };
      out.push(at(6), at(9), at(10), at(11));
      g.W = {}; g.spawnQ = []; g.wave = 5; W.startWave(); const b6 = g.banner.sub; out.push(at(6));
      g.wave = 9; W.startWave(); const b10 = g.banner.sub; out.push(at(10));
      return { out, b6, b10, seen: W.S.seen.slice().sort().join() }; });
    // (review fix: the Brute's whole blurb runs past the intro's 2 lines on a 390px phone, so 'Armored, so small hits do less.' goes
    // and the line still ends on what it costs; see "the 'New' intro on every phone" below.)
    check(seq.out[0] === 'New: Brute. Longshot ignores armor. Costs 2 lives.' && seq.out[1] === 'Next wave:' && seq.out[2] === 'New: Warlord. Heavy armor. Costs 5 lives.' && seq.out[3] === 'Next wave:', 'before waves 6 and 10 the Brute and the Warlord get their blurbs (the Brute\'s shortened to fit its 2 lines) ' + JSON.stringify(seq.out));
    check(seq.b6 === 'New: Brute' && seq.b10 === 'A Warlord is coming', "banner subs: 'New: Brute'; a Warlord's first wave keeps 'A Warlord is coming' " + JSON.stringify(seq));
    check(seq.out[4] === 'Next wave:' && seq.out[5] === 'Next wave:' && seq.seen === 'boss,brute,grunt,scout,splitter,wisp', 'once met, neither is introduced again ' + JSON.stringify(seq));
    const subs = await G(page, () => { const W = window.__pw, keep = W.S.seen, sub = (seen, w) => { W.S.seen = seen; return W.bannerSub(w); };
      const all = Object.keys(W.ED), r = { a: sub(['grunt', 'scout', 'brute', 'splitter', 'boss'], 20), b: sub(all, 8), c: sub(['grunt', 'scout'], 9), d: sub(['grunt', 'scout', 'brute', 'splitter', 'boss'], 7) }; W.S.seen = keep; return r; });
    check(subs.a === 'A Warlord is coming · New: Wisp' && subs.b === '' && subs.c === 'Swarm · New: Splitter' && subs.d === 'Air raid · New: Wisp', "bannerSub joins its parts with ' · ' (a theme first, then what is new) " + JSON.stringify(subs));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-intel: S.seen for players from before 1.1';
  {
    const { ctx, page } = await newPage(browser);
    const load = async v => { await page.evaluate(v => localStorage.setItem('pathwarden.v1', JSON.stringify(v)), v); await page.reload(); await page.waitForTimeout(200); return { seen: await G(page, () => window.__pw.S.seen.slice()), ls: (await stored(page)).seen }; };
    const b12 = await load({ best: { meadow: 12 } });
    check(b12.seen.includes('splitter') && b12.seen.includes('brute'), "storage with best {meadow:12} and no seen: S.seen includes 'splitter' and 'brute' after load " + JSON.stringify(b12.seen));
    check(b12.seen.slice().sort().join() === 'boss,brute,grunt,scout,splitter,wisp' && JSON.stringify(b12.ls) === JSON.stringify(b12.seen), 'it is grunt plus every type in waves 1-12, and it is saved ' + JSON.stringify(b12));
    const b4 = await load({ best: { quarry: 4, switch: 2 }, saves: { quarry: { map: 'quarry', wave: 4, gold: 100, lives: 20, towers: [] } } });
    check(b4.seen.join() === 'grunt,scout,brute', 'best of 4 (the highest of any road): grunt, scout, brute; no wisp yet ' + JSON.stringify(b4.seen));
    await page.click('#bContinue');
    const st = await intel(page);
    check(st.msg.startsWith('New: Splitter.'), 'continuing that run at wave 4 introduces the Splitter: wave 5 is a Swarm (' + st.msg + ')');
    await G(page, () => { window.__pw.G.running = false; }); // so the reloads below do not save the run (and S) over the storage set for them
    const odd = [];
    for (const v of [{ best: { meadow: 1e9 } }, { best: { meadow: 'x', quarry: null } }, { seen: 'wisp', best: { meadow: 5 } }, { seen: ['wisp', 'laser', 7, 'wisp', 'constructor'] }]) odd.push((await load(v)).seen.join());
    // (review fix: seeded from 1.0's waves, which a 1.0 best covers: Wisps from wave 5, the first Splitters in wave 7.)
    check(odd[0] === 'grunt,scout,brute,wisp,splitter,boss' && odd[1] === 'grunt' && odd[2] === 'grunt,scout,brute,wisp' && odd[3] === 'grunt,wisp', 'a huge or broken best, or a broken seen list, still loads to a clean S.seen ' + JSON.stringify(odd));
    // A 1.0 player with best 5 met Wisps in 1.0's wave 5 and no Splitter yet (1.0's first was in wave 7). So 1.1's wave-5 Swarm
    // introduces the Splitter, and wave 6 does not introduce the Wisp again. With best 6 the Splitter is still new.
    const b5 = await load({ best: { meadow: 5 } });
    await startMap(page, 1);
    const in5 = await G(page, () => { const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'); g.running = false; W.build('bolt', 2, 2); const at = w => { g.wave = w - 1; W.refreshPanel(); return m.textContent; };
      const r = { w5: at(5), w6: at(6) }; g.wave = 0; return r; });
    const b6 = await load({ best: { meadow: 6 } });
    check(b5.seen.join() === 'grunt,scout,brute,wisp' && in5.w5.startsWith('New: Splitter.') && !in5.w6.includes('Wisp') && b6.seen.join() === 'grunt,scout,brute,wisp', 'a 1.0 best of 5 or 6: S.seen is what 1.0\'s waves 1-5 brought (grunt, scout, brute, wisp), so the wave-5 Swarm introduces the Splitter and wave 6 says nothing about Wisps ' + JSON.stringify({ b5: b5.seen, in5, b6: b6.seen }));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = "wave-intel: the 'New' intro and every preview fit a 320px phone";
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(page, 1);
    // Acceptance: the #info scrollHeight in the New-intro state.
    const r = await G(page, () => { const W = window.__pw, g = W.G, i = document.querySelector('#info'), m = document.querySelector('#infoMsg'), c = document.querySelector('#chips'), out = {}; g.running = false; W.build('bolt', 2, 2);
      for (const [w, seen] of [[4, ['grunt']], [5, ['grunt', 'scout', 'wisp']], [8, ['grunt', 'scout', 'brute', 'wisp']], [9, ['grunt', 'scout', 'brute', 'wisp', 'splitter']]]) {
        W.S.seen = seen; g.wave = w; W.refreshPanel(); out[w + 1] = { sh: i.scrollHeight, msg: m.textContent.slice(0, 16), l2: m.classList.contains('l2'), rows: c.clientHeight }; }
      W.S.seen = ['grunt', 'scout', 'brute', 'wisp', 'splitter', 'boss']; return out; });
    check(Object.values(r).every(x => x.sh <= 50 && x.msg.startsWith('New: ') && x.l2 && x.rows === 16), 'at 320x568 the #info scrollHeight is <= 50 in the New-intro state (Splitter in the wave-5 and wave-9 Swarms, Brute, Warlord) ' + JSON.stringify(r));
    // Every wave to 40, between waves and while it marches in: #info stays within 50px and every chip is whole.
    // (themed-waves-balance: before wave 7, the run's first Air raid, the message is the Air raid line, also while wave 6 marches in.)
    const all = await G(page, () => { const W = window.__pw, g = W.G, i = document.querySelector('#info'), m = document.querySelector('#infoMsg'), c = document.querySelector('#chips'), bad = []; let two = 0, marchFit = 0;
      let twoLines = 0, short = 0, air = [];
      for (let w = 0; w <= 40; w++) for (const spawning of w ? [false, true] : [false]) {
        g.wave = w; g.W = {}; g.spawnQ = spawning ? [{ at: 1e9, type: 'grunt', w }] : []; W.refreshPanel();
        const rows = c.scrollHeight > 17 ? 2 : 1, whole = c.scrollHeight <= c.clientHeight + 1, fits = m.scrollHeight <= m.clientHeight + 1, tx = m.textContent;
        if (rows === 2) two++;
        if (spawning && tx === `Wave ${w} is marching in. Next:`) { marchFit++; if (m.classList.contains('l2')) twoLines++; }
        if (spawning && tx === 'Next wave:') { short++; if (rows !== 2) bad.push({ w, why: 'shortened over one row' }); }
        const airLine = tx === "Air raid next: Mortars can't hit fliers.";
        if (airLine) air.push(w + (spawning ? 's' : ''));
        if (i.scrollHeight > 50 || !whole || !fits || (spawning && !tx.endsWith('Next:') && tx !== 'Next wave:' && !airLine)) bad.push({ w, spawning, sh: i.scrollHeight, whole, fits, msg: tx });
      }
      g.spawnQ = []; W.refreshPanel(); return { bad, two, marchFit, twoLines, short, air: air.join() }; });
    check(all.bad.length === 0 && all.two > 5, `320px, waves 1-41, between waves and while one marches in: #info is never over 50px, every chip shows whole (${all.two} previews take two rows), and no message is cut ` + JSON.stringify(all.bad.slice(0, 3)));
    check(all.marchFit + all.short === 39 && all.air === '6,6s' && all.twoLines > 5 && all.short > 0, `320px: 'Wave N is marching in. Next:' takes a second line over one row of chips (${all.twoLines} times); over two rows it becomes 'Next wave:' (${all.short} times); before wave 7 the Air raid line shows instead ` + JSON.stringify(all));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // (review fixes) The 'New' intro on every phone, in the order a player meets the types: it fits its 2 lines (the Brute's blurb drops
  // sentences after the name, so it still ends on what the Brute costs), the type it names leads the one row of chips (on a 320px
  // phone a 4-type wave has no room for its last chip, and that must not be the new one), and a themed wave keeps its tag.
  current = "wave-intel: the 'New' intro on every phone";
  for (const vp of [{ width: 320, height: 568 }, { width: 330, height: 600 }, { width: 360, height: 640 }, { width: 390, height: 780 }, { width: 844, height: 390 }]) {
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    const r = await G(page, () => { const W = window.__pw, g = W.G, i = document.querySelector('#info'), m = document.querySelector('#infoMsg'), c = document.querySelector('#chips'), out = []; g.running = false; W.build('bolt', 2, 2);
      const met = w => { const s = ['grunt']; for (let x = 1; x < w; x++) for (const [t] of W.buildWave(x)) if (!s.includes(t)) s.push(t); return s; };
      // Waves 4, 5, 6 and 10 bring the Brute, the Splitter (in the first Swarm), the Wisp and the Warlord. Wave 9 is the Swarm where a
      // player from 1.0 with a best of 5 or 6 meets the Splitter.
      for (const [w, seen] of [[4], [5], [6], [9, ['grunt', 'scout', 'brute', 'wisp']], [10]]) for (const st of ['calm', 'early', 'march']) {
        W.S.seen = seen || met(w); g.wave = w - 1; g.W = {}; g.spawnQ = [];
        if (st === 'early') g.W = { [w - 1]: { rem: 0, alive: 1 } };
        if (st === 'march') { g.spawnQ = [{ at: 1e9, type: 'grunt', w: w - 1 }]; g.W = { [w - 1]: { rem: 1, alive: 0 } }; }
        W.refreshPanel();
        const nt = W.newTypes(w), type = nt[nt.length - 1], cr = c.getBoundingClientRect(), chips = [...c.querySelectorAll('.chip')], tag = c.querySelector('.theme');
        const inside = x => { const b = x.getBoundingClientRect(); return b.bottom <= cr.bottom + 0.5 && b.right <= cr.right + 0.5; };
        out.push({ w, st, type, msg: m.textContent, l2: m.classList.contains('l2'), fits: m.scrollHeight <= m.clientHeight + 1, ends: m.textContent.endsWith(W.BLURB[type].split('. ').pop()),
          named: m.textContent.startsWith(`New: ${W.ED[type].name}.`), lead: !!chips[0] && chips[0].dataset.t === type && inside(chips[0]), cut: chips.filter(x => !inside(x)).map(x => x.dataset.t),
          tag: tag ? !tag.hidden && inside(tag) : null, sh: i.scrollHeight, label: document.querySelector('#bWave').textContent });
      }
      W.S.seen = Object.keys(W.ED); g.W = {}; g.spawnQ = []; W.refreshPanel(); return out; });
    // At 320px wave 6 (Wisp, Grunt, Scout, Brute) leaves its last chip, the one Brute, past the row: the Wisp it introduces leads.
    const bad = r.filter(x => !x.l2 || !x.fits || !x.ends || !x.named || !x.lead || x.tag === false || x.sh > 50 || x.cut.length > (vp.width === 320 && x.w === 6 ? 1 : 0));
    check(bad.length === 0 && r.length === 15, `${vp.width}px: every 'New' intro (Brute, Splitter, Wisp, Warlord; between waves, beside the early call and while a wave marches in) fits its 2 lines, keeps the name and the blurb's last sentence, leads the chips with the type it names, and keeps the theme tag ` + JSON.stringify(bad.slice(0, 3)));
    const brute = r.filter(x => x.w === 4).map(x => x.msg);
    // (While wave 3 marches in, the shorter 'Wave 3…' leaves room for 'Longshot ignores armor.' as well.)
    if (vp.width === 320) check(brute[0] === 'New: Brute. Costs 2 lives.' && brute[1] === brute[0] && brute[2] === 'New: Brute. Longshot ignores armor. Costs 2 lives.' && r.filter(x => x.w === 5).every(x => x.tag) && r.find(x => x.w === 5 && x.st === 'early').label === 'Call early +45', "320px: the Brute's line is 'New: Brute. Costs 2 lives.' (beside 'Wave 3…' it keeps 'Longshot ignores armor.' too), and the wave-5 Swarm keeps its tag, also beside 'Call early +45' " + JSON.stringify(brute));
    if (vp.width === 390) check(brute.every(x => x === 'New: Brute. Longshot ignores armor. Costs 2 lives.'), "390px: 'New: Brute. Longshot ignores armor. Costs 2 lives.' " + JSON.stringify(brute));
    if (vp.width === 320) await page.screenshot({ path: path.join(__dirname, 'out', 'new-intro-320.png') });
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'wave-intel: tap a chip for its details';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); W.S.seen = Object.keys(W.ED); W.G.wave = 5; W.refreshPanel(); });
    // Acceptance.
    await page.click('#chips .chip[data-t="brute"]');
    const t0 = await G(page, () => performance.now());
    let st = await intel(page);
    check(st.msg.includes('Armor') && st.msg.includes('Longshot ignores armor'), "tap the brute chip at wave 6: #infoMsg includes 'Armor' and 'Longshot ignores armor' (" + st.msg + ')');
    const head = await G(page, () => { const W = window.__pw, w = 6, hp = Math.round(175 * (1 + W.CFG.hpA * (w - 1) + W.CFG.hpB * (w - 1) ** 2) * W.G.map.hp); return `Brute ×1 · ${hp} HP · Slow · Armor ${(3 * (1 + (w - 1) * 0.03)).toFixed(0)}. `; });
    check(st.msg.startsWith(head) && st.msg.endsWith('Longshot ignores armor. Costs 2 lives.') && st.fits && st.html.startsWith('<b>Brute</b> ×1'), `the detail: <b>Brute</b> ×n · HP · speed · Armor a, then the blurb, which drops sentences from its front to fit 3 lines (${st.msg})`);
    check(!st.chips && st.off && !st.l1 && !st.l2, 'the chips make way and the detail gets 3 lines ' + JSON.stringify(st));
    check((await page.$eval('#sr', el => el.textContent)) === head + 'Brute. Armored, so small hits do less. Longshot ignores armor. Costs 2 lives.', 'the whole detail is read out to screen readers');
    const wait = async ms => { const left = await G(page, ([t0, ms]) => t0 + ms - performance.now(), [t0, ms]); if (left > 0) await page.waitForTimeout(left); };
    await wait(3000);
    st = await intel(page);
    check(!st.chips && st.msg.startsWith('Brute'), 'it is still up 3s later');
    await wait(4200);
    st = await intel(page);
    check(st.chips && !st.off && st.msg === 'Next wave:', 'after 4.2s the chips show again ' + JSON.stringify(st));
    // Every type's detail at 390px: the full spec line.
    // (themed-waves-balance: the Splitter is checked in the wave-9 Swarm, and HP follows CFG, which the retune changed.)
    const det = await G(page, () => { const W = window.__pw, g = W.G, out = {};
      for (const w of [6, 9, 20]) { g.wave = w - 1; g.chipTip = null; W.refreshPanel();
        for (const c of [...document.querySelectorAll('#chips .chip')]) { c.click(); const m = document.querySelector('#infoMsg'); out[c.dataset.t + w] = { t: m.textContent, fits: m.scrollHeight <= m.clientHeight + 1 }; } }
      g.chipTip = null; g.wave = 5; W.refreshPanel(); out.cfg = { hpA: W.CFG.hpA, hpB: W.CFG.hpB, split9: W.buildWave(9).find(x => x[0] === 'splitter')[1] }; return out; });
    const hpOf = (base, w) => Math.round(base * (1 + det.cfg.hpA * (w - 1) + det.cfg.hpB * (w - 1) ** 2));
    check(det.grunt6.t === `Grunt ×14 · ${hpOf(42, 6)} HP · Normal. Grunt. Steady and common.` && det.scout6.t === `Scout ×7 · ${hpOf(22, 6)} HP · Fast. Scout. Fast and fragile.`, 'Grunt: Normal; Scout: Fast (speed over 1.3) ' + JSON.stringify([det.grunt6, det.scout6]));
    check(det.wisp6.t === `Wisp ×4 · ${hpOf(36, 6)} HP · Normal. Wisp. Flies. Mortars can't hit it.` && det.splitter9.t === `Splitter ×${det.cfg.split9} · ${hpOf(80, 9)} HP · Normal. Splitter. Bursts into 2 Scouts.`, 'Wisp and Splitter ' + JSON.stringify([det.wisp6, det.splitter9]));
    check(det.boss20.t === `Warlord ×2 · ${hpOf(900, 20)} HP · Slow · Armor 9. Warlord. Heavy armor. Costs 5 lives.`, 'Warlord at wave 20: Slow, Armor (6*(1+19*0.03)).toFixed(0) = 9 ' + JSON.stringify(det.boss20));
    check(Object.entries(det).every(([k, d]) => k === 'cfg' || d.fits), 'every detail fits its 3 lines at 390px ' + JSON.stringify(Object.keys(det)));
    // A tap anywhere along the row picks the nearest chip (they are only 16px tall); a tile tap closes the detail.
    const box = await rect(page, '#chips');
    await page.mouse.click(box.right - 3, box.top + 8);
    check((await G(page, () => window.__pw.G.chipTip && window.__pw.G.chipTip.type)) === 'wisp', 'a tap past the last chip picks the nearest one (the Wisp)');
    await tapTile(page, 4, 5);
    check((await G(page, () => window.__pw.G.chipTip)) === null && (await text(page, '#infoMsg')) === 'Pick a tower to place here.', 'a tile tap closes the detail');
    await tapTile(page, 4, 5);
    // Keyboard: Enter on #chips picks the first chip, again the next; the wave does not start and focus stays on #chips.
    await G(page, () => document.activeElement.blur());
    for (let i = 0; i < 8 && (await G(page, () => document.activeElement.id)) !== 'chips'; i++) await page.keyboard.press('Tab');
    check(await page.$eval('#chips', el => document.activeElement === el && getComputedStyle(el).outlineStyle === 'solid'), 'Tab reaches #chips, which shows a focus ring');
    await page.keyboard.press('Enter');
    const k1 = await G(page, () => ({ t: window.__pw.G.chipTip && window.__pw.G.chipTip.type, wave: window.__pw.G.wave, focus: document.activeElement.id, msg: document.querySelector('#infoMsg').textContent }));
    await page.keyboard.press('Enter');
    const k2 = await G(page, () => ({ t: window.__pw.G.chipTip.type, wave: window.__pw.G.wave, focus: document.activeElement.id }));
    await page.keyboard.press(' ');
    const k3 = await G(page, () => ({ t: window.__pw.G.chipTip.type, wave: window.__pw.G.wave, focus: document.activeElement.id }));
    check(k1.t === 'grunt' && k1.msg.startsWith('Grunt ×14') && k1.wave === 5 && k1.focus === 'chips', 'Enter on #chips shows the first chip, and does not start the wave ' + JSON.stringify(k1));
    check(k2.t === 'scout' && k3.t === 'brute' && k3.wave === 5 && k3.focus === 'chips', 'Enter again, then Space, step to the next chips; focus stays on #chips ' + JSON.stringify([k2, k3]));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = "wave-intel: the placing line keeps each tower's trait";
  for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 780 }]) {
    // Lead designer: keep the name, the trait and 'Covers N tiles of road'; drop 'Tap again to build.' first; then shorten the trait
    // to its key phrase. For every tower, wave button label and gold, the key phrase is visible: the line fits #infoMsg and contains it.
    // (Arc's description, 'Lightning jumps between foes.', states its trait in full without the word 'Chains'.)
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    const res = await G(page, () => {
      const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'), bw = document.querySelector('#bWave'), out = [];
      g.running = false; g.hintTiles = [];
      const states = { 'Start wave 1': () => { g.wave = 0; g.W = {}; g.spawnQ = []; g.sendArmAt = 0; }, 'Send anyway?': () => { g.wave = 0; g.W = {}; g.spawnQ = []; g.sendArmAt = performance.now(); }, 'Call 12 early': () => { g.wave = 11; g.W = { 11: { rem: 0, alive: 1 } }; g.spawnQ = []; }, 'Start wave 31': () => { g.wave = 30; g.W = {}; g.spawnQ = []; } };
      for (const gold of [9999, 0]) for (const [label, set] of Object.entries(states)) for (const k of Object.keys(W.TD)) {
        set(); g.gold = gold; g.selTower = null; g.sel = { c: 4, r: 5 }; g.pending = k; W.refreshPanel();
        const tx = m.textContent, d = W.TD[k];
        out.push({ label: bw.textContent, k, nm: d.name, gold, tx, fits: m.scrollHeight <= m.clientHeight + 1, name: tx.startsWith(d.name + ' · '), cov: /Covers \d+\.\d tiles of road\./.test(tx), key: tx.includes(d.key), desc: tx.includes(d.desc), tail: /Tap again to build\.|Not enough gold yet\./.test(tx) });
      }
      g.sel = null; g.pending = null; g.W = {}; g.wave = 0; W.refreshPanel();
      return { out, keys: Object.fromEntries(Object.keys(W.TD).map(k => [k, W.TD[k].key])) };
    });
    const bad = res.out.filter(r => !r.fits || !r.name || !r.cov || !(r.key || (r.k === 'arc' && r.desc)));
    check(bad.length === 0 && res.out.length === 40, `${vp.width}px: for all five towers beside every wave label, affordable or not, the placing line fits #infoMsg (scrollHeight <= clientHeight) and keeps the name, the trait's key phrase and the coverage ` + JSON.stringify(bad.slice(0, 3)));
    check(JSON.stringify(res.keys) === '{"bolt":"Hits fliers","mortar":"Ground only","frost":"Slows","arc":"Chains","long":"Ignores armor"}', 'the key phrases: Bolt "Hits fliers", Mortar "Ground only", Frost "Slows", Arc "Chains", Longshot "Ignores armor"');
    if (vp.width === 390) {
      const s1 = res.out.filter(r => r.label === 'Start wave 1' && r.gold);
      check(s1.filter(r => r.k !== 'long').every(r => r.desc && r.tail) && s1.find(r => r.k === 'long').desc && !s1.find(r => r.k === 'long').tail, "390px beside 'Start wave 1': four towers keep the full spec line; Longshot keeps its description and drops 'Tap again to build.' first " + JSON.stringify(s1.map(r => r.tx)));
    } else {
      const sa = res.out.filter(r => r.label === 'Send anyway?' && r.gold);
      check(sa.length === 5 && sa.every(r => !r.tail && r.tx.startsWith(`${r.nm} · ${res.keys[r.k]}`)), "320px beside 'Send anyway?': no room for the description, so it is the key phrase, and 'Tap again to build.' is gone " + JSON.stringify(sa.map(r => r.tx)));
      check(res.out.find(r => r.k === 'mortar' && r.label === 'Send anyway?' && r.gold).tx.includes('Ground only'), "320px: Mortar keeps 'Ground only' wherever it goes");
    }
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // targeting-early-call: three target modes (First, Toughest, Fliers), First by default on every tower, a 4s line in #infoMsg on
  // what a mode does, 1.0 modes migrated on load, and an early call that pays CFG.earlyMul*(10+w) on an outlined button that says so.
  const MODE_TIPS = { First: 'First: shoots whoever is closest to the keep.', Toughest: 'Toughest: focuses Brutes and Warlords. Fliers may slip past.', Fliers: 'Fliers: shoots fliers first, then the leader.' };
  // modeState(page): the Target button's label, the selected tower's mode, and what #infoMsg, #chips and #sr show.
  const modeState = page => G(page, () => { const m = document.querySelector('#infoMsg'), c = document.querySelector('#chips'), t = window.__pw.G.selTower;
    return { small: document.querySelector('#bMode small').textContent, mode: t && t.mode, msg: m.textContent, html: m.innerHTML, fits: m.scrollHeight <= m.clientHeight + 1, lines: m.classList.contains('l1') ? 1 : m.classList.contains('l2') ? 2 : 3,
      off: c.classList.contains('off'), chips: !c.hidden && c.getBoundingClientRect().height > 0, info: document.querySelector('#info').scrollHeight, sr: document.querySelector('#sr').textContent }; });
  // wbtn(page): #bWave's text, markup, class, aria-label and look.
  const wbtn = page => page.$eval('#bWave', el => { const cs = getComputedStyle(el), sm = el.querySelector('small'), ss = sm && getComputedStyle(sm);
    return { text: el.textContent.trim(), html: el.innerHTML, early: el.classList.contains('early'), disabled: el.disabled, aria: el.getAttribute('aria-label'), bg: cs.backgroundColor, color: cs.color,
      border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`, shadow: cs.boxShadow, small: ss ? `${ss.fontSize} ${ss.fontWeight}` : '', sw: el.scrollWidth, cw: el.clientWidth }; });

  current = 'targeting-early-call: First, Toughest and Fliers, with First the default';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    // Acceptance: the Longshot (1.0 default 'strong') now starts on First, like every other tower.
    const def = await G(page, () => { const W = window.__pw; W.newGame(1); W.build('long', 4, 5); const long = W.G.towers[0].mode, all = {};
      Object.keys(W.TD).forEach((k, i) => { W.G.gold = 9999; W.build(k, i * 2, 0); all[k] = W.G.towers[W.G.towers.length - 1].mode; }); return { long, all }; });
    check(def.long === 'first', "__pw.newGame(1); __pw.build('long',4,5): G.towers[0].mode === 'first' (" + def.long + ')');
    check(Object.values(def.all).length === 5 && Object.values(def.all).every(m => m === 'first'), 'every tower type starts on First ' + JSON.stringify(def.all));
    // Acceptance: a Bolt cycles Toughest, Fliers, First. Each tap says what the new mode does in #infoMsg.
    await tapTile(page, 0, 0);
    const first = await modeState(page);
    check(first.small === 'First' && first.msg.startsWith('Next level') && first.lines === 1 && first.chips, 'a selected Bolt reads Target: First, with its Next level line over the chips ' + JSON.stringify(first));
    const seq = [];
    for (let i = 0; i < 3; i++) { await page.click('#bMode'); seq.push(await modeState(page)); }
    check(seq.map(s => s.small).join(',') === 'Toughest,Fliers,First' && seq.map(s => s.mode).join(',') === 'tough,air,first', "select a bolt and tap #bMode 3 times: the small labels read 'Toughest','Fliers','First' " + JSON.stringify(seq.map(s => s.small + '/' + s.mode)));
    check(seq.every(s => s.msg === MODE_TIPS[s.small]), 'each tap shows the spec line for the new mode in #infoMsg ' + JSON.stringify(seq.map(s => s.msg)));
    check(seq.every(s => s.html.startsWith(`<b>${s.small}:</b> `) && s.fits && s.lines === 3 && s.off && !s.chips && s.info <= 50), 'the mode name is bold, the line gets 3 lines and fits, and the chips make way for it ' + JSON.stringify(seq.map(s => [s.html.slice(0, 20), s.fits, s.lines, s.off, s.info])));
    check(seq.every(s => s.sr === MODE_TIPS[s.small]), 'each line is read out to screen readers (#sr) ' + JSON.stringify(seq.map(s => s.sr)));
    // It stays up for 4s, then the Next level line and the chips come back.
    const t0 = await G(page, () => performance.now());
    const wait = async ms => { const left = await G(page, ([t0, ms]) => t0 + ms - performance.now(), [t0, ms]); if (left > 0) await page.waitForTimeout(left); };
    await wait(3000);
    const at3 = await modeState(page);
    check(at3.msg === MODE_TIPS.First && at3.off, 'it is still up 3s after the tap ' + JSON.stringify(at3));
    await wait(4200);
    const at4 = await modeState(page);
    check(at4.msg.startsWith('Next level') && at4.lines === 1 && at4.chips && !at4.off, 'after 4.2s the Next level line and the chips are back ' + JSON.stringify(at4));
    // Acceptance: a Mortar can't hit fliers, so it cycles Toughest, First (and never Fliers).
    await tapTile(page, 2, 0);
    const mor = [];
    for (let i = 0; i < 4; i++) { await page.click('#bMode'); mor.push(await modeState(page)); }
    check(mor.map(s => s.small).join(',') === 'Toughest,First,Toughest,First' && mor.every(s => s.msg === MODE_TIPS[s.small]), "a mortar cycles 'Toughest','First' " + JSON.stringify(mor.map(s => s.small)));
    // Frost, Arc and Longshot hit fliers, so they cycle all three.
    const cyc = await G(page, () => { const W = window.__pw, g = W.G, out = {};
      for (const k of ['frost', 'arc', 'long']) { const t = g.towers.find(x => x.type === k && x.r === 0); g.selTower = t; W.refreshPanel(); const l = [];
        for (let i = 0; i < 3; i++) { document.querySelector('#bMode').click(); l.push(document.querySelector('#bMode small').textContent); } out[k] = l.join(','); }
      return out; });
    check(Object.values(cyc).every(v => v === 'Toughest,Fliers,First'), 'Frost, Arc and Longshot cycle Toughest, Fliers, First ' + JSON.stringify(cyc));
    // Anything else done to the tower, or a tap on the board, takes the line down at once.
    await tapTile(page, 0, 0);
    await page.click('#bMode'); await page.click('#bUp');
    const up = await modeState(page);
    check(up.msg.startsWith('Next level') && up.chips, 'Upgrade right after a Target tap shows the new Next level line ' + JSON.stringify(up));
    await page.click('#bMode'); await tapTile(page, 2, 0);
    const other = await modeState(page);
    check(other.small === 'First' && other.msg.startsWith('Next level') && other.chips, "selecting another tower doesn't carry the line over " + JSON.stringify(other));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'targeting-early-call: Toughest and Fliers pick their targets';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    // Acceptance: a level-3 Longshot on Toughest, a grunt at 8 and a brute at 6 (wave 10: the brute takes more than two shots).
    const tough = await G(page, () => { const W = window.__pw;
      const run = mode => { W.newGame(1); const g = W.G; g.wave = 10; g.gold = 9999; W.build('long', 4, 5); const t = g.towers[0]; W.upgrade(t); W.upgrade(t); t.mode = mode;
        W.spawn('grunt', 8); W.spawn('brute', 6); const [gr, br] = g.enemies, h = [gr.hp, br.hp], d = [gr.dist, br.dist]; let shots = 0;
        for (let i = 0; i < 75; i++) { W.step(1 / 30); shots += g.fx.filter(f => f.k === 'tracer' && f.t === 1 / 30).length; }
        return { level: t.level, ahead: d[0] > d[1], grunt: gr.hp < h[0], brute: br.hp < h[1], shots, inRange: [gr, br].every(e => Math.hypot(e.x - t.x, e.y - t.y) < 5.2) }; };
      return { tough: run('tough'), first: run('first') }; });
    check(tough.tough.level === 3 && tough.tough.ahead && tough.tough.inRange && tough.tough.shots >= 2, 'set-up: a level 3 Longshot with the grunt ahead, both in range, firing twice in 2.5s ' + JSON.stringify(tough.tough));
    check(tough.tough.brute && !tough.tough.grunt, "Toughest: after 2.5s the brute's hp dropped and the grunt's did not " + JSON.stringify(tough.tough));
    check(tough.first.grunt && !tough.first.brute, 'First: the same Longshot shoots the grunt ahead instead ' + JSON.stringify(tough.first));
    // Acceptance: a Bolt on Fliers with a wisp behind a grunt shoots the wisp first.
    const air = await G(page, () => { const W = window.__pw;
      const run = (mode, foes) => { W.newGame(1); const g = W.G; g.wave = 5; W.build('bolt', 4, 5); const t = g.towers[0]; t.mode = mode;
        for (const [k, d] of foes) W.spawn(k, d); const es = g.enemies.slice(); let tg = null;
        for (let i = 0; i < 18; i++) { W.step(1 / 30); if (!tg && g.projs.length) tg = es.indexOf(g.projs[0].tg); }
        return { tg, hit: es.map(e => e.hp < e.max) }; };
      return { air: run('air', [['grunt', 7], ['wisp', 6]]), first: run('first', [['grunt', 7], ['wisp', 6]]), leader: run('air', [['grunt', 6], ['grunt', 7]]) }; });
    check(air.air.tg === 1 && air.air.hit[1] && !air.air.hit[0], "Fliers: a bolt with a wisp behind a grunt shoots the wisp first (and the grunt isn't hit in 0.6s) " + JSON.stringify(air.air));
    check(air.first.tg === 0 && air.first.hit[0] && !air.first.hit[1], 'First: the same bolt shoots the grunt ahead ' + JSON.stringify(air.first));
    check(air.leader.tg === 1, 'Fliers with no flier in range shoots the leader ' + JSON.stringify(air.leader));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'targeting-early-call: 1.0 target modes load as the new ones';
  {
    const { ctx, page } = await newPage(browser);
    const meadow = [{ type: 'long', c: 2, r: 2, mode: 'strong' }, { type: 'bolt', c: 4, r: 2, mode: 'strong' }, { type: 'arc', c: 3, r: 5, mode: 'close' }];
    // Every other case on Quarry: 'last' becomes First, a Mortar's 'strong' Toughest; a Mortar can't be on Fliers; unknown modes go.
    const quarry = [{ type: 'frost', c: 0, r: 0, mode: 'last' }, { type: 'mortar', c: 2, r: 0, mode: 'strong' }, { type: 'mortar', c: 6, r: 0, mode: 'air' }, { type: 'bolt', c: 8, r: 0, mode: 'air' },
      { type: 'frost', c: 2, r: 5, mode: 'laser' }, { type: 'long', c: 5, r: 5, mode: 'tough' }, { type: 'arc', c: 3, r: 10 }];
    await page.evaluate(([meadow, quarry]) => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { map: 'meadow', wave: 3, gold: 100, lives: 20, towers: meadow }, quarry: { map: 'quarry', wave: 2, gold: 100, lives: 20, towers: quarry } }, last: 'meadow' })), [meadow, quarry]);
    await page.reload(); await page.waitForTimeout(250);
    const sv = await G(page, () => { const s = window.__pw.S.saves, ls = JSON.parse(localStorage.getItem('pathwarden.v1')).saves, m = l => l.towers.map(t => String(t.mode)).join(); return { meadow: m(s.meadow), quarry: m(s.quarry), stored: m(ls.meadow) }; });
    check(sv.meadow === 'first,tough,first', "a save with towers [{type:'long',mode:'strong'},{type:'bolt',mode:'strong'},{type:'arc',mode:'close'}] loads as modes first, tough, first (" + sv.meadow + ')');
    check(sv.stored === 'first,tough,first', 'and the migrated modes are written back to storage (' + sv.stored + ')');
    check(sv.quarry === 'first,tough,undefined,air,undefined,tough,undefined', "'last' becomes first, a Mortar's 'strong' tough; a Mortar on 'air', an unknown mode and no mode load as undefined; air and tough stay (" + sv.quarry + ')');
    await page.click('#bContinue');
    const run = await G(page, () => window.__pw.G.towers.map(t => t.mode).join());
    check(run === 'first,tough,first', 'Continue builds the run with those modes ' + run);
    await tapTile(page, 4, 2);
    check((await page.$eval('#bMode small', el => el.textContent)) === 'Toughest', "the 1.0 'Strongest' Bolt reads Target: Toughest");
    await G(page, () => { window.__pw.G.running = false; }); await page.reload(); await page.waitForTimeout(250); // so the reload doesn't save Meadow over Quarry's test
    await startMap(page, 2);
    const q = await G(page, () => window.__pw.G.towers.map(t => t.mode).join());
    check(q === 'first,tough,first,air,first,tough,first', 'on Quarry every dropped mode starts on First ' + q);
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'targeting-early-call: an early call pays 3x(10+w) and says so on the button';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    check((await G(page, () => window.__pw.CFG.earlyMul)) === 3, 'CFG.earlyMul is 3');
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); W.refreshPanel(); });
    const s0 = await wbtn(page);
    check(s0.text === 'Start wave 1' && !s0.early && s0.bg === 'rgb(227, 173, 69)' && s0.color === 'rgb(43, 31, 7)' && s0.shadow !== 'none' && s0.aria === null, "'Start wave' keeps the solid brass primary style " + JSON.stringify(s0));
    await page.click('#bWave');
    const s1 = await wbtn(page);
    check(s1.text === 'Wave 1…' && s1.disabled && !s1.early, 'while wave 1 spawns: Wave 1…, disabled, not early ' + JSON.stringify(s1));
    // Acceptance: step until the spawn queue is empty with enemies alive.
    const alive = await G(page, () => { const W = window.__pw, g = W.G; while (g.spawnQ.length) W.step(1 / 30); W.refreshPanel(); return g.enemies.length; });
    const e1 = await wbtn(page);
    check(alive > 0 && e1.early && /Call 2 early\s*\+36/.test(e1.text) && /^Call 2 early\s*\+36$/.test(e1.text), "wave 1 on the road: #bWave has class 'early' and reads 'Call 2 early +36' (" + e1.text + ', ' + alive + ' alive)');
    check(e1.html === 'Call 2 early <small>+36</small>' && !e1.disabled, 'the bonus is a <small> beside the label ' + JSON.stringify(e1.html));
    check(e1.bg === 'rgb(44, 58, 40)' && e1.color === 'rgb(227, 173, 69)' && e1.border === '1px solid rgb(227, 173, 69)' && e1.shadow === 'none' && e1.small === '12px 800', '#bWave.early: panel-2 background, brass text, a 1px brass border and no shadow; the bonus at 12px, weight 800 ' + JSON.stringify(e1));
    check(e1.aria === 'Call wave 2 early for 36 bonus gold', 'its aria-label says the wave and the bonus (' + e1.aria + ')');
    const keep = await G(page, () => { const W = window.__pw, sm = document.querySelector('#bWave small'); W.G.gold += 5; W.refreshPanel(); return document.querySelector('#bWave small') === sm; });
    check(keep, "a gold change (refreshPanel on every kill) keeps the button's <small>, so a tap on it is never lost");
    const g0 = await G(page, () => window.__pw.G.gold);
    await page.click('#bWave');
    const af = await G(page, () => ({ gold: window.__pw.G.gold, wave: window.__pw.G.wave, toast: document.querySelector('#toast').textContent }));
    check(af.gold === g0 + 36 && af.wave === 2, 'tapping it adds exactly 36 gold and sends wave 2 ' + JSON.stringify({ g0, ...af }));
    check(af.toast === 'Called early · +36 gold', 'the toast still says what was paid (' + af.toast + ')');
    const s2 = await wbtn(page);
    check(s2.text === 'Wave 2…' && !s2.early && s2.aria === null, 'once called, the button is back to the spawning state ' + JSON.stringify(s2));
    // Any wave: the label and the payout are CFG.earlyMul*(10+w).
    const b12 = await G(page, () => { const W = window.__pw, g = W.G; g.spawnQ = []; g.enemies = []; g.W = { 11: { rem: 0, alive: 1 } }; g.wave = 11; W.refreshPanel(); const bw = document.querySelector('#bWave'), label = bw.textContent, g0 = g.gold; bw.click(); return { label, paid: g.gold - g0, wave: g.wave }; });
    check(/^Call 12 early\s*\+66$/.test(b12.label) && b12.paid === 66 && b12.wave === 12, 'at wave 11 the button reads Call 12 early +66 and pays 66 ' + JSON.stringify(b12));
    // A calm board again: 'Start wave' and its brass look come back.
    const s3 = await G(page, () => { const W = window.__pw, g = W.G; g.spawnQ = []; g.enemies = []; g.W = {}; W.refreshPanel(); const bw = document.querySelector('#bWave'); return { text: bw.textContent, early: bw.classList.contains('early'), bg: getComputedStyle(bw).backgroundColor }; });
    check(s3.text === 'Start wave 13' && !s3.early && s3.bg === 'rgb(227, 173, 69)', 'with the board calm it is Start wave 13 in brass again ' + JSON.stringify(s3));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'targeting-early-call: the early call fits narrow phones';
  for (const vp of [{ width: 320, height: 640 }, { width: 320, height: 568 }, { width: 360, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 780 }]) {
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    const res = await G(page, () => { const W = window.__pw, g = W.G, bw = document.querySelector('#bWave'), m = document.querySelector('#infoMsg'), out = [];
      g.running = false; W.S.seen = Object.keys(W.ED); W.build('bolt', 2, 2); W.build('mortar', 4, 5);
      for (const w of [1, 11, 29, 98]) {
        // (review fix: a run on wave 98 has won the campaign. Until it is won, wave 31 can't be called during wave 30.)
        g.spawnQ = []; g.enemies = []; g.W = { [w]: { rem: 0, alive: 1 } }; g.wave = w; g.won = w >= 30; g.selTower = null; W.refreshPanel();
        const row = { w, text: bw.textContent, early: bw.classList.contains('early'), sw: bw.scrollWidth, cw: bw.clientWidth, h: bw.getBoundingClientRect().height, tips: [] };
        // Each mode's line beside it, for a Bolt and a Mortar.
        for (const t of g.towers) { g.selTower = t; for (const mode of ['first', 'tough', 'air']) { if (t.type === 'mortar' && mode === 'air') continue; t.mode = mode; g.modeTip = { t, until: performance.now() + 1e6 };
          W.refreshPanel(); row.tips.push(m.scrollHeight <= m.clientHeight + 1 && document.querySelector('#info').scrollHeight <= 50); } t.mode = 'first'; }
        g.modeTip = null; g.selTower = null; W.refreshPanel(); out.push(row);
      }
      g.W = {}; W.refreshPanel(); return out; });
    const narrow = vp.width <= 360;
    const bad = res.filter(r => !r.early || r.sw > r.cw || r.h !== 42 || !r.tips.every(Boolean) || r.tips.length !== 5 || !(narrow ? /^Call early \+\d+$/ : /^Call \d+ early \+\d+$/).test(r.text) || !r.text.endsWith('+' + 3 * (11 + r.w)));
    check(bad.length === 0 && res.length === 4, `${vp.width}x${vp.height}: in the early state (waves 2, 12, 30 and 99 next) #bWave scrollWidth <= clientWidth, it reads ${narrow ? "'Call early +N'" : "'Call N early +B'"}, and every Target line fits beside it ` + JSON.stringify(bad.slice(0, 2)));
    if (vp.width === 320 && vp.height === 640) check(res[0].text.startsWith('Call early') && res[0].sw <= res[0].cw, "acceptance at 320x640: the text starts with 'Call early' and scrollWidth <= clientWidth " + JSON.stringify(res[0]));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    // A rotation to a narrow width rewrites the label.
    const { ctx, page } = await newPage(browser, { viewport: { width: 390, height: 780 } });
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; W.build('bolt', 2, 2); g.W = { 1: { rem: 0, alive: 1 } }; g.wave = 1; W.refreshPanel(); });
    const wide = await wbtn(page);
    await page.setViewportSize({ width: 320, height: 640 }); await page.waitForTimeout(250);
    const slim = await wbtn(page);
    check(wide.text === 'Call 2 early +36' && slim.text === 'Call early +36' && slim.sw <= slim.cw, 'resized from 390px to 320px, the label drops the wave number ' + JSON.stringify([wide.text, slim.text]));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // themed-waves-balance: from wave 5, non-boss waves rotate by w%4: 1 Swarm, 2 Armored (from wave 14; Mixed before), 3 Air raid,
  // 0 Mixed. A themed wave spends CFG.themeBudget (0.85) of the Mixed wave's unit HP on two types. #chips leads with the theme's
  // tag, bannerSub names it, and before the run's first Air raid #infoMsg says Mortars can't hit fliers. Then one balance retune
  // (CFG.hpB, Quarry's hp), checked by tests/balance.js (run by hand) and recorded in README 'Balance'.
  // OLD_WAVE: buildWave as it was before this item (the Mixed formula and the boss waves), for the snapshots below.
  const OLD_WAVE = w => { const g = [], n = Math.round(6 + w * 1.4), iv = Math.max(0.42, 0.9 - w * 0.016);
    if (w % 10 === 0) { g.push(['grunt', Math.round(n * 0.6), iv, 0]); g.push(['boss', w / 10, 4, 2]); if (w >= 20) g.push(['wisp', 4 + w / 5, 0.6, 2]); return g; }
    g.push(['grunt', n, iv, 0]); if (w >= 3) g.push(['scout', Math.round(n * 0.5), 0.38, 1.6]); if (w >= 4 && w % 2 === 0) g.push(['brute', 1 + Math.floor((w - 4) / 3), 1.8, 1.6]);
    if (w >= 5 && w % 3 !== 1) g.push(['wisp', 2 + Math.floor(w / 3), 0.7, 1.6]); if (w >= 7 && w % 2 === 1) g.push(['splitter', 2 + Math.floor(w / 4), 1.1, 1.6]); return g; };
  const UNIT_HP = { grunt: 42, scout: 22, brute: 175, wisp: 36, splitter: 80, boss: 900 };
  const unitHp = g => g.reduce((s, [t, c]) => s + c * UNIT_HP[t], 0);
  // The run's state after waves 1-6 as a player meets them: every type in them is in S.seen (the Wisp came in wave 6).
  const seenTo = (page, w) => G(page, w => { const W = window.__pw, s = ['grunt']; for (let i = 1; i <= w; i++) for (const [t] of W.buildWave(i)) if (!s.includes(t)) s.push(t); W.S.seen = s; return s.join(); }, w);
  const AIR_LINE = "Air raid next: Mortars can't hit fliers.";

  current = 'themed-waves-balance: the waves';
  {
    const { ctx, page } = await newPage(browser);
    const d = await G(page, () => { const W = window.__pw, out = { waves: {}, mixed: {}, theme: {} };
      for (let w = 1; w <= 60; w++) { out.waves[w] = W.buildWave(w); out.mixed[w] = W.mixedWave(w); out.theme[w] = W.waveTheme(w); }
      out.cfg = { budget: W.CFG.themeBudget }; out.sum = { 7: W.waveSummary(7), 8: W.waveSummary(8), 9: W.waveSummary(9), 14: W.waveSummary(14) }; return out; });
    // Acceptance: waves 1-4 and the boss waves are the old formula (snapshots taken from the build before this item).
    const SNAP14 = '[[["grunt",7,0.884,0]],[["grunt",9,0.868,0]],[["grunt",10,0.852,0],["scout",5,0.38,1.6]],[["grunt",12,0.8360000000000001,0],["scout",6,0.38,1.6],["brute",1,1.8,1.6]]]';
    const SNAPBOSS = '[[["grunt",12,0.74,0],["boss",1,4,2]],[["grunt",20,0.5800000000000001,0],["boss",2,4,2],["wisp",8,0.6,2]],[["grunt",29,0.42000000000000004,0],["boss",3,4,2],["wisp",10,0.6,2]]]';
    check(JSON.stringify([1, 2, 3, 4].map(w => d.waves[w])) === SNAP14 && JSON.stringify([1, 2, 3, 4].map(w => OLD_WAVE(w))) === SNAP14, 'waves 1-4 are unchanged from the old formula (snapshot) ' + JSON.stringify([1, 2, 3, 4].map(w => d.waves[w])));
    check(JSON.stringify([10, 20, 30].map(w => d.waves[w])) === SNAPBOSS && JSON.stringify([10, 20, 30].map(w => OLD_WAVE(w))) === SNAPBOSS, 'buildWave(10), buildWave(20) and buildWave(30) deep-equal the pre-change formula (snapshot) ' + JSON.stringify([10, 20, 30].map(w => d.waves[w])));
    const bossOk = [40, 50, 60].every(w => JSON.stringify(d.waves[w]) === JSON.stringify(OLD_WAVE(w)) && d.theme[w] === '');
    check(bossOk, 'every boss wave (40, 50, 60 too) is unchanged and has no theme');
    // mixedWave is the old non-boss formula, for every wave.
    const mixBad = []; for (let w = 1; w <= 60; w++) if (w % 10 && JSON.stringify(d.mixed[w]) !== JSON.stringify(OLD_WAVE(w))) mixBad.push(w);
    check(mixBad.length === 0, '__pw.mixedWave(w) is the old non-boss formula for every non-boss wave 1-60 ' + JSON.stringify(mixBad));
    // The rotation.
    const want = w => w % 10 === 0 || w < 5 ? '' : w % 4 === 1 ? 'Swarm' : w % 4 === 3 ? 'Air raid' : w % 4 === 2 && w >= 14 ? 'Armored' : 'Mixed';
    const thBad = []; for (let w = 1; w <= 60; w++) if (d.theme[w] !== want(w)) thBad.push(w + ':' + d.theme[w]);
    check(thBad.length === 0, "waveTheme(w) is '' for waves 1-4 and boss waves, then w%4: 1 Swarm, 2 Armored from 14 (Mixed before), 3 Air raid, 0 Mixed " + JSON.stringify(thBad));
    check(d.theme[5] === 'Swarm' && d.theme[7] === 'Air raid' && d.theme[14] === 'Armored' && [8, 12, 16].every(w => d.theme[w] === 'Mixed') && [1, 2, 3, 4].every(w => d.theme[w] === ''), 'the first themes land at wave 5 Swarm and wave 7 Air raid, the first Armored at 14, and Mixed at 8, 12, 16 ' + JSON.stringify([5, 7, 8, 12, 14, 16].map(w => w + ' ' + d.theme[w])));
    // Acceptance: wave 6 has no Armored theme (it is Mixed, the old wave), and wave 14 does.
    check(d.theme[6] !== 'Armored' && d.theme[6] === 'Mixed' && JSON.stringify(d.waves[6]) === JSON.stringify(OLD_WAVE(6)) && !d.waves[6].some(g => g[0] === 'brute' && g[1] > 1) && d.theme[14] === 'Armored', "buildWave(6) has no 'Armored' theme (waveTheme(6) is 'Mixed' and the wave is the old one) and waveTheme(14) === 'Armored'");
    // Acceptance: wave 7's unit HP is within 5% of 0.85 x the Mixed wave 7, and wisps hold at least 70% of it.
    const w7 = d.waves[7], hp7 = unitHp(w7), mix7 = unitHp(OLD_WAVE(7)), wisp7 = unitHp(w7.filter(g => g[0] === 'wisp'));
    check(d.cfg.budget === 0.85 && Math.abs(hp7 / (0.85 * mix7) - 1) <= 0.05 && wisp7 / hp7 >= 0.7, `__pw.buildWave(7) total unit HP ${hp7} is within ±5% of 0.85 × the mixedWave(7) total ${mix7} (${(hp7 / (0.85 * mix7)).toFixed(3)}), and wisps hold ${(100 * wisp7 / hp7).toFixed(1)}% of it`);
    check(JSON.stringify(w7) === JSON.stringify([['grunt', 6, Math.max(0.42, 0.9 - 7 * 0.016), 0], ['wisp', 19, 0.5, 1.6]]), 'wave 7 is 6 Grunts at the usual interval, then 19 Wisps 0.5s apart after a 1.6s gap ' + JSON.stringify(w7));
    // Every themed wave follows its recipe: budget = 0.85 x the Mixed wave's unit HP, split between two types.
    const recipe = w => { const b = 0.85 * unitHp(OLD_WAVE(w)), iv = Math.max(0.42, 0.9 - w * 0.016), k = (t, s) => Math.round(s * b / UNIT_HP[t]);
      return want(w) === 'Swarm' ? [['scout', k('scout', 0.55), 0.3, 0], ['splitter', k('splitter', 0.45), 0.9, 1.6]] : want(w) === 'Armored' ? [['grunt', k('grunt', 0.25), iv, 0], ['brute', k('brute', 0.75), 1.3, 1.6]]
        : want(w) === 'Air raid' ? [['grunt', k('grunt', 0.25), iv, 0], ['wisp', k('wisp', 0.75), 0.5, 1.6]] : OLD_WAVE(w); };
    const recBad = []; for (let w = 1; w <= 60; w++) if (JSON.stringify(d.waves[w]) !== JSON.stringify(recipe(w))) recBad.push(w);
    check(recBad.length === 0, 'waves 1-60: Swarm is 55% Scouts (0.3s) and 45% Splitters (0.9s); Armored 25% Grunts and 75% Brutes (1.3s); Air raid 25% Grunts and 75% Wisps (0.5s); Mixed and early waves the old formula ' + JSON.stringify(recBad));
    const ratio = [5, 7, 9, 11, 13, 14, 15, 17, 18, 19, 21, 22, 23, 25, 26, 27, 29].map(w => unitHp(d.waves[w]) / (0.85 * unitHp(OLD_WAVE(w))));
    check(ratio.every(r => Math.abs(r - 1) <= 0.06), 'every themed wave to 29 carries 0.85 of its Mixed wave\'s unit HP, give or take rounding ' + JSON.stringify(ratio.map(r => +r.toFixed(3))));
    // Acceptance: the aria-label summary names the theme and leads with what the wave brings most of.
    check(d.sum[7] === 'Air raid: 19 Wisps (air), 6 Grunts' && d.sum[9].startsWith('Swarm: ') && d.sum[14].startsWith('Armored: ') && /^\d/.test(d.sum[8]), "waveSummary prefixes the theme: 'Air raid: 19 Wisps (air), 6 Grunts'; a Mixed wave has no prefix " + JSON.stringify(d.sum));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = "themed-waves-balance: the preview's theme tag and the first Air raid line";
  for (const vp of [{ width: 390, height: 780 }, { width: 320, height: 568 }]) {
    const { ctx, page } = await newPage(browser, { viewport: vp });
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); });
    await seenTo(page, 6);
    // Acceptance: G.wave=6; refreshPanel().
    const tag = () => G(page, () => { const c = document.querySelector('#chips'), t = c.querySelector('.theme'), m = document.querySelector('#infoMsg'), i = document.querySelector('#info');
      const cs = t && getComputedStyle(t), r = t && t.getBoundingClientRect();
      return { text: t && t.textContent, cls: t && t.className, first: c.firstElementChild === t, css: t && [cs.fontSize, cs.fontWeight, cs.textTransform, cs.paddingTop + ' ' + cs.paddingRight, cs.borderTopLeftRadius, cs.backgroundColor, cs.color].join('|'), h: r && r.height,
        rows: c.scrollHeight, whole: c.scrollHeight <= c.clientHeight + 1, one: c.classList.contains('one'), chips: !c.hidden && c.getBoundingClientRect().height > 0, aria: c.getAttribute('aria-label'),
        msg: m.textContent, html: m.innerHTML, l2: m.classList.contains('l2'), fits: m.scrollHeight <= m.clientHeight + 1, info: i.scrollHeight, label: document.querySelector('#bWave').textContent }; });
    await G(page, () => { const W = window.__pw; W.G.wave = 6; W.refreshPanel(); });
    let a = await tag();
    check(a.text === 'Air raid' && a.msg.includes("Mortars can't hit fliers"), `${vp.width}px: G.wave=6; refreshPanel(): '#chips .theme' text is 'Air raid' and #infoMsg includes "Mortars can't hit fliers" ` + JSON.stringify(a));
    check(a.msg === AIR_LINE && a.html === "<b>Air raid next:</b> Mortars can't hit fliers." && a.l2 && a.one && a.chips && a.whole && a.fits && a.info <= 50, `${vp.width}px: the line is '${AIR_LINE}', on 2 lines over one row of chips, all of it whole inside #info's 50px ` + JSON.stringify(a));
    check(a.first && a.cls === 'theme air' && a.css === '11px|800|uppercase|1px 6px|6px|rgb(35, 65, 90)|rgb(191, 231, 255)' && a.h === 16, `${vp.width}px: the tag leads #chips: <span class="theme air">, 11px, weight 800, uppercase, padding 1px 6px, radius 6px, #23415a on #bfe7ff, as tall as a chip ` + JSON.stringify(a));
    check(a.aria === 'Next wave: Air raid: 19 Wisps (air), 6 Grunts', "#chips' aria-label: 'Next wave: Air raid: 19 Wisps (air), 6 Grunts' (" + a.aria + ')');
    // The other tags, and none for Mixed, boss or early waves.
    const tags = await G(page, () => { const W = window.__pw, out = {}; W.S.seen = Object.keys(W.ED);
      for (const w of [2, 5, 8, 9, 10, 14, 15, 16]) { W.G.wave = w - 1; W.refreshPanel(); const t = document.querySelector('#chips .theme'), c = document.querySelector('#chips'), cs = t && getComputedStyle(t);
        out[w] = t ? [t.textContent, t.className, cs.backgroundColor, cs.color, c.scrollHeight <= c.clientHeight + 1].join('|') : '-'; }
      return out; });
    check(tags[5] === 'Swarm|theme swarm|rgb(74, 66, 34)|rgb(241, 210, 124)|true' && tags[9] === tags[5], 'Swarm (waves 5, 9): #4a4222 and #f1d27c ' + JSON.stringify(tags));
    check(tags[14] === 'Armored|theme armored|rgb(60, 65, 72)|rgb(225, 230, 234)|true' && tags[15].startsWith('Air raid|theme air|'), 'Armored (wave 14): #3c4148 and #e1e6ea; Air raid again at 15 ' + JSON.stringify(tags));
    check(tags[2] === '-' && tags[8] === '-' && tags[10] === '-' && tags[16] === '-', 'Mixed (8, 16), boss (10) and early (2) waves show no tag');
    // Priority: below the New intro, above 'Wave 6 is marching in', and only before the run's first Air raid.
    const pri = await G(page, () => { const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'), out = {};
      const at = (w, set) => { g.wave = w; g.W = {}; g.spawnQ = []; g.selTower = null; if (set) set(); W.refreshPanel(); return m.textContent; };
      W.S.seen = ['grunt', 'scout', 'brute', 'splitter']; out.newWisp = at(6);
      W.S.seen = Object.keys(W.ED);
      out.marching = at(6, () => { g.spawnQ = [{ at: 1e9, type: 'grunt', w: 6 }]; g.W = { 6: { rem: 1, alive: 0 } }; });
      out.early = at(6, () => { g.W = { 6: { rem: 0, alive: 1 } }; }); out.earlyLabel = document.querySelector('#bWave').textContent;
      out.w11 = at(10); out.w8 = at(7); out.w15 = at(14);
      out.tower = at(6, () => { g.selTower = g.towers[0]; }); g.selTower = null;
      out.back = at(6); return out; });
    check(pri.newWisp.startsWith('New: Wisp.'), "a Wisp not yet met: its 'New' intro comes first (" + pri.newWisp + ')');
    check(pri.marching === AIR_LINE && pri.early === AIR_LINE, "while wave 6 marches in, and once it is all on the road ('" + pri.earlyLabel + "'), the Air raid line still shows " + JSON.stringify(pri));
    check(pri.w11 === 'Next wave:' && pri.w15 === 'Next wave:' && pri.w8 === 'Next wave:', 'only before the first Air raid of the run: not before waves 11 or 15, nor before a Mixed wave ' + JSON.stringify(pri));
    check(pri.tower.startsWith('Next level') && pri.back === AIR_LINE, "a selected tower's line outranks it " + JSON.stringify(pri));
    // Every state of the line fits beside every wave button label it can meet.
    const fit = await G(page, () => { const W = window.__pw, g = W.G, m = document.querySelector('#infoMsg'), c = document.querySelector('#chips'), i = document.querySelector('#info'), bad = [], tags = [];
      for (const st of [{}, { spawnQ: [{ at: 1e9, type: 'grunt', w: 6 }], W: { 6: { rem: 1, alive: 0 } } }, { W: { 6: { rem: 0, alive: 1 } } }]) {
        g.wave = 6; g.W = st.W || {}; g.spawnQ = st.spawnQ || []; W.refreshPanel();
        const tg = c.querySelector('.theme'), chipsIn = [...c.querySelectorAll('.chip')].every(x => x.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5);
        tags.push(document.querySelector('#bWave').textContent + ':' + (tg.hidden ? 'no tag' : 'tag'));
        if (m.textContent !== "Air raid next: Mortars can't hit fliers." || m.scrollHeight > m.clientHeight + 1 || c.scrollHeight > c.clientHeight + 1 || !chipsIn || i.scrollHeight > 50) bad.push({ label: document.querySelector('#bWave').textContent, msg: m.textContent, sh: i.scrollHeight, cs: c.scrollHeight });
      }
      g.W = {}; g.spawnQ = []; W.refreshPanel(); return { bad, tags, back: !document.querySelector('#chips .theme').hidden }; });
    check(fit.bad.length === 0, `${vp.width}px: beside 'Start wave 7', 'Wave 6…' and the early call, the Air raid line and every chip fit ` + JSON.stringify(fit));
    // (review fix) Where one row can't hold it all (320px beside 'Call early +51'), the row first closes up its gaps, which keeps the tag.
    check(fit.tags.every(t => t.endsWith(':tag')) && fit.back && (vp.width === 390 || fit.tags[2] === 'Call early +51:tag'), `${vp.width}px: the tag shows beside every wave button label ` + JSON.stringify(fit));
    // Only where even that is not enough does the tag go, not a chip; it is back once there is room. (#info squeezed to force it.)
    const squeeze = await G(page, () => { const W = window.__pw, g = W.G, c = document.querySelector('#chips'), i = document.querySelector('#info'); g.wave = 6; g.W = { 6: { rem: 0, alive: 1 } }; g.spawnQ = [];
      const st = () => ({ tag: !c.querySelector('.theme').hidden, tight: c.classList.contains('tight'), whole: [...c.querySelectorAll('.chip')].every(x => x.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5) });
      W.refreshPanel(); const a = st(); i.style.maxWidth = '112px'; W.refreshPanel(); const b = st(); i.style.maxWidth = ''; g.W = {}; W.refreshPanel(); const d = st(); return { a, b, d }; });
    check(squeeze.b.tight && !squeeze.b.tag && squeeze.b.whole && squeeze.d.tag && !squeeze.d.tight, `${vp.width}px: squeezed further, the row drops the tag rather than a chip, and both come back with the room ` + JSON.stringify(squeeze));
    // (review fix) A tap on the tag shows the type the theme is built on, not whichever chip is beside it: 'AIR RAID' shows the Wisps.
    await G(page, () => { const W = window.__pw; W.G.wave = 6; W.refreshPanel(); });
    await page.click('#chips .theme');
    check((await G(page, () => window.__pw.G.chipTip && window.__pw.G.chipTip.type)) === 'wisp' && (await text(page, '#infoMsg')).startsWith('Wisp ×19'), 'a tap on the Air raid tag shows the Wisps, not the Grunts beside it ' + (await text(page, '#infoMsg')));
    // Every tag, touch-tapped at its centre: Swarm the Scouts, Armored the Brutes, Air raid the Wisps.
    const tapTag = async w => { await G(page, w => { const W = window.__pw, g = W.G; g.chipTip = null; W.S.seen = Object.keys(W.ED); g.wave = w - 1; W.refreshPanel(); }, w);
      const r = await page.$eval('#chips .theme', el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
      await page.touchscreen.tap(r.x, r.y); return text(page, '#infoMsg'); };
    const tt = { 13: await tapTag(13), 14: await tapTag(14), 15: await tapTag(15) };
    check(tt[13].startsWith('Scout ×') && tt[14].startsWith('Brute ×') && tt[14].includes('Armor') && tt[15].startsWith('Wisp ×') && tt[15].includes("Mortars can't hit it"), "touch-tapping 'SWARM', 'ARMORED' and 'AIR RAID' shows the Scouts, the Brutes and the Wisps " + JSON.stringify(tt));
    await G(page, () => { const W = window.__pw, g = W.G; g.chipTip = null; W.S.seen = ['grunt', 'scout', 'brute', 'splitter', 'wisp']; g.wave = 6; W.refreshPanel(); });
    if (vp.width === 390) await page.screenshot({ path: path.join(__dirname, 'out', 'themed-air-raid-390.png') });
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'themed-waves-balance: the WAVE banner names the theme';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.build('bolt', 2, 2); });
    await seenTo(page, 6);
    // Acceptance: startWave at wave 7.
    const b7 = await G(page, () => { const W = window.__pw, g = W.G; g.wave = 6; W.startWave(); const q = {}; for (const s of g.spawnQ) q[s.type] = (q[s.type] || 0) + 1;
      return { sub: g.banner.sub, s: g.banner.s, sr: document.querySelector('#sr').textContent, q }; });
    check(b7.sub.includes('Air raid') && b7.s === 'WAVE 7', "after startWave at wave 7, G.banner.sub includes 'Air raid' " + JSON.stringify(b7));
    check(b7.sub === 'Air raid' && b7.sr === 'Wave 7. Air raid' && JSON.stringify(b7.q) === '{"grunt":6,"wisp":19}', "with the Wisp already met it is just 'Air raid', read out as 'Wave 7. Air raid', and the wave sends 6 Grunts and 19 Wisps " + JSON.stringify(b7));
    const subs = await G(page, () => { const W = window.__pw, g = W.G, out = {}; const start = (w, seen) => { W.S.seen = seen; g.W = {}; g.spawnQ = []; g.enemies = []; g.wave = w - 1; W.startWave(); return g.banner.sub; };
      const all = Object.keys(W.ED); out[5] = start(5, ['grunt', 'scout', 'brute']); out.w7new = start(7, ['grunt', 'scout', 'brute', 'splitter']); out[8] = start(8, all); out[10] = start(10, all); out[14] = start(14, all); out[9] = start(9, all);
      g.W = {}; g.spawnQ = []; g.enemies = []; return out; });
    check(subs[5] === 'Swarm · New: Splitter' && subs.w7new === 'Air raid · New: Wisp', "the theme comes ahead of the 'New:' text, joined with ' · ' " + JSON.stringify(subs));
    check(subs[9] === 'Swarm' && subs[14] === 'Armored' && subs[8] === '' && subs[10] === 'A Warlord is coming', "Swarm and Armored too; a Mixed wave's banner has no sub, and a boss wave keeps its warning " + JSON.stringify(subs));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'themed-waves-balance: the retune';
  {
    const { ctx, page } = await newPage(browser);
    const v = await G(page, () => { const W = window.__pw; return { cfg: { ...W.CFG }, hp: W.MAPS.map(m => m.hp), td: Object.fromEntries(Object.entries(W.TD).map(([k, d]) => [k, [d.cost, d.range, d.rate, d.dmg, d.splash || 0, d.slow || 0, d.chain || 0].join()])) }; });
    // (review fix: retuned for the plan's smart profile, which does not read the coming waves.)
    check(v.cfg.hpB === 0.021 && v.cfg.themeBudget === 0.85 && v.hp.join() === '0.88,1,1.05', `the shipped retune: CFG.hpB ${v.cfg.hpB}, CFG.themeBudget ${v.cfg.themeBudget}, road hp ${v.hp.join(', ')} (Quarry Run 1.05)`);
    check(v.cfg.hpA === 0.25 && v.cfg.goldGrow === 0.01 && v.cfg.bonusA === 15 && v.cfg.bonusB === 2 && v.cfg.startGold === 200 && v.cfg.earlyMul === 3, 'nothing else in CFG moved ' + JSON.stringify(v.cfg));
    check(JSON.stringify(v.td) === JSON.stringify({ bolt: '50,2.4,0.55,11,0,0,0', mortar: '90,2.4,1.5,30,0.95,0,0', frost: '70,2,1,5,0.75,0.42,0', arc: '130,2.2,1.1,21,0,0,3', long: '120,4.6,2.1,78,0,0,0' }), 'no tower stat changed in this pass ' + JSON.stringify(v.td));
    // README 'Balance' records the numbers.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), bal = readme.slice(readme.indexOf('## Balance'));
    check(readme.includes('## Balance') && bal.includes('`CFG.hpB` 0.021') && bal.includes('`CFG.themeBudget` 0.85') && bal.includes('`hp` 1.05') && bal.includes('node tests/balance.js') && /smart \(20 seeds\) \| 20\/20/.test(bal), "README.md has a 'Balance' section with the final numbers and the bot results");
    // tests/balance.js: exists, parses, and holds the spec's profiles and targets. It is run by hand (10-20 minutes budgeted), never from here.
    const bj = path.join(__dirname, 'balance.js'), src = fs.existsSync(bj) ? fs.readFileSync(bj, 'utf8') : '';
    const parse = require('child_process').spawnSync(process.execPath, ['--check', bj], { encoding: 'utf8' });
    check(src && parse.status === 0, 'tests/balance.js exists and parses ' + (parse.stderr || ''));
    // (review fix: smart is the plan's profile again, with no reading ahead; the reading bot is the extra 'reader' profile. Smart and
    // early play Normal on past wave 30 until they fall, so the early target compares how far each gets, not 30 with 30.)
    check(["smart: { opts: SMART, maps: [0, 1, 2], seeds: range(20), endless: [1] }", "spam: { opts: { allow: ['bolt'], div: 0 }, maps: [0, 1, 2], seeds: range(5) }", "mlf: { opts: { allow: ['mortar', 'long', 'frost'] }, maps: [1], seeds: range(5) }", 'early: { opts: { ...SMART, early: true }', 'const SMART = { frostN: 3, div: 0.3, noise: 0.3 };', "reader: { opts: { ...SMART, look: 4 }", '(P.endless || []).includes(m) ? 100 : 30'].every(x => src.includes(x)), 'it defines the smart (the plan\'s profile), spam, mlf and early profiles over the spec seeds, and plays smart and early on Normal until they fall');
    check(['smart wins Easy >= 19/20', 'smart wins Normal >= 17/20', 'smart wins Hard 8-12/20', 'dies before wave 24', 'loses at least 1 life on an Air raid wave', 'median cleared wave within +-2 on Normal'].every(x => src.includes(x)) && !/require\(['"][^'"]*balance/.test(fs.readFileSync(__filename, 'utf8')), 'and checks every target; tests/run.js does not run it');
    // A 1.1 save from before this item still loads: its run carries on into the themed waves.
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { map: 'meadow', wave: 6, gold: 300, lives: 17, towers: [{ type: 'mortar', c: 2, r: 2, level: 2, spent: 160, mode: 'first' }] } }, last: 'meadow', best: { meadow: 6 } })));
    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue'); await page.waitForTimeout(80);
    const sv = await G(page, () => ({ wave: window.__pw.G.wave, towers: window.__pw.G.towers.length, seen: window.__pw.S.seen.join(), tag: (document.querySelector('#chips .theme') || {}).textContent, msg: document.querySelector('#infoMsg').textContent }));
    check(sv.wave === 6 && sv.towers === 1 && sv.seen === 'grunt,scout,brute,wisp' && sv.tag === 'Air raid' && sv.msg === AIR_LINE, 'an older save at wave 6 (best 6, no S.seen) loads; S.seen is rebuilt from 1.0\'s waves 1-6 and wave 7 is previewed as an Air raid ' + JSON.stringify(sv));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  // stars-run-report: stars per road for winning the campaign (by lives left), shown on the win card and the road cards; a run report
  // on the end card (kills, gold, what got through, each tower's share of the damage, a tip on a loss); a 'New record' toast; and an
  // endless run's own end card.
  // winAt(page, lives): win wave 30 on the current road with that many lives (step + hurtAll until #endOv shows).
  // endCard(page): what the end card shows. pcts(line): the percentages in a line. loseNow(page): one grunt walks in with 1 life left.
  const winAt = (page, lives) => G(page, lives => { const W = window.__pw, g = W.G; g.wave = 29; g.cleared = 29; g.lives = lives; W.startWave(); let t = 0;
    while (document.querySelector('#endOv').hidden && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } return { stars: W.S.stars[g.map.id], won: g.won, lives: g.lives }; }, lives);
  const endCard = page => G(page, () => { const q = s => document.querySelector(s), ov = q('#endOv'), st = q('#endStats');
    return { shown: !ov.hidden, title: q('#endTitle').textContent, text: q('#endText').textContent, html: q('#endText').innerHTML, main: q('#bEndMain').textContent,
      on: ov.querySelectorAll('.star.on').length, n: ov.querySelectorAll('.star').length, popAt: [...ov.querySelectorAll('.star')].map(s => s.classList.contains('pop') ? s.style.animationDelay : '-'),
      starsHidden: q('#endStars').hidden, aria: q('#endStars').getAttribute('aria-label'), hint: q('#endHint').hidden ? null : q('#endHint').textContent,
      stats: st.textContent, lines: [...st.children].map(c => c.textContent), tip: (st.querySelector('.tip') || {}).textContent || null, focus: document.activeElement.id }; });
  const pcts = line => (line.match(/\d+%/g) || []).map(x => parseInt(x));
  const loseNow = page => G(page, () => { const W = window.__pw, g = W.G; g.lives = 1; W.spawn('grunt', g.map.path.len - 0.3); let n = 0; while (!g.over && n++ < 60) W.step(1 / 30); return g.over; });
  const runWave = page => G(page, () => { const W = window.__pw, g = W.G; W.startWave(); let t = 0; while ((g.spawnQ.length || g.enemies.length) && !g.over && t < 400) { W.step(1 / 30); t += 1 / 30; } return !g.spawnQ.length && !g.enemies.length; });
  const menuCards = page => G(page, () => [...document.querySelectorAll('.mapbtn')].map(b => ({ on: b.querySelectorAll('.star.on').length, n: b.querySelectorAll('.star').length, md: b.querySelector('.md').textContent,
    prog: b.querySelector('.md').classList.contains('prog'), aria: (b.querySelector('.stars') || { getAttribute: () => null }).getAttribute('aria-label') })));

  current = 'stars-run-report: stars for a win, on the win card and the road cards';
  {
    const { ctx, page } = await newPage(browser);
    check((await text(page, '#roadHead')) === 'Choose a road · ★ 0/9', "a fresh store: the eyebrow reads 'Choose a road · ★ 0/9' (" + (await text(page, '#roadHead')) + ')');
    let cards = await menuCards(page);
    check(cards.every(c => c.n === 0 && c.md === 'Not yet played'), 'never-played roads keep "Not yet played" and show no stars ' + JSON.stringify(cards));
    await startMap(page, 1);
    // Acceptance: G.wave=29, G.cleared=29, G.lives=16, startWave, then step+hurtAll(1e9) until #endOv shows.
    const w = await winAt(page, 16);
    let c = await endCard(page);
    check(w.stars === 3 && c.shown && c.on === 3 && c.n === 3, 'acceptance: Meadow won with 16 lives: S.stars.meadow === 3 and the win card has 3 .star.on ' + JSON.stringify({ w, on: c.on }));
    check((await stored(page)).stars.meadow === 3, 'the stars are saved (localStorage stars.meadow === 3)');
    check(c.title === 'The road holds' && c.main === 'Keep going' && c.aria === '3 of 3 stars' && c.hint === null, 'the win card: three stars (read as "3 of 3 stars") and no hint at 3 stars ' + JSON.stringify(c));
    check(c.popAt.join() === '0ms,150ms,300ms', 'all three are new to this road, so they pop in 150ms apart ' + JSON.stringify(c.popAt));
    const look = await G(page, () => { const q = s => document.querySelector(s), s0 = q('#endStars .star'), cs = getComputedStyle(s0), r = { width: parseFloat(cs.width), height: parseFloat(cs.height) }, on = getComputedStyle(q('#endStars .star.on path'));
      let kf = ''; for (const sh of document.styleSheets) for (const rule of sh.cssRules) if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'starpop') kf = rule.cssText;
      const kids = [...q('#endOv .card').children].map(e => e.id); return { w: r.width, h: r.height, anim: cs.animationName, dur: cs.animationDuration, kf, fill: on.fill, kids }; });
    check(look.w === 28 && look.h === 28 && look.fill === 'rgb(227, 173, 69)', 'the win card stars are 28px and filled #e3ad45 ' + JSON.stringify(look));
    check(look.anim === 'starpop' && look.dur === '0.2s' && /(from|0%)\s*\{\s*transform: scale\(0\.4\)/.test(look.kf) && /(to|100%)\s*\{\s*transform: scale\(1\)/.test(look.kf), 'the pop is a CSS scale from .4 to 1 over 200ms ' + JSON.stringify(look));
    check(look.kids.join() === 'endTitle,endStars,endHint,endText,endStats,bEndMain,bEndAlt', 'the stars sit above #endText, and #endStats between #endText and the buttons ' + JSON.stringify(look.kids));
    // The road cards.
    await page.click('#bEndAlt'); await page.waitForTimeout(100);
    cards = await menuCards(page);
    const head = await text(page, '#roadHead');
    check(cards[1].on === 3 && /★ 3\/9/.test(head), 'acceptance: the menu Meadow card has 3 .star.on and the eyebrow matches /★ 3\\/9/ (' + head + ')');
    check(cards[1].n === 3 && cards[1].md === 'In progress · wave 31' && cards[1].prog && cards[1].aria === '3 of 3 stars', "the won run is saved, so the card's stars are followed by 'In progress · wave 31' " + JSON.stringify(cards[1]));
    check(cards[0].n === 0 && cards[2].n === 0 && cards[0].md === 'Not yet played', 'the other roads still read "Not yet played" ' + JSON.stringify([cards[0], cards[2]]));
    const small = await G(page, () => { const b = document.querySelectorAll('.mapbtn')[1], s = b.querySelector('.star'), r = s.getBoundingClientRect(); return { w: r.width, h: r.height, fill: getComputedStyle(b.querySelector('.star.on path')).fill, svg: s.tagName.toLowerCase() }; });
    check(small.w === 12 && small.h === 12 && small.svg === 'svg' && small.fill === 'rgb(227, 173, 69)', 'the card stars are 12px inline SVGs filled #e3ad45 ' + JSON.stringify(small));
    // Acceptance: replaying with 9 lives keeps the 3 stars.
    await G(page, () => { delete window.__pw.S.saves.meadow; });
    await startMap(page, 1);
    check((await G(page, () => window.__pw.G.wave)) === 0, 'with the saved run gone, the Meadow card starts a fresh run');
    const w9 = await winAt(page, 9);
    c = await endCard(page);
    check(w9.stars === 3 && (await stored(page)).stars.meadow === 3, 'acceptance: replaying with lives=9 keeps S.stars.meadow === 3 ' + JSON.stringify(w9));
    check(c.on === 1 && c.n === 3 && c.aria === '1 of 3 stars' && c.popAt.every(p => p === '-'), "the win card shows this run's 1 star, and nothing pops (the road already has more) " + JSON.stringify(c));
    check(c.hint === 'Finish with 10 or more lives for a second star.', "1 star: the hint reads 'Finish with 10 or more lives for a second star.' (" + c.hint + ')');
    // With no run saved, the card reads 'Best wave 30' after its stars.
    await G(page, () => { delete window.__pw.S.saves.meadow; });
    await page.click('#bEndAlt'); await page.waitForTimeout(100);
    cards = await menuCards(page);
    check(cards[1].on === 3 && cards[1].md === 'Best wave 30' && !cards[1].prog, "with no run in progress the card's stars are followed by 'Best wave 30' " + JSON.stringify(cards[1]));
    // Outline stars: a road with a best wave and no win yet.
    await G(page, () => { const W = window.__pw; W.S.best.quarry = 12; W.S.saves.quarry = { map: 'quarry', wave: 12, gold: 100, lives: 20, towers: [], won: false, stats: { kills: 0, gold: 0, leaks: {}, dmg: {}, slowed: 0 } }; });
    await startMap(page, 1); await page.click('#bPause'); await page.click('#bMenu'); await page.waitForTimeout(100);
    cards = await menuCards(page);
    const off = await G(page, () => { const p = document.querySelectorAll('.mapbtn')[2].querySelector('.star path'), cs = getComputedStyle(p); return { fill: cs.fill, stroke: cs.stroke }; });
    check(cards[2].n === 3 && cards[2].on === 0 && cards[2].md === 'In progress · wave 13' && cards[2].aria === '0 of 3 stars', 'a road with a best wave but no win: 3 outline stars, then its run in progress ' + JSON.stringify(cards[2]));
    check(off.fill === 'none' && off.stroke === 'rgb(167, 177, 153)', 'an unearned star is an outline in var(--muted) ' + JSON.stringify(off));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: 2 stars and 1 star, the hint, and the thresholds';
  // (review fix: back to the plan's thresholds, 16 and 10, now that tests/balance.js plays the plan's smart profile.)
  for (const [lives, n, hint] of [[12, 2, 'Finish with 16 or more lives for the third star.'], [9, 1, 'Finish with 10 or more lives for a second star.']]) {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const w = await winAt(page, lives);
    const c = await endCard(page);
    check(w.stars === n && (await stored(page)).stars.meadow === n && c.on === n && c.n === 3, `acceptance: a fresh context won with lives=${lives} gives ${n} star${n > 1 ? 's' : ''} ` + JSON.stringify({ w, on: c.on }));
    check(c.hint === hint && c.aria === `${n} of 3 stars`, `${n} star${n > 1 ? 's' : ''}: the hint reads '${hint}' (${c.hint})`);
    check(c.popAt.join() === (n === 2 ? '0ms,150ms,-' : '0ms,-,-'), 'the newly earned stars pop in, 150ms apart ' + JSON.stringify(c.popAt));
    if (n === 2) {
      // A better win later: only the star new to this road pops.
      await G(page, () => { delete window.__pw.S.saves.meadow; });
      await page.click('#bEndAlt'); await startMap(page, 1);
      const w3 = await winAt(page, 16);
      const c3 = await endCard(page);
      check(w3.stars === 3 && c3.on === 3 && c3.popAt.join() === '-,-,0ms' && c3.hint === null, 'winning again with 16 lives earns the third star, and only that one pops ' + JSON.stringify({ w3, pop: c3.popAt }));
    }
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page } = await newPage(browser);
    const th = await G(page, () => { const W = window.__pw; return { t: [W.STAR3, W.STAR2], n: [20, 16, 15, 13, 12, 10, 9, 1].map(l => W.starCount(l)) }; });
    check(th.n.join() === '3,3,2,2,2,2,1,1' && th.t.join() === '16,10', '3 stars from 16 lives, 2 from 10, else 1 (20 gives 3, 15 and 12 give 2, 9 gives 1) ' + JSON.stringify(th));
    // Thresholds against tests/balance.js (the plan's smart bot, 20 seeds; lives when wave 30 clears): Easy 16-20, Normal winners 3-20
    // (median 10), Hard winners 1-14. At 16/10 the smart Normal winners split 7 / 5 / 7 across 3, 2 and 1 stars, and no Hard winner gets 3.
    const BOT_NORMAL = [3, 3, 3, 6, 8, 8, 9, 10, 10, 10, 11, 15, 17, 17, 17, 18, 18, 19, 20], BOT_HARD = [1, 2, 2, 3, 4, 4, 5, 10, 14];
    const split = await G(page, ([a, b]) => { const W = window.__pw, k = l => [0, 0, 0, 0].map((_, i) => l.filter(x => W.starCount(x) === i).length); return { normal: k(a), hard: k(b) }; }, [BOT_NORMAL, BOT_HARD]);
    check(split.normal[3] >= 3 && split.normal[2] >= 3 && split.hard[3] === 0, "the bot's Normal winners split across 2 and 3 stars, and its Hard winners earn no 3 stars " + JSON.stringify(split));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    // Reduced motion: the stars are simply there.
    const { ctx, page } = await newPage(browser);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await startMap(page, 1);
    await winAt(page, 16);
    const c = await endCard(page), anim = await page.$$eval('#endStars .star', els => els.map(e => getComputedStyle(e).animationName));
    check(c.on === 3 && c.popAt.every(p => p === '-') && anim.every(a => a === 'none'), 'reduced motion: three stars, none popping ' + JSON.stringify({ pop: c.popAt, anim }));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // (review fix) Wave 31 can't be called early while wave 30 is on the road and the campaign is not won yet, so the win (and its stars)
  // always comes when wave 30 is over. Past the campaign, calling early is open again; before wave 30 it always was.
  current = 'stars-run-report: wave 30 is won before wave 31 can be called';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const btn = () => G(page, () => { const b = document.querySelector('#bWave'); return { text: b.textContent, early: b.classList.contains('early'), disabled: b.disabled, wave: window.__pw.G.wave }; });
    // The whole wave out of the cave at once: the spawn queue is empty and the wave is still on the road.
    const onRoad = () => G(page, () => { const W = window.__pw, g = W.G; W.startWave(); g.spawnQ.forEach(q => { q.at = g.time; }); W.step(1 / 30); return g.enemies.length; });
    await G(page, () => { const g = window.__pw.G; g.running = false; g.wave = 28; g.cleared = 28; g.lives = 18; });
    await onRoad();
    const w29 = await btn();
    check(w29.early && !w29.disabled && /^Call 30 early\s*\+120$/.test(w29.text), "wave 29 on the road: 'Call 30 early +120' as before " + JSON.stringify(w29));
    await G(page, () => { const W = window.__pw, g = W.G; g.enemies = []; g.W = {}; g.cleared = 29; W.refreshPanel(); });
    const n30 = await onRoad();
    const w30 = await btn();
    await page.click('#bWave', { force: true });
    const after = await G(page, () => { const W = window.__pw, g = W.G, w0 = g.wave; W.startWave(); return { click: w0, call: g.wave, active: Object.keys(g.W).join() }; });
    check(n30 > 0 && w30.disabled && !w30.early && w30.text === 'Wave 30…' && after.click === 30 && after.call === 30 && after.active === '30', "wave 30 on the road, nothing left to spawn: #bWave reads 'Wave 30…' and is disabled, and neither a tap nor startWave() calls wave 31 " + JSON.stringify({ w30, after }));
    await G(page, () => { const W = window.__pw; let t = 0; while (document.querySelector('#endOv').hidden && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } });
    const c = await endCard(page), st = await G(page, () => ({ stars: window.__pw.S.stars.meadow, won: window.__pw.G.won }));
    check(c.shown && c.title === 'The road holds' && c.on === 3 && st.stars === 3 && st.won, 'wave 30 over: the win card with its 3 stars (18 lives) ' + JSON.stringify({ c: c.title, on: c.on, st }));
    await page.click('#bEndMain');
    await G(page, () => { window.__pw.G.running = false; });
    await onRoad();
    const w31 = await btn();
    check(w31.wave === 31 && w31.early && /^Call 32 early\s*\+126$/.test(w31.text), "past the campaign the early call is back: 'Call 32 early +126' during wave 31 " + JSON.stringify(w31));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: stars for players from before 1.1';
  {
    const { ctx, page } = await newPage(browser);
    const load = async v => { await page.evaluate(v => localStorage.setItem('pathwarden.v1', JSON.stringify(v)), v); await page.reload(); await page.waitForTimeout(250);
      return { stars: await G(page, () => window.__pw.S.stars), ls: (await stored(page)).stars, head: await text(page, '#roadHead'), cards: await menuCards(page) }; };
    let r = await load({ best: { switch: 30 } });
    check(r.stars.switch === 1 && r.ls.switch === 1, 'acceptance: storage {best:{switch:30}} without stars loads with S.stars.switch === 1, and it is written back ' + JSON.stringify(r.stars));
    check(r.cards[0].on === 1 && r.cards[0].n === 3 && r.cards[0].md === 'Best wave 30' && r.head === 'Choose a road · ★ 1/9', "its card: 1 star then 'Best wave 30'; the eyebrow counts it " + JSON.stringify([r.cards[0], r.head]));
    r = await load({ best: { switch: 30, meadow: 12 }, stars: { switch: 3 } });
    check(JSON.stringify(r.stars) === '{"switch":3}' && r.cards[1].n === 3 && r.cards[1].on === 0 && r.cards[1].md === 'Best wave 12', 'stored stars are kept; a road not yet won has none, and its card shows 3 outline stars and its best ' + JSON.stringify(r));
    r = await load({ best: { quarry: 31 }, stars: 'x' });
    check(JSON.stringify(r.stars) === '{"quarry":1}', 'stars that are not an object start over: {}, then 1 for a best of 30 or more ' + JSON.stringify(r.stars));
    r = await load({ best: { meadow: 'x' }, stars: { meadow: 7, quarry: 2, nowhere: 3, switch: '3' } });
    check(JSON.stringify(r.stars) === '{"quarry":2}' && r.head === 'Choose a road · ★ 2/9', 'only 1-3 on a real road is kept ' + JSON.stringify(r));
    r = await load({ stars: [3, 3, 3] });
    check(JSON.stringify(r.stars) === '{}' && r.head === 'Choose a road · ★ 0/9', 'an array is not a stars object ' + JSON.stringify(r.stars));
    // (review fix) Only storage from before 1.1 (no stars yet) turns a best of 30 into a star, once. 1.1 storage keeps what was won,
    // so a road's stars never change between launches.
    r = await load({ best: { meadow: 30, switch: 30 }, stars: { switch: 2 } });
    await page.reload(); await page.waitForTimeout(250);
    const r2 = { stars: await G(page, () => window.__pw.S.stars), head: await text(page, '#roadHead') };
    check(JSON.stringify(r.stars) === '{"switch":2}' && JSON.stringify(r2.stars) === '{"switch":2}' && r2.head === 'Choose a road · ★ 2/9', 'stored 1.1 stars: a best of 30 on a road with none earns no star, on this launch or the next ' + JSON.stringify({ r: r.stars, r2 }));
    r = await load({ best: { quarry: 30 } });
    await page.reload(); await page.waitForTimeout(250);
    check(JSON.stringify(r.stars) === '{"quarry":1}' && JSON.stringify(await G(page, () => window.__pw.S.stars)) === '{"quarry":1}', 'a 1.0 store gets its 1 star once, and keeps it on the next launch ' + JSON.stringify(r.stars));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: what got through, and the tip a loss ends on';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    // Acceptance: G.lives=3; spawn('wisp', path.len-0.3) three times; step until over and wait 1000ms.
    await G(page, () => { const W = window.__pw, g = W.G; g.lives = 3; for (let i = 0; i < 3; i++) W.spawn('wisp', g.map.path.len - 0.3); let n = 0; while (!g.over && n++ < 300) W.step(1 / 30); });
    await page.waitForTimeout(1000);
    let c = await endCard(page);
    check(c.shown && c.stats.includes('Wisps') && c.stats.includes("Mortars can't hit"), "acceptance: #endStats includes 'Wisps' and \"Mortars can't hit\" " + JSON.stringify(c.lines));
    check(c.lines[0] === '0 kills · 0 gold earned' && c.lines[1] === 'Got through: 3 Wisps (-3)' && c.tip === "Wisps fly. Mortars can't hit them, but Bolt, Frost, Arc and Longshot can." && c.lines.length === 3,
      "kills and gold, 'Got through: 3 Wisps (-3)', no damage line (no tower hit anything), and the Wisp tip " + JSON.stringify(c.lines));
    check(c.title === 'The keep has fallen' && c.main === 'Try again' && c.starsHidden && c.hint === null && c.focus === 'bEndMain', 'a loss before the campaign is won: the usual title, no stars, and focus on Try again ' + JSON.stringify(c));
    const css = await G(page, () => { const cs = getComputedStyle(document.querySelector('#endStats')); return [cs.fontSize, cs.color, cs.display, cs.flexDirection, cs.rowGap].join('|'); });
    check(css === '13px|rgb(167, 177, 153)|flex|column|6px', '#endStats is 13px var(--muted), its lines 6px apart ' + css);
    // At most 3 types, by lives lost, with the count of enemies (lives / ED lives); the tip follows the type that cost the most.
    await page.click('#bEndMain');
    await G(page, () => { window.__pw.G.stats.leaks = { grunt: 2, scout: 1, brute: 4, boss: 5, splitter: 1 }; });
    await loseNow(page); await page.waitForTimeout(1000);
    c = await endCard(page);
    check(c.lines[1] === 'Got through: 1 Warlord (-5), 2 Brutes (-4), 3 Grunts (-3)' && c.tip === 'Armor blunts small hits. Longshot ignores armor.', 'three types at most, most lives first: 1 Warlord (-5), 2 Brutes (-4), 3 Grunts (-3); the Warlord tip ' + JSON.stringify(c.lines));
    await page.click('#bEndMain');
    await G(page, () => { window.__pw.G.stats.leaks = { scout: 4, splitter: 3 }; });
    await loseNow(page); await page.waitForTimeout(1000);
    c = await endCard(page);
    check(c.lines[1] === 'Got through: 4 Scouts (-4), 3 Splitters (-3), 1 Grunt (-1)' && c.tip === 'Scouts are fast. Frost slows them down.', 'the Scout tip when Scouts cost the most ' + JSON.stringify(c.lines));
    const tips = await G(page, () => window.__pw.END_TIP);
    check(JSON.stringify(tips) === JSON.stringify({ wisp: "Wisps fly. Mortars can't hit them, but Bolt, Frost, Arc and Longshot can.", brute: 'Armor blunts small hits. Longshot ignores armor.', boss: 'Armor blunts small hits. Longshot ignores armor.',
      scout: 'Scouts are fast. Frost slows them down.', splitter: 'Splitters burst into 2 Scouts. Hit them early on the road.', grunt: 'Build where the road bends so one tower covers two stretches.' }), 'the tip for every type is the spec copy ' + JSON.stringify(tips));
    await page.click('#bEndMain');
    await loseNow(page); await page.waitForTimeout(1000);
    c = await endCard(page);
    check(c.tip === 'Build where the road bends so one tower covers two stretches.' && c.lines[1] === 'Got through: 1 Grunt (-1)', 'a Grunt that walks in: the Grunt tip ' + JSON.stringify(c.lines));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: kills, gold and the damage each tower dealt';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    // Acceptance: build frost, mortar and long; run wave 1; force a loss.
    const built = await G(page, () => { const W = window.__pw, g = W.G; g.running = false; g.gold = 1000; return [['frost', 2, 2], ['mortar', 4, 2], ['long', 3, 5]].map(([k, c, r]) => W.build(k, c, r)).every(Boolean); });
    check(built, 'built a Frost, a Mortar and a Longshot on Meadow');
    const calm = await runWave(page);
    const over = await loseNow(page);
    await page.waitForTimeout(1000);
    const st = await G(page, () => JSON.parse(JSON.stringify(window.__pw.G.stats)));
    let c = await endCard(page);
    const dline = c.lines.find(l => l.includes('%')) || '', p = pcts(dline), sum = p.reduce((a, b) => a + b, 0), kills = +((c.lines[0].match(/^([\d,]+) kills/) || [])[1] || '-1').replace(/,/g, '');
    check(calm && over && sum >= 99 && sum <= 101 && c.stats.includes('Frost slowed') && kills === st.kills && st.kills > 0, `acceptance: the damage percentages sum to ${sum}, the text includes 'Frost slowed', and the kills number ${kills} equals G.stats.kills ${st.kills} > 0 ` + JSON.stringify(c.lines));
    const names = dline.split(' · ').filter(x => x.includes('%')).map(x => x.split(' ')[0]);
    check(['Frost', 'Mortar', 'Longshot'].every(n => names.includes(n)) && p.every((x, i) => i === 0 || x <= p[i - 1]) && p.every(x => x >= 1), 'every tower that hit something is listed, largest share first ' + dline);
    check(dline.endsWith(` · Frost slowed ${st.slowed}`) && st.slowed > 0, `then ' · Frost slowed ${st.slowed}' ` + dline);
    check(c.lines[0] === `${st.kills} kills · ${st.gold} gold earned` && st.gold > 0, 'line 1: kills and gold earned ' + c.lines[0]);
    const bar = await G(page, () => { const b = document.querySelector('#endStats .dbar'), r = b.getBoundingClientRect(), cs = getComputedStyle(b);
      return { h: r.height, rad: cs.borderTopLeftRadius, w: r.width, segs: [...b.children].map(i => ({ t: i.dataset.t, bg: getComputedStyle(i).backgroundColor, w: i.getBoundingClientRect().width })), next: b.nextElementSibling && b.nextElementSibling.textContent }; });
    const rgb = h => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    const TDC = { bolt: '#d39a45', mortar: '#79808c', frost: '#8fd6ea', arc: '#a487ff', long: '#cf5547' };
    check(bar.h === 8 && bar.rad === '4px' && bar.segs.length === names.length && bar.segs.every(s => s.bg === rgb(TDC[s.t])) && Math.abs(bar.segs.reduce((a, s) => a + s.w, 0) - bar.w) < 1 && bar.next === dline,
      'line 3: an 8px stacked bar with radius 4, one segment per tower type in its colour, filling the bar, with the line below it ' + JSON.stringify(bar));
    check(bar.segs.map(s => s.t).join() === names.map(n => ({ Frost: 'frost', Mortar: 'mortar', Longshot: 'long', Bolt: 'bolt', Arc: 'arc' })[n]).join(), 'the bar and the line are in the same order ' + JSON.stringify(bar.segs.map(s => s.t)));
    // The formats: thousands separators, shares under 1% dropped from the line (not the bar), and fmt for 'Frost slowed'.
    await page.click('#bEndMain');
    await G(page, () => { window.__pw.G.stats = { kills: 12345, gold: 1234567, leaks: {}, dmg: { long: 590, mortar: 240, arc: 110, bolt: 50, frost: 4 }, slowed: 1234 }; });
    await loseNow(page); await page.waitForTimeout(1000);
    c = await endCard(page);
    const segs = await page.$$eval('#endStats .dbar i', els => els.length);
    check(c.lines[0] === '12,345 kills · 1,234,567 gold earned', "toLocaleString('en-US'): '12,345 kills · 1,234,567 gold earned' (" + c.lines[0] + ')');
    check(c.lines[2] === 'Longshot 59% · Mortar 24% · Arc 11% · Bolt 5% · Frost slowed 1.2k' && segs === 5, "'Longshot 59% · Mortar 24% · Arc 11% · Bolt 5% · Frost slowed 1.2k': Frost's 0.4% is in the bar but not the line (" + c.lines[2] + ')');
    // (review fix) A share under 1% stays out of the line even where it rounds to 1%: 0.7% is in the bar only.
    await page.click('#bEndMain');
    await G(page, () => { window.__pw.G.stats = { kills: 1, gold: 1, leaks: {}, dmg: { long: 99.3, frost: 0.7 }, slowed: 0 }; });
    await loseNow(page); await page.waitForTimeout(1000);
    c = await endCard(page);
    const segs2 = await page.$$eval('#endStats .dbar i', els => els.map(e => e.dataset.t).join());
    check(c.lines[2] === 'Longshot 99%' && segs2 === 'long,frost', "Longshot 99.3% and Frost 0.7%: the line is 'Longshot 99%' and the bar still has both (" + c.lines[2] + ', ' + segs2 + ')');
    const f = await G(page, () => [0, 7, 999, 1000, 1234, 15678].map(window.__pw.fmtK));
    check(f.join() === '0,7,999,1.0k,1.2k,15.7k', 'fmt: under 1000 as is, else one decimal and k ' + f.join());
    // A win where nothing got through.
    await page.click('#bEndMain');
    await winAt(page, 20);
    c = await endCard(page);
    const good = await page.$eval('#endStats .ok', el => getComputedStyle(el).color);
    check(c.lines.includes('Nothing got through.') && good === 'rgb(159, 211, 106)' && c.tip === null, "a win with no leaks: 'Nothing got through.' in var(--good), and no tip on a win " + JSON.stringify(c.lines));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: what the run report counts';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    const r = await G(page, () => { const W = window.__pw, g = W.G, o = {}; g.running = false;
      o.fresh = JSON.stringify(g.stats) === '{"kills":0,"gold":0,"leaks":{},"dmg":{},"slowed":0}' && g.prevBest === 0;
      // hurt: the damage that landed, up to the HP left, goes to the tower type that dealt it.
      g.wave = 1; g.W = { 1: { rem: 99, alive: 0 } }; W.spawn('grunt', 3); const e = g.enemies[0], hp = e.hp;
      W.hurt(e, 10, false, 'bolt'); o.bolt = g.stats.dmg.bolt;
      W.hurt(e, 1000, true, 'long'); o.long = g.stats.dmg.long; o.left = hp - 10; o.kills = g.stats.kills; o.gold = g.stats.gold; o.eg = e.gold;
      g.wave = 4; g.W[4] = { rem: 99, alive: 0 }; W.spawn('brute', 3); const b = g.enemies.find(x => x.type === 'brute');
      W.hurt(b, 11, false, 'bolt'); o.armor = [b.armor, g.stats.dmg.bolt - 10];
      W.hurt(b, 2, false, 'arc'); o.arc = g.stats.dmg.arc;
      const d0 = JSON.stringify(g.stats.dmg); W.hurt(b, 50, true); W.hurtAll(1); o.nosrc = JSON.stringify(g.stats.dmg) === d0 && Object.keys(g.stats.dmg).join() === 'bolt,long,arc';
      // A frost splash counts each enemy it slows.
      g.enemies = []; g.projs = []; g.W = { 1: { rem: 99, alive: 0 } }; g.wave = 1; for (let i = 0; i < 3; i++) W.spawn('grunt', 3 + i * 0.1); const t = g.enemies[0];
      g.projs.push({ k: 'frost', x: t.x, y: t.y, tg: t, spd: 6, dmg: 5, splash: 0.75, slow: 0.42, slowDur: 1.6, src: 'frost' }); W.step(1 / 60);
      o.slowed = g.stats.slowed; o.frost = g.stats.dmg.frost; o.slowNow = g.enemies.filter(x => x.slow > 0).length;
      // A leak counts the lives it cost, by type.
      g.enemies = []; g.W = {}; g.lives = 20; g.wave = 4; W.spawn('brute', g.map.path.len - 0.3); W.spawn('scout', g.map.path.len - 0.25); W.spawn('brute', g.map.path.len - 0.28);
      for (let i = 0; i < 30; i++) W.step(1 / 30); o.leaks = { ...g.stats.leaks }; o.lives = g.lives;
      return o; });
    check(r.fresh, 'newGame: G.stats is {kills:0, gold:0, leaks:{}, dmg:{}, slowed:0} and G.prevBest is the road best (0)');
    check(Math.abs(r.bolt - 10) < 1e-9 && Math.abs(r.long - r.left) < 1e-9 && r.kills === 1 && r.gold === r.eg, `hurt credits its src: Bolt 10, then Longshot only the ${r.left.toFixed(1)} HP left (not 1000); the kill adds 1 kill and its ${r.eg} gold ` + JSON.stringify(r));
    check(Math.abs(r.armor[1] - (11 - r.armor[0])) < 1e-9 && Math.abs(r.arc - 0.5) < 1e-9, 'armor is taken off first (11 - armor), and a blunted hit still counts its quarter (2 -> 0.5) ' + JSON.stringify(r));
    check(r.nosrc, 'a hit with no src (hurtAll) is not credited to any tower');
    check(r.slowed === 3 && r.slowNow === 3 && Math.abs(r.frost - 15) < 1e-9, 'one frost splash over 3 grunts: slowed 3, Frost dmg 15 ' + JSON.stringify(r));
    check(r.leaks.brute === 4 && r.leaks.scout === 1 && Object.keys(r.leaks).length === 2 && r.lives === 15, 'leaks count lives by type: 2 Brutes 4, 1 Scout 1 ' + JSON.stringify(r));
    // Gold earned: kills, the wave bonus and an early call's bonus. A sale is not earned.
    const gd = await G(page, () => { const W = window.__pw; W.newGame(1); const g = W.G, g0 = g.gold;
      W.startWave(); while (g.spawnQ.length) W.step(1 / 30); W.startWave(); const early = g.gold; let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; }
      return { earned: g.stats.gold, delta: g.gold - g0, kills: g.stats.kills, early, cleared: g.cleared }; });
    check(gd.cleared === 2 && gd.earned === gd.delta && gd.earned > 0, 'over a wave and an early-called wave, gold earned is exactly the gold gained (kills, 2 wave bonuses, the early bonus) ' + JSON.stringify(gd));
    await G(page, () => { const W = window.__pw, g = W.G; g.running = true; });
    await tapTile(page, 2, 2); await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]'); await tapTile(page, 2, 2); await page.click('#bSell'); await page.click('#bSell');
    const sold = await G(page, () => ({ towers: window.__pw.G.towers.length, earned: window.__pw.G.stats.gold }));
    check(sold.towers === 0 && sold.earned === gd.earned, 'selling a tower is not gold earned ' + JSON.stringify(sold));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: the report is saved with the run';
  {
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await G(page, () => { const W = window.__pw; W.G.running = false; W.G.gold = 1000; [['bolt', 2, 2], ['mortar', 4, 2], ['long', 3, 5]].forEach(([k, c, r]) => W.build(k, c, r)); });
    await runWave(page);
    const live = await G(page, () => JSON.parse(JSON.stringify(window.__pw.G.stats)));
    let sv = (await stored(page)).saves.meadow;
    check(sv && sv.stats && sv.stats.kills === live.kills && live.kills > 0, `acceptance: after a wave clears, the saved run includes stats.kills (${sv && sv.stats && sv.stats.kills})`);
    check(JSON.stringify(sv.stats) === JSON.stringify(live) && sv.prevBest === 0, 'the whole report is saved, and the best the run began with ' + JSON.stringify(sv));
    // The save holds a copy: a kill after it does not change the stored run until the next save.
    const alias = await G(page, () => { const W = window.__pw, g = W.G; g.W = { 1: { rem: 99, alive: 0 } }; W.spawn('grunt', 3); W.hurtAll(1e9); return { live: g.stats.kills, saved: W.S.saves.meadow.stats.kills }; });
    check(alias.live === alias.saved + 1, 'the saved report is a copy of the live one ' + JSON.stringify(alias));
    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue'); await page.waitForTimeout(80);
    const back = await G(page, () => JSON.parse(JSON.stringify(window.__pw.G.stats)));
    check(JSON.stringify(back) === JSON.stringify(sv.stats), 'Continue brings the report back with the run ' + JSON.stringify(back));
    // Acceptance: old saves without stats load with zeroed stats.
    await G(page, () => { window.__pw.G.running = false; });
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { map: 'meadow', wave: 3, gold: 150, lives: 20, towers: [{ type: 'bolt', c: 2, r: 2 }] } }, last: 'meadow', best: { meadow: 3 } })));
    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue'); await page.waitForTimeout(80);
    const old = await G(page, () => ({ stats: JSON.stringify(window.__pw.G.stats), prev: window.__pw.G.prevBest, wave: window.__pw.G.wave, towers: window.__pw.G.towers.length }));
    // (review fix: such a report covers only the waves from the one the run goes on with, stats.from.)
    check(old.stats === '{"kills":0,"gold":0,"leaks":{},"dmg":{},"slowed":0,"from":4}' && old.wave === 3 && old.towers === 1 && old.prev === 3, 'acceptance: an old save without stats loads with zeroed stats, marked as covering waves 4 on (and prevBest from the best wave) ' + JSON.stringify(old));
    // Damaged reports start over; a good one is kept.
    await G(page, () => { window.__pw.G.running = false; });
    const base = { wave: 3, gold: 150, lives: 20, towers: [] }, good = { kills: 5, gold: 40, leaks: { wisp: 1 }, dmg: { bolt: 120.5, long: 3 }, slowed: 2 };
    const variants = [{ ...good, kills: -1 }, { ...good, gold: '40' }, { ...good, leaks: { dragon: 2 } }, { ...good, dmg: { bolt: null } }, { ...good, dmg: { grunt: 3 } }, { kills: 1, gold: 1, leaks: {}, dmg: {} }, { ...good, leaks: [1] }, 7];
    const res = [];
    for (let i = 0; i < variants.length; i += 2) {
      await page.evaluate(([base, a, b, good]) => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { ...base, map: 'meadow', stats: a }, quarry: { ...base, map: 'quarry', stats: b }, switch: { ...base, map: 'switch', stats: good, prevBest: 9 } } })), [base, variants[i], variants[i + 1], good]);
      await page.reload(); await page.waitForTimeout(250);
      res.push(...(await G(page, () => { const s = window.__pw.S.saves; return [JSON.stringify(s.meadow.stats), JSON.stringify(s.quarry.stats), JSON.stringify(s.switch.stats) + ':' + s.switch.prevBest]; })));
    }
    const fresh = '{"kills":0,"gold":0,"leaks":{},"dmg":{},"slowed":0,"from":4}', goodS = JSON.stringify(good) + ':9';
    check(res.filter((_, i) => i % 3 < 2).every(x => x === fresh), 'a report with a negative, non-number or missing field, or a key that is not an enemy (leaks) or tower (dmg) type, starts over ' + JSON.stringify(res));
    check(res.filter((_, i) => i % 3 === 2).every(x => x === goodS), 'a sound report (and prevBest) loads as saved ' + JSON.stringify(res.filter((_, i) => i % 3 === 2)));
    // (review fix) The end card of a run continued from a 1.0 save says which waves its report covers. It does not claim that nothing
    // got through the whole run (this one is down to 9 lives).
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ saves: { meadow: { map: 'meadow', wave: 29, gold: 500, lives: 9, towers: [{ type: 'long', c: 3, r: 5 }] } }, last: 'meadow', best: { meadow: 29 } })));
    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue'); await page.waitForTimeout(80);
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; W.startWave(); let t = 0; while (document.querySelector('#endOv').hidden && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } });
    const pc = await endCard(page), psv = (await stored(page)).saves.meadow;
    check(pc.shown && pc.title === 'The road holds' && /^From wave 30: [\d,]+ kills · [\d,]+ gold earned$/.test(pc.lines[0]) && pc.lines[1] === 'Nothing got through from wave 30.' && !pc.lines.includes('Nothing got through.') && psv.stats.from === 30,
      "a win continued from a 1.0 save at wave 29: 'From wave 30: … kills · … gold earned' and 'Nothing got through from wave 30.', and the saved run keeps stats.from " + JSON.stringify({ lines: pc.lines, from: psv.stats.from }));
    await page.click('#bEndMain');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = "stars-run-report: 'New record' and the end of an endless run";
  {
    const { ctx, page } = await newPage(browser);
    await page.evaluate(() => localStorage.setItem('pathwarden.v1', JSON.stringify({ best: { meadow: 37 } })));
    await page.reload(); await page.waitForTimeout(250);
    await startMap(page, 1);
    await toastLog(page);
    // Acceptance: with best.meadow=37 stored: set wave 36, cleared 36, won=true, run 2 waves.
    await G(page, () => { const g = window.__pw.G; g.running = false; g.wave = 36; g.cleared = 36; g.won = true; });
    check((await G(page, () => window.__pw.G.prevBest)) === 37, 'G.prevBest is the stored best, 37');
    await killWaves(page, 1);
    const t37 = await toasts(page);
    await killWaves(page, 1);
    const t38 = await toasts(page);
    check(t38.includes('New record · wave 38'), "acceptance: a #toast text 'New record · wave 38' was observed " + JSON.stringify(t38));
    check(!t37.some(t => t.startsWith('New record')), 'wave 37 only equals the best: no toast ' + JSON.stringify(t37));
    // Once a run, even after the app is closed and the run continued.
    check((await stored(page)).saves.meadow.prevBest === 37, 'the saved run keeps the best it began with');
    await page.reload(); await page.waitForTimeout(250);
    await page.click('#bContinue'); await page.waitForTimeout(80);
    await toastLog(page);
    await G(page, () => { window.__pw.G.running = false; });
    await killWaves(page, 1);
    const t39 = await toasts(page);
    check((await G(page, () => window.__pw.G.prevBest)) === 37 && !t39.some(t => t.startsWith('New record')), 'continued, the run still measures from 37 and does not toast a record again at 39 ' + JSON.stringify(t39));
    // Acceptance: a later loss.
    await loseNow(page); await page.waitForTimeout(1000);
    let c = await endCard(page);
    check(c.title === 'Endless run over' && c.main === 'New run', "acceptance: a later loss shows #endTitle 'Endless run over' and #bEndMain 'New run' " + JSON.stringify(c));
    check(c.html === 'Cleared <b>39</b> waves, 9 past the campaign. <span class="tag rec">New record</span>' && c.starsHidden && c.tip === 'Build where the road bends so one tower covers two stretches.',
      "'Cleared <b>39</b> waves, 9 past the campaign.' with a 'New record' tag, and the loss tip " + c.html);
    const tag = await page.$eval('#endText .tag.rec', el => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.color, cs.textTransform].join('|'); });
    check(tag === 'rgb(227, 173, 69)|rgb(43, 31, 7)|uppercase', 'the tag is brass ' + tag);
    await page.click('#bEndMain');
    const nr = await G(page, () => ({ wave: window.__pw.G.wave, won: window.__pw.G.won, over: window.__pw.G.over, map: window.__pw.G.map.id, prev: window.__pw.G.prevBest }));
    check(nr.wave === 0 && !nr.won && !nr.over && nr.map === 'meadow' && nr.prev === 39, 'New run starts the road again from wave 0, measured against the new best ' + JSON.stringify(nr));
    // An endless run that ends short of the best: no tag.
    await G(page, () => { const W = window.__pw, g = W.G; W.S.best.meadow = 45; W.newGame(1); W.G.wave = 36; W.G.cleared = 36; W.G.won = true; });
    await toastLog(page);
    await killWaves(page, 1);
    await loseNow(page); await page.waitForTimeout(1000);
    c = await endCard(page);
    check(c.title === 'Endless run over' && c.html === 'Cleared <b>37</b> waves, 7 past the campaign.' && !(await toasts(page)).some(t => t.startsWith('New record')), 'below the best: the same card with no tag, and no toast ' + c.html);
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  {
    // A player's first run has no best to beat: no toast.
    const { ctx, page } = await newPage(browser);
    await startMap(page, 1);
    await toastLog(page);
    await G(page, () => { window.__pw.G.running = false; });
    await killWaves(page, 2);
    check(!(await toasts(page)).some(t => t.startsWith('New record')) && (await G(page, () => window.__pw.G.prevBest)) === 0, 'a first run (no best yet) never toasts a record ' + JSON.stringify(await toasts(page)));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  current = 'stars-run-report: the end card on a 320x568 phone';
  {
    const { ctx, page } = await newPage(browser, { viewport: { width: 320, height: 568 } });
    await startMap(page, 1);
    // The longest report: 3 types through, all 5 towers in the line, five-digit numbers, and a tip.
    await G(page, () => { window.__pw.G.stats = { kills: 12345, gold: 123456, leaks: { boss: 10, wisp: 9, splitter: 8, brute: 2 }, dmg: { long: 400, mortar: 250, arc: 150, bolt: 120, frost: 80 }, slowed: 23456 }; });
    await loseNow(page); await page.waitForTimeout(1000);
    const fit = () => G(page, () => { const ov = document.querySelector('#endOv'), card = ov.querySelector('.card').getBoundingClientRect(), st = document.querySelector('#endStats');
      const whole = [...st.querySelectorAll('.nw')].every(s => s.getClientRects().length === 1);
      const inside = [...ov.querySelectorAll('.card > *')].every(el => { const r = el.getBoundingClientRect(); return !r.width || (r.left >= card.left && r.right <= card.right + 0.5); });
      ov.scrollTop = 0; const title = document.querySelector('#endTitle').getBoundingClientRect().top;
      ov.scrollTop = 1e6; const alt = document.querySelector('#bEndAlt').getBoundingClientRect();
      const res = { whole, inside, lines: [...st.children].map(c => c.textContent), noX: st.scrollWidth <= st.clientWidth && document.documentElement.scrollWidth <= innerWidth, title: title >= 0, alt: alt.bottom <= innerHeight && alt.top >= 0 };
      ov.scrollTop = 0; return res; });
    let f = await fit();
    check(f.whole && f.inside && f.noX && f.alt && f.title, "320x568, the longest loss report: every part kept whole (no line starts with '·'), inside the card, no sideways scroll, and both buttons reachable " + JSON.stringify(f));
    await page.screenshot({ path: path.join(__dirname, 'out', 'stars-loss-320.png') });
    await page.click('#bEndMain');
    await winAt(page, 11);
    f = await fit();
    check(f.whole && f.inside && f.noX && f.alt && f.title, '320x568, a 2-star win card with its hint and report fits the same way ' + JSON.stringify(f));
    await page.screenshot({ path: path.join(__dirname, 'out', 'stars-win-320.png') });
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'long run soak (30 waves, all roads)';
  for (let mi = 0; mi < 3; mi++) {
    const { ctx, page } = await newPage(browser);
    await startMap(page, mi);
    const res = await G(page, mi => {
      const W = window.__pw, g = W.G, bad = [];
      g.gold = 1e6;
      const types = Object.keys(W.TD);
      let i = 0;
      for (let r = 0; r < W.ROWS; r++) for (let c = 0; c < W.COLS; c++) if (!g.grid[r * W.COLS + c] && (r + c) % 3 === 0) { W.build(types[i++ % 5], c, r); }
      for (const t of g.towers) { W.upgrade(t); W.upgrade(t); }
      g.gold = 500;
      let maxE = 0, maxFx = 0, maxP = 0, renderMs = 0, frames = 0;
      for (let w = 0; w < 32 && !g.over; w++) {
        W.startWave();
        let t = 0;
        while ((g.spawnQ.length || g.enemies.length) && !g.over && t < 900) {
          W.step(1 / 20); t += 1 / 20;
          maxE = Math.max(maxE, g.enemies.length); maxFx = Math.max(maxFx, g.fx.length); maxP = Math.max(maxP, g.projs.length);
          if (!Number.isInteger(g.gold) || g.gold < 0) bad.push('gold ' + g.gold);
          for (const e of g.enemies) if (!isFinite(e.x) || !isFinite(e.y) || !isFinite(e.hp)) { bad.push('NaN enemy ' + e.type); break; }
          for (const k in g.W) if (g.W[k].alive < 0 || g.W[k].rem < 0) bad.push('wave count <0 ' + k);
          if (bad.length > 5) break;
        }
        if (t >= 900) bad.push('wave ' + g.wave + ' never finished');
      }
      return { wave: g.wave, over: g.over, lives: g.lives, stuck: Object.keys(g.W).length, maxE, maxFx, maxP, renderMs: +renderMs.toFixed(1), bad: [...new Set(bad)].slice(0, 5) };
    }, mi);
    check(res.bad.length === 0, `invariants hold on road ${mi}: ${JSON.stringify(res.bad)}`);
    check(res.over || res.stuck === 0, `no wave left stuck on road ${mi}`);
    check(res.maxFx < 3000 && res.maxP < 3000, `effects stay bounded (fx ${res.maxFx}, projectiles ${res.maxP})`);
    console.log(`  soak road ${mi}:`, JSON.stringify(res));
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }

  // ---------------------------------------------------------------
  current = 'offline install (service worker)';
  {
    const { ctx, page } = await newPage(browser, { sw: true });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await page.waitForTimeout(300);
    const cached = await page.evaluate(async () => { const k = await caches.keys(); const c = await caches.open(k[0]); return (await c.keys()).map(r => new URL(r.url).pathname); });
    check(['/index.html', '/manifest.webmanifest', '/icons/icon-192.png'].every(p => cached.includes(p)), 'game files cached: ' + cached.join(' '));
    await ctx.setOffline(true);
    await page.reload(); await page.waitForTimeout(300);
    check(!(await hidden(page, '#menu')) && (await page.$$('.mapbtn')).length === 3, 'loads with no network');
    await startMap(page, 1); await sendWave(page); await page.waitForTimeout(300);
    check((await G(page, () => window.__pw.G.wave)) === 1, 'plays with no network');
    await ctx.setOffline(false);
    const mf = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
    check(mf.icons.some(i => i.sizes === '512x512') && mf.icons.some(i => i.sizes === '192x192') && mf.display === 'standalone', 'manifest is installable');
    check(page.errors.length === 0, 'no console errors: ' + page.errors.join('|'));
    await ctx.close();
  }
  current = 'opened as a local file';
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto('file://' + path.join(ROOT, 'index.html')); await page.waitForTimeout(250);
    await page.click('.mapbtn >> nth=0'); await sendWave(page); await page.waitForTimeout(300);
    check(errs.length === 0 && (await page.evaluate(() => window.__pw.G.wave)) === 1, 'runs from file:// with no server ' + errs.join('|'));
    await ctx.close();
  }

  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('Failures:'); failed.forEach(f => console.log(` - [${f.test}] ${f.msg}`)); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exit(2); });
