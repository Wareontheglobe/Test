// Balance check for Pathwarden: a greedy bot plays every road many times and the summary is checked against the release targets.
// Not part of tests/run.js. Run it by hand from the repo root after changing CFG, MAPS[i].hp, TD, ED or the waves:
//   node tests/balance.js            every profile: 200 runs, about 70 seconds on 4 cores
//   node tests/balance.js --profiles=smart,spam --seeds=5 --bruteArmor=5 --boltDmg=10   a quick look while tuning
// Overrides (applied in the page before each run; without them the game's own values are used):
//   --hpB --budget --earlyMul --armorGrow --floor      CFG.hpB, CFG.themeBudget, CFG.earlyMul, CFG.armorGrow, CFG.armorFloor
//   --easy --normal --hard                             MAPS[0..2].hp (the road's HP multiplier)
//   --bruteArmor --bossArmor                           ED.brute.armor, ED.boss.armor
//   --boltCost --boltDmg --boltRate --boltRange        TD.bolt (rate is seconds between shots)
//   --profiles=smart,spam plays only those profiles; --roads=2 (or 0,2) only those roads (0 Easy, 1 Normal, 2 Hard).
//   --seeds=5 plays at most 5 seeds per profile and road; --seedFrom=21 plays seeds 21, 22, ... (a fresh sample of the same size).
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
// The tuning knobs: option name -> the value it sets, as a path under window.__pw.
const KNOBS = {
  hpB: 'CFG.hpB', budget: 'CFG.themeBudget', earlyMul: 'CFG.earlyMul', armorGrow: 'CFG.armorGrow', floor: 'CFG.armorFloor',
  easy: 'MAPS.0.hp', normal: 'MAPS.1.hp', hard: 'MAPS.2.hp', bruteArmor: 'ED.brute.armor', bossArmor: 'ED.boss.armor',
  boltCost: 'TD.bolt.cost', boltDmg: 'TD.bolt.dmg', boltRate: 'TD.bolt.rate', boltRange: 'TD.bolt.range',
};
const over = Object.entries(KNOBS).filter(([k]) => arg(k) !== undefined).map(([k, p]) => [p, +arg(k)]);
const SEEDS = arg('seeds') ? +arg('seeds') : null, FROM = +arg('seedFrom', 1);
const range = n => Array.from({ length: SEEDS ? Math.min(SEEDS, n) : n }, (_, i) => FROM + i);

// Profiles. Every profile spends the same way (see BOT): between waves and once a second while a wave runs.
// smart: the plan's profile, the design team's balanced builder with some noise. It does not read the coming waves, so it is a
// player who ignores the preview. spam: Bolts only, with smart's noise, so its seeds are different runs. mlf: Mortar, Longshot
// and Frost only. early: smart that also calls the next wave early when it is safe (lives >= 15 and the front of the road is
// clear); that call is the only difference between smart and early. reader: smart reading the next 4 waves (look: 4, see BOT),
// as a player reads the chips and their theme tag. It has no target; it shows what the preview is worth.
// endless: roads where the bot plays on past wave 30 until it falls (up to wave 100), so 'median cleared' there can tell smart and
// early apart. Capped at 30, both win nearly every Normal run and the early target would compare 30 with 30.
const SMART = { frostN: 3, div: 0.3, noise: 0.3 };
const PROFILES = {
  smart: { opts: SMART, maps: [0, 1, 2], seeds: range(20), endless: [1] },
  spam: { opts: { allow: ['bolt'], div: 0, noise: 0.3 }, maps: [0, 1, 2], seeds: range(5) },
  mlf: { opts: { allow: ['mortar', 'long', 'frost'] }, maps: [1], seeds: range(5) },
  early: { opts: { ...SMART, early: true }, maps: [0, 1, 2], seeds: range(20), endless: [1] },
  reader: { opts: { ...SMART, look: 4 }, maps: [0, 1, 2], seeds: range(20) },
};
const want = (arg('profiles') || Object.keys(PROFILES).join(',')).split(',');
// --roads=2 (or 0,2) plays only those roads (0 Easy, 1 Normal, 2 Hard), for a quick look at one of them.
if (arg('roads')) { const keep = arg('roads').split(',').map(Number); for (const P of Object.values(PROFILES)) P.maps = P.maps.filter(m => keep.includes(m)); }
const MAX_ENDLESS = 100;

// The page-side greedy bot, ported from the design team's progression bot. Each time it spends, it buys the best value it can
// afford, again and again: a new tower on the tile where it covers the most road, or an upgrade. Value is damage per second times
// the square root of the road covered, per gold, with a few habits: some Frost from wave 3, Mortars held to a third of the build,
// Longshots favoured from wave 7. If the best buy costs more than it has, it takes one worth at least 75% of it, or waits.
// The shared spending rule: every profile spends before each wave and once every second of game time while a wave runs, as
// people play. Two additions play the way the 1.1 interface teaches: with o.look it reads the coming waves (the chips and their
// theme tag) and scales each tower by how much of them it can hurt; and its Longshots are on Toughest while a Warlord wave is on
// the road and on First otherwise (the only targeting change it makes). It records lives after every wave, the lives it had when
// wave 30 was cleared (at30) and the lives lost on each wave.
function BOT(o) {
  const W = window.__pw, g = W.G, map = g.map, TD = W.TD, C = W.COLS, R = W.ROWS;
  const GROW = W.CFG.armorGrow ?? 0.03, FLOOR = W.CFG.armorFloor ?? 0.25;
  let rs = (o.seed || 1) * 7919 + 13; const rnd = () => { rs = (rs * 1103515245 + 12345) & 0x7fffffff; return rs / 0x7fffffff; };
  const samples = []; for (let d = 0; d < map.path.len; d += 0.2) samples.push(map.path.at(d));
  const covC = new Map();
  const cov = (c, r, Rr) => { const key = c + ',' + r + ',' + Rr; let n = covC.get(key); if (n !== undefined) return n; n = 0;
    for (const p of samples) { const dx = p.x - c - 0.5, dy = p.y - r - 0.5; if (dx * dx + dy * dy <= Rr * Rr) n++; } n *= 0.2; covC.set(key, n); return n; };
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
      const a = d.pierce ? 0 : (e.armor || 0) * (1 + (w - 1) * GROW); got += h * Math.max(FLOOR, (dmg - a) / dmg); }
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
  const boss = w => W.buildWave(w).some(([t]) => W.ED[t].boss);
  // Longshots on Toughest while a Warlord wave is on the road (G.W holds the waves still running), else on First.
  const aim = () => { const m = Object.keys(g.W).some(w => boss(+w)) ? 'tough' : 'first'; for (const t of g.towers) if (t.type === 'long') t.mode = m; };
  // The cheapest buy, so spending can stop at once when even that is out of reach (most ticks).
  const cheapest = () => Math.min(...allow.map(k => TD[k].cost), ...g.towers.filter(t => t.level < 3).map(upCost));
  function spend() {
    for (let guard = 0; guard < (o.guard || 60); guard++) {
      if (g.gold < cheapest()) break;
      const op = options(); if (!op.length) break;
      const best = op[0], pick = best.cost <= g.gold ? best : op.find(x => x.cost <= g.gold && x.v >= best.v * (o.patience || 0.75));
      if (!pick) break;
      if (pick.kind === 'build') W.build(pick.k, pick.c, pick.r); else W.upgrade(pick.t);
    }
    aim();
  }
  // Sends the next wave if the game takes it (it refuses wave 31 while wave 30 is on the road).
  const send = () => { const w = g.wave; W.startWave(); aim(); return g.wave > w; };
  const res = { map: map.id, seed: o.seed, traj: [20], loss: {}, at30: null }, maxWave = o.maxWave || 30;
  while (!g.over && g.wave < maxWave) {
    spend();
    const l0 = g.lives, w0 = g.wave + 1; send();
    let n = 0, since = 0;
    while ((g.spawnQ.length || g.enemies.length) && !g.over && since < 900 * 30) {
      W.step(1 / 30); n++; since++;
      if (n % 30) continue;
      // Once a second of game time: spend, then (early only) call the next wave if it is safe.
      spend();
      if (o.early && !g.spawnQ.length && g.enemies.length && g.lives >= 15 && g.wave < maxWave && g.enemies.every(e => e.dist > map.path.len * 0.35) && send()) since = 0;
    }
    // Lives lost from this wave's start to calm (with early calls that can cover several waves; it is booked on the first).
    if (l0 > g.lives) res.loss[w0] = l0 - g.lives;
    res.traj[g.cleared] = g.lives;
    if (g.cleared >= 30 && res.at30 === null) res.at30 = g.lives;
  }
  res.over = g.over; res.cleared = g.cleared; res.lives = g.lives; res.won = g.cleared >= 30; res.towers = g.towers.length;
  res.build = {}; for (const t of g.towers) res.build[t.type] = (res.build[t.type] || 0) + 1;
  res.dmg = { ...g.stats.dmg };
  return res;
}

(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const jobs = [];
  for (const p of want) { const P = PROFILES[p]; if (!P) throw new Error('unknown profile ' + p); for (const m of P.maps) for (const s of P.seeds) jobs.push({ p, m, s, o: { ...P.opts, seed: s, maxWave: (P.endless || []).includes(m) ? MAX_ENDLESS : 30 } }); }
  // The longest runs first, so the workers finish together.
  jobs.sort((a, b) => b.o.maxWave - a.o.maxWave);
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
        for (const [p, v] of ov) { const ks = p.split('.'), last = ks.pop(); ks.reduce((x, k) => x[k], W)[last] = v; }
        W.newGame(m);
        const res = eval('(' + bot + ')')(o);
        res.air = Object.entries(res.loss).filter(([w]) => W.waveTheme && W.waveTheme(+w) === 'Air raid').reduce((s, [, n]) => s + n, 0);
        res.stars = res.won && W.starCount ? W.starCount(res.at30) : 0;
        const b = W.TD.bolt;
        res.cfg = { hpB: W.CFG.hpB, budget: W.CFG.themeBudget, hp: W.MAPS.map(x => x.hp).join('/'), earlyMul: W.CFG.earlyMul, grow: W.CFG.armorGrow, floor: W.CFG.armorFloor,
          brute: W.ED.brute.armor, boss: W.ED.boss.armor, bolt: `${b.cost}g ${b.dmg} dmg ${b.rate}s ${b.range}`, stars: W.STAR3 ? `${W.STAR3}/${W.STAR2}` : '-' };
        return res;
      }, [BOT.toString(), j.m, j.o, over]);
      out.push({ ...r, profile: j.p });
      if (++done % 10 === 0) process.stdout.write(`${done}/${jobs.length} `);
    }
    await ctx.close();
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, os.cpus().length)) }, worker));
  await browser.close();

  const c = out[0].cfg;
  console.log(`\n\nPathwarden balance (${out.length} runs, ${Math.round((Date.now() - t0) / 1000)}s): CFG.hpB ${c.hpB}, themeBudget ${c.budget}, road hp ${c.hp}, earlyMul ${c.earlyMul}, ` +
    `armor Brute ${c.brute} Warlord ${c.boss} (+${c.grow}/wave, floor ${c.floor}), Bolt ${c.bolt}, stars ${c.stars}\n`);
  const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  const runs = (p, m) => out.filter(r => r.profile === p && r.map === ROADS[m]);
  // Lives when wave 30 was cleared; a run that fell before it had 0 then.
  const at30 = r => r.won ? r.at30 : 0;
  const stars = rs => [3, 2, 1].map(n => rs.filter(r => r.stars === n).length);
  for (const p of want) for (const m of PROFILES[p].maps) {
    const rs = runs(p, m); if (!rs.length) continue;
    const wins = rs.filter(r => r.won), l30 = wins.map(r => r.at30).sort((a, b) => a - b), st = stars(rs);
    console.log(`${p.padEnd(6)} ${DIFF[m].padEnd(6)} wins ${String(wins.length).padStart(2)}/${rs.length}  median cleared ${String(median(rs.map(r => r.cleared))).padStart(4)}${(PROFILES[p].endless || []).includes(m) ? ' (endless)' : ''}  cleared ${rs.map(r => r.cleared).sort((a, b) => a - b).join(',')}` +
      `  lives at 30 ${l30.join(',') || '-'}${l30.length ? ` (median ${median(l30)})` : ''}${wins.length ? `  stars 3/2/1: ${st.join('/')}` : ''}  lost on Air raids ${rs.map(r => r.air).join(',')}`);
  }

  const results = [];
  const target = (name, ok, got) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${got})`); };
  console.log('');
  const wins = (p, m) => runs(p, m).filter(r => r.won).length, n = (p, m) => runs(p, m).length;
  if (want.includes('smart')) {
    if (n('smart', 0)) target('smart wins Easy >= 19/20', wins('smart', 0) >= Math.ceil(19 / 20 * n('smart', 0)), `${wins('smart', 0)}/${n('smart', 0)}`);
    if (n('smart', 1)) target('smart wins Normal >= 17/20', wins('smart', 1) >= Math.ceil(17 / 20 * n('smart', 1)), `${wins('smart', 1)}/${n('smart', 1)}`);
    if (n('smart', 2)) target('smart wins Hard 8-12/20', wins('smart', 2) >= Math.floor(8 / 20 * n('smart', 2)) && wins('smart', 2) <= Math.ceil(12 / 20 * n('smart', 2)), `${wins('smart', 2)}/${n('smart', 2)}`);
    // Stars (STAR3/STAR2): the Normal winners should spread across 1, 2 and 3 stars, and Hard winners should rarely earn 3.
    if (n('smart', 1)) { const s = stars(runs('smart', 1)), k = Math.max(1, Math.round(n('smart', 1) / 10));
      target(`smart's Normal winners earn 3, 2 and 1 stars (at least ${k} runs each)`, s.every(x => x >= k), `3/2/1 stars: ${s.join('/')}`); }
    if (n('smart', 2)) { const s = stars(runs('smart', 2)), k = Math.max(1, Math.round(n('smart', 2) / 10));
      target(`smart's Hard winners rarely earn 3 stars (at most ${k} runs)`, s[0] <= k, `3/2/1 stars: ${s.join('/')}`); }
  }
  if (want.includes('spam')) {
    // Bolts only: a fair run, then the Armored and Warlord waves end it. It dies on wave cleared+1 (it never calls early).
    const SPAM = [[15, 29], [15, 23], [12, 23]];
    for (const m of PROFILES.spam.maps) {
      const [lo, hi] = SPAM[m], d = runs('spam', m).map(r => r.over ? r.cleared + 1 : 'won');
      target(`spam reaches wave ${lo} and dies before wave ${hi + 1} on ${DIFF[m]}`, d.length && d.every(x => x !== 'won' && x >= lo && x <= hi), 'dies on waves ' + d.join(','));
    }
  }
  if (want.includes('mlf')) {
    const a = runs('mlf', 1).map(r => r.air);
    target('mlf on Normal loses at least 1 life on an Air raid wave in every run', a.length && a.every(x => x >= 1), 'lives lost on Air raids per run ' + a.join(','));
  }
  if (want.includes('early') && want.includes('smart')) {
    // Both play Normal on past wave 30 until they fall, so the first two measure how far each gets and how safely. A median at
    // the cap (wave 100, or 20 lives) can't tell them apart, so it fails.
    const ce = median(runs('early', 1).map(r => r.cleared)), cs = median(runs('smart', 1).map(r => r.cleared));
    target('early vs smart on Normal: median cleared wave within 10, played on until both fall', Math.abs(ce - cs) <= 10 && ce < MAX_ENDLESS && cs < MAX_ENDLESS, `early ${ce}, smart ${cs}`);
    const le = median(runs('early', 1).map(at30)), ls = median(runs('smart', 1).map(at30));
    target('early vs smart on Normal: median lives at wave 30 within 3', Math.abs(le - ls) <= 3 && Math.min(le, ls) < 20, `early ${le}, smart ${ls} (0 for a run that fell before wave 30)`);
    const we = wins('early', 2), ws = wins('smart', 2), k = Math.ceil(3 / 20 * n('smart', 2));
    target(`early vs smart on Hard: wins within ${k}/${n('smart', 2)}`, Math.abs(we - ws) <= k && Math.min(we, ws) < n('smart', 2), `early ${we}/${n('early', 2)}, smart ${ws}/${n('smart', 2)}`);
  }
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} targets met`);
  if (arg('json')) require('fs').writeFileSync(arg('json'), JSON.stringify(out, null, 1));
  if (bad) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(2); });
