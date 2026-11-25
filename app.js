import { pip, GEAR } from "./mascot.js";

/* =========================================================================
   Blog Quest — daily fact-check lessons for the blog.
   Decks of "possible error" cards are read from a PRIVATE GitHub repo
   (decks/*.json). Answers are stored on the phone first, then uploaded to
   responses/*.json in the same repo whenever the phone is online.
   ========================================================================= */

// Demo mode: a page can set window.BQ_DEMO = {deck} before loading this script.
// Cards come from that deck, nothing is sent anywhere, and progress stays in this browser.
const DEMO = window.BQ_DEMO || null;
const APP_VERSION = "1.5";      // shown in Settings, and in the details she can copy when asking for help
// Deep copy that also works on phones a few years old.
const clone = (o) => (typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const KEY = DEMO ? "blogquest.demo" : "blogquest.v1";
const XP = { answer: 10, high: 5, note: 5, source: 5, later: 2, opened: 3 };
// Miles needed for each rank.
const LEVELS = [[0, "Tourist"], [50, "Wanderer"], [120, "Backpacker"], [250, "Explorer"], [450, "Pathfinder"], [700, "Globetrotter"], [1000, "Trailblazer"], [1500, "Legend"]];
const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100];
// Lessons are bite-size: three cards, or everything that's left when that's four or fewer.
const lessonSize = (n) => (n <= 4 ? n : 3);
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const FINE_REASONS = [
  ["first_hand", "I know first-hand"],
  ["source_wrong", "The source is wrong or out of date"],
  ["different_thing", "It's about something else"],
];
const TYPE_ICON = { closed: "🚪", price: "💲", hours: "🕒", show: "🎭", link: "🔗", rule: "📋", typo: "✏️", consistency: "🔁", alt: "🖼️", other: "🔍" };

const DEFAULTS = {
  settings: { token: "", repo: "Wareontheglobe/blog-fixes", branch: "main", dailyGoal: 3, sound: true, name: "", email: "", remindTime: "19:30", reviewer: false },
  decks: {},        // deckId -> {id, sha, created, cards: []}
  answers: {},      // cardId -> answer record
  later: [],        // cardIds on the research list
  laterNotes: {},   // cardId -> {note, at} for cards on the research list
  researchDirty: false, // the research list changed and needs saving to the repo
  researchResolved: 0,  // research cards she has since decided
  pending: [],      // answers not yet packaged into an upload
  outbox: [],       // [{path, body}] files waiting to upload
  xp: 0,
  streak: { count: 0, lastDay: "", graceDay: "" },
  frozen: "",       // day she ran out of cards with a live streak; it can't break until new cards arrive
  frozenDays: {},   // days the streak was protected
  fixlog: {},       // cardId -> status from fixes/applied.json
  redone: {},       // cardIds she reopened to answer again (no second helping of miles)
  opened: {},       // cardIds where she opened a source before deciding
  days: {},         // yyyy-mm-dd -> cards resolved that day
  badges: {},       // badgeId -> date earned
  lastSync: "",
  restored: false,
  seenIntro: false, // she has been through the welcome walkthrough
  q: { day: "", ids: [], prog: {}, done: {}, bonus: false },   // today's quests
  xpDays: {},       // miles earned per day, for the weekly recap
  recapSeen: "",    // Monday of the last week whose recap she has seen
  syncError: null,  // {kind, msg, at} from the last failed sync; cleared when one succeeds
  lastTry: 0,       // when a sync was last attempted (ms)
  reviewCache: {},  // reviewer mode: response files already downloaded (they never change)
  progressSaved: "",  // the progress backup as last written to the repo
  progressSha: "",
  progressAt: 0,
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
    if (raw) return { ...clone(DEFAULTS), ...raw, settings: { ...DEFAULTS.settings, ...raw.settings } };
  } catch (e) { /* storage blocked or corrupt — start fresh in memory */ }
  return clone(DEFAULTS);
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
const num = (n) => Number(n || 0).toLocaleString("en-US");
// Pip, wearing whatever gear her level has unlocked.
const pipG = (mood, size) => pip(mood, size, level().n);
// Curly quotes and long dashes count the same as plain ones when comparing text (one character for one).
const fold1 = (t) => String(t ?? "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u00a0/g, " ");
// What changes between the old words and the new, widened to whole words so it reads naturally.
function diffParts(oldText, newText) {
  const a = fold1(oldText), b = fold1(newText);
  let p = 0, s = 0;
  while (p < Math.min(a.length, b.length) && a[p] === b[p]) p++;
  while (s < Math.min(a.length, b.length) - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  while (p > 0 && !/\s/.test(a[p - 1])) p--;
  while (s > 0 && !/\s/.test(a[a.length - s])) s--;
  return { pre: oldText.slice(0, p), del: oldText.slice(p, oldText.length - s), ins: newText.slice(p, newText.length - s), post: oldText.slice(oldText.length - s) };
}
const diffHtml = (oldText, newText) => { const d = diffParts(oldText, newText); return `${esc(d.pre)}${d.del ? `<del>${esc(d.del)}</del>` : ""}${d.del && d.ins ? " " : ""}${d.ins ? `<ins>${esc(d.ins)}</ins>` : ""}${esc(d.post)}`; };
// The quoted words, shown inside their sentence when the card supplies one.
function claimHtml(c) {
  const q = c.claim?.quote || "", ctx = c.claim?.context || "";
  const i = ctx ? fold1(ctx).indexOf(fold1(q)) : -1;
  if (i < 0) return esc(q);
  const tail = /[.!?)"']$/.test(ctx.trim()) ? "" : "…";
  return `${esc(ctx.slice(0, i))}<mark>${esc(ctx.slice(i, i + q.length))}</mark>${esc(ctx.slice(i + q.length))}${tail}`;
}
const isQuickFix = (c) => !(c.sources || []).length;       // typos and the like: the evidence is the post itself
// A general lesson leads with one fact check and fills up with quick fixes, so each one has some of both.
function mixLesson(cards) {
  const size = lessonSize(cards.length), facts = cards.filter((c) => !isQuickFix(c)), quick = cards.filter(isQuickFix), out = [];
  while (out.length < size) {
    const wantFact = out.length % 3 === 0;
    const from = (wantFact && facts.length) || !quick.length ? facts : quick;
    out.push(from.shift());
  }
  return out;
}
const viewsLine = (post) => (post?.views?.count ? `👀 ${num(post.views.count)} views in the last ${Math.max(1, Math.round((post.views.days || 30) / 30))} month${post.views.days > 45 ? "s" : ""}` : "");
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
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3)
      || (a.confidence === "strong" ? 0 : 1) - (b.confidence === "strong" ? 0 : 1));
}
function laterCards() { const all = allCards(); return S.later.map((id) => all.find((c) => c.id === id)).filter(Boolean); }
function posts() {
  const map = new Map();
  allCards().forEach((c) => {
    const k = c.post?.id ?? c.post?.url ?? c.post?.title;
    if (!map.has(k)) map.set(k, { key: k, title: c.post?.title || "Untitled post", url: c.post?.url, views: c.post?.views?.count || 0, post: c.post, cards: [] });
    map.get(k).cards.push(c);
  });
  return [...map.values()].map((p) => ({
    ...p,
    done: p.cards.filter((c) => S.answers[c.id]).length,
    open: p.cards.filter((c) => !S.answers[c.id] && !S.later.includes(c.id)).length,
  }));
}
function streakAlive() {
  const s = S.streak, recent = [today(), yesterday()];
  return recent.includes(s.lastDay) || recent.includes(s.graceDay);
}
function streakNow() { return S.frozen || streakAlive() ? S.streak.count : 0; }
// Running out of cards never breaks a streak: it is frozen until new cards arrive,
// and she then has that day and the next to pick it back up.
function updateFreeze() {
  const open = openCards().length;
  if (!open && !S.frozen && S.streak.count && streakAlive()) { S.frozen = today(); save(); }
  else if (open && S.frozen) {
    for (let d = new Date(S.frozen + "T12:00:00"); dayKey(d) < today(); d.setDate(d.getDate() + 1)) {
      if (!S.days[dayKey(d)]) S.frozenDays[dayKey(d)] = true;
    }
    S.streak.graceDay = today(); S.frozen = ""; save();
  }
}
function level(xp = S.xp) {
  let i = 0;
  while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
  const next = LEVELS[i + 1];
  return { n: i + 1, name: LEVELS[i][1], next: next ? next[0] : null, nextName: next ? next[1] : "",
    pct: next ? Math.round(((xp - LEVELS[i][0]) / (next[0] - LEVELS[i][0])) * 100) : 100 };
}
function weekDays() {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dayKey(d), played = S.days[k] > 0;
    out.push({ letter: "SMTWTFS"[d.getDay()], played, frozen: !played && !!(S.frozenDays[k] || (S.frozen && k >= S.frozen)), today: i === 0 });
  }
  return out;
}
function resolvedCount() { return Object.keys(S.answers).length; }
function addXp(n) { if (n) { S.xp += n; S.xpDays[today()] = (S.xpDays[today()] || 0) + n; } }

/* ---------------- daily quests ----------------
   Three small goals a day, chosen from what the day's cards make possible. They reward
   the habits worth having: checking a source, clearing the research list, finishing a post. */
const QUESTS = {
  goal: { icon: "🎯", text: () => `Decide ${S.settings.dailyGoal} cards`, target: () => S.settings.dailyGoal, miles: 10, ok: (o) => o.open >= S.settings.dailyGoal },
  source: { icon: "🔗", text: () => "Open a source before you decide", target: () => 1, miles: 5, ok: (o) => o.facts >= 1 },
  research: { icon: "🔖", text: () => "Decide a card from your Research list", target: () => 1, miles: 10, ok: (o) => o.research >= 1 },
  note: { icon: "✍️", text: () => "Add a note or your own source", target: () => 1, miles: 5, ok: (o) => o.open >= 1 },
  quick: { icon: "✏️", text: () => "Do 3 quick fixes", target: () => 3, miles: 5, ok: (o) => o.quick >= 3 },
  post: { icon: "🛂", text: () => "Finish every card on one post", target: () => 1, miles: 15, ok: (o) => o.finishable },
};
const QUEST_BONUS = 10;
function ensureQuests() {
  const open = openCards();
  // Chosen once a day. If the day started with nothing to do, choose when the first cards arrive.
  if (S.q?.day === today() && (S.q.ids.length || !open.length)) return;
  const o = { open: open.length, facts: open.filter((c) => !isQuickFix(c)).length, quick: open.filter(isQuickFix).length,
    research: S.later.length, finishable: posts().some((p) => p.open > 0 && p.open <= 4) };
  const able = Object.keys(QUESTS).filter((id) => QUESTS[id].ok(o));
  // A different mix each day, but the same all day: rotate the list by a number made from the date.
  const seed = [...today()].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7) >>> 0;
  const rest = able.filter((id) => id !== "goal");
  const rotated = rest.map((_, i) => rest[(i + seed) % rest.length]);
  const ids = (able.includes("goal") ? ["goal"] : []).concat(rotated).slice(0, 3);
  S.q = { day: today(), ids, prog: {}, done: {}, bonus: false };
  save();
}
// Called for each new answer. Returns the quests it completed, and adds their miles.
function questProgress(card, extra, wasResearch) {
  ensureQuests();
  const q = S.q, bump = (id) => { if (q.ids.includes(id) && !q.done[id]) q.prog[id] = (q.prog[id] || 0) + 1; };
  bump("goal");
  if (S.opened[card.id]) bump("source");
  if (wasResearch) bump("research");
  if (extra.note || extra.source) bump("note");
  if (isQuickFix(card)) bump("quick");
  const post = posts().find((p) => p.cards.some((c) => c.id === card.id));
  if (post && post.cards.every((c) => S.answers[c.id])) bump("post");
  const finished = [];
  q.ids.forEach((id) => {
    if (!q.done[id] && (q.prog[id] || 0) >= QUESTS[id].target()) { q.done[id] = true; addXp(QUESTS[id].miles); finished.push({ text: QUESTS[id].text(), miles: QUESTS[id].miles }); }
  });
  if (q.ids.length && !q.bonus && q.ids.every((id) => q.done[id])) { q.bonus = true; addXp(QUEST_BONUS); finished.push({ text: "All of today's quests", miles: QUEST_BONUS }); }
  return finished;
}

/* ---------------- weekly recap ---------------- */
function mondayOf(d = new Date()) { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m; }
function lastWeek() {
  const start = mondayOf(); start.setDate(start.getDate() - 7);
  let cards = 0, played = 0, miles = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i); const k = dayKey(d);
    cards += S.days[k] || 0; played += S.days[k] ? 1 : 0; miles += S.xpDays[k] || 0;
  }
  return { cards, played, miles };
}
const recapDue = () => S.recapSeen !== dayKey(mondayOf()) && lastWeek().cards > 0;

/* ---------------- daily reminder ----------------
   The app can't send notifications by itself, so the reminder is a repeating calendar event with an alert. */
function reminderLinks(time) {
  const [h, m] = String(time || "19:30").split(":").map(Number);
  const start = new Date(); start.setHours(h || 0, m || 0, 0, 0);
  if (start < new Date()) start.setDate(start.getDate() + 1);
  const end = new Date(start.getTime() + 10 * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (x) => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
  const url = location.origin + location.pathname, enc = encodeURIComponent;
  const title = "Blog Quest 🌍", details = `Three cards keeps the streak going. ${url}`;
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&details=${enc(details)}&dates=${stamp(start)}/${stamp(end)}&recur=${enc("RRULE:FREQ=DAILY")}${tz ? `&ctz=${enc(tz)}` : ""}`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Blog Quest//EN", "BEGIN:VEVENT", "UID:blog-quest-daily-reminder", `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, "RRULE:FREQ=DAILY", `SUMMARY:${title}`, `DESCRIPTION:${details}`, `URL:${url}`,
    "BEGIN:VALARM", "TRIGGER:PT0M", "ACTION:DISPLAY", "DESCRIPTION:Blog Quest", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  return { google, ics: "data:text/calendar;charset=utf-8," + enc(ics) };
}

/* ---------------- badges ---------------- */
const BADGES = [
  { id: "first", e: "🔎", name: "First Catch", how: "Resolve your first card", test: () => resolvedCount() >= 1 },
  { id: "lesson", e: "🎒", name: "Day Tripper", how: "Finish a full lesson", test: () => S.badges.lesson },
  { id: "streak3", e: "🔥", name: "On a Roll", how: "3-day streak", test: () => streakNow() >= 3 },
  { id: "streak7", e: "🌋", name: "Volcano", how: "7-day streak", test: () => streakNow() >= 7 },
  { id: "streak14", e: "🌠", name: "Fortnight", how: "14-day streak", test: () => streakNow() >= 14 },
  { id: "streak30", e: "🌕", name: "Full Moon", how: "30-day streak", test: () => streakNow() >= 30 },
  { id: "closed", e: "🔖", name: "Case Closed", how: "Decide a card from your research list", test: () => (S.researchResolved || 0) >= 1 },
  { id: "checker", e: "🧐", name: "Double Checker", how: "Open a source before deciding, 5 times", test: () => Object.values(S.answers).filter((a) => a.checked_source).length >= 5 },
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
    // Only headers GitHub is certain to accept from a browser on another site: Authorization and Accept.
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(opts.headers || {}) },
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
// An Error that remembers what kind of failure it was, so the home screen can explain it.
async function ghFail(res) {
  const e = new Error(await ghError(res));
  e.kind = res.status === 401 ? "auth" : res.status === 403 || res.status === 404 ? "access" : "other";
  return e;
}
// Cards come from a file someone edits, so take only what the app can show.
function cleanCards(list) {
  return (Array.isArray(list) ? list : []).filter((c) => c && typeof c.id === "string" && c.claim && typeof c.claim.quote === "string" && c.post)
    .map((c) => ({ ...c, options: Array.isArray(c.options) ? c.options.filter((o) => o && o.id && o.label) : [], sources: Array.isArray(c.sources) ? c.sources.filter(Boolean) : [] }));
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
    if (!res.ok) throw await ghFail(res);
    S.outbox.shift(); sent += n; save();
  }
  return sent;
}

async function pullDecks() {
  const { branch } = S.settings;
  const res = await gh(`contents/decks?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return 0;
  if (!res.ok) throw await ghFail(res);
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
      S.decks[id] = { id, sha: f.sha, created: deck.created || id, cards: cleanCards(Array.isArray(deck) ? deck : deck.cards) };
      added += S.decks[id].cards.filter((c) => !before.has(c.id)).length;
    } catch (e) { /* skip malformed deck */ }
  }
  // Decks and cards removed from the repo (a card that turned out to be wrong) disappear here too.
  const keep = new Set(files.map((f) => f.name.replace(/\.json$/, "")));
  Object.keys(S.decks).forEach((id) => { if (!keep.has(id)) delete S.decks[id]; });
  const known = new Set(allCards().map((c) => c.id));
  if (S.later.some((id) => !known.has(id))) {
    S.later.filter((id) => !known.has(id)).forEach((id) => delete S.laterNotes[id]);
    S.later = S.later.filter((id) => known.has(id)); S.researchDirty = true;
  }
  save();
  return added;
}

/* ---------------- research list ---------------- */
function researchItems() { return laterCards().map((c) => ({ c, note: S.laterNotes[c.id]?.note || "", at: S.laterNotes[c.id]?.at || "" })); }

// The list as Markdown (saved to research/open.md in the repo) or as plain text (email, share, copy).
function researchDoc(md) {
  const items = researchItems();
  const links = (c) => (c.sources || []).filter((s) => safeUrl(s.url));
  if (md) {
    const mdEsc = (s) => String(s ?? "").replace(/[\[\]]/g, "\\$&");
    const head = `# Research list\n\n_Cards marked for more research in Blog Quest and still waiting for a decision. Updated ${today()}. The app rewrites this file, so don't edit it by hand._\n`;
    if (!items.length) return head + "\nNothing is waiting for research right now.\n";
    return head + items.map(({ c, note, at }, i) => `
## ${i + 1}. ${c.headline}

- **Post:** [${mdEsc(c.post?.title)}](${c.post?.url || ""})${c.claim?.section ? ` (${c.claim.section})` : ""}
- **The post says:** "${c.claim?.quote || ""}"
- **What Pip found:** ${c.summary || ""}
- **Sources:** ${links(c).map((s) => `[${mdEsc(s.label)}](${s.url})`).join(", ") || "none"}
- **Her note:** ${note || "none"}
- **Marked:** ${(at || "").slice(0, 10) || "unknown"} · Card: \`${c.id}\`
`).join("");
  }
  if (!items.length) return "Blog Quest research list\n\nNothing is waiting for research right now.";
  return `Blog Quest research list (${items.length})\n` + items.map(({ c, note }, i) => `
${i + 1}. ${c.headline}
Post: ${c.post?.title || ""}
${c.post?.url || ""}
The post says: "${c.claim?.quote || ""}"
Pip found: ${c.summary || ""}${links(c).length ? `\nSources: ${links(c).map((s) => s.url).join(" , ")}` : ""}${note ? `\nTo check: ${note}` : ""}
`).join("");
}

async function pushResearch() {
  if (!S.researchDirty) return;
  const path = "contents/research/open.md";
  let sha;
  const cur = await gh(`${path}?ref=${encodeURIComponent(S.settings.branch)}`);
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw await ghFail(cur);
  if (sha || S.later.length) {
    const res = await gh(path, {
      method: "PUT",
      body: JSON.stringify({ message: `Blog Quest: research list (${S.later.length} open)`, content: b64(researchDoc(true)), branch: S.settings.branch, ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw await ghFail(res);
  }
  S.researchDirty = false; save();
}

/* ---------------- progress backup ----------------
   Miles, streak and badges live on the phone. A copy is kept in progress/state.json in the
   private repo so a new phone, or a reinstall, picks up where she left off. No name or email in it. */
function progressDoc() {
  const days = Object.fromEntries(Object.entries(S.days).sort().slice(-120));
  return JSON.stringify({ app: "blog-quest", version: 1, xp: S.xp, streak: S.streak, frozen: S.frozen, frozenDays: S.frozenDays, days,
    badges: S.badges, researchResolved: S.researchResolved || 0, redone: S.redone, seenLive: S.seenLive || 0,
    dailyGoal: S.settings.dailyGoal, sound: S.settings.sound }, null, 1);
}
async function pushProgress(force) {
  const doc = progressDoc();
  if (doc === S.progressSaved || (!S.xp && !S.progressSha)) return;
  if (!force && Date.now() - (S.progressAt || 0) < 5 * 60 * 1000) return;     // at most every five minutes
  const path = "contents/progress/state.json";
  const put = (sha) => gh(path, { method: "PUT", body: JSON.stringify({ message: "Blog Quest: progress backup", content: b64(doc + "\n"), branch: S.settings.branch, ...(sha ? { sha } : {}) }) });
  let res = await put(S.progressSha);
  if (res.status === 409 || res.status === 422) {                             // our copy of the file's version is out of date
    const cur = await gh(`${path}?ref=${encodeURIComponent(S.settings.branch)}`);
    res = await put(cur.ok ? (await cur.json()).sha : "");
  }
  if (!res.ok) throw await ghFail(res);
  S.progressSha = (await res.json().catch(() => ({})))?.content?.sha || "";
  S.progressSaved = doc; S.progressAt = Date.now(); save();
}
async function restoreProgress() {
  const res = await gh(`contents/progress/state.json?ref=${encodeURIComponent(S.settings.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!res.ok) return;
  let p; try { p = await res.json(); } catch (e) { return; }
  if (!p || p.app !== "blog-quest" || S.xp > (p.xp || 0)) return;
  S.xp = p.xp || 0; S.streak = { ...S.streak, ...(p.streak || {}) }; S.frozen = p.frozen || ""; S.frozenDays = p.frozenDays || {};
  S.days = { ...(p.days || {}), ...S.days }; S.badges = { ...(p.badges || {}), ...S.badges };
  S.researchResolved = p.researchResolved || 0; S.redone = p.redone || {}; S.seenLive = p.seenLive || 0;
  if (p.dailyGoal) S.settings.dailyGoal = p.dailyGoal;
  if (typeof p.sound === "boolean") S.settings.sound = p.sound;
  S.progressSaved = progressDoc(); S.restoredProgress = true;
}

// On a fresh install, mark cards that were already answered on another device / earlier install.
async function restoreAnswered() {
  if (S.restored || resolvedCount() > 0) { S.restored = true; return; }
  const { branch } = S.settings;
  await restoreProgress();
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
  // Her research list, as last saved by the app.
  const rl = await gh(`contents/research/open.md?ref=${encodeURIComponent(branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (rl.ok) {
    (await rl.text()).split("\n## ").slice(1).forEach((sec) => {
      const id = (sec.match(/Card: `([^`]+)`/) || [])[1];
      if (!id || S.answers[id] || S.later.includes(id)) return;
      const note = (sec.match(/\*\*Her note:\*\* (.*)/) || [])[1] || "";
      S.later.push(id);
      S.laterNotes[id] = { note: note === "none" ? "" : note, at: (sec.match(/\*\*Marked:\*\* (\d{4}-\d\d-\d\d)/) || [])[1] || "" };
    });
  }
  S.restored = true; save();
}

/* ---------------- reviewer mode ----------------
   For the person who applies her fixes: the same app, showing her answers instead of the game.
   It only reads. Nothing in this mode writes to the repo. */
let review = null;    // { answers, applied, research, at }
async function pullReview() {
  const ref = `?ref=${encodeURIComponent(S.settings.branch)}`, rawH = { headers: { Accept: "application/vnd.github.raw+json" } };
  const top = await gh(`contents/responses${ref}`);
  if (!top.ok && top.status !== 404) throw await ghFail(top);
  if (top.ok) {
    for (const d of (await top.json()).filter((x) => x.type === "dir")) {
      const r = await gh(`contents/${d.path}${ref}`);
      if (!r.ok) continue;
      for (const f of (await r.json()).filter((x) => x.name.endsWith(".json") && !S.reviewCache[x.path])) {
        const fr = await gh(`contents/${f.path}${ref}`, rawH);
        if (!fr.ok) continue;
        try { S.reviewCache[f.path] = (await fr.json()).answers || []; } catch (e) { /* skip a broken file */ }
      }
    }
  }
  const latest = {};
  Object.values(S.reviewCache).flat().forEach((a) => {
    const prev = latest[a.card_id];
    if (!prev || (a.answered_at || "") >= (prev.answered_at || "")) latest[a.card_id] = a;
  });
  const ap = await gh(`contents/fixes/applied.json${ref}`, rawH);
  let applied = {}; if (ap.ok) { try { applied = (await ap.json()) || {}; } catch (e) {} }
  const research = [];
  const rl = await gh(`contents/research/open.md${ref}`, rawH);
  if (rl.ok) (await rl.text()).split("\n## ").slice(1).forEach((sec) => {
    const id = (sec.match(/Card: `([^`]+)`/) || [])[1];
    const note = (sec.match(/\*\*Her note:\*\* (.*)/) || [])[1] || "";
    if (id) research.push({ id, note: note === "none" ? "" : note });
  });
  review = { answers: Object.values(latest), applied, research, at: new Date().toISOString() };
  save();
}
function reviewData() {
  const r = review || { answers: [], applied: {}, research: [] };
  const cards = Object.fromEntries(allCards().map((c) => [c.id, c]));
  const answered = new Set(r.answers.map((a) => a.card_id)), parked = new Set(r.research.map((x) => x.id));
  const pending = r.answers.filter((a) => !r.applied[a.card_id]).sort((a, b) => (a.post?.title || "").localeCompare(b.post?.title || "") || (a.answered_at || "").localeCompare(b.answered_at || ""));
  const open = allCards().filter((c) => !answered.has(c.id) && !parked.has(c.id));
  const tally = {};
  Object.values(r.applied).forEach((e) => { if (e?.status) tally[e.status] = (tally[e.status] || 0) + 1; });
  return { r, cards, pending, open, tally };
}
function reviewSummary() {
  const { r, cards, pending, open } = reviewData();
  const what = (a) => a.decision === "apply_option" ? `${a.option?.label || "fix"}: "${a.option?.new_text || "(remove)"}"` : a.decision === "post_is_fine" ? `post is fine${a.fine_reason ? ` (${a.fine_reason.replace("_", " ")})` : ""}` : `her wording: ${a.note}`;
  return [`Blog Quest review, ${today()}`, `${pending.length} answers to apply, ${r.research.length} on her research list, ${open.length} cards still waiting for her.`, "",
    ...pending.map((a) => `- [${a.post?.title || "?"}] ${cards[a.card_id]?.headline || a.card_id}: ${what(a)}${a.note && a.decision !== "other" ? ` (note: ${a.note})` : ""}`),
    ...(r.research.length ? ["", "Research list:", ...r.research.map((x) => `- ${cards[x.id]?.headline || x.id}${x.note ? `: ${x.note}` : ""}`)] : [])].join("\n");
}
function reviewerView() {
  const { r, cards, pending, open, tally } = reviewData();
  const handled = Object.entries(r.applied).sort((a, b) => (b[1]?.date || "").localeCompare(a[1]?.date || "")).slice(0, 6);
  const label = { applied: "📰 applied", no_change: "✓ no change", needs_human: "👀 needs a person", skipped: "skipped" };
  const answerHtml = (a) => {
    const c = cards[a.card_id];
    const what = a.decision === "apply_option"
      ? `<b>${esc(a.option?.label || "Fix")}</b>${a.option?.action === "remove" ? `<small>Removes: “${esc(a.claim_quote)}”</small>` : `<small class="diff">${diffHtml(a.claim_quote || "", a.option?.new_text || "")}</small>`}`
      : a.decision === "post_is_fine" ? `<b>Post is fine as is</b><small>${esc({ first_hand: "She knows first-hand", source_wrong: "The source is wrong or out of date", different_thing: "It's about something else" }[a.fine_reason] || "No reason given")}</small>`
      : `<b>Her own wording</b><small>“${esc(a.note)}”</small>`;
    return `<div class="answer"><div><span class="small muted">${TYPE_ICON[c?.type] || "🔍"} ${esc(c?.headline || a.card_id)}${a.checked_source ? " · 🔗 opened a source" : ""}</span>${what}
      ${a.note && a.decision !== "other" ? `<small>📝 ${esc(a.note)}</small>` : ""}${a.research_note ? `<small>🔖 was researching: ${esc(a.research_note)}</small>` : ""}${a.extra_source_url && safeUrl(a.extra_source_url) ? `<small><a href="${esc(a.extra_source_url)}" target="_blank" rel="noopener noreferrer">Her source ↗</a></small>` : ""}</div></div>`;
  };
  const byPost = new Map();
  pending.forEach((a) => { const k = a.post?.title || "Unknown post"; if (!byPost.has(k)) byPost.set(k, []); byPost.get(k).push(a); });
  return `<div class="topbar"><span class="pill off">🧾 Reviewer</span><span class="spacer"></span>${navigator.onLine ? "" : `<span class="pill off">📴 Offline</span>`}</div>
    <h1 class="title">Her answers</h1>
    ${S.syncError && S.syncError.kind !== "other" ? `<div class="alert" role="alert"><b>⚠️ Can't read the repo</b><p>${esc(S.syncError.msg)}</p></div>` : ""}
    <div class="kpis">
      <div class="kpi"><div class="v">${pending.length}</div><div class="l">Answers to apply</div></div>
      <div class="kpi"><div class="v">${r.research.length}</div><div class="l">On her research list</div></div>
      <div class="kpi"><div class="v">${open.length}</div><div class="l">Cards waiting for her</div></div>
      <div class="kpi"><div class="v">${tally.applied || 0}</div><div class="l">Fixes applied so far</div></div>
    </div>
    <p class="small muted" style="margin:10px 2px">${review ? `Checked ${new Date(review.at).toLocaleString()}` : "Not checked yet"} · <button class="linkbtn" data-act="sync" style="padding:0">Check again</button></p>
    ${pending.length ? `<div class="tip">To apply these, open Claude with the blog-fixes repo and say <b>“work through the new responses”</b>. You'll see each change before it goes live.
        <button class="btn ghost sm" data-act="copy-review" style="margin-top:10px">📋 Copy this list</button>
        <textarea id="review-text" hidden readonly aria-label="Review summary"></textarea></div>`
      : `<div class="empty">${pipG("sleepy", 100)}<p class="muted">Nothing to apply right now.</p></div>`}
    ${[...byPost.entries()].map(([title, list]) => `<h2>${esc(title)}</h2><div class="answers">${list.map(answerHtml).join("")}</div>`).join("")}
    ${r.research.length ? `<h2>Her research list</h2><div class="answers">${r.research.map((x) => `<div class="answer"><div><b>${esc(cards[x.id]?.headline || x.id)}</b><small>${esc(cards[x.id]?.post?.title || "")}</small>${x.note ? `<small>🔖 ${esc(x.note)}</small>` : ""}</div></div>`).join("")}</div>` : ""}
    ${handled.length ? `<h2>Recently handled</h2><div class="answers">${handled.map(([id, e]) => `<div class="answer"><div><b>${esc(cards[id]?.headline || id)}</b><small>${esc(e.summary || "")}</small><span class="status ${e.status === "applied" ? "live" : e.status === "no_change" ? "ok" : "wait"}">${label[e.status] || esc(e.status || "")}${e.date ? ` · ${esc(e.date)}` : ""}</span></div></div>`).join("")}</div>` : ""}`;
}

async function sync({ quiet = false } = {}) {
  if (DEMO) {
    packagePending();
    const n = S.outbox.reduce((k, o) => k + o.body.answers.length, 0);
    S.demoSent = [...(S.demoSent || []), ...S.outbox].slice(-20); S.outbox = []; S.researchDirty = false; save();
    if (n) toast(`Demo: ${n} answer${n === 1 ? "" : "s"} would upload now`);
    else if (!quiet) toast("Demo mode: nothing to upload");
    refreshAfterSync();
    return;
  }
  if (syncing) return;
  if (!S.settings.token) { if (!quiet) toast("Add the GitHub key in Settings first"); return; }
  if (!navigator.onLine) { if (!quiet) toast("Offline — will sync when you're back online"); return; }
  syncing = true; S.lastTry = Date.now();
  if (!S.lastSync && view.name === "home") render();      // show "fetching your cards" on the very first sync
  try {
    if (S.settings.reviewer) {                             // read-only: her answers, the fix log, her research list
      await pullDecks(); await pullReview();
      S.lastSync = new Date().toISOString(); S.syncError = null; save();
      if (!quiet) toast("Up to date ✓");
      return;
    }
    packagePending();
    const sent = await flushOutbox();
    const added = await pullDecks();
    await pushResearch();
    const wasFresh = !S.restored;
    await restoreAnswered();
    const newlyLive = await pullFixLog();
    await pushProgress(!quiet || sent > 0);
    S.lastSync = new Date().toISOString(); S.syncError = null; save();
    if (wasFresh && S.restoredProgress) { toast(`Welcome back! Your ${S.xp} miles and streak are restored.`); quiet = true; S.restoredProgress = false; }
    else if (!quiet || sent || added || newlyLive) {
      const bits = [];
      if (sent) bits.push(`${sent} answer${sent === 1 ? "" : "s"} uploaded`);
      if (added) bits.push(`${added} new card${added === 1 ? "" : "s"}`);
      if (newlyLive) bits.push(`🎉 ${newlyLive} of your fixes ${newlyLive === 1 ? "is" : "are"} live on the blog!`);
      toast(bits.length ? bits.join(" · ") : "All synced ✓");
    }
  } catch (e) {
    S.syncError = { kind: e.kind || "other", msg: e.message || "Sync failed", at: S.syncError?.at || new Date().toISOString() }; save();
    if (!quiet) toast(e.message || "Sync failed — will retry");
  } finally {
    syncing = false;
    refreshAfterSync();
  }
}

// Re-draw only screens with nothing she could be typing into.
function refreshAfterSync() {
  updateIconBadge();
  if (["home", "passport"].includes(view.name)) render();
  else if (view.name === "complete") { const el = $(".sync-line"); if (el) el.textContent = syncLine(); }
}

// fixes/applied.json is written when her answers are applied to the blog.
async function pullFixLog() {
  const res = await gh(`contents/fixes/applied.json?ref=${encodeURIComponent(S.settings.branch)}`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!res.ok) return 0;
  let log; try { log = await res.json(); } catch (e) { return 0; }
  S.live = {}; S.fixlog = {};
  Object.entries(log || {}).forEach(([id, e]) => {
    if (!e || !e.status) return;
    S.fixlog[id] = e.status;
    if (e.status === "applied") S.live[id] = e;
  });
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
  const redo = !!S.redone[card.id];          // changing an earlier answer earns nothing extra
  const wasResearch = S.later.includes(card.id);
  let earned = 0;
  if (!redo) {
    if (S.streak.lastDay !== day) {
      S.streak = { ...S.streak, count: S.frozen || streakAlive() ? S.streak.count + 1 : 1, lastDay: day };
    }
    S.days[day] = (S.days[day] || 0) + 1;
    earned = XP.answer;
    if (card.severity === "high") earned += XP.high;
    if (extra.note) earned += XP.note;
    if (extra.source) earned += XP.source;
    if (S.opened[card.id]) earned += XP.opened;
    addXp(earned);
  }
  const rec = {
    card_id: card.id,
    deck: card.deck,
    post: card.post,
    type: card.type,
    severity: card.severity,
    claim_quote: card.claim?.quote || "",
    fine_reason: decision.kind === "post_is_fine" ? (extra.fineReason || "") : "",
    decision: decision.kind,                         // "apply_option" | "post_is_fine" | "other"
    option: decision.option || null,                 // {id, label, action, new_text} when apply_option
    note: extra.note || "",
    research_note: S.laterNotes[card.id]?.note || "",  // what she wanted to check while it was on her research list
    extra_source_url: extra.source || "",
    checked_source: !!S.opened[card.id],             // she opened a source link before deciding
    sources_shown: (card.sources || []).map((s) => s.url),
    answered_at: new Date().toISOString(),
  };
  S.answers[card.id] = rec;
  if (wasResearch) {
    S.later = S.later.filter((id) => id !== card.id);
    delete S.laterNotes[card.id];
    S.researchResolved = (S.researchResolved || 0) + 1; S.researchDirty = true;
  }
  S.pending.push(rec);
  recordAnswer.quests = redo ? [] : questProgress(card, extra, wasResearch);   // after the answer is stored, so "finish a post" can see it
  earned += recordAnswer.quests.reduce((n, q) => n + q.miles, 0);
  save();
  return earned;
}

/* ---------------- views ---------------- */
function render() {
  updateFreeze();
  ensureQuests();
  const app = $("#app");
  const bare = ["lesson", "complete", "intro", "recap"].includes(view.name);   // full-screen views without the tab bar
  app.classList.toggle("lesson-mode", bare);
  const html = {
    home: homeView, lesson: lessonView, complete: completeView, later: laterView, passport: passportView, settings: settingsView, intro: introView, recap: recapView,
  }[view.name]();
  app.innerHTML = html + (bare ? "" : navView());
  bind();
  window.scrollTo(0, 0);
  updateIconBadge();
  const screen = view.name + (view.name === "lesson" ? lesson.i : view.step || "");
  if (screen !== render.screen) {
    render.screen = screen;
    const h = $("#app h1, #app h2, #app .chip");
    if (h && document.activeElement?.tagName !== "INPUT") { h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (e) {} }
  }
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
  const name = S.settings.name ? `, ${S.settings.name}` : "";
  if (!open) {
    if (S.frozen) return `All caught up${name}! Your ${S.streak.count}-day streak is safe until new cards arrive ❄️`;
    return pick([`All caught up${name}! Every fact checked. I'll have more for you soon.`, "Nothing to check right now — go have an adventure! 🌍"]);
  }
  const doneToday = S.days[today()] || 0;
  if (doneToday >= S.settings.dailyGoal) return pick([`Daily goal smashed${name}! 🎉 Bonus rounds still count.`, "You're on fire today. Want to keep going?"]);
  if (!doneToday && streakNow() >= 2) return `Check one card to keep your ${streakNow()}-day streak going${name} 🔥`;
  if (!doneToday && S.streak.count >= 2 && !streakNow()) return `Welcome back${name}! Let's start a new streak today.`;
  return pick([`Hi${name}! I found ${open} thing${open === 1 ? "" : "s"} that might need a look.`, `Ready for a quick fact-check trip${name}?`, `${open} possible fix${open === 1 ? "" : "es"} waiting — let's go!`]);
}

function homeView() {
  if (S.settings.reviewer && !DEMO) return reviewerView();
  const open = openCards();
  const doneToday = S.days[today()] || 0;
  const goal = S.settings.dailyGoal;
  const pct = Math.min(100, Math.round((doneToday / goal) * 100));
  const ps = posts().sort((a, b) => (b.open > 0) - (a.open > 0) || b.views - a.views);
  const L = level(), week = weekDays(), size = lessonSize(open.length);
  const goalText = doneToday >= goal ? "Done for today — nice!"
    : !open.length ? (S.frozen ? "Nothing left to check. Streak protected ❄️" : "Nothing left to check right now")
    : open.length < goal - doneToday ? `${open.length} card${open.length === 1 ? "" : "s"} left to check`
    : `${goal - doneToday} more card${goal - doneToday === 1 ? "" : "s"} to hit today's goal`;
  const standalone = DEMO || matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (!S.settings.token) return `${topbar()}<h1 class="sr-only">Blog Quest</h1>
    <div class="hero">${pipG("happy", 104)}<div class="bubble">Hi! I'm Pip 👋 I hunt for things on the blog that might be out of date. Let's get connected!</div></div>
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
  const err = S.syncError, stuck = err && (err.kind !== "other" || Date.now() - new Date(err.at).getTime() > 24 * 3600 * 1000);
  const banner = !stuck ? "" : `<div class="alert" role="alert"><b>⚠️ ${err.kind === "other" ? "I haven't been able to sync for a while" : "I can't reach your cards"}</b>
      <p>${err.kind === "auth" ? "The access key has stopped working. It may have expired. Ask for a new one, then paste it in Settings → Connection."
        : err.kind === "access" ? "The access key can't open the cards any more. Ask for it to be checked, then paste the new one in Settings → Connection."
        : "Your answers are safe on this phone and will upload when the connection works again."}</p>
      <button class="btn ghost sm" data-nav="settings">Open Settings</button></div>`;
  if (!allCards().length && navigator.onLine && !err && (syncing || !S.lastSync)) return `${topbar()}<h1 class="sr-only">Blog Quest</h1>
    <div class="hero">${pipG("think", 104)}<div class="bubble">Fetching your cards…</div></div>
    <div class="card loading" aria-busy="true"><i></i><i></i><i></i></div>`;
  return `${topbar()}<h1 class="sr-only">Blog Quest</h1>${banner}
    <div class="hero">${pipG(open.length ? "happy" : "sleepy", 104)}<div class="bubble">${esc(greeting(open.length))}</div></div>
    <div class="goal">
      <div class="ring" style="--p:${pct}"><span>${Math.min(doneToday, goal)}/${goal}</span></div>
      <div style="flex:1;min-width:0"><b>Daily goal</b><small>${goalText}</small>
        <div class="week" role="img" aria-label="Played ${week.filter((d) => d.played).length} of the last 7 days">${week.map((d) =>
          `<div class="day ${d.played ? "played" : d.frozen ? "frozen" : ""} ${d.today ? "today" : ""}"><span>${d.letter}</span><i>${d.played ? "✓" : d.frozen ? "❄" : ""}</i></div>`).join("")}</div>
      </div>
    </div>
    <div class="levelrow"><b>Level ${L.n} · ${L.name}</b><div class="bar sm"><i style="width:${L.pct}%"></i></div>
      <small>${L.next ? `${L.next - S.xp} miles to ${L.nextName}` : "Top rank!"}</small></div>
    ${open.length ? `<button class="btn" data-act="start">Start lesson · ${size} card${size === 1 ? "" : "s"}</button>`
      : `<button class="btn ghost" data-act="sync">${S.settings.token ? "Check for new cards" : "Open Settings"}</button>`}
    <div style="margin-top:14px">${questsHtml()}</div>
    ${!standalone ? `<div class="tip">📲 <b>Tip:</b> add this to your home screen so it works offline. iPhone: Share → <i>Add to Home Screen</i>. Android: menu ⋮ → <i>Install app</i>.</div>` : ""}
    ${ps.length ? `<h2>Your journey</h2><p class="muted small" style="margin:-4px 0 14px">Each stop is one of your posts. Tap one to check just that post.</p><div class="path">${ps.map((p) => {
      const cls = p.open === 0 ? (p.done ? "done" : "locked") : "";
      const icon = p.open === 0 ? (p.done ? "⭐" : "🔒") : "📍";
      return `<button class="stop ${cls}" data-post="${esc(p.key)}" ${p.open ? "" : "disabled"}>
        <span class="node">${icon}${p.open ? `<span class="count">${p.open}</span>` : ""}</span>
        <span class="label">${esc(p.title)}<small>${p.done}/${p.cards.length} checked${p.views ? ` · 👀 ${num(p.views)}` : ""}</small></span></button>`;
    }).join("")}</div>` : ""}`;
}

function questsHtml() {
  const q = S.q;
  if (!q?.ids?.length) return "";
  const all = q.ids.every((id) => q.done[id]);
  return `<div class="card quests"><b>Today's quests</b>${all ? ` <span class="small muted">· all done, +${QUEST_BONUS} bonus</span>` : ""}
    ${q.ids.map((id) => { const Q = QUESTS[id], t = Q.target(), n = Math.min(q.prog[id] || 0, t);
      return `<div class="quest ${q.done[id] ? "done" : ""}"><span class="qi">${q.done[id] ? "✅" : Q.icon}</span>
        <span class="qt">${esc(Q.text())}<span class="bar sm"><i style="width:${Math.round((n / t) * 100)}%"></i></span></span>
        <span class="qm">${q.done[id] ? "" : `+${Q.miles}`}</span></div>`; }).join("")}</div>`;
}

function recapView() {
  const w = lastWeek(), live = Object.keys(S.live || {}).length;
  const line = w.played >= 5 ? "That's a proper habit. The blog is better for it." : w.played >= 3 ? "A solid week. Every card makes a post more trustworthy." : "Every card counts. See if you can play one more day this week.";
  return `<div class="complete">
    ${pipG("cheer", 140)}
    <h1>Your week</h1>
    <div class="muted">${esc(line)}</div>
    <div class="stats">
      <div class="stat a"><div class="t">Cards</div><div class="v">${w.cards}</div></div>
      <div class="stat b"><div class="t">Days played</div><div class="v">${w.played}/7</div></div>
      <div class="stat c"><div class="t">Miles</div><div class="v">+${w.miles}</div></div>
    </div>
    <div class="card" style="width:100%"><b>🔥 ${streakNow()}-day streak</b>${live ? ` · <b>📰 ${live}</b> fix${live === 1 ? "" : "es"} live on the blog` : ""}</div>
    <div style="width:100%;margin-top:auto"><button class="btn" data-act="recap-done">Start this week</button></div></div>`;
}

// The welcome walkthrough: shown on first open, and again from Settings.
const INTRO = [
  { mood: "happy", title: "Hi, I'm Pip!", body: "I read your blog posts and look for things that may need a fix: a price that changed, new opening hours, a typo. I never change your blog myself." },
  { mood: "think", title: "You make the call", body: "Each card shows what your post says and what I found, with links to check. Pick a suggested fix, tell me the post is fine, or write your own. Not sure? Tap “I need to research this first” and it's saved to your Research list." },
  { mood: "cheer", title: "Then it gets fixed", body: "Your answers are saved and sent off, even if you were offline at the time. Each one is reviewed and applied to the blog, and I'll tell you when your fix is live. Until then you can change your mind in Passport." },
  { mood: "wow", title: "A little every day", body: "A lesson is three cards and takes a minute or two. Decide at least one card a day to keep your streak 🔥. New cards arrive about once a week, and if you run out your streak is frozen ❄️ until they do." },
];
function introView() {
  const i = Math.min(view.step || 0, INTRO.length - 1), step = INTRO[i], last = i === INTRO.length - 1;
  return `<div class="intro">
    <button class="linkbtn skip" data-act="intro-done">Skip</button>
    ${pipG(step.mood, 150)}
    <h1>${esc(step.title)}</h1>
    <p>${esc(step.body)}</p>
    ${last ? `<div class="field" style="width:100%;text-align:left"><label for="intro-name">What should I call you?</label>
      <input type="text" id="intro-name" autocomplete="given-name" maxlength="30" value="${esc(S.settings.name)}" placeholder="Your first name (optional)"></div>` : ""}
    <div class="dots" role="img" aria-label="Step ${i + 1} of ${INTRO.length}">${INTRO.map((_, n) => `<i class="${n === i ? "on" : ""}"></i>`).join("")}</div>
    <div class="intro-actions">
      ${i ? `<button class="btn ghost" data-act="intro-back">Back</button>` : ""}
      <button class="btn ${last ? "" : "teal"}" data-act="${last ? "intro-done" : "intro-next"}">${last ? "Let's go" : "Next"}</button>
    </div></div>`;
}

function navView() {
  const n = S.later.length;
  if (S.settings.reviewer && !DEMO) {
    const r = (id, icon, label) => `<button class="${view.name === id ? "on" : ""}" data-nav="${id}" aria-label="${label}">${icon}<span>${label}</span></button>`;
    return `<nav class="tabs"><div class="in">${r("home", "🧾", "Review")}${r("settings", "⚙️", "Settings")}</div></nav>`;
  }
  const t = (id, icon, label) => `<button class="${view.name === id ? "on" : ""}" data-nav="${id}" aria-label="${label}">${icon}<span>${label}</span>${id === "later" && n ? `<i class="dot">${n}</i>` : ""}</button>`;
  return `<nav class="tabs"><div class="in">${t("home", "🗺️", "Journey")}${t("later", "🔖", "Research")}${t("passport", "🛂", "Passport")}${t("settings", "⚙️", "Settings")}</div></nav>`;
}

function startLesson(cards) {
  if (!cards.length) return;
  lesson = { cards: cards.slice(0, lessonSize(cards.length)), i: 0, selected: null, earned: 0, answered: 0, parked: 0, startLevel: level().n, startStreak: streakNow() };
  view = { name: "lesson" }; render();
}

function lessonView() {
  const c = lesson.cards[lesson.i];
  const pct = Math.round((lesson.i / lesson.cards.length) * 100);
  const sev = c.severity || "low";
  const sevText = { high: "Readers may act on this", medium: "Worth updating", low: "Minor" }[sev] || "";
  // An option can carry "valid_until": "YYYY-MM-DD" (e.g. "add a final-weekend note") and is hidden after that date.
  const options = (c.options || []).filter((o) => !o.valid_until || o.valid_until >= today()).map((o, n) => ({ key: String.fromCharCode(65 + n), id: `opt:${o.id}`, label: o.label, sub: o.new_text && o.action !== "remove" ? `“${o.new_text}”` : o.action === "remove" ? "Removes it from the post" : "",
    diff: o.action === "replace" && o.new_text && isQuickFix(c) ? diffHtml(c.claim?.quote || "", o.new_text) : "" }));
  const hasSources = (c.sources || []).length > 0;   // quick-fix cards (typos and the like) have none
  options.push({ key: "✓", id: "fine", label: "The post is fine as is", sub: hasSources ? "The sources are wrong or don't apply" : "Leave it the way it is" });
  options.push({ key: "✎", id: "other", label: "Something else…", sub: "Tell us what to change" });
  const sel = lesson.selected;
  return `<div class="lesson-top">
      <button class="iconbtn" data-act="quit" aria-label="Quit lesson">✕</button>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span class="pill miles">✈️ ${S.xp}</span>
    </div>
    <div>
      ${!resolvedCount() && !S.later.length ? `<div class="tip">👋 <b>Your first card.</b> Read what your post says, look at what I found, then choose an option below. Nothing on your blog changes until your answer has been reviewed.</div>` : ""}
      <h1 class="chip ${esc(sev)}" style="margin:0">${TYPE_ICON[c.type] || "🔍"} ${esc(c.headline || "Possible issue")}</h1>
      <span class="small muted" style="margin-left:6px">${esc(sevText)}</span>
      <div class="posttitle">${safeUrl(c.post?.url) ? `<a href="${esc(c.post.url)}" target="_blank" rel="noopener noreferrer">${esc(c.post?.title)}</a>` : esc(c.post?.title)}${c.claim?.section ? ` · ${esc(c.claim.section)}` : ""}</div>
      ${viewsLine(c.post) ? `<div class="small muted">${viewsLine(c.post)}</div>` : ""}
      ${S.laterNotes[c.id]?.note ? `<div class="tip" style="margin-top:8px">🔖 <b>Your note:</b> ${esc(S.laterNotes[c.id].note)}</div>` : ""}
      ${c.update?.text ? `<div class="tip" style="margin-top:8px">🔎 <b>Pip looked into it${c.update.date ? ` (${esc(c.update.date)})` : ""}:</b> ${esc(c.update.text)}</div>` : ""}
      <div class="label-sm">Your post says</div>
      <blockquote class="claim">${claimHtml(c)}</blockquote>
      ${(c.also_in || []).length ? `<div class="small muted" style="margin-top:6px">📌 Also in this post: ${c.also_in.map(esc).join(" · ")}. Any fix gets applied there too.</div>` : ""}
      <div class="think">${pipG("think", 58)}<div class="bubble">${esc(c.summary)}</div></div>
      ${isQuickFix(c) && c.confidence !== "check" ? "" : `<div class="label-sm">What I found</div>`}
      ${c.confidence && !(isQuickFix(c) && c.confidence !== "check") ? `<div class="evidence ${c.confidence === "strong" ? "strong" : "check"}">
          <b>${c.confidence === "strong" ? "✅ Strong evidence" : "⚠️ Worth a look before you decide"}</b>
          ${c.evidence ? `<span>${esc(c.evidence)}</span>` : ""}</div>` : ""}
      ${(c.sources || []).map((s, n) => `<div class="source">
          <b>${n + 1}. ${esc(s.label)}</b>
          ${s.quote ? `<q>${esc(s.quote)}</q>` : ""}
          <div class="meta">
            ${safeUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ""}
            ${s.retrieved ? `<span>checked ${esc(s.retrieved)}</span>` : ""}
            ${s.via === "search snippet" ? `<span>from search preview</span>` : ""}
            ${s.via === "owner" ? `<span>✔ confirmed first-hand</span>` : ""}
          </div></div>`).join("")}
      ${!navigator.onLine ? `<div class="tip">📴 You're offline — the quotes above were saved for you. Links will open when you're back online.</div>` : ""}
      <div class="label-sm">What should we do?</div>
      ${options.map((o) => `<button class="opt ${sel === o.id ? "sel" : ""}" data-opt="${esc(o.id)}" aria-pressed="${sel === o.id}"><span class="k">${o.key}</span><span>${esc(o.label)}${o.diff ? `<small class="diff">${o.diff}</small>` : o.sub ? `<small>${esc(o.sub)}</small>` : ""}</span></button>`).join("")}
      ${sel === "fine" && hasSources ? `<div class="reasons" role="group" aria-label="Why is the post right?">
          <span class="small muted">Why? (helps Pip check better next time)</span>
          ${FINE_REASONS.map(([id, label]) => `<button class="reason ${lesson.fineReason === id ? "on" : ""}" data-reason="${id}">${label}</button>`).join("")}
        </div>` : ""}
      ${sel === "other" ? `<textarea id="note" placeholder="What should change? (dictate with the 🎤 on your keyboard)">${esc(lesson.note || "")}</textarea>`
        : `<details class="extra" ${lesson.note || lesson.source ? "open" : ""}><summary>+ Add a note or your own source (bonus miles)</summary>
            <textarea id="note" placeholder="Anything we should know?">${esc(lesson.note || "")}</textarea>
            <input type="url" id="source" inputmode="url" placeholder="https:// link you found (optional)" value="${esc(lesson.source || "")}">
          </details>`}
      ${sel === "other" ? `<input type="url" id="source" inputmode="url" placeholder="https:// link you found (optional)" value="${esc(lesson.source || "")}" style="margin-top:8px">` : ""}
      <button class="linkbtn" data-act="later">🔖 ${S.later.includes(c.id) ? "Keep it on my research list" : "I need to research this first"}</button>
    </div>
    <div class="lesson-actions"><button class="btn teal" data-act="check" ${sel ? "" : "disabled"}>Save answer</button></div>
    <div class="sheet" id="sheet"><div class="in"></div></div>`;
}

const PRAISE = ["Nice catch!", "Great detective work!", "Sharp eyes!", "Fact checked!", "Readers will thank you!", "Pip approves!", "Smooth sailing!"];

function showSheet({ later = false, earned = 0, title, cardId = "", bonus = "", quests = [] }) {
  const sheet = $("#sheet");
  sheet.classList.toggle("later", later);
  $(".in", sheet).innerHTML = `<div class="row">${pipG(later ? "wow" : "cheer", 64)}<div><h2>${esc(title)}</h2>
    <div class="xp">${later ? "Saved to your research list 🔖" : earned ? `+${earned} miles ✈️${bonus ? ` · ${esc(bonus)}` : ""}` : "Answer updated"}</div></div></div>
    ${quests.map((q) => `<div class="questdone">⭐ Quest complete: ${esc(q.text)} <b>+${q.miles}</b></div>`).join("")}
    ${later ? `<input type="text" id="rnote" data-card="${esc(cardId)}" value="${esc(S.laterNotes[cardId]?.note || "")}" placeholder="What do you need to check? (optional)" aria-label="What do you need to check?" style="margin-bottom:12px">` : ""}
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
  const earned = recordAnswer(c, decision, { note: lesson.note, source: lesson.source, fineReason: lesson.fineReason });
  lesson.earned += earned; lesson.answered++; lesson.undo.earned = earned; lesson.undo.kind = "answer";
  chime("ok"); buzz(20);
  const goalHit = earned && (S.days[today()] || 0) === S.settings.dailyGoal;
  showSheet({ earned, title: goalHit ? "Daily goal reached! 🎯" : pick(PRAISE), bonus: S.opened[c.id] && earned ? "source checked" : "", quests: recordAnswer.quests });
}

function parkLater() {
  const c = lesson.cards[lesson.i];
  const fresh = !S.later.includes(c.id);     // miles only the first time a card goes on the list
  const earned = fresh ? XP.later : 0;
  lesson.undo = { ...snapshot(c), earned, kind: "later", fresh };
  if (fresh) {
    S.later.push(c.id); S.laterNotes[c.id] = { note: "", at: new Date().toISOString() };
    lesson.parked++; S.researchDirty = true;
  }
  addXp(earned); lesson.earned += earned;
  save(); chime("later"); buzz(10);
  showSheet({ later: true, title: fresh ? "Good call — no guessing!" : "Still on your research list", cardId: c.id });
}

// Everything an answer can change, so a mis-tap can be taken back before moving on.
function snapshot(c) {
  return { cardId: c.id, xp: S.xp, streak: { ...S.streak }, day: S.days[today()] || 0,
    later: [...S.later], laterNotes: clone(S.laterNotes), researchResolved: S.researchResolved || 0,
    q: clone(S.q), xpDay: S.xpDays[today()] || 0,
    pendingLen: S.pending.length, note: lesson.note, source: lesson.source, selected: lesson.selected, fineReason: lesson.fineReason };
}

function undoLast() {
  const u = lesson.undo;
  if (!u) return;
  // Only possible while the answer is still on the phone (not yet packaged for upload).
  if (u.kind === "answer" && S.pending.length !== u.pendingLen + 1) { toast("Already uploaded — can't undo this one"); return; }
  if (u.kind === "answer") { S.pending.pop(); delete S.answers[u.cardId]; lesson.answered--; }
  else if (u.fresh) lesson.parked--;
  S.xp = u.xp; S.streak = u.streak; S.later = u.later; S.q = u.q;
  if (u.xpDay) S.xpDays[today()] = u.xpDay; else delete S.xpDays[today()];
  S.laterNotes = u.laterNotes; S.researchResolved = u.researchResolved; S.researchDirty = true;
  if (u.day) S.days[today()] = u.day; else delete S.days[today()];
  lesson.earned -= u.earned;
  lesson.undo = null;
  lesson.note = u.note; lesson.source = u.source; lesson.selected = u.selected; lesson.fineReason = u.fineReason;
  save();
  render();
  toast("Undone — pick again");
}

function nextCard() {
  const rn = $("#rnote");
  if (rn && S.laterNotes[rn.dataset.card] && S.laterNotes[rn.dataset.card].note !== rn.value.trim()) {
    S.laterNotes[rn.dataset.card].note = rn.value.trim(); S.researchDirty = true; save();
  }
  lesson.i++; lesson.selected = null; lesson.note = ""; lesson.source = ""; lesson.undo = null; lesson.fineReason = "";
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
    ${pipG("cheer", 150)}
    <h1>Lesson complete!</h1>
    <div class="muted">${L.answered} checked${L.parked ? ` · ${L.parked} saved for research` : ""}</div>
    <div class="stats">
      <div class="stat a"><div class="t">Miles</div><div class="v">+${L.earned}</div></div>
      <div class="stat b"><div class="t">Streak</div><div class="v">🔥 ${streakNow()}</div></div>
      <div class="stat c"><div class="t">Today</div><div class="v">${S.days[today()] || 0}/${S.settings.dailyGoal}</div></div>
    </div>
    ${level().n > L.startLevel ? `<div class="card up" style="width:100%"><b>⭐ Level up!</b><div>You're now a <b>${esc(level().name)}</b> (level ${level().n})${GEAR.filter(([n]) => n > L.startLevel && n <= level().n).map(([, g]) => `<br>Pip earned ${esc(g)}!`).join("")}</div></div>` : ""}
    ${STREAK_MILESTONES.includes(streakNow()) && streakNow() > L.startStreak ? `<div class="card up" style="width:100%"><b>🔥 ${streakNow()}-day streak!</b><div>${streakNow() >= 7 ? "That's a real habit now." : "You're on a roll."}</div></div>` : ""}
    ${(L.newBadges || []).length ? `<div class="card" style="width:100%"><b>New badge${L.newBadges.length > 1 ? "s" : ""}!</b><div>${L.newBadges.map((b) => `${b.e} ${esc(b.name)}`).join(" · ")}</div></div>` : ""}
    <div class="sync-line">${syncLine()}</div>
    <div style="width:100%;margin-top:auto;display:grid;gap:12px">
      ${openCards().length ? `<button class="btn" data-act="start">Keep going · ${lessonSize(openCards().length)} more</button>` : ""}
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
  const items = researchItems();
  const canShare = !DEMO && typeof navigator.share === "function";
  return `${topbar()}<h1 class="title">🔖 Research list</h1>
    ${items.length ? `<p class="muted small">Things you want to look into before deciding. ${DEMO ? "In the real app this list is saved with your answers." : "The list is saved with your answers, so it's never lost."}</p>
      ${items.map(({ c, note }) => {
        const src = (c.sources || []).find((s) => safeUrl(s.url));
        return `<div class="card research">
          <span class="chip ${esc(c.severity || "low")}">${TYPE_ICON[c.type] || "🔍"} ${esc(c.headline)}</span>
          <div class="posttitle">${safeUrl(c.post?.url) ? `<a href="${esc(c.post.url)}" target="_blank" rel="noopener noreferrer">${esc(c.post?.title)}</a>` : esc(c.post?.title)}</div>
          <blockquote class="claim sm">${esc(c.claim?.quote)}</blockquote>
          <p class="small" style="margin:8px 0">${esc(c.summary)}</p>
          ${c.update?.text ? `<div class="tip">🔎 <b>Pip looked into it${c.update.date ? ` (${esc(c.update.date)})` : ""}:</b> ${esc(c.update.text)}</div>` : ""}
          <label class="small muted" for="rn-${esc(c.id)}">What to check</label>
          <input type="text" id="rn-${esc(c.id)}" data-rnote="${esc(c.id)}" value="${esc(note)}" placeholder="e.g. call and ask about Monday hours">
          <div class="row2">
            ${src ? `<a class="btn ghost sm" href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ""}
            <button class="btn teal sm" data-laterid="${esc(c.id)}">Decide now</button>
          </div></div>`;
      }).join("")}
      <div class="card"><b>Take the list with you</b>
        <div style="display:grid;gap:10px;margin-top:10px">
          ${DEMO ? "" : `<button class="btn ghost" data-act="email-research">✉️ Email me the list</button>`}
          ${canShare ? `<button class="btn ghost" data-act="share-research">📤 Share or save to Notes</button>` : ""}
          <button class="btn ghost" data-act="copy-research">📋 Copy the list</button>
          <textarea id="research-text" hidden readonly aria-label="Research list text"></textarea>
        </div></div>`
      : `<div class="empty">${pipG("sleepy", 110)}<p class="muted">Nothing to research. When a card needs digging, tap “I need to research this first” and it lands here.</p></div>`}`;
}

function answerRows() {
  const cards = Object.fromEntries(allCards().map((c) => [c.id, c]));
  return Object.values(S.answers).sort((a, b) => (b.answered_at || "").localeCompare(a.answered_at || "")).slice(0, 15).map((a) => {
    const c = cards[a.card_id], st = S.fixlog[a.card_id];
    const status = st === "applied" ? ["live", "📰 Live on the blog"] : st === "no_change" ? ["ok", "✓ Checked, no change needed"]
      : st ? ["wait", "👀 Being looked at"] : ["wait", "⏳ Sent, waiting for review"];
    const what = a.decision === "apply_option" ? (a.option?.label || "Fix chosen") : a.decision === "post_is_fine" ? "Post is fine as is" : `Note: ${a.note}`;
    return `<div class="answer"><div><b>${esc(c?.headline || a.claim_quote)}</b><small>${esc(what)}</small><span class="status ${status[0]}">${status[1]}</span></div>
      ${c && !st ? `<button class="linkbtn" data-redo="${esc(a.card_id)}">Change</button>` : ""}</div>`;
  }).join("");
}

function passportView() {
  const ps = posts();
  const stamped = ps.filter((p) => p.done && p.done === p.cards.length);
  const fixes = Object.values(S.answers).filter((a) => a.decision !== "post_is_fine").length;
  const L = level();
  // Monthly readers of the posts that now carry one of her fixes.
  const reach = ps.filter((p) => p.cards.some((c) => S.live[c.id])).reduce((n, p) => n + Math.round((p.post?.views?.count || 0) / Math.max(1, (p.post?.views?.days || 30) / 30)), 0);
  return `${topbar()}<h1 class="title">🛂 Passport</h1>
    <div class="levelrow big"><b>Level ${L.n} · ${L.name}</b><div class="bar sm"><i style="width:${L.pct}%"></i></div>
      <small>${L.next ? `${L.next - S.xp} miles to ${L.nextName}` : "Top rank!"}</small></div>
    <div class="gear">${pipG("happy", 72)}<div class="small"><b>Pip's gear</b><br>${GEAR.filter(([n]) => n <= L.n).map(([, g]) => esc(g)).join(", ") || "Just the hat and magnifying glass so far."}
      ${GEAR.find(([n]) => n > L.n) ? `<br><span class="muted">Next: ${esc(GEAR.find(([n]) => n > L.n)[1])} at level ${GEAR.find(([n]) => n > L.n)[0]}</span>` : ""}</div></div>
    <div class="kpis">
      <div class="kpi"><div class="v">✈️ ${S.xp}</div><div class="l">Miles earned</div></div>
      <div class="kpi"><div class="v">🔥 ${streakNow()}</div><div class="l">Day streak</div></div>
      <div class="kpi"><div class="v">${resolvedCount()}</div><div class="l">Cards checked</div></div>
      <div class="kpi"><div class="v">${fixes}</div><div class="l">Fixes sent</div></div>
    </div>
    <div class="kpi" style="margin-top:10px"><div class="v">📰 ${Object.keys(S.live || {}).length}</div><div class="l">Fixes live on the blog</div></div>
    ${reach ? `<div class="kpi" style="margin-top:10px"><div class="v">👀 ${num(reach)}</div><div class="l">Readers a month on posts you've fixed</div></div>` : ""}
    <details class="card how"><summary><b>How miles and streaks work</b></summary>
      <ul class="small">
        <li><b>Miles:</b> ${XP.answer} for every card you decide. +${XP.high} if readers might act on it, +${XP.note} for adding a note, +${XP.source} for adding your own source, +${XP.opened} for opening a source first, and ${XP.later} for saving a card to your Research list.</li>
        <li><b>Levels:</b> miles add up to ranks, from ${LEVELS[0][1]} to ${LEVELS[LEVELS.length - 1][1]}.</li>
        <li><b>Streak 🔥:</b> decide at least one card a day. If there are no cards left, it's frozen ❄️ and can't break. When new cards arrive you have that day and the next to carry on.</li>
        <li><b>Daily goal:</b> ${S.settings.dailyGoal} cards. Change it in Settings.</li>
        <li><b>Stamps and badges:</b> finish every card on a post for its stamp. Badges mark milestones.</li>
      </ul></details>
    <h2>Badges</h2>
    <div class="badges">${BADGES.map((b) => `<div class="badge ${S.badges[b.id] ? "" : "locked"}"><span class="e">${b.e}</span><b>${esc(b.name)}</b><small>${esc(b.how)}</small></div>`).join("")}</div>
    <h2>Stamps</h2>
    ${stamped.length ? `<div class="stamps">${stamped.map((p) => `<div class="stamp">✔ ${esc(p.title)}</div>`).join("")}</div>`
      : `<p class="muted small">Finish every card on a post to earn its stamp.</p>`}
    <h2>Your answers</h2>
    ${resolvedCount() ? `<div class="answers">${answerRows()}</div><p class="muted small">You can change an answer until it has been applied to the blog.</p>`
      : `<p class="muted small">Your answers will show here, along with what happened to each one.</p>`}`;
}

function youFields(s) {
  return `<div class="field"><label for="name">What should Pip call you?</label>
      <input type="text" id="name" autocomplete="given-name" maxlength="30" value="${esc(s.name)}" placeholder="Your first name"></div>
    ${DEMO ? "" : `<div class="field"><label for="email">Your email</label>
      <input type="email" id="email" autocomplete="email" inputmode="email" value="${esc(s.email)}" placeholder="you@example.com">
      <div class="hint">Used only to address the research list when you email it to yourself. Stored on this phone.</div></div>`}
    <div class="field"><label for="goal">Daily goal (cards)</label><input type="number" id="goal" min="1" max="30" value="${s.dailyGoal}"></div>
    <label class="toggle">Sounds <input type="checkbox" id="sound" ${s.sound ? "checked" : ""}></label>`;
}

function reminderCard() {
  const r = reminderLinks(S.settings.remindTime);
  return `<div class="card"><b>Daily reminder</b>
    <p class="small muted" style="margin:6px 0 10px">Adds a repeating event with an alert to your calendar, so your phone nudges you. Delete the event to stop it.</p>
    <div class="field"><label for="remind">Remind me at</label><input type="time" id="remind" value="${esc(S.settings.remindTime || "19:30")}"></div>
    <div style="display:grid;gap:10px">
      <a class="btn ghost" id="remind-google" href="${esc(r.google)}" target="_blank" rel="noopener noreferrer">📅 Add to Google Calendar</a>
      ${DEMO ? "" : `<a class="btn ghost" id="remind-ics" href="${esc(r.ics)}" download="blog-quest-reminder.ics">🍎 Add to Apple or another calendar</a>`}
    </div></div>`;
}

function demoSettingsView() {
  const s = S.settings;
  const last = (S.demoSent || []).slice(-1)[0];
  return `${topbar()}<h1 class="title">⚙️ Settings</h1>
    <div class="tip"><b>Demo mode.</b> Cards are built in, nothing is sent to GitHub or the blog, and progress stays in this browser only.</div>
    <div class="card">
      ${youFields(s)}
      <button class="btn teal" data-act="save-demo">Save</button>
    </div>
    <div class="card">
      <b>Try the rest of the loop</b>
      <p class="small muted" style="margin:6px 0 12px">See the file the real app would upload, or pretend your fixes went live on the blog.</p>
      <div style="display:grid;gap:10px">
        <button class="btn ghost" data-act="demo-file" ${last ? "" : "disabled"}>${last ? "Show the last upload file" : "Finish a lesson to see its upload file"}</button>
        <pre id="demo-file" hidden style="overflow:auto;max-height:320px;font-size:12px;background:var(--surface-2);padding:12px;border-radius:12px;white-space:pre-wrap;word-break:break-word">${last ? esc(`${last.path}\n\n${JSON.stringify(last.body, null, 2)}`) : ""}</pre>
        <button class="btn ghost" data-act="demo-research">Show the saved research list</button>
        <pre id="demo-research" hidden style="overflow:auto;max-height:320px;font-size:12px;background:var(--surface-2);padding:12px;border-radius:12px;white-space:pre-wrap;word-break:break-word">${esc(`research/open.md\n\n${researchDoc(true)}`)}</pre>
        <button class="btn sun" data-act="demo-live">🎉 Pretend my fixes went live</button>
      </div>
    </div>
    ${reminderCard()}
    <button class="btn ghost" data-act="show-intro" style="margin-bottom:6px">❓ How Blog Quest works</button>
    <button class="linkbtn" data-act="reset" style="color:var(--coral-text)">Reset the demo</button>`;
}

function settingsView() {
  if (DEMO) return demoSettingsView();
  const s = S.settings;
  const waiting = S.outbox.reduce((n, o) => n + o.body.answers.length, 0) + S.pending.length;
  return `${topbar()}<h1 class="title">⚙️ Settings</h1>
    <div class="card">${youFields(s)}</div>
    <details class="card conn"><summary><b>Connection</b> <span class="small muted">· set up once</span></summary>
      <div class="field" style="margin-top:12px"><label for="token">GitHub access key</label>
        <input type="password" id="token" autocomplete="off" placeholder="github_pat_…" value="${esc(s.token)}">
        <div class="hint">Only stored on this phone. Ask whoever set this up for it if it's blank.</div></div>
      <div class="field"><label for="repo">Repo</label><input type="text" id="repo" value="${esc(s.repo)}" autocapitalize="off" autocorrect="off"></div>
      <div class="field"><label for="branch">Branch</label><input type="text" id="branch" value="${esc(s.branch)}" autocapitalize="off" autocorrect="off"></div>
      <label class="toggle" for="reviewer">Reviewer mode <input type="checkbox" id="reviewer" ${s.reviewer ? "checked" : ""}></label>
      <div class="hint">For the person who applies the fixes. Shows her answers instead of the game, and never writes anything.</div>
    </details>
    <button class="btn teal" data-act="save-settings" style="margin-bottom:14px">Save & sync</button>
    <div class="card small">
      <div><b>Last sync:</b> ${S.lastSync ? new Date(S.lastSync).toLocaleString() : "never"}</div>
      <div><b>Waiting to upload:</b> ${waiting} answer${waiting === 1 ? "" : "s"}</div>
      <div><b>Cards on phone:</b> ${allCards().length}</div>
      ${S.syncError ? `<div><b>Last problem:</b> ${esc(S.syncError.msg)}</div>` : ""}
      <div class="muted">Blog Quest ${APP_VERSION}</div>
      <div style="margin-top:10px;display:grid;gap:10px"><button class="btn ghost" data-act="sync">Sync now</button>
        <button class="btn ghost" data-act="copy-help">📋 Copy details for help</button>
        <textarea id="help-text" hidden readonly aria-label="Details for help"></textarea></div>
    </div>
    ${reminderCard()}
    <button class="btn ghost" data-act="show-intro" style="margin-bottom:6px">❓ How Blog Quest works</button>
    <button class="linkbtn" data-act="reset" style="color:var(--coral-text)">Reset this phone's progress</button>`;
}

/* ---------------- events ---------------- */
function bind() {
  document.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => {
    const leavingResearch = view.name === "later" && S.researchDirty;
    view = { name: b.dataset.nav }; render();
    if (leavingResearch) sync({ quiet: true });   // save edited research notes
  }));
  // Changing the reminder time updates the calendar links straight away.
  $("#remind")?.addEventListener("input", (e) => {
    S.settings.remindTime = e.target.value || "19:30"; save();
    const r = reminderLinks(S.settings.remindTime);
    $("#remind-google")?.setAttribute("href", r.google); $("#remind-ics")?.setAttribute("href", r.ics);
  });
  // Notes on the research list save as she types.
  document.querySelectorAll("[data-rnote]").forEach((inp) => inp.addEventListener("input", () => {
    const id = inp.dataset.rnote;
    S.laterNotes[id] = { at: new Date().toISOString(), ...S.laterNotes[id], note: inp.value.trim() };
    S.researchDirty = true; save();
  }));
  // Opening a source before deciding earns a small bonus, to reward checking over guessing.
  document.querySelectorAll(".source a").forEach((a) => a.addEventListener("click", () => {
    const c = lesson?.cards[lesson.i];
    if (c && !S.opened[c.id]) { S.opened[c.id] = true; save(); }
  }));
  document.querySelectorAll("[data-redo]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.redo, card = allCards().find((c) => c.id === id);
    if (!card) return;
    askConfirm("Change this answer?", "Your new answer replaces the old one.", "Change it", "Cancel").then((ok) => {
      if (!ok) return;
      delete S.answers[id]; S.redone[id] = true;
      S.pending = S.pending.filter((a) => a.card_id !== id); save();
      startLesson([card]);
    });
  }));
  document.querySelectorAll("[data-post]").forEach((b) => b.addEventListener("click", () => {
    startLesson(openCards().filter((c) => String(c.post?.id ?? c.post?.url ?? c.post?.title) === b.dataset.post));
  }));
  document.querySelectorAll("[data-laterid]").forEach((b) => b.addEventListener("click", () => {
    startLesson(laterCards().filter((c) => c.id === b.dataset.laterid));
  }));
  document.querySelectorAll("[data-opt]").forEach((b) => b.addEventListener("click", () => {
    readExtras(); lesson.selected = b.dataset.opt; if (lesson.selected !== "fine") lesson.fineReason = ""; buzz(8);
    const y = window.scrollY; render(); window.scrollTo(0, y);
    if (lesson.selected === "other") $("#note")?.focus();
  }));
  document.querySelectorAll("[data-reason]").forEach((b) => b.addEventListener("click", () => {
    readExtras(); lesson.fineReason = lesson.fineReason === b.dataset.reason ? "" : b.dataset.reason; buzz(8);
    const y = window.scrollY; render(); window.scrollTo(0, y);
  }));
  document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act)));
}

function act(a) {
  switch (a) {
    case "start": startLesson(mixLesson(openCards())); break;
    case "email-research": {
      const body = researchDoc(false);
      const cut = body.length > 1700 ? body.slice(0, 1700) + "\n…(the full list is in the app)" : body;
      const to = (S.settings.email || "").replace(/[^\w.@+-]/g, "");
      location.href = `mailto:${to}?subject=${encodeURIComponent(`Blog Quest research list (${S.later.length})`)}&body=${encodeURIComponent(cut)}`;
      break;
    }
    case "share-research":
      navigator.share({ title: "Blog Quest research list", text: researchDoc(false) }).catch(() => {});
      break;
    case "copy-research": {
      const text = researchDoc(false);
      const fallback = () => { const t = $("#research-text"); if (t) { t.hidden = false; t.value = text; t.focus(); t.select(); toast("Select all, then copy"); } };
      try { navigator.clipboard.writeText(text).then(() => toast("List copied — paste it into Notes or an email"), fallback); } catch (e) { fallback(); }
      break;
    }
    case "copy-help": {
      // Nothing private: no key, no answers. Just what someone helping would need to know.
      const text = [`Blog Quest ${APP_VERSION}`, `Last sync: ${S.lastSync || "never"}`, `Last problem: ${S.syncError ? `${S.syncError.kind}: ${S.syncError.msg} (since ${S.syncError.at})` : "none"}`,
        `Key saved: ${S.settings.token ? "yes" : "no"}`, `Repo: ${S.settings.repo} @ ${S.settings.branch}`, `Online: ${navigator.onLine}`,
        `Cards on phone: ${allCards().length} (${openCards().length} open, ${S.later.length} research)`, `Waiting to upload: ${S.outbox.length} files, ${S.pending.length} answers`,
        `Installed: ${matchMedia("(display-mode: standalone)").matches || !!navigator.standalone}`, `Reviewer mode: ${!!S.settings.reviewer}`, `Browser: ${navigator.userAgent}`].join("\n");
      const fallback = () => { const t = $("#help-text"); if (t) { t.hidden = false; t.value = text; t.focus(); t.select(); toast("Select all, then copy"); } };
      try { navigator.clipboard.writeText(text).then(() => toast("Copied. Paste it into a message."), fallback); } catch (e) { fallback(); }
      break;
    }
    case "copy-review": {
      const text = reviewSummary();
      const fallback = () => { const t = $("#review-text"); if (t) { t.hidden = false; t.value = text; t.focus(); t.select(); toast("Select all, then copy"); } };
      try { navigator.clipboard.writeText(text).then(() => toast("Copied"), fallback); } catch (e) { fallback(); }
      break;
    }
    case "demo-research": { const box = $("#demo-research"); if (box) box.hidden = !box.hidden; break; }
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
    case "intro-next": view = { name: "intro", step: (view.step || 0) + 1 }; render(); break;
    case "intro-back": view = { name: "intro", step: Math.max(0, (view.step || 0) - 1) }; render(); break;
    case "intro-done": {
      const n = $("#intro-name");
      if (n) S.settings.name = n.value.trim().slice(0, 30);
      S.seenIntro = true; save(); view = { name: "home" }; render(); break;
    }
    case "show-intro": view = { name: "intro", step: 0 }; render(); break;
    case "recap-done": S.recapSeen = dayKey(mondayOf()); save(); view = { name: "home" }; render(); break;
    case "save-demo":
      S.settings.name = $("#name").value.trim().slice(0, 30);
      S.settings.dailyGoal = Math.max(1, Math.min(30, parseInt($("#goal").value, 10) || 3));
      S.settings.sound = $("#sound").checked; save(); toast("Saved"); break;
    case "save-settings":
      S.settings.token = $("#token").value.trim();
      S.settings.repo = $("#repo").value.trim() || DEFAULTS.settings.repo;
      S.settings.branch = $("#branch").value.trim() || "main";
      S.settings.name = $("#name").value.trim().slice(0, 30);
      S.settings.email = $("#email").value.trim();
      S.settings.dailyGoal = Math.max(1, Math.min(30, parseInt($("#goal").value, 10) || 3));
      S.settings.sound = $("#sound").checked;
      S.settings.reviewer = $("#reviewer").checked;
      save(); toast("Saved"); view = { name: S.settings.reviewer ? "home" : "settings" }; render(); sync(); break;
    case "reset":
      askConfirm("Reset progress?", DEMO ? "Clears this demo so you can start over." : "Answers already uploaded stay safe in GitHub.", "Reset", "Cancel").then((ok) => {
        if (!ok) return;
        const settings = S.settings; S = clone(DEFAULTS); S.settings = settings;
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
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mt">${pipG("wow", 64)}
      <h2 id="mt">${esc(title)}</h2><p class="muted">${esc(body)}</p>
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
  S.decks = { [d.created]: { id: d.created, sha: "demo", created: d.created, cards: cleanCards(d.cards) } };
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
    if (h.get("reviewer")) { S.settings.reviewer = true; S.seenIntro = true; }   // setup link for the reviewer: …#token=…&reviewer=1
    save();
    history.replaceState(null, "", location.pathname + location.search);
    setTimeout(() => toast(S.settings.reviewer ? "Connected! Fetching her answers…" : "Connected! Pulling your cards…"), 300);
  }
})();

if (!DEMO && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("online", () => { refreshAfterSync(); sync({ quiet: true }); });
window.addEventListener("offline", refreshAfterSync);
// Coming back to the app syncs, but not more than once a minute unless something is waiting to go up.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const waiting = S.pending.length || S.outbox.length || S.researchDirty;
  if (waiting || Date.now() - (S.lastTry || 0) > 60 * 1000) sync({ quiet: true });
});
// Ask the browser not to clear the app's saved progress when the phone runs low on space.
if (!DEMO) { try { navigator.storage?.persist?.(); } catch (e) {} }

// Any answers left from a lesson that was closed mid-way get packaged for upload.
packagePending();
if (!S.seenIntro) view = { name: "intro", step: 0 };
else if (recapDue() && !S.settings.reviewer) view = { name: "recap" };
render();
// Home-screen shortcuts: …/#start goes straight into a lesson, …/#research opens the research list.
if (view.name === "home" && !S.settings.reviewer && S.settings.token) {
  if (location.hash === "#start" && openCards().length) startLesson(mixLesson(openCards()));
  else if (location.hash === "#research") { view = { name: "later" }; render(); }
}
sync({ quiet: true });

// Exposed for local testing only.
window.__bq = { get state() { return S; }, get lesson() { return lesson; }, get view() { return view; }, load: (decks) => { decks.forEach((d) => (S.decks[d.id] = d)); save(); render(); } };
