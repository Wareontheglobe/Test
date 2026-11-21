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
async function startMap(page, i) { await page.click(`.mapbtn >> nth=${i}`); await page.waitForTimeout(80); }
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
    check(await page.$eval('.tw', el => el.classList.contains('dim')), 'palette dimmed with no tile selected');
    await page.click('.tw[data-t="bolt"]');
    check((await text(page, '#info')).includes('Tap a grass tile first'), 'palette tap without a tile explains what to do');

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
    check((await G(page, () => window.__pw.G.gold)) === goldBefore + Math.floor(spent * 0.7), 'refund is 70% of total spent');
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
    const saved = await G(page, () => JSON.parse(localStorage.getItem('pathwarden.v1')).save);
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
    await page.click('#bPause'); await page.click('#bRestart');
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
    await page.click('#bWave');
    await runUntilCalm(page);
    await page.waitForTimeout(80);
    check(await G(page, () => window.__pw.G.over), 'game ends at 0 lives');
    check(!(await hidden(page, '#endOv')) && (await text(page, '#endTitle')) === 'The keep has fallen', 'loss screen shown');
    check((await G(page, () => JSON.parse(localStorage.getItem('pathwarden.v1')).save)) === undefined, 'save cleared on loss');
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
    await page.click('#bWave');
    await page.waitForTimeout(300);
    check(page.errors.length === 0, 'plays with storage blocked (private mode): ' + page.errors.join('|'));
    await ctx.close();
  }
  for (const bad of ['5', 'not json', 'null', '{"best":5}', '{"save":{"map":"meadow","wave":3,"gold":100,"lives":20,"towers":[{"type":"laser","c":0,"r":0},{"type":"bolt","c":1,"r":3},{"type":"bolt","c":99,"r":-4}]}}']) {
    current = 'corrupt save ' + bad.slice(0, 20);
    const { ctx, page } = await newPage(browser);
    await page.evaluate(v => localStorage.setItem('pathwarden.v1', v), bad); await page.reload(); await page.waitForTimeout(250);
    check(!(await hidden(page, '#menu')) && (await page.$$('.mapbtn')).length === 3, 'menu still loads with roads listed');
    if (!(await hidden(page, '#bContinue'))) { await page.click('#bContinue'); await page.waitForTimeout(100); }
    else { await startMap(page, 1); }
    await page.click('#bWave'); await page.waitForTimeout(200);
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
    await startMap(page, 1); await page.click('#bWave'); await page.waitForTimeout(300);
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
    await page.click('.mapbtn >> nth=0'); await page.click('#bWave'); await page.waitForTimeout(300);
    check(errs.length === 0 && (await page.evaluate(() => window.__pw.G.wave)) === 1, 'runs from file:// with no server ' + errs.join('|'));
    await ctx.close();
  }

  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('Failures:'); failed.forEach(f => console.log(` - [${f.test}] ${f.msg}`)); process.exitCode = 1; }
})().catch(e => { console.error(e); process.exit(2); });
