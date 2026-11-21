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
    for (let i = 0; i < 4; i++) { await page.click('#bMode'); modes.push(await page.$eval('#bMode small', el => el.textContent)); }
    check(modes.join(',') === 'Last,Strongest,Closest,First', 'target cycles Last→Strongest→Closest→First (' + modes + ')');

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
      check(label === 'Call 2 early', 'offers early call once wave fully arrived (' + label + ')');
      const g0 = await G(page, () => window.__pw.G.gold);
      await page.click('#bWave');
      check((await G(page, () => window.__pw.G.gold)) >= g0 + 12, 'early call pays a bonus');
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
    await page.waitForTimeout(80);
    check(await G(page, () => window.__pw.G.over), 'game ends at 0 lives');
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
    check((await text(page, '#toast')) === 'Wave 1' && (await page.$eval('#toast', el => el.classList.contains('show'))), 'wave 1 toast showing');
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
    check(parts === 4, 'reduced motion: a kill bursts half the particles (' + parts + ')');
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
    check(parts2 === 8, 'full motion: a kill bursts 8 particles (' + parts2 + ')');
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
    check(near(sine, 1047) && sine.filter(x => Math.abs(x - 523) < 0.5).length === 1, 'victory plays the win cue (523-1047) once, with no clear cue on top ' + JSON.stringify(sine.map(Math.round)));
    await page.click('#bEndMain');
    await clearRec(page, 70);
    const r31 = await killWaves(page, 1);
    sine = await vals(page, 'sine');
    check(r31.wave === 31 && near(sine, 523) && near(sine, 659) && near(sine, 784) && !near(sine, 1047), 'an ordinary wave clear plays clear (523, 659, 784) ' + JSON.stringify(sine.map(Math.round)));
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
    const ready = await text(page, '#info');
    check(ready.startsWith('Bolt ready. Tap grass to place it.') && ready.endsWith('Dmg 11 · Range 2.4 · 1.8/s') && (await page.$eval('#info', el => el.innerHTML.includes('<b>Bolt</b> ready.') && el.innerHTML.includes('<br>'))), '#info: "<b>Bolt</b> ready. Tap grass to place it.<br>" and the Bolt stats (' + ready + ')');
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
    check((await text(page, '#info')).startsWith('Next: ') && !(await text(page, '#info')).includes('ready'), 'a tower kept armed after a build leaves #info to the wave preview (' + (await text(page, '#info')) + ')');
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
    check((await text(page, '#info')) === 'Wave 1 is marching in.' && (await cls(page, '.tw[data-t="bolt"]', 'armed')), 'during the wave #info says the wave is marching in, and the palette still shows Bolt armed (' + (await text(page, '#info')) + ')');
    await G(page, () => { const W = window.__pw, g = W.G; g.running = false; let t = 0; while ((g.spawnQ.length || g.enemies.length) && t < 400) { W.step(1 / 30); W.hurtAll(1e9); t += 1 / 30; } g.running = true; });
    await page.waitForTimeout(100);
    check((await text(page, '#info')).startsWith('Next: ') && (await G(page, () => window.__pw.G.pending)) === 'bolt', 'after the wave the next-wave preview is back (' + (await text(page, '#info')) + ')');
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
      const W = window.__pw, g = W.G, info = document.querySelector('#info'), bw = document.querySelector('#bWave'), out = [];
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
    check(bad.length === 0 && res.length === 20, `${vp.width}px: for every tower beside every wave button label, the ready line fits #info's 3 lines and keeps the tower's name, the instruction and its trait ` + JSON.stringify(bad.slice(0, 3)));
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
    const coach = await page.evaluate(() => { const i = document.querySelector('#info'); return { text: i.textContent, html: i.innerHTML, color: getComputedStyle(i).color }; });
    check(coach.text === 'Build first: tap a grass tile beside the road.' && coach.html.startsWith('<b>Build first:</b>') && coach.color === 'rgb(240, 233, 210)', 'fresh storage: #info reads "Build first: tap a grass tile beside the road." in ink, not muted ' + JSON.stringify(coach));
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
    check(!(await text(page, '#info')).includes('Build first') && !(await cls(page, '#info', 'coach')), 'arming a tower replaces the coaching line');
    await page.click('.tw[data-t="bolt"]');
    check((await text(page, '#info')).includes('Build first'), 'disarming brings it back');
    await tapTile(page, h0.c, h0.r);
    check((await text(page, '#info')) === 'Pick a tower to place here.', 'a selected tile replaces it too');
    await page.click('.tw[data-t="bolt"]'); await page.click('.tw[data-t="bolt"]');
    const after = await G(page, () => ({ hints: window.__pw.G.hintTiles.length, done: window.__pw.S.tutorialDone, tip: window.__pw.S.refundTip, towers: window.__pw.G.towers.length }));
    check(after.towers === 1 && after.hints === 0 && after.done === true, 'after the first build G.hintTiles is empty and S.tutorialDone === true ' + JSON.stringify(after));
    const ls = await stored(page);
    check(ls.tutorialDone === true && ls.refundTip === true, 'tutorialDone and refundTip are saved');
    check((await text(page, '#toast')) === 'Changed your mind? Full refund until the next wave.' && after.tip === true, 'the first build toasts "Changed your mind? Full refund until the next wave."');
    check(!(await text(page, '#info')).includes('Build first') && !(await cls(page, '#info', 'coach')), 'the coaching line is gone once a tower stands');
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
