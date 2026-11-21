// Balance check for Pathwarden: a greedy bot plays every road many times and the summary is checked against the release targets.
// Not part of tests/run.js. Run it by hand from the repo root after changing CFG, MAPS[i].hp, TD or the waves:
//   node tests/balance.js            all target profiles: 140 runs, under a minute on 4 cores (the plan budgeted 10-20 minutes)
//   node tests/balance.js --profiles=smart,plain --seeds=5 --hpB=0.026 --hard=1.05 --budget=0.85   a quick look while tuning
//   --file=path/to/index.html plays another copy (an older build, to compare); --json=out.json saves every run.
// The bot only uses window.__pw (build, upgrade, startWave, step, buildWave, G), so it plays index.html as shipped. The game's
// randomness is drawing only, so a seed always plays the same run.
// It prints one line per profile and road, then PASS or FAIL per target, and exits 1 if a target fails.
'use strict';
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
// --file= plays another copy of the game (an older build, to compare).
const FILE = 'file://' + path.resolve(arg('file') || path.join(__dirname, '..', 'index.html'));
const ROADS = ['switch', 'meadow', 'quarry'], DIFF = ['Easy', 'Normal', 'Hard'];
// Overrides for tuning, applied to __pw.CFG and __pw.MAPS before each run. Without them the game's own values are used.
const over = { hpB: arg('hpB'), hard: arg('hard'), budget: arg('budget') };
const SEEDS = arg('seeds') ? +arg('seeds') : null;
const range = n => Array.from({ length: SEEDS ? Math.min(SEEDS, n) : n }, (_, i) => i + 1);

// Profiles. smart: a balanced builder with some noise that reads the coming waves (look: 4, see BOT). plain: the same builder
// without reading them, as the design team's bot played before themed waves (not a target; for comparison). spam: Bolts only.
// mlf: Mortar, Longshot and Frost only. early: smart, calling the next wave early whenever the road is safe.
const SMART = { frostN: 3, div: 0.3, noise: 0.3, look: 4 };
const PROFILES = {
  smart: { opts: SMART, maps: [0, 1, 2], seeds: range(20) },
  spam: { opts: { allow: ['bolt'], div: 0 }, maps: [0, 1, 2], seeds: range(5) },
  mlf: { opts: { allow: ['mortar', 'long', 'frost'] }, maps: [1], seeds: range(5) },
  early: { opts: { ...SMART, early: true }, maps: [0, 1, 2], seeds: range(20) },
  plain: { opts: { frostN: 3, div: 0.3, noise: 0.3 }, maps: [0, 1, 2], seeds: range(20), extra: true },
};
const want = (arg('profiles') || Object.keys(PROFILES).filter(p => !PROFILES[p].extra).join(',')).split(',');

// The page-side greedy bot, ported from the design team's progression bot. Each turn it spends its gold on the best value it can
// afford: a new tower on the tile where it covers the most road, or an upgrade. Value is damage per second times the square root
// of the road covered, per gold, with a few habits: some Frost from wave 3, Mortars held to a third of the build, Longshots
// favoured from wave 7. Two additions play the way the 1.1 interface teaches: with o.look it reads the coming waves (the chips
// and their theme tag) and scales each tower by how much of them it can hurt; and it puts its Longshots on Toughest for a Warlord
// wave and back on First after it (the only targeting change it makes). It records lives after every wave and the lives lost on
// each wave.
function BOT(o) {
  const W = window.__pw, g = W.G, map = g.map, TD = W.TD, C = W.COLS, R = W.ROWS;
  let rs = (o.seed || 1) * 7919 + 13; const rnd = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const samples = []; for (let d = 0; d < map.path.len; d += 0.2) samples.push(map.path.at(d));
  const cov = (c, r, Rr) => { let n = 0; for (const p of samples) { const dx = p.x - c - 0.5, dy = p.y - r - 0.5; if (dx * dx + dy * dy <= Rr * Rr) n++; } return n * 0.2; };
  const lvMul = [1, 1.6, 2.5], eff = { bolt: 1, mortar: 2.0, frost: 0.5, arc: 2.3, long: 1.3 };
  const allow = o.allow || Object.keys(TD);
  const rng = (k, lv) => TD[k].range + 0.3 * (lv - 1);
  const dps = (k, lv) => TD[k].dmg * lvMul[lv - 1] / (TD[k].rate * Math.pow(0.9, lv - 1)) * eff[k];
  const val = (k, lv, c, r) => dps(k, lv) * Math.sqrt(Math.min(cov(c, r, rng(k, lv)), o.covCap || 7));
  const upCost = t => t.level >= 3 ? 0 : Math.round(TD[t.type].cost * (t.level === 1 ? 0.8 : 1.4) / 5) * 5;
  const count = k => g.towers.filter(t => t.type === k).length;
  // How well tower type k answers wave w, from the game's own rules: the share of the wave's HP it can hit (a Mortar can't hit
  // fliers), times the share of a level-2 hit that gets through armor (a Longshot ignores it). With o.look the bot reads the
  // coming waves as a player reads the preview: it scales every build and upgrade by the average fit over the next o.look waves.
  const fitW = (k, w) => { const d = TD[k], dmg = d.dmg * 1.6; let all = 0, got = 0;
    for (const [t, c] of W.buildWave(w)) { const e = W.ED[t], h = e.hp * c; all += h; if (e.fly && d.air === false) continue;
      const a = d.pierce ? 0 : (e.armor || 0) * (1 + (w - 1) * 0.03); got += h * Math.max(0.25, (dmg - a) / dmg); }
    return got / all; };
  const reach = () => { const f = {}; for (const k of Object.keys(TD)) { let s = 0; for (let i = 1; i <= (o.look || 0); i++) s += fitW(k, g.wave + i); f[k] = o.look ? s / o.look : 1; } return k => f[k]; };
  function options() {
    const opts = [], nT = g.towers.length, nM = count('mortar'), nF = count('frost'), hit = reach();
    for (const k of allow) {
      let best = null, bv = 0;
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { if (g.grid[r * C + c]) continue; const v = val(k, 1, c, r); if (v > bv) { bv = v; best = [c, r]; } }
      if (!best) continue;
      let v = bv / TD[k].cost / (1 + (o.div ?? 0.18) * count(k)) * hit(k);
      if (k === 'mortar' && nM >= Math.max(1, (nT - nM) * 0.5)) v *= 0.3;
      if (k === 'frost') v = (g.wave >= 3 && nF < (o.frostN ?? 2) && nT >= 3) ? v * (o.frostW ?? 3.5) * 4 : v * 0.3;
      if (k === 'long' && g.wave >= 7) v *= (o.longW ?? 1.4);
      v *= 1 + (o.noise || 0) * (rnd() - 0.5);
      opts.push({ kind: 'build', k, c: best[0], r: best[1], cost: TD[k].cost, v });
    }
    for (const t of g.towers) {
      if (t.level >= 3) continue;
      const cst = upCost(t); let v = (val(t.type, t.level + 1, t.c, t.r) - val(t.type, t.level, t.c, t.r)) / cst * hit(t.type);
      if (t.type === 'frost') v *= 0.6;
      v *= 1 + (o.noise || 0) * (rnd() - 0.5);
      opts.push({ kind: 'up', t, cost: cst, v });
    }
    return opts.sort((a, b) => b.v - a.v);
  }
  function spend() {
    for (let guard = 0; guard < (o.guard || 60); guard++) {
      const op = options(); if (!op.length) return;
      const best = op[0], pick = best.cost <= g.gold ? best : op.find(x => x.cost <= g.gold && x.v >= best.v * (o.patience || 0.75));
      if (!pick) return;
      if (pick.kind === 'build') W.build(pick.k, pick.c, pick.r); else W.upgrade(pick.t);
    }
  }
  const boss = w => W.buildWave(w).some(([t]) => W.ED[t].boss);
  const send = () => { const m = boss(g.wave + 1) ? 'tough' : 'first'; for (const t of g.towers) if (t.type === 'long') t.mode = m; W.startWave(); };
  const res = { map: map.id, seed: o.seed, traj: [20], loss: {} }, maxWave = o.maxWave || 30;
  while (!g.over && g.wave < maxWave) {
    spend();
    const l0 = g.lives, w0 = g.wave + 1; send();
    let t = 0;
    while ((g.spawnQ.length || g.enemies.length) && !g.over && t < 900) {
      W.step(1 / 30); t += 1 / 30;
      if (o.early && !g.spawnQ.length && g.enemies.length && g.lives >= 15 && g.wave < maxWave && g.enemies.every(e => e.dist > map.path.len * 0.35)) { spend(); send(); }
    }
    // Lives lost from this wave's start to calm (with early calls that can cover several waves; it is booked on the first).
    if (l0 > g.lives) res.loss[w0] = l0 - g.lives;
    res.traj[g.cleared] = g.lives;
  }
  res.over = g.over; res.cleared = g.cleared; res.lives = g.lives; res.won = g.cleared >= 30; res.towers = g.towers.length;
  return res;
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const jobs = [];
  for (const p of want) { const P = PROFILES[p]; if (!P) throw new Error('unknown profile ' + p); for (const m of P.maps) for (const s of P.seeds) jobs.push({ p, m, s }); }
  const out = []; let next = 0, done = 0;
  async function worker() {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 2; });
    while (next < jobs.length) {
      const j = jobs[next++];
      await page.goto(FILE); await page.waitForTimeout(50);
      const r = await page.evaluate(([bot, m, o, ov]) => {
        const W = window.__pw;
        if (ov.hpB) W.CFG.hpB = +ov.hpB; if (ov.budget) W.CFG.themeBudget = +ov.budget; if (ov.hard) W.MAPS[2].hp = +ov.hard;
        W.newGame(m);
        const res = eval('(' + bot + ')')(o);
        res.air = Object.entries(res.loss).filter(([w]) => W.waveTheme && W.waveTheme(+w) === 'Air raid').reduce((s, [, n]) => s + n, 0);
        res.cfg = { hpB: W.CFG.hpB, budget: W.CFG.themeBudget, hard: W.MAPS[2].hp };
        return res;
      }, [BOT.toString(), j.m, { ...PROFILES[j.p].opts, seed: j.s }, over]);
      out.push({ ...r, profile: j.p });
      if (++done % 10 === 0) process.stdout.write(`${done}/${jobs.length} `);
    }
    await ctx.close();
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, os.cpus().length)) }, worker));
  await browser.close();

  const cfg = out[0].cfg;
  console.log(`\n\nPathwarden balance: CFG.hpB ${cfg.hpB}, CFG.themeBudget ${cfg.budget}, Quarry hp ${cfg.hard} (${out.length} runs, ${Math.round((Date.now() - t0) / 1000)}s)\n`);
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const runs = (p, m) => out.filter(r => r.profile === p && r.map === ROADS[m]);
  for (const p of want) for (const m of PROFILES[p].maps) {
    const rs = runs(p, m); if (!rs.length) continue;
    const wins = rs.filter(r => r.won);
    console.log(`${p.padEnd(5)} ${DIFF[m].padEnd(6)} wins ${String(wins.length).padStart(2)}/${rs.length}  median cleared ${String(median(rs.map(r => r.cleared))).padStart(4)}  cleared ${rs.map(r => r.cleared).sort((a, b) => a - b).join(',')}` +
      `  lives at 30 ${wins.map(r => r.lives).sort((a, b) => a - b).join(',') || '-'}  lost on Air raids ${rs.map(r => r.air).join(',')}`);
  }

  const results = [];
  const target = (name, ok, got) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${got})`); };
  console.log('');
  if (want.includes('smart')) {
    const w = m => runs('smart', m).filter(r => r.won).length, n = m => runs('smart', m).length;
    if (n(0)) target('smart wins Easy >= 19/20', w(0) >= Math.ceil(19 / 20 * n(0)), `${w(0)}/${n(0)}`);
    if (n(1)) target('smart wins Normal >= 17/20', w(1) >= Math.ceil(17 / 20 * n(1)), `${w(1)}/${n(1)}`);
    if (n(2)) target('smart wins Hard 8-12/20', w(2) >= Math.floor(8 / 20 * n(2)) && w(2) <= Math.ceil(12 / 20 * n(2)), `${w(2)}/${n(2)}`);
  }
  if (want.includes('spam')) for (const m of PROFILES.spam.maps) {
    // Dies on wave cleared+1 (no early calls): it must get to wave 15 and fall before wave 24.
    const d = runs('spam', m).map(r => r.over ? r.cleared + 1 : 99);
    target(`spam reaches wave 15 or later but dies before wave 24 on ${DIFF[m]}`, d.every(x => x >= 15 && x < 24), 'dies on waves ' + d.join(','));
  }
  if (want.includes('mlf')) {
    const a = runs('mlf', 1).map(r => r.air);
    target('mlf on Normal loses at least 1 life on an Air raid wave', a.every(x => x >= 1), 'lives lost on Air raids per run ' + a.join(','));
  }
  if (want.includes('early') && want.includes('smart')) {
    const e = median(runs('early', 1).map(r => r.cleared)), s = median(runs('smart', 1).map(r => r.cleared));
    target('early vs smart: median cleared wave within +-2 on Normal', Math.abs(e - s) <= 2, `early ${e}, smart ${s}`);
  }
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} targets met`);
  if (arg('json')) require('fs').writeFileSync(arg('json'), JSON.stringify(out, null, 1));
  if (bad) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(2); });
