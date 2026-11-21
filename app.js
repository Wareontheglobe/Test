import { pip } from "./mascot.js";

/* =========================================================================
   Blog Quest — daily fact-check lessons for the blog.
   Decks of "possible error" cards are read from a PRIVATE GitHub repo
   (decks/*.json). Answers are stored on the phone first, then uploaded to
   responses/*.json in the same repo whenever the phone is online.
   ========================================================================= */

// Demo mode: a page can set window.BQ_DEMO = {deck} before loading this script.
// Cards come from that deck, nothing is sent anywhere, and progress stays in this browser.
const DEMO = window.BQ_DEMO || null;
const KEY = DEMO ? "blogquest.demo" : "blogquest.v1";
const LESSON_SIZE = 5;
const XP = { answer: 10, high: 5, note: 5, source: 5, later: 2 };
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const TYPE_ICON = { closed: "🚪", price: "💲", hours: "🕒", show: "🎭", link: "🔗", rule: "📋", other: "🔍" };

const DEFAULTS = {
  settings: { token: "", repo: "Wareontheglobe/blog-fixes", branch: "main", dailyGoal: 5, sound: true },
  decks: {},        // deckId -> {id, sha, created, cards: []}
  answers: {},      // cardId -> answer record
  later: [],        // cardIds parked in Investigations
  pending: [],      // answers not yet packaged into an upload
  outbox: [],       // [{path, body}] files waiting to upload
  xp: 0,
  streak: { count: 0, lastDay: "" },
  days: {},         // yyyy-mm-dd -> cards resolved that day
  badges: {},       // badgeId -> date earned
  lastSync: "",
  restored: false,
  live: {},         // cardId -> fix-log entry, for answers that are now live on the blog
  seenLive: 0,      // how many live fixes she has already been told about
};

let S = load();
let view = { name: "home" };
let lesson = null;    // {cards, i, selected, earned, startXp, done}
let syncing = false;

/* ---------------- storage ---------------- */
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw) return { ...structuredClone(DEFAULTS), ...raw, settings: { ...DEFAULTS.settings, ...raw.settings } };
  } catch (e) { /* storage blocked or corrupt — start fresh in memory */ }
  return structuredClone(DEFAULTS);
}
let saveWarned = false;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { if (!saveWarned) { saveWarned = true; toast("This browser won't save progress — it resets when you close the app"); } }
}

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const today = () => dayKey(new Date());
function dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d); }
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }

let actx;
function chime(kind = "ok") {
  if (!S.settings.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = kind === "win" ? [523, 659, 784, 1047] : kind === "later" ? [440, 392] : [660, 880];
    notes.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "triangle"; o.frequency.value = f;
      const t0 = actx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + 0.25);
    });
  } catch (e) {}
}

/* ---------------- card queries ---------------- */
function allCards() {
  const out = [];
  Object.values(S.decks).sort((a, b) => (b.id > a.id ? 1 : -1)).forEach((d) =>
    (d.cards || []).forEach((c) => out.push({ ...c, deck: d.id })));
  const seen = new Set();
  return out.filter((c) => c.id && !seen.has(c.id) && seen.add(c.id));
}
function openCards() {
  return allCards()
    .filter((c) => !S.answers[c.id] && !S.later.includes(c.id))
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
}
function laterCards() { const all = allCards(); return S.later.map((id) => all.find((c) => c.id === id)).filter(Boolean); }
function posts() {
  const map = new Map();
  allCards().forEach((c) => {
    const k = c.post?.id ?? c.post?.url ?? c.post?.title;
    if (!map.has(k)) map.set(k, { key: k, title: c.post?.title || "Untitled post", url: c.post?.url, cards: [] });
    map.get(k).cards.push(c);
  });
  return [...map.values()].map((p) => ({
    ...p,
    done: p.cards.filter((c) => S.answers[c.id]).length,
    open: p.cards.filter((c) => !S.answers[c.id] && !S.later.includes(c.id)).length,
  }));
}
function streakNow() {
  const s = S.streak;
  return s.lastDay === today() || s.lastDay === yesterday() ? s.count : 0;
}
function resolvedCount() { return Object.keys(S.answers).length; }

/* ---------------- badges ---------------- */
const BADGES = [
  { id: "first", e: "🔎", name: "First Catch", how: "Resolve your first card", test: () => resolvedCount() >= 1 },
  { id: "lesson", e: "🎒", name: "Day Tripper", how: "Finish a full lesson", test: () => S.badges.lesson },
  { id: "streak3", e: "🔥", name: "On a Roll", how: "3-day streak", test: () => streakNow() >= 3 },
  { id: "streak7", e: "🌋", name: "Volcano", how: "7-day streak", test: () => streakNow() >= 7 },
  { id: "ten", e: "🧭", name: "Navigator", how: "Resolve 10 cards", test: () => resolvedCount() >= 10 },
  { id: "fifty", e: "🏔️", name: "Summit", how: "Resolve 50 cards", test: () => resolvedCount() >= 50 },
  { id: "sleuth", e: "🕵️", name: "Sleuth", how: "Add your own source", test: () => Object.values(S.answers).some((a) => a.extra_source_url) },
  { id: "stamp", e: "🛂", name: "Stamped", how: "Finish every card on a post", test: () => posts().some((p) => p.done && p.done === p.cards.length) },
  { id: "miles500", e: "✈️", name: "Frequent Flyer", how: "Earn 500 miles", test: () => S.xp >= 500 },
  { id: "live", e: "📰", name: "Published", how: "A fix you chose goes live", test: () => Object.keys(S.live || {}).length >= 1 },
  { id: "live10", e: "🏆", name: "Editor in Chief", how: "10 fixes live on the blog", test: () => Object.keys(S.live || {}).length >= 10 },
];
function checkBadges() {
  const fresh = [];
  BADGES.forEach((b) => { if (!S.badges[b.id] && b.test()) { S.badges[b.id] = today(); fresh.push(b); } });
  return fresh;
}

/* ---------------- GitHub sync ---------------- */
function gh(path, opts = {}) {
  const { token, repo } = S.settings;
  return fetch(`https://api.github.com/repos/${repo}${path ? "/" + path : ""}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json", ...(opts.headers || {}) },
  });
}
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
async function ghError(res) {
  if (res.status === 401) return "GitHub didn't accept the access key. Check Settings.";
  if (res.status === 403 || res.status === 404) return "Can't reach the repo with this key. Check the repo name and key permissions.";
  return `GitHub error ${res.status}`;
}

function packagePending() {
  if (!S.pending.length) return;
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const body = {
    app: "blog-quest", version: 1, submitted_at: now.toISOString(),
    answers: S.pending,
  };
  S.outbox.push({ path: `responses/${dayKey(now)}/${stamp}.json`, body });
  S.pending = [];
  save();
}

async function flushOutbox() {
  let sent = 0;
  while (S.outbox.length) {
    const item = S.outbox[0];
    const n = item.body.answers.length;
    const res = await gh(`contents/${item.path}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Blog Quest: ${n} answer${n === 1 ? "" : "s"}`,
        content: b64(JSON.stringify(item.body, null, 2) + "\n"),
        branch: S.settings.branch,
      }),
    });
    if (res.status === 422) { item.path = item.path.replace(/\.json$/, `-${Math.random().toString(36).slice(2, 6)}.json`); continue; }
    if (!res.ok) throw new Error(await ghError(res));
    S.outbox.shift(); sent += n; save();
  }
  return sent;
}

async function pullDecks() {
  const { branch } = S.settings;
  const res = await gh(`contents/decks?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(await ghError(res));
  const files = (await res.json()).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  let added = 0;
  for (const f of files) {
    const id = f.name.replace(/\.json$/, "");
    if (S.decks[id]?.sha === f.sha) continue;
    const r = await gh(`contents/${f.path}?ref=${encodeURIComponent(branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (!r.ok) continue;
    try {
      const deck = await r.json();
      const before = new Set((S.decks[id]?.cards || []).map((c) => c.id));
      S.decks[id] = { id, sha: f.sha, created: deck.created || id, cards: Array.isArray(deck) ? deck : deck.cards || [] };
      added += S.decks[id].cards.filter((c) => !before.has(c.id)).length;
    } catch (e) { /* skip malformed deck */ }
  }
  save();
  return added;
}

// On a fresh install, mark cards that were already answered on another device / earlier install.
async function restoreAnswered() {
  if (S.restored || resolvedCount() > 0) { S.restored = true; return; }
  const { branch } = S.settings;
  const top = await gh(`contents/responses?ref=${encodeURIComponent(branch)}`);
  if (top.ok) {
    const dirs = (await top.json()).filter((d) => d.type === "dir");
    for (const d of dirs) {
      const r = await gh(`contents/${d.path}?ref=${encodeURIComponent(branch)}`);
      if (!r.ok) continue;
      for (const f of (await r.json()).filter((x) => x.name.endsWith(".json"))) {
        const fr = await gh(`contents/${f.path}?ref=${encodeURIComponent(branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
        if (!fr.ok) continue;
        try { (await fr.json()).answers?.forEach((a) => { S.answers[a.card_id] = { ...a, restored: true }; }); } catch (e) {}
      }
    }
  }
  S.restored = true; save();
}

async function sync({ quiet = false } = {}) {
  if (DEMO) {
    packagePending();
    const n = S.outbox.reduce((k, o) => k + o.body.answers.length, 0);
    S.demoSent = [...(S.demoSent || []), ...S.outbox].slice(-20); S.outbox = []; save();
    if (n) toast(`Demo: ${n} answer${n === 1 ? "" : "s"} would upload now`);
    else if (!quiet) toast("Demo mode: nothing to upload");
    refreshAfterSync();
    return;
  }
  if (syncing) return;
  if (!S.settings.token) { if (!quiet) toast("Add the GitHub key in Settings first"); return; }
  if (!navigator.onLine) { if (!quiet) toast("Offline — will sync when you're back online"); return; }
  syncing = true;
  try {
    packagePending();
    const sent = await flushOutbox();
    const added = await pullDecks();
    await restoreAnswered();
    const newlyLive = await pullFixLog();
    S.lastSync = new Date().toISOString(); save();
    if (!quiet || sent || added || newlyLive) {
      const bits = [];
      if (sent) bits.push(`${sent} answer${sent === 1 ? "" : "s"} uploaded`);
      if (added) bits.push(`${added} new card${added === 1 ? "" : "s"}`);
      if (newlyLive) bits.push(`🎉 ${newlyLive} of your fixes ${newlyLive === 1 ? "is" : "are"} live on the blog!`);
      toast(bits.length ? bits.join(" · ") : "All synced ✓");
    }
  } catch (e) {
    if (!quiet) toast(e.message || "Sync failed — will retry");
  } finally {
    syncing = false;
    refreshAfterSync();
  }
}

// Re-draw only screens with nothing she could be typing into.
function refreshAfterSync() {
  updateIconBadge();
  if (["home", "later", "passport"].includes(view.name)) render();
  else if (view.name === "complete") { const el = $(".sync-line"); if (el) el.textContent = syncLine(); }
}

// fixes/applied.json is written when her answers are applied to the blog.
async function pullFixLog() {
  const res = await gh(`contents/fixes/applied.json?ref=${encodeURIComponent(S.settings.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!res.ok) return 0;
  let log; try { log = await res.json(); } catch (e) { return 0; }
  S.live = {};
  Object.entries(log || {}).forEach(([id, e]) => { if (e && e.status === "applied") S.live[id] = e; });
  const n = Object.keys(S.live).length;
  const fresh = Math.max(0, n - (S.seenLive || 0));
  S.seenLive = n;
  checkBadges();
  save();
  return fresh;
}

function updateIconBadge() {
  try {
    const n = openCards().length;
    if (!("setAppBadge" in navigator)) return;
    n ? navigator.setAppBadge(n) : navigator.clearAppBadge();
  } catch (e) {}
}

/* ---------------- answering ---------------- */
function recordAnswer(card, decision, extra) {
  const day = today();
  if (S.streak.lastDay !== day) {
    S.streak = { count: S.streak.lastDay === yesterday() ? S.streak.count + 1 : 1, lastDay: day };
  }
  S.days[day] = (S.days[day] || 0) + 1;
  let earned = XP.answer;
  if (card.severity === "high") earned += XP.high;
  if (extra.note) earned += XP.note;
  if (extra.source) earned += XP.source;
  S.xp += earned;
  const rec = {
    card_id: card.id,
    deck: card.deck,
    post: card.post,
    type: card.type,
    severity: card.severity,
    claim_quote: card.claim?.quote || "",
    decision: decision.kind,                         // "apply_option" | "post_is_fine" | "other"
    option: decision.option || null,                 // {id, label, action, new_text} when apply_option
    note: extra.note || "",
    extra_source_url: extra.source || "",
    sources_shown: (card.sources || []).map((s) => s.url),
    answered_at: new Date().toISOString(),
  };
  S.answers[card.id] = rec;
  S.later = S.later.filter((id) => id !== card.id);
  S.pending.push(rec);
  save();
  return earned;
}

/* ---------------- views ---------------- */
function render() {
  const app = $("#app");
  app.classList.toggle("lesson-mode", view.name === "lesson" || view.name === "complete");
  const html = {
    home: homeView, lesson: lessonView, complete: completeView, later: laterView, passport: passportView, settings: settingsView,
  }[view.name]();
  app.innerHTML = html + (view.name === "lesson" || view.name === "complete" ? "" : navView());
  bind();
  window.scrollTo(0, 0);
  updateIconBadge();
}

function topbar() {
  const offline = !navigator.onLine;
  const waiting = S.outbox.reduce((n, o) => n + o.body.answers.length, 0) + S.pending.length;
  return `<div class="topbar">
    <span class="pill streak" title="Day streak">🔥 ${streakNow()}</span>
    <span class="pill miles" title="Miles earned">✈️ ${S.xp}</span>
    <span class="spacer"></span>
    ${DEMO ? `<span class="pill off" title="Nothing is sent anywhere">🧪 Demo</span>` : ""}
    ${offline ?`<span class="pill off">📴 Offline</span>` : waiting ? `<span class="pill off">⏳ ${waiting} to upload</span>` : ""}
  </div>`;
}

function greeting(open) {
  if (!S.settings.token && !allCards().length) return "Hi! I'm Pip 👋 Let's get set up — tap ⚙️ Settings to connect.";
  if (!open) return pick(["All caught up! Every fact checked. I'll have more for you soon.", "Nothing to check right now — go have an adventure! 🌍"]);
  const doneToday = S.days[today()] || 0;
  if (doneToday >= S.settings.dailyGoal) return pick(["Daily goal smashed! 🎉 Bonus rounds still count.", "You're on fire today. Want to keep going?"]);
  if (streakNow() >= 2) return `${streakNow()} days in a row! Keep the streak alive 🔥`;
  return pick([`I found ${open} things that might need a look.`, "Ready for a quick fact-check trip?", `${open} possible fixes waiting — let's go!`]);
}

function homeView() {
  const open = openCards();
  const doneToday = S.days[today()] || 0;
  const goal = S.settings.dailyGoal;
  const pct = Math.min(100, Math.round((doneToday / goal) * 100));
  const ps = posts().sort((a, b) => (b.open > 0) - (a.open > 0));
  const standalone = DEMO || matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!S.settings.token) return `${topbar()}
    <div class="hero">${pip("happy", 104)}<div class="bubble">Hi! I'm Pip 👋 I hunt for things on the blog that might be out of date. Let's get connected!</div></div>
    ${!standalone ? `<div class="tip">📲 <b>Do this first:</b> add Blog Quest to your home screen, then open it from there and connect. (iPhone: Share → <i>Add to Home Screen</i>. Android: ⋮ → <i>Install app</i>.) The home-screen app keeps its own storage, so connecting in the browser won't carry over.</div>` : ""}
    <div class="card">
      <b>Step 1 · Connect</b>
      <p class="small muted" style="margin:6px 0 12px">Copy the access key you were sent, then tap Paste.</p>
      <button class="btn teal" data-act="paste-key">📋 Paste key</button>
      <details class="extra"><summary>Or type it in</summary>
        <input type="password" id="token" autocomplete="off" placeholder="github_pat_…">
        <button class="btn ghost" data-act="save-key" style="margin-top:10px">Connect</button>
      </details>
    </div>`;
  return `${topbar()}
    <div class="hero">${pip(open.length ? "happy" : "sleepy", 104)}<div class="bubble">${esc(greeting(open.length))}</div></div>
    <div class="goal">
      <div class="ring" style="--p:${pct}"><span>${Math.min(doneToday, goal)}/${goal}</span></div>
      <div><b>Daily goal</b><small>${doneToday >= goal ? "Done for today — nice!" : `${goal - doneToday} more card${goal - doneToday === 1 ? "" : "s"} to hit today's goal`}</small></div>
    </div>
    ${open.length ? `<button class="btn" data-act="start">Start lesson · ${Math.min(LESSON_SIZE, open.length)} cards</button>`
      : `<button class="btn ghost" data-act="sync">${S.settings.token ? "Check for new cards" : "Open Settings"}</button>`}
    ${!standalone ? `<div class="tip" style="margin-top:14px">📲 <b>Tip:</b> add this to your home screen so it works offline. iPhone: Share → <i>Add to Home Screen</i>. Android: menu ⋮ → <i>Install app</i>.</div>` : ""}
    ${ps.length ? `<h2>Your journey</h2><div class="path">${ps.map((p) => {
      const cls = p.open === 0 ? (p.done ? "done" : "locked") : "";
      const icon = p.open === 0 ? (p.done ? "⭐" : "🔒") : "📍";
      return `<button class="stop ${cls}" data-post="${esc(p.key)}" ${p.open ? "" : "disabled"}>
        <span class="node">${icon}${p.open ? `<span class="count">${p.open}</span>` : ""}</span>
        <span class="label">${esc(p.title)}<small>${p.done}/${p.cards.length} checked</small></span></button>`;
    }).join("")}</div>` : ""}`;
}

function navView() {
  const n = S.later.length;
  const t = (id, icon, label) => `<button class="${view.name === id ? "on" : ""}" data-nav="${id}" aria-label="${label}">${icon}<span>${label}</span>${id === "later" && n ? `<i class="dot">${n}</i>` : ""}</button>`;
  return `<nav class="tabs"><div class="in">${t("home", "🗺️", "Journey")}${t("later", "🕵️", "Investigate")}${t("passport", "🛂", "Passport")}${t("settings", "⚙️", "Settings")}</div></nav>`;
}

function startLesson(cards) {
  if (!cards.length) return;
  lesson = { cards: cards.slice(0, LESSON_SIZE), i: 0, selected: null, earned: 0, answered: 0, parked: 0 };
  view = { name: "lesson" }; render();
}

function lessonView() {
  const c = lesson.cards[lesson.i];
  const pct = Math.round((lesson.i / lesson.cards.length) * 100);
  const sev = c.severity || "low";
  const sevText = { high: "Readers may act on this", medium: "Worth updating", low: "Minor" }[sev] || "";
  // An option can carry "valid_until": "YYYY-MM-DD" (e.g. "add a final-weekend note") and is hidden after that date.
  const options = (c.options || []).filter((o) => !o.valid_until || o.valid_until >= today()).map((o, n) => ({ key: String.fromCharCode(65 + n), id: `opt:${o.id}`, label: o.label, sub: o.new_text && o.action !== "remove" ? `“${o.new_text}”` : o.action === "remove" ? "Removes it from the post" : "" }));
  options.push({ key: "✓", id: "fine", label: "The post is fine as is", sub: "The sources are wrong or don't apply" });
  options.push({ key: "✎", id: "other", label: "Something else…", sub: "Tell us what to change" });
  const sel = lesson.selected;
  return `<div class="lesson-top">
      <button class="iconbtn" data-act="quit" aria-label="Quit lesson">✕</button>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span class="pill miles">✈️ ${S.xp}</span>
    </div>
    <div>
      <span class="chip ${esc(sev)}">${TYPE_ICON[c.type] || "🔍"} ${esc(c.headline || "Possible issue")}</span>
      <span class="small muted" style="margin-left:6px">${esc(sevText)}</span>
      <div class="posttitle">${safeUrl(c.post?.url) ? `<a href="${esc(c.post.url)}" target="_blank" rel="noopener">${esc(c.post?.title)}</a>` : esc(c.post?.title)}${c.claim?.section ? ` · ${esc(c.claim.section)}` : ""}</div>
      <div class="label-sm">Your post says</div>
      <blockquote class="claim">${esc(c.claim?.quote)}</blockquote>
      ${(c.also_in || []).length ? `<div class="small muted" style="margin-top:6px">📌 Also in this post: ${c.also_in.map(esc).join(" · ")}. Any fix gets applied there too.</div>` : ""}
      <div class="think">${pip("think", 58)}<div class="bubble">${esc(c.summary)}</div></div>
      <div class="label-sm">What I found</div>
      ${(c.sources || []).map((s, n) => `<div class="source">
          <b>${n + 1}. ${esc(s.label)}</b>
          ${s.quote ? `<q>${esc(s.quote)}</q>` : ""}
          <div class="meta">
            ${safeUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">Open source ↗</a>` : ""}
            ${s.retrieved ? `<span>checked ${esc(s.retrieved)}</span>` : ""}
            ${s.via === "search snippet" ? `<span>from search preview</span>` : ""}
          </div></div>`).join("")}
      ${!navigator.onLine ? `<div class="tip">📴 You're offline — the quotes above were saved for you. Links will open when you're back online.</div>` : ""}
      <div class="label-sm">What should we do?</div>
      ${options.map((o) => `<button class="opt ${sel === o.id ? "sel" : ""}" data-opt="${esc(o.id)}"><span class="k">${o.key}</span><span>${esc(o.label)}${o.sub ? `<small>${esc(o.sub)}</small>` : ""}</span></button>`).join("")}
      ${sel === "other" ? `<textarea id="note" placeholder="What should change? (dictate with the 🎤 on your keyboard)">${esc(lesson.note || "")}</textarea>`
        : `<details class="extra" ${lesson.note || lesson.source ? "open" : ""}><summary>+ Add a note or your own source (bonus miles)</summary>
            <textarea id="note" placeholder="Anything we should know?">${esc(lesson.note || "")}</textarea>
            <input type="url" id="source" inputmode="url" placeholder="https:// link you found (optional)" value="${esc(lesson.source || "")}">
          </details>`}
      ${sel === "other" ? `<input type="url" id="source" inputmode="url" placeholder="https:// link you found (optional)" value="${esc(lesson.source || "")}" style="margin-top:8px">` : ""}
      <button class="linkbtn" data-act="later">🕵️ I'll investigate this later</button>
    </div>
    <div class="lesson-actions"><button class="btn teal" data-act="check" ${sel ? "" : "disabled"}>Save answer</button></div>
    <div class="sheet" id="sheet"><div class="in"></div></div>`;
}

const PRAISE = ["Nice catch!", "Great detective work!", "Sharp eyes!", "Fact checked!", "Readers will thank you!", "Pip approves!", "Smooth sailing!"];

function showSheet({ later = false, earned = 0, title }) {
  const sheet = $("#sheet");
  sheet.classList.toggle("later", later);
  $(".in", sheet).innerHTML = `<div class="row">${pip(later ? "wow" : "cheer", 64)}<div><h3>${esc(title)}</h3>
    <div class="xp">${later ? "Saved to Investigate 🕵️" : `+${earned} miles ✈️`}</div></div></div>
    <button class="btn ${later ? "sun" : "teal"}" data-act="next">Continue</button>
    <button class="linkbtn undo" data-act="undo" style="display:block;margin:6px auto 0;color:inherit">↩︎ Undo</button>`;
  requestAnimationFrame(() => sheet.classList.add("show"));
  const milesPill = $(".lesson-top .pill.miles"); if (milesPill) milesPill.textContent = `✈️ ${S.xp}`;
  $("[data-act=next]", sheet).addEventListener("click", nextCard);
  $("[data-act=undo]", sheet).addEventListener("click", undoLast);
  $(".lesson-actions").style.visibility = "hidden";
}

function readExtras() {
  lesson.note = ($("#note")?.value || "").trim();
  const src = ($("#source")?.value || "").trim();
  lesson.source = safeUrl(src) ? src : "";
}

function checkAnswer() {
  readExtras();
  const c = lesson.cards[lesson.i];
  const sel = lesson.selected;
  if (sel === "other" && !lesson.note) { toast("Add a quick note so we know what to change"); $("#note")?.focus(); return; }
  let decision;
  if (sel === "fine") decision = { kind: "post_is_fine" };
  else if (sel === "other") decision = { kind: "other" };
  else {
    const o = (c.options || []).find((x) => `opt:${x.id}` === sel);
    decision = { kind: "apply_option", option: o ? { id: o.id, label: o.label, action: o.action, new_text: o.new_text ?? "" } : null };
  }
  lesson.undo = snapshot(c);
  const earned = recordAnswer(c, decision, { note: lesson.note, source: lesson.source });
  lesson.earned += earned; lesson.answered++; lesson.undo.earned = earned; lesson.undo.kind = "answer";
  chime("ok"); buzz(20);
  showSheet({ earned, title: pick(PRAISE) });
}

function parkLater() {
  const c = lesson.cards[lesson.i];
  lesson.undo = { ...snapshot(c), earned: XP.later, kind: "later" };
  if (!S.later.includes(c.id)) S.later.push(c.id);
  S.xp += XP.later; lesson.earned += XP.later; lesson.parked++;
  save(); chime("later"); buzz(10);
  showSheet({ later: true, title: "Good call — no guessing!" });
}

// Everything an answer can change, so a mis-tap can be taken back before moving on.
function snapshot(c) {
  return { cardId: c.id, xp: S.xp, streak: { ...S.streak }, day: S.days[today()] || 0,
    later: [...S.later], pendingLen: S.pending.length, note: lesson.note, source: lesson.source, selected: lesson.selected };
}

function undoLast() {
  const u = lesson.undo;
  if (!u) return;
  // Only possible while the answer is still on the phone (not yet packaged for upload).
  if (u.kind === "answer" && S.pending.length !== u.pendingLen + 1) { toast("Already uploaded — can't undo this one"); return; }
  if (u.kind === "answer") { S.pending.pop(); delete S.answers[u.cardId]; lesson.answered--; }
  else lesson.parked--;
  S.xp = u.xp; S.streak = u.streak; S.later = u.later;
  if (u.day) S.days[today()] = u.day; else delete S.days[today()];
  lesson.earned -= u.earned;
  lesson.undo = null;
  lesson.note = u.note; lesson.source = u.source; lesson.selected = u.selected;
  save();
  render();
  toast("Undone — pick again");
}

function nextCard() {
  lesson.i++; lesson.selected = null; lesson.note = ""; lesson.source = ""; lesson.undo = null;
  if (lesson.i >= lesson.cards.length) return finishLesson();
  render();
}

function finishLesson() {
  if (lesson.answered && lesson.answered === lesson.cards.length) S.badges.lesson = S.badges.lesson || today();
  lesson.newBadges = checkBadges();
  packagePending();
  save();
  view = { name: "complete" }; render();
  chime("win"); buzz([30, 40, 30]); confetti();
  if (navigator.onLine && S.settings.token) sync({ quiet: true }).then(() => { const el = $(".sync-line"); if (el) el.textContent = syncLine(); });
}

function syncLine() {
  if (DEMO) return "Demo: in the real app these answers upload to GitHub for fixing.";
  const waiting = S.outbox.length + (S.pending.length ? 1 : 0);
  if (!S.settings.token) return "Saved on your phone. Connect GitHub in Settings to upload.";
  if (waiting) return navigator.onLine ? "Uploading your answers…" : "📴 Saved on your phone — uploads when you're back online.";
  return "✅ Answers uploaded — ready to fix!";
}

function completeView() {
  const L = lesson;
  return `<div class="complete">
    ${pip("cheer", 150)}
    <h1>Lesson complete!</h1>
    <div class="muted">${L.answered} checked${L.parked ? ` · ${L.parked} saved to investigate` : ""}</div>
    <div class="stats">
      <div class="stat a"><div class="t">Miles</div><div class="v">+${L.earned}</div></div>
      <div class="stat b"><div class="t">Streak</div><div class="v">🔥 ${streakNow()}</div></div>
      <div class="stat c"><div class="t">Today</div><div class="v">${S.days[today()] || 0}/${S.settings.dailyGoal}</div></div>
    </div>
    ${(L.newBadges || []).length ? `<div class="card" style="width:100%"><b>New badge${L.newBadges.length > 1 ? "s" : ""}!</b><div>${L.newBadges.map((b) => `${b.e} ${esc(b.name)}`).join(" · ")}</div></div>` : ""}
    <div class="sync-line">${syncLine()}</div>
    <div style="width:100%;margin-top:auto;display:grid;gap:12px">
      ${openCards().length ? `<button class="btn" data-act="start">Keep going · ${Math.min(LESSON_SIZE, openCards().length)} more</button>` : ""}
      <button class="btn ghost" data-act="home">Back to journey</button>
    </div></div>`;
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = document.createElement("div"); box.className = "confetti";
  const colors = ["#FF6B5B", "#17A398", "#FFC845", "#46A8E0", "#7BD389"];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement("i");
    p.style.left = Math.random() * 100 + "vw"; p.style.background = pick(colors);
    p.style.animationDuration = 1.6 + Math.random() * 1.6 + "s"; p.style.animationDelay = Math.random() * 0.4 + "s";
    box.appendChild(p);
  }
  document.body.appendChild(box); setTimeout(() => box.remove(), 4000);
}

function laterView() {
  const cards = laterCards();
  return `${topbar()}<h2>🕵️ Investigations</h2>
    ${cards.length ? `<p class="muted small">Cards you parked to look into. Tap one when you're ready.</p>
      ${cards.map((c) => `<button class="opt" data-laterid="${esc(c.id)}"><span class="k">${TYPE_ICON[c.type] || "🔍"}</span><span>${esc(c.headline)}<small>${esc(c.post?.title)}</small></span></button>`).join("")}
      ${cards.length > 1 ? `<button class="btn sun" data-act="later-all" style="margin-top:8px">Investigate all ${Math.min(cards.length, LESSON_SIZE)}</button>` : ""}`
      : `<div class="empty">${pip("sleepy", 110)}<p class="muted">Nothing parked. When a card needs digging, tap “I'll investigate this later”.</p></div>`}`;
}

function passportView() {
  const ps = posts();
  const stamped = ps.filter((p) => p.done && p.done === p.cards.length);
  const fixes = Object.values(S.answers).filter((a) => a.decision !== "post_is_fine").length;
  return `${topbar()}<h2>🛂 Passport</h2>
    <div class="kpis">
      <div class="kpi"><div class="v">✈️ ${S.xp}</div><div class="l">Miles earned</div></div>
      <div class="kpi"><div class="v">🔥 ${streakNow()}</div><div class="l">Day streak</div></div>
      <div class="kpi"><div class="v">${resolvedCount()}</div><div class="l">Cards checked</div></div>
      <div class="kpi"><div class="v">${fixes}</div><div class="l">Fixes sent</div></div>
    </div>
    <div class="kpi" style="margin-top:10px"><div class="v">📰 ${Object.keys(S.live || {}).length}</div><div class="l">Fixes live on the blog</div></div>
    <h2>Badges</h2>
    <div class="badges">${BADGES.map((b) => `<div class="badge ${S.badges[b.id] ? "" : "locked"}"><span class="e">${b.e}</span><b>${esc(b.name)}</b><small>${esc(b.how)}</small></div>`).join("")}</div>
    <h2>Stamps</h2>
    ${stamped.length ? `<div class="stamps">${stamped.map((p) => `<div class="stamp">✔ ${esc(p.title)}</div>`).join("")}</div>`
      : `<p class="muted small">Finish every card on a post to earn its stamp.</p>`}`;
}

function demoSettingsView() {
  const s = S.settings;
  const last = (S.demoSent || []).slice(-1)[0];
  return `${topbar()}<h2>⚙️ Settings</h2>
    <div class="tip"><b>Demo mode.</b> Cards are built in, nothing is sent to GitHub or the blog, and progress stays in this browser only.</div>
    <div class="card">
      <div class="field"><label for="goal">Daily goal (cards)</label><input type="number" id="goal" min="1" max="30" value="${s.dailyGoal}"></div>
      <label class="toggle">Sounds <input type="checkbox" id="sound" ${s.sound ? "checked" : ""}></label>
      <button class="btn teal" data-act="save-demo">Save</button>
    </div>
    <div class="card">
      <b>Try the rest of the loop</b>
      <p class="small muted" style="margin:6px 0 12px">See the file the real app would upload, or pretend your fixes went live on the blog.</p>
      <div style="display:grid;gap:10px">
        <button class="btn ghost" data-act="demo-file" ${last ? "" : "disabled"}>${last ? "Show the last upload file" : "Finish a lesson to see its upload file"}</button>
        <pre id="demo-file" hidden style="overflow:auto;max-height:320px;font-size:12px;background:var(--surface-2);padding:12px;border-radius:12px;white-space:pre-wrap;word-break:break-word">${last ? esc(`${last.path}\n\n${JSON.stringify(last.body, null, 2)}`) : ""}</pre>
        <button class="btn sun" data-act="demo-live">🎉 Pretend my fixes went live</button>
      </div>
    </div>
    <button class="linkbtn" data-act="reset" style="color:var(--coral-dark)">Reset the demo</button>`;
}

function settingsView() {
  if (DEMO) return demoSettingsView();
  const s = S.settings;
  const waiting = S.outbox.reduce((n, o) => n + o.body.answers.length, 0) + S.pending.length;
  return `${topbar()}<h2>⚙️ Settings</h2>
    <div class="card">
      <div class="field"><label for="token">GitHub access key</label>
        <input type="password" id="token" autocomplete="off" placeholder="github_pat_…" value="${esc(s.token)}">
        <div class="hint">Only stored on this phone. Ask whoever set this up for it if it's blank.</div></div>
      <div class="field"><label for="repo">Repo</label><input type="text" id="repo" value="${esc(s.repo)}" autocapitalize="off" autocorrect="off"></div>
      <div class="field"><label for="branch">Branch</label><input type="text" id="branch" value="${esc(s.branch)}" autocapitalize="off" autocorrect="off"></div>
      <button class="btn teal" data-act="save-settings">Save & sync</button>
    </div>
    <div class="card">
      <div class="field"><label for="goal">Daily goal (cards)</label><input type="number" id="goal" min="1" max="30" value="${s.dailyGoal}"></div>
      <label class="toggle">Sounds <input type="checkbox" id="sound" ${s.sound ? "checked" : ""}></label>
    </div>
    <div class="card small">
      <div><b>Last sync:</b> ${S.lastSync ? new Date(S.lastSync).toLocaleString() : "never"}</div>
      <div><b>Waiting to upload:</b> ${waiting} answer${waiting === 1 ? "" : "s"}</div>
      <div><b>Cards on phone:</b> ${allCards().length}</div>
      <div style="margin-top:10px"><button class="btn ghost" data-act="sync">Sync now</button></div>
    </div>
    <button class="linkbtn" data-act="reset" style="color:var(--coral-dark)">Reset this phone's progress</button>`;
}

/* ---------------- events ---------------- */
function bind() {
  document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => { view = { name: b.dataset.nav }; render(); }));
  document.querySelectorAll("[data-post]").forEach((b) => b.addEventListener("click", () => {
    startLesson(openCards().filter((c) => String(c.post?.id ?? c.post?.url ?? c.post?.title) === b.dataset.post));
  }));
  document.querySelectorAll("[data-laterid]").forEach((b) => b.addEventListener("click", () => {
    startLesson(laterCards().filter((c) => c.id === b.dataset.laterid));
  }));
  document.querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("click", () => {
    readExtras(); lesson.selected = b.dataset.opt; buzz(8);
    const y = window.scrollY; render(); window.scrollTo(0, y);
    if (lesson.selected === "other") $("#note")?.focus();
  }));
  document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
}

function act(a) {
  switch (a) {
    case "start": startLesson(openCards()); break;
    case "later-all": startLesson(laterCards()); break;
    case "check": checkAnswer(); break;
    case "later": parkLater(); break;
    case "quit": {
      const leave = () => { packagePending(); view = { name: "home" }; render(); sync({ quiet: true }); };
      if (lesson.answered) askConfirm("Leave this lesson?", "Your answers so far are saved.", "Leave", "Keep going").then((ok) => ok && leave());
      else leave();
      break;
    }
    case "home": view = { name: "home" }; render(); break;
    case "sync": if (!S.settings.token) { view = { name: "settings" }; render(); } else sync(); break;
    case "paste-key":
      (async () => {
        let k = "";
        try { k = (await navigator.clipboard.readText()).trim(); } catch (e) {}
        if (!/^(github_pat_|ghp_)\w+/.test(k)) { toast("No key on the clipboard — copy it, or type it in below"); const d = $("details.extra"); if (d) d.open = true; return; }
        connectWith(k);
      })();
      break;
    case "save-key": {
      const k = ($("#token")?.value || "").trim();
      if (!k) { toast("Paste or type the key first"); return; }
      connectWith(k); break;
    }
    case "undo": undoLast(); break;
    case "save-demo":
      S.settings.dailyGoal = Math.max(1, Math.min(30, parseInt($("#goal").value, 10) || 5));
      S.settings.sound = $("#sound").checked; save(); toast("Saved"); break;
    case "save-settings":
      S.settings.token = $("#token").value.trim();
      S.settings.repo = $("#repo").value.trim() || DEFAULTS.settings.repo;
      S.settings.branch = $("#branch").value.trim() || "main";
      S.settings.dailyGoal = Math.max(1, Math.min(30, parseInt($("#goal").value, 10) || 5));
      S.settings.sound = $("#sound").checked;
      save(); toast("Saved"); sync(); break;
    case "reset":
      askConfirm("Reset progress?", DEMO ? "Clears this demo so you can start over." : "Answers already uploaded stay safe in GitHub.", "Reset", "Cancel").then((ok) => {
        if (!ok) return;
        const settings = S.settings; S = structuredClone(DEFAULTS); S.settings = settings;
        if (DEMO) loadDemoDeck();
        save(); view = { name: "home" }; render(); sync({ quiet: true });
      });
      break;
    case "demo-live": {
      // Pretend some of her answers were applied to the blog, to preview the celebration.
      const ids = Object.values(S.answers).filter((a) => a.decision !== "post_is_fine").map((a) => a.card_id);
      if (!ids.length) { toast("Answer a card with a fix first"); return; }
      const before = Object.keys(S.live).length;
      ids.forEach((id) => (S.live[id] = { status: "applied", date: today() }));
      const fresh = Object.keys(S.live).length - before; S.seenLive = Object.keys(S.live).length;
      checkBadges(); save(); render();
      toast(fresh ? `🎉 ${fresh} of your fixes ${fresh === 1 ? "is" : "are"} live on the blog!` : "Those fixes are already live");
      if (fresh) { chime("win"); confetti(); }
      break;
    }
    case "demo-file": {
      const box = $("#demo-file");
      if (box) box.hidden = !box.hidden;
      break;
    }
  }
}

// In-page confirmation (pop-up dialogs are blocked in some places the app runs).
function askConfirm(title, body, yes, no) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal";
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mt">${pip("wow", 64)}
      <h3 id="mt">${esc(title)}</h3><p class="muted">${esc(body)}</p>
      <div style="display:grid;gap:10px"><button class="btn" data-a="yes">${esc(yes)}</button><button class="btn ghost" data-a="no">${esc(no)}</button></div></div>`;
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.addEventListener("click", (e) => { const a = e.target.closest("[data-a]")?.dataset.a; if (a) done(a === "yes"); else if (e.target === wrap) done(false); });
    document.body.appendChild(wrap);
    $("[data-a=no]", wrap).focus();
  });
}

async function connectWith(key) {
  S.settings.token = key; save();
  toast("Checking the key…");
  const res = await gh("").catch(() => null);
  if (!res || !res.ok) {
    S.settings.token = ""; save();
    toast(res ? await ghError(res) : "Can't reach GitHub — are you online?");
    return;
  }
  toast("Connected! Pulling your cards…");
  render(); sync({ quiet: true });
}

function loadDemoDeck() {
  const d = DEMO.deck;
  S.decks = { [d.created]: { id: d.created, sha: "demo", created: d.created, cards: d.cards } };
  S.settings.token = "demo"; S.restored = true;
}

/* ---------------- boot ---------------- */
if (DEMO) { loadDemoDeck(); save(); }
// Setup link support: …/#token=github_pat_xxx  (the hash never leaves the phone)
(function readSetupLink() {
  if (DEMO) return;
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("token")) {
    S.settings.token = h.get("token");
    if (h.get("repo")) S.settings.repo = h.get("repo");
    save();
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => toast("Connected! Pulling your cards…"), 300);
  }
})();

if (!DEMO && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("online", () => { sync({ quiet: true }); if (view.name !== "lesson") render(); });
window.addEventListener("offline", () => { if (view.name !== "lesson") render(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync({ quiet: true }); });

// Any answers left from a lesson that was closed mid-way get packaged for upload.
packagePending();
render();
sync({ quiet: true });

// Exposed for local testing only.
window.__bq = { get state() { return S; }, load: (decks) => { decks.forEach((d) => (S.decks[d.id] = d)); save(); render(); } };
