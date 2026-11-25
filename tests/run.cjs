#!/usr/bin/env node
// End-to-end tests for Blog Quest. Run: node tests/run.cjs [name filter]
// Needs Playwright with Chromium. Everything runs against a pretend GitHub; nothing leaves the machine.
const assert = require("assert");
const { serve, newRepo, fixtureDeck, Session, answer, next, chromium, GOOD_KEY } = require("./harness.cjs");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const cardId = (page) => page.evaluate(() => window.__bq.lesson.cards[window.__bq.lesson.i].id);
const dayStr = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const text = async (page, sel) => ((await page.textContent(sel)) || "").trim().replace(/\s+/g, " ");
async function finishLesson(page, choice = "fine") {
  while (await page.$("[data-act=check]")) { await answer(page, choice); await next(page); }
  await page.waitForTimeout(500);
}
async function playAll(page) {
  for (let g = 0; g < 12 && await page.$("[data-act=start]"); g++) { await page.click("[data-act=start]"); await finishLesson(page); await page.click("[data-act=home]"); }
}
const skipRecap = async (page) => { if (await page.$("[data-act=recap-done]")) await page.click("[data-act=recap-done]"); };
const syncNow = async (page) => { await page.click("[data-nav=settings]"); await page.click("[data-act=sync]"); await page.waitForTimeout(900); };

test("walkthrough explains the app, asks her name, and can be replayed", async (S) => {
  const { page, state } = await S.open({ intro: true });
  const titles = [];
  for (let i = 0; i < 4; i++) { titles.push(await text(page, ".intro h1")); if (i < 3) await page.click("[data-act=intro-next]"); }
  assert.deepStrictEqual(titles, ["Hi, I'm Pip!", "You make the call", "Then it gets fixed", "A little every day"]);
  await page.click("[data-act=intro-back]"); await page.click("[data-act=intro-next]");
  await page.fill("#intro-name", "Sam"); await page.click(".intro-actions [data-act=intro-done]");
  assert.strictEqual((await state()).settings.name, "Sam");
  assert.ok(await page.$("[data-act=start]"), "home shows Start lesson");
  await page.click("[data-nav=settings]"); await page.click("[data-act=show-intro]");
  assert.strictEqual(await text(page, ".intro h1"), "Hi, I'm Pip!");
  await page.click(".intro .skip"); await page.reload(); await page.waitForTimeout(500);
  assert.ok(!(await page.$(".intro")), "walkthrough is not shown again after the first time");
});

test("first card shows a hint; answers upload with everything needed to apply them", async (S) => {
  const { page, repo, state } = await S.open();
  assert.strictEqual(await text(page, "[data-act=start]"), "Start lesson · 3 cards");
  await page.click("[data-act=start]");
  assert.ok(await page.$("text=Your first card."));
  const first = await cardId(page);
  await answer(page, "a"); await next(page);                                  // the warm-up quick fix
  assert.ok(!(await page.$("text=Your first card.")), "hint goes away after the first answer");
  await page.click(".source a"); await page.waitForTimeout(200);              // open a source before deciding
  await answer(page, "fine", { reason: "first_hand" });
  assert.match(await text(page, "#sheet .xp"), /source checked/);
  await next(page);
  await answer(page, "other", { note: "Reword this please" }); await next(page);
  await page.waitForTimeout(900);
  assert.strictEqual(await text(page, ".complete h1"), "Lesson complete!");
  assert.strictEqual(repo.responses.length, 1);
  const up = repo.responses[0];
  assert.match(up.path, /^responses\/\d{4}-\d\d-\d\d\/.+\.json$/);
  const [a1, a2, a3] = up.body.answers;
  assert.strictEqual(a1.card_id, first);
  assert.strictEqual(a1.decision, "apply_option");
  assert.ok(a1.option.new_text && a1.option.action && a1.claim_quote && a1.post.id);
  assert.deepStrictEqual([a2.decision, a2.fine_reason, a2.checked_source], ["post_is_fine", "first_hand", true]);
  assert.deepStrictEqual([a3.decision, a3.note], ["other", "Reword this please"]);
  assert.deepStrictEqual(repo.badHeaders || [], [], "only headers GitHub accepts from a browser are sent");
  const s = await state();
  assert.strictEqual(s.streak.count, 1);
  assert.ok(s.badges.first && s.badges.lesson);
  assert.strictEqual(s.outbox.length + s.pending.length, 0);
});

test("\"Something else\" needs a note; undo takes back an answer completely", async (S) => {
  const { page, state } = await S.open();
  await page.click("[data-act=start]");
  await page.click("[data-opt=other]"); await page.click("[data-act=check]");
  assert.ok(!(await page.$("#sheet.show")), "blocked without a note");
  const id = await cardId(page);
  await page.click('[data-opt^="opt:"]'); await page.click("[data-act=check]"); await page.waitForSelector("#sheet.show");
  assert.ok((await state()).xp > 0);
  // She switches apps and comes back: the background sync must not upload a mid-lesson answer, or Undo would be lost.
  await page.evaluate(() => { window.__bq.state.lastTry = 0; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(700);
  await page.click("#sheet [data-act=undo]");
  const s = await state();
  assert.deepStrictEqual([s.xp, Object.keys(s.answers).length, s.pending.length, s.streak.count], [0, 0, 0, 0]);
  assert.strictEqual(await cardId(page), id);
  assert.ok(await page.$(".opt.sel"), "her selection is kept after undo");
});

test("research list: mark with a note, saved to the repo, edit, decide later", async (S) => {
  const { page, repo, state } = await S.open();
  await page.click("[data-act=start]");
  const id = await cardId(page);
  await answer(page, "later", { note: "Call and ask" }); await next(page);
  await page.click("[data-act=quit]"); await page.waitForTimeout(900);
  const file = repo.files["research/open.md"];
  assert.ok(file, "research/open.md written");
  assert.ok(file.text.includes("Call and ask") && file.text.includes(`Card: \`${id}\``));
  assert.match(file.message, /1 open/);
  await page.click("[data-nav=later]");
  await page.fill("[data-rnote]", "Check their website"); await page.click("[data-nav=home]"); await page.waitForTimeout(900);
  assert.ok(repo.files["research/open.md"].text.includes("Check their website"), "edited note saved");
  await page.click("[data-nav=later]"); await page.click("[data-laterid]");
  assert.ok(await page.$("text=Your note:"));
  const xp = (await state()).xp;
  await answer(page, "later"); assert.strictEqual((await state()).xp, xp, "no extra miles for keeping it on the list");
  await page.click("#sheet [data-act=undo]");
  await answer(page, "a"); await next(page); await page.waitForTimeout(900);
  const s = await state();
  assert.strictEqual(s.later.length, 0);
  assert.ok(s.badges.closed, "Case Closed badge");
  assert.ok(repo.files["research/open.md"].text.includes("Nothing is waiting"));
  assert.strictEqual(repo.responses.at(-1).body.answers[0].research_note, "Check their website");
});

test("an answer can be changed until it is applied, without earning twice", async (S) => {
  const { page, repo, state } = await S.open();
  await page.click("[data-act=start]"); await finishLesson(page, "a");
  await page.click("[data-act=home]"); await page.click("[data-nav=passport]");
  const before = await state();
  await page.click("[data-redo]"); await page.click(".modal [data-a=yes]");
  await answer(page, "fine"); await next(page); await page.waitForTimeout(900);
  const after = await state();
  assert.strictEqual(after.xp, before.xp);
  assert.strictEqual(repo.responses.length, 2);
  const id = repo.responses[1].body.answers[0].card_id;
  assert.strictEqual(repo.responses[1].body.answers[0].decision, "post_is_fine");
  repo.fixlog = { [id]: { status: "applied" } };
  await page.click("[data-act=home]"); await syncNow(page); await page.click("[data-nav=passport]");
  assert.ok(await page.$("text=Live on the blog"));
  assert.strictEqual((await state()).live[id].status, "applied");
  assert.strictEqual(await page.$$eval("[data-redo]", (els) => els.length), 2, "the applied answer can no longer be changed");
});

test("expired options are hidden; quick-fix cards have no source questions", async (S) => {
  const { page } = await S.open();
  await page.click('[data-post="103"]');
  for (let i = 0; i < 2; i++) {
    if (await cardId(page) === "c-103-2") {
      const labels = await page.$$eval('[data-opt^="opt:"]', (els) => els.map((e) => e.textContent));
      assert.strictEqual(labels.length, 1); assert.match(labels[0], /Remove it/);
    } else assert.ok(await page.$("text=Pip looked into it"), "research update shown on the card");
    await answer(page, "fine"); await next(page);
  }
  await page.click("[data-act=home]"); await page.click('[data-post="102"]');
  while (await cardId(page) !== "c-102-2") { await answer(page, "fine"); await next(page); }
  assert.ok(await page.$("text=Leave it the way it is"));
  await page.click("[data-opt=fine]");
  assert.ok(!(await page.$(".reasons")), "no 'why is the source wrong' on a typo card");
});

test("lessons mix one fact check with quick fixes; typo cards show the change in place", async (S) => {
  const { page, repo, state } = await S.open();
  assert.match(await text(page, '[data-post="101"] .label small'), /👀 4,200/);
  await page.click("[data-act=start]");
  const ids = await page.evaluate(() => window.__bq.lesson.cards.map((c) => c.id));
  assert.deepStrictEqual(ids, ["c-101-3", "c-101-1", "c-102-2"], "a quick fix to warm up, then the highest-priority fact check, then quick fixes");
  assert.match(await text(page, ".posttitle + .small"), /4,200 views in the last 3 months/);
  assert.strictEqual(await page.$eval("blockquote.claim", (e) => e.innerHTML), "You should <mark>visit teh museum</mark> before lunch.");
  assert.strictEqual(await page.$eval(".opt .diff", (e) => e.innerHTML), "visit <del>teh</del> <ins>the</ins> museum");
  await answer(page, "a"); await next(page);
  await answer(page, "a"); await next(page);
  repo.fixlog = { "c-101-1": { status: "applied" } };
  await finishLesson(page, "a"); await page.click("[data-act=home]"); await syncNow(page); await page.click("[data-nav=passport]");
  assert.match(await text(page, ".kpis ~ .kpi ~ .kpi"), /1,400 ?Readers a month on posts you've fixed/);
});

test("streak freezes when there is nothing left and picks up when cards arrive", async (S) => {
  const { page, repo, state } = await S.open();
  await playAll(page);
  let s = await state();
  assert.ok(s.frozen, "frozen once everything is answered");
  // Five days go by with nothing to do.
  await page.evaluate((old) => { const k = "blogquest.v1", s = JSON.parse(localStorage.getItem(k)); const t = Object.keys(s.days)[0]; s.days = { [old]: s.days[t] }; s.streak.lastDay = old; s.frozen = old; localStorage.setItem(k, JSON.stringify(s)); }, dayStr(-5));
  await page.reload(); await page.waitForTimeout(700); await skipRecap(page);
  assert.strictEqual(await text(page, ".pill.streak"), "🔥 1");
  assert.match(await text(page, ".hero .bubble"), /safe until new cards arrive/);
  const d = fixtureDeck(); d.cards = [{ ...d.cards[0], id: "c-101-9" }];
  repo.decks["2026-01-08"] = { sha: "d2", deck: d };
  await syncNow(page); await page.click("[data-nav=home]");
  s = await state();
  assert.strictEqual(s.frozen, ""); assert.strictEqual(Object.keys(s.frozenDays).length, 4);
  await page.click("[data-act=start]"); await answer(page, "a"); await next(page);
  assert.strictEqual((await state()).streak.count, 2, "the streak continues after the freeze");
});

test("a missed day with cards waiting does break the streak", async (S) => {
  const { page, state } = await S.open();
  await page.click("[data-act=start]"); await answer(page, "a"); await next(page); await page.click("[data-act=quit]"); await page.click(".modal [data-a=yes]");
  await page.waitForTimeout(900);                       // let the upload finish before rewriting saved state
  await page.evaluate((old) => { const k = "blogquest.v1", s = JSON.parse(localStorage.getItem(k)); s.days = { [old]: 1 }; s.streak.lastDay = old; localStorage.setItem(k, JSON.stringify(s)); }, dayStr(-3));
  await page.reload(); await page.waitForTimeout(600); await skipRecap(page);
  assert.strictEqual(await text(page, ".pill.streak"), "🔥 0");
  await page.click("[data-act=start]"); await answer(page, "a");
  assert.strictEqual((await state()).streak.count, 1);
});

test("a first sync that fails part-way restores nothing, then restores everything on the next try", async (S) => {
  const first = await S.open();
  await first.page.click("[data-act=start]");
  await answer(first.page, "later", { note: "look this up" }); await next(first.page);
  await finishLesson(first.page, "a");
  const s1 = await first.state();
  const backupBefore = first.repo.files["progress/state.json"].text, researchBefore = first.repo.files["research/open.md"].text;
  // New phone. GitHub fails on one request in the middle of the restore.
  const repo = first.repo; repo.failOnce = /contents\/responses\/\d{4}-\d\d-\d\d$/;
  const second = await S.open({ repo, device: "Pixel 7" });
  await second.page.waitForTimeout(700);
  let s2 = await second.state();
  assert.strictEqual(s2.restored, false, "an interrupted restore is not marked done");
  assert.deepStrictEqual([Object.keys(s2.answers).length, s2.later.length, s2.xp], [0, 0, 0], "nothing half-restored");
  assert.strictEqual(repo.files["progress/state.json"].text, backupBefore, "the progress backup is not overwritten");
  assert.strictEqual(repo.files["research/open.md"].text, researchBefore, "the research list is not overwritten");
  await syncNow(second.page);
  s2 = await second.state();
  assert.strictEqual(s2.restored, true);
  assert.deepStrictEqual([Object.keys(s2.answers).sort(), s2.later, s2.xp], [Object.keys(s1.answers).sort(), s1.later, s1.xp]);
});

test("the card can't be answered twice from behind the answer panel", async (S) => {
  const { page, repo, state } = await S.open();
  await page.click("[data-act=start]");
  const first = await cardId(page);
  await answer(page, "a");
  const xp = (await state()).xp;
  // Clicks sent straight to the buttons behind the panel, as a stray tap or a screen reader could.
  await page.evaluate(() => ['[data-opt="opt:b"]', "[data-opt=fine]", "#cardbody [data-act=later]", "[data-act=more-sources]", "[data-act=check]"]
    .forEach((sel) => document.querySelector(sel)?.click()));
  const s = await state();
  assert.deepStrictEqual([s.xp, s.pending.length, Object.values(s.days)[0]], [xp, 1, 1], "still one answer, one lot of miles");
  assert.ok(await page.$("#sheet.show"), "the panel is still up, with Undo available");
  await next(page); await finishLesson(page, "a");
  assert.strictEqual(repo.responses[0].body.answers.filter((a) => a.card_id === first).length, 1);
});

test("changing an answer and then backing out keeps the original; undo puts it back", async (S) => {
  const { page, repo, state } = await S.open();
  await page.click("[data-act=start]"); await finishLesson(page, "a"); await page.click("[data-act=home]");
  const before = await state();
  await page.click("[data-nav=passport]"); await page.click("[data-redo]"); await page.click(".modal [data-a=yes]");
  assert.ok(!(await page.$("[data-act=later]")), "no research option while changing an answer");
  const id = await cardId(page);
  await page.click("[data-act=quit]"); await page.waitForTimeout(400);
  let s = await state();
  assert.deepStrictEqual(s.answers[id], before.answers[id], "backing out leaves her answer as it was");
  assert.strictEqual(Object.keys(s.answers).length, 3);
  await page.click("[data-nav=passport]"); await page.click("[data-redo]"); await page.click(".modal [data-a=yes]");
  await answer(page, "fine"); await page.click("#sheet [data-act=undo]");
  s = await state();
  assert.strictEqual(s.answers[id].decision, "apply_option", "undo restores the original answer rather than deleting it");
  assert.strictEqual(repo.responses.length, 1);
});

test("her own link is kept: a missing https:// is added, and nonsense is questioned, not dropped", async (S) => {
  const { page, repo } = await S.open();
  await page.click("[data-act=start]");
  await page.click("[data-opt=fine]"); await page.click("details.extra summary");
  await page.fill("#source", "www.example.com/hours"); await page.click('[data-opt="opt:a"]');
  assert.strictEqual(await page.inputValue("#source"), "www.example.com/hours", "what she typed stays in the box");
  await page.click("[data-act=check]"); await page.waitForSelector("#sheet.show"); await next(page);
  await page.click("[data-opt=fine]"); await page.click("details.extra summary");
  await page.fill("#source", "see their instagram"); await page.click("[data-act=check]");
  assert.ok(!(await page.$("#sheet.show")), "asked to fix or clear it");
  await page.fill("#source", ""); await page.click("[data-act=check]"); await page.waitForSelector("#sheet.show"); await next(page);
  await finishLesson(page, "a");
  assert.strictEqual(repo.responses[0].body.answers[0].extra_source_url, "https://www.example.com/hours");
});

test("reset really resets this phone, and sends anything still waiting", async (S) => {
  const { ctx, page, repo, state } = await S.open();
  await page.click("[data-act=start]"); await finishLesson(page, "a"); await page.click("[data-act=home]");
  await ctx.setOffline(true);
  await page.click("[data-act=start]"); await answer(page, "a"); await next(page); await page.click("[data-act=quit]"); await page.click(".modal [data-a=yes]");
  assert.strictEqual((await state()).outbox.length, 1);
  await page.click("[data-nav=settings]"); await page.click("[data-act=reset]"); await page.click(".modal [data-a=yes]");
  let s = await state();
  assert.deepStrictEqual([s.xp, Object.keys(s.answers).length, s.outbox.length], [0, 0, 1], "progress cleared, the waiting answer kept");
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online"))); await page.waitForTimeout(1200);
  s = await state();
  assert.deepStrictEqual([s.xp, Object.keys(s.answers).length], [0, 0], "the old progress is not pulled back");
  assert.strictEqual(repo.responses.length, 2, "the waiting answer was uploaded");
});

test("small things: date stepping back, a refused upload, odd deck data, an all-research lesson", async (S) => {
  const tomorrow = dayStr(1);
  const a = await S.open({ state: { seenIntro: true, restored: true, xp: 50, streak: { count: 12, lastDay: tomorrow }, days: { [tomorrow]: 2 } } });
  assert.strictEqual(await text(a.page, ".pill.streak"), "🔥 12", "streak survives the date stepping back a day");
  await a.page.click("[data-act=start]"); await answer(a.page, "a");
  assert.strictEqual((await a.state()).streak.count, 12);
  await next(a.page);
  // a deck with also_in given as plain text must not break the card
  const repo = newRepo(); const d = fixtureDeck(); d.cards.forEach((c) => { c.also_in = "FAQ block"; }); repo.decks["2026-01-01"].deck = d; repo.status422 = true;
  const b = await S.open({ repo });
  await b.page.click("[data-act=start]");
  assert.match(await text(b.page, "#cardbody"), /Also in this post: FAQ block/);
  // every card to the research list: no "Lesson complete! 0 checked"
  for (let i = 0; i < 3; i++) { await answer(b.page, "later"); await next(b.page); }
  assert.strictEqual(await text(b.page, "h1.title"), "🔖 Research list");
  // an upload GitHub keeps refusing is retried a few times, not forever
  await b.page.click("[data-laterid]"); await answer(b.page, "a"); await next(b.page); await b.page.waitForTimeout(1200);
  const puts = repo.requests.filter((r) => r.startsWith("PUT /contents/responses")).length;
  assert.ok(puts >= 1 && puts <= 9, `refused upload retried a bounded number of times (${puts})`);
  assert.strictEqual((await b.state()).outbox.length, 1, "and the answer is still waiting on the phone");
});

test("daily quests track progress, pay out once, and are undone with the answer", async (S) => {
  const { page, state } = await S.open();
  let s = await state();
  assert.strictEqual(s.q.ids.length, 3); assert.strictEqual(s.q.ids[0], "goal");
  assert.strictEqual(await page.$$eval(".quest", (els) => els.length), 3);
  await page.click("[data-act=start]");
  await answer(page, "a"); await page.click("#sheet [data-act=undo]");
  s = await state();
  assert.deepStrictEqual([s.xp, s.q.prog.goal || 0], [0, 0], "undo takes quest progress back too");
  await answer(page, "a"); await next(page); await answer(page, "a"); await next(page);
  const before = (await state()).xp;
  await answer(page, "a");
  assert.match(await text(page, "#sheet"), /Quest complete: Decide 3 cards \+10/);
  s = await state();
  assert.ok(s.q.done.goal); assert.ok(s.xp >= before + 20, "card miles plus the quest's 10");
  assert.strictEqual(s.xpDays[Object.keys(s.xpDays)[0]], s.xp, "miles per day recorded for the recap");
  await next(page); await page.waitForTimeout(500); await page.click("[data-act=home]");
  assert.ok(await page.$(".quest.done"));
});

test("weekly recap appears once after a week with activity", async (S) => {
  const lastMon = new Date(); lastMon.setDate(lastMon.getDate() - ((lastMon.getDay() + 6) % 7) - 7);
  const k = (i) => { const d = new Date(lastMon); d.setDate(d.getDate() + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const { page, state } = await S.open({ state: { seenIntro: true, xp: 70, days: { [k(0)]: 3, [k(2)]: 2, [k(5)]: 1 }, xpDays: { [k(0)]: 40, [k(2)]: 30 }, streak: { count: 1, lastDay: k(5) } } });
  assert.strictEqual(await text(page, ".complete h1"), "Your week");
  assert.deepStrictEqual(await page.$$eval(".stat .v", (els) => els.map((e) => e.textContent)), ["6", "3/7", "+70"]);
  await page.click("[data-act=recap-done]");
  assert.ok(await page.$(".topbar"));
  await page.reload(); await page.waitForTimeout(500);
  assert.ok(!(await page.$("text=Your week")), "not shown twice");
});

test("reminder links, Pip's gear and the scoring guide", async (S) => {
  const { page, state } = await S.open({ state: { seenIntro: true, xp: 130 } });      // level 3
  assert.ok(await page.$(".hero svg.pip rect"), "Pip wears the backpack at level 3");
  await page.click("[data-nav=passport]");
  assert.match(await text(page, ".gear"), /a scarf, a backpack.*Next: a feather for the hat at level 5/);
  await page.click("details.how summary");
  assert.match(await text(page, "details.how"), /Streak 🔥: decide at least one card a day/);
  await page.click("[data-nav=settings]");
  await page.fill("#remind", "07:15");
  const g = new URL(await page.getAttribute("#remind-google", "href"));
  assert.strictEqual(g.hostname, "calendar.google.com");
  assert.match(g.searchParams.get("dates"), /^\d{8}T071500\/\d{8}T072500$/);
  assert.strictEqual(g.searchParams.get("recur"), "RRULE:FREQ=DAILY");
  const ics = decodeURIComponent((await page.getAttribute("#remind-ics", "href")).split(",")[1]);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.includes("RRULE:FREQ=DAILY") && ics.includes("BEGIN:VALARM") && /DTSTART:\d{8}T071500/.test(ics));
  assert.strictEqual((await state()).settings.remindTime, "07:15");
});

test("answers given offline wait on the phone and upload on reconnect", async (S) => {
  const { ctx, page, repo, state } = await S.open();
  await ctx.setOffline(true);
  await page.click("[data-act=start]");
  assert.ok(await page.$("text=You're offline"));
  await finishLesson(page, "a");
  assert.strictEqual(repo.responses.length, 0);
  assert.match(await text(page, ".sync-line"), /uploads when you're back online/);
  assert.strictEqual((await state()).outbox.length, 1);
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online"))); await page.waitForTimeout(1200);
  assert.strictEqual(repo.responses.length, 1);
  assert.strictEqual((await state()).outbox.length, 0);
});

test("once opened, the app starts with no connection at all", async (S) => {
  const { ctx, page, state } = await S.open();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(800);                                  // let the service worker finish saving the app's files
  await ctx.setOffline(true);
  await page.reload(); await page.waitForTimeout(800);
  assert.ok(await page.$("[data-act=start]"), "home screen loads from the saved copy");
  assert.ok(await page.$("text=Offline"));
  await page.click("[data-act=start]"); await answer(page, "a"); await next(page);
  assert.strictEqual(Object.keys((await state()).answers).length, 1);
});

test("home-screen shortcuts open a lesson or the research list", async (S) => {
  const a = await S.open({ state: { seenIntro: true }, key: "" });
  await a.page.evaluate((k) => { const s = JSON.parse(localStorage.getItem("blogquest.v1")); s.settings = { token: k }; localStorage.setItem("blogquest.v1", JSON.stringify(s)); }, GOOD_KEY);
  await a.page.reload(); await a.page.waitForTimeout(900);           // cards download on this load
  await a.page.goto(S.base + "#start"); await a.page.reload(); await a.page.waitForTimeout(600);
  assert.ok(await a.page.$("[data-act=check]"), "#start lands in a lesson");
  await a.page.goto(S.base + "#research"); await a.page.reload(); await a.page.waitForTimeout(600);
  assert.strictEqual(await text(a.page, "h1.title"), "🔖 Research list");
});

test("a key that stops working shows a clear warning, and recovers", async (S) => {
  const { page, repo, state } = await S.open();
  await page.click("[data-act=start]"); await answer(page, "a"); await next(page);
  repo.status = 401;
  await page.click("[data-act=quit]"); await page.click(".modal [data-a=yes]"); await page.waitForTimeout(900);
  assert.ok(await page.$(".alert"), "warning banner on the home screen");
  assert.match(await text(page, ".alert"), /access key has stopped working/);
  assert.strictEqual((await state()).outbox.length, 1, "her answer is kept");
  await page.click("[data-nav=settings]");
  assert.match(await text(page, ".card.small"), /Last problem: GitHub didn't accept the access key/);
  await page.click("[data-act=copy-help]"); await page.waitForTimeout(200);
  const help = await page.inputValue("#help-text");
  assert.match(help, /Blog Quest \d+\.\d+/); assert.match(help, /Last problem: auth/); assert.match(help, /Waiting to upload: 1 files/);
  assert.ok(!help.includes(GOOD_KEY), "the key is never in the help details");
  await page.click("[data-nav=home]");
  repo.status = 0;
  await syncNow(page); await page.click("[data-nav=home]");
  assert.ok(!(await page.$(".alert")));
  assert.strictEqual(repo.responses.length, 1);
});

test("a wrong key is refused at setup", async (S) => {
  const { page, state } = await S.open({ key: "" });
  assert.ok(await page.$("[data-act=paste-key]"), "welcome screen asks for the key");
  await page.click("details.extra summary"); await page.fill("#token", "github_pat_WRONG"); await page.click("[data-act=save-key]"); await page.waitForTimeout(700);
  assert.strictEqual((await state()).settings.token, "");
  await page.fill("#token", GOOD_KEY); await page.click("[data-act=save-key]"); await page.waitForTimeout(1200);
  assert.ok(await page.$("[data-act=start]"));
});

test("progress is backed up and restored on a new phone, without her name", async (S) => {
  const first = await S.open();
  await first.page.click("[data-nav=settings]"); await first.page.fill("#name", "Sam"); await first.page.click("[data-act=save-settings]"); await first.page.waitForTimeout(600);
  await first.page.click("[data-nav=home]"); await first.page.click("[data-act=start]");
  await answer(first.page, "later", { note: "look this up" }); await next(first.page);
  await finishLesson(first.page, "a");
  const s1 = await first.state();
  const backup = first.repo.files["progress/state.json"];
  assert.ok(backup, "progress/state.json written");
  const doc = JSON.parse(backup.text);
  assert.strictEqual(doc.xp, s1.xp); assert.strictEqual(doc.streak.count, 1);
  assert.ok(!backup.text.includes("Sam") && !backup.text.includes(GOOD_KEY), "no name or key in the backup");
  const second = await S.open({ repo: first.repo, device: "Pixel 7" });
  await second.page.waitForTimeout(600);
  const s2 = await second.state();
  assert.strictEqual(s2.xp, s1.xp, "miles restored");
  assert.strictEqual(s2.streak.count, 1);
  assert.deepStrictEqual(Object.keys(s2.answers).sort(), Object.keys(s1.answers).sort(), "answered cards are not asked again");
  assert.deepStrictEqual(s2.later, s1.later, "research list restored");
  assert.strictEqual(Object.values(s2.laterNotes)[0].note, "look this up");
});

test("cards removed from the repo disappear; a broken deck file is ignored", async (S) => {
  const { page, repo, state } = await S.open();
  const d = fixtureDeck(); d.cards = d.cards.slice(0, 2).concat([{ id: "c-bad-1" }, null, "nonsense"]);
  repo.decks["2026-01-01"] = { sha: "d9", deck: d };
  repo.decks["2026-01-02"] = { sha: "bad", deck: "{ this is not json" };
  await syncNow(page);
  const s = await state();
  assert.strictEqual(s.decks["2026-01-01"].cards.length, 2, "malformed cards dropped");
  assert.ok(!s.decks["2026-01-02"]);
  await page.click("[data-nav=home]");
  assert.strictEqual(await text(page, "[data-act=start]"), "Start lesson · 2 cards");
  delete repo.decks["2026-01-01"]; repo.decks["2026-01-03"] = { sha: "e", deck: { created: "2026-01-03", cards: [] } };
  await syncNow(page);
  assert.deepStrictEqual(Object.keys((await state()).decks), ["2026-01-03"]);
});

test("lessons open with a quick fix as a warm-up, then a fact check", async (S) => {
  const { page } = await S.open(); await skipRecap(page);
  await page.click("[data-act=start]");
  const kinds = await page.evaluate(() => window.__bq.lesson.cards.map((c) => ((c.sources || []).length ? "fact" : "quick")));
  assert.deepStrictEqual(kinds, ["quick", "fact", "quick"]);
});

test("a card with many sources folds the extras away until she asks for them", async (S) => {
  const repo = newRepo(); const d = fixtureDeck(); const src = d.cards[0].sources[0];
  const many = (c) => ({ ...c, sources: [1, 2, 3, 4].map((n) => ({ ...src, label: `Source ${n}` })) });
  d.cards = [many(d.cards[0]), many(d.cards[1])]; repo.decks["2026-01-01"].deck = d;
  const { page } = await S.open({ repo }); await skipRecap(page);
  await page.click("[data-act=start]");
  assert.strictEqual(await page.locator(".source").count(), 1, "only the first source shows at first");
  assert.strictEqual(await text(page, "[data-act=more-sources]"), "Show 3 more sources");
  await page.click(".opt >> nth=0"); await page.click("details.extra summary"); await page.fill("#note", "keep me");
  await page.click("[data-act=more-sources]");
  assert.strictEqual(await page.locator(".source").count(), 4);
  assert.ok(!(await page.$("[data-act=more-sources]")), "the button goes away once they are all showing");
  assert.strictEqual(await page.inputValue("#note"), "keep me", "a note she was typing survives");
  assert.strictEqual(await page.locator(".opt.sel").count(), 1, "her choice survives");
  await page.click("[data-act=check]"); await page.waitForSelector("#sheet.show"); await next(page);
  assert.strictEqual(await page.locator(".source").count(), 1, "the next card starts folded again");
});

test("background syncs are throttled", async (S) => {
  const { page, repo } = await S.open();
  await page.waitForTimeout(400);
  const before = repo.requests.length;
  for (let i = 0; i < 5; i++) await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(500);
  assert.strictEqual(repo.requests.length, before, "no extra requests within a minute when nothing is waiting");
});

test("every screen fits a small phone, light and dark, with no script or policy errors", async (S) => {
  for (const dark of [false, true]) {
    const { page } = await S.open({ dark, viewport: { width: 320, height: 568 } });
    const fits = async (where) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `sideways scroll on ${where}`);
    await fits("home");
    await page.click("[data-act=start]"); await fits("card");
    await answer(page, "later", { note: "a note" }); await fits("research sheet"); await next(page);
    await answer(page, "a"); await fits("answer sheet"); await next(page);
    await answer(page, "fine"); await next(page); await page.waitForTimeout(400); await fits("lesson complete");
    await page.click("[data-act=home]");
    for (const tab of ["later", "passport", "settings"]) { await page.click(`[data-nav=${tab}]`); await fits(tab); }
    await page.click("[data-act=show-intro]"); await fits("walkthrough");
  }
});

test("reviewer mode shows her answers and research list, and never writes", async (S) => {
  const repo = newRepo();
  const cards = fixtureDeck().cards, ans = (i, extra) => ({ card_id: cards[i].id, post: cards[i].post, claim_quote: cards[i].claim.quote, note: "", fine_reason: "", ...extra });
  repo.responses.push({ path: "responses/2026-01-02/a.json", body: { answers: [
    ans(0, { decision: "apply_option", option: cards[0].options[0], answered_at: "2026-01-02T10:00:00Z", checked_source: true }),
    ans(2, { decision: "apply_option", option: cards[2].options[0], answered_at: "2026-01-02T10:01:00Z" }),
    ans(4, { decision: "post_is_fine", fine_reason: "first_hand", answered_at: "2026-01-02T10:02:00Z" }) ] } });
  repo.responses.push({ path: "responses/2026-01-03/b.json", body: { answers: [
    ans(0, { decision: "other", note: "Say it opens at ten", answered_at: "2026-01-03T09:00:00Z" }) ] } });        // she changed her mind
  repo.fixlog = { [cards[4].id]: { status: "no_change", date: "2026-01-03", summary: "She says the post is right." } };
  repo.files["research/open.md"] = { sha: "r1", text: `# Research list\n\n## 1. x\n\n- **Her note:** ring them\n- **Marked:** 2026-01-02 · Card: \`${cards[6].id}\`\n` };
  const { page } = await S.open({ repo, hash: "&reviewer=1" });
  await page.waitForTimeout(600);
  assert.ok(!(await page.$(".intro")), "the reviewer link skips the walkthrough");
  assert.strictEqual(await text(page, "h1.title"), "Her answers");
  assert.deepStrictEqual(await page.$$eval(".kpi .v", (els) => els.map((e) => e.textContent)), ["2", "1", "4", "0"]);
  const body = await text(page, "#app");
  assert.match(body, /Her own wording ?“Say it opens at ten”/, "her latest answer wins");
  assert.ok(!body.includes("Update to 10 AM"), "the answer she replaced is not shown");
  assert.match(body, /visit ?teh ?the ?museum/, "typo fix shown as a before/after");
  assert.match(body, /ring them/);
  assert.match(body, /Recently handled.*no change/);
  assert.strictEqual(await page.$$eval("nav.tabs button", (els) => els.length), 2);
  await page.click("[data-act=copy-review]"); await page.waitForTimeout(200);
  assert.match(await page.inputValue("#review-text"), /2 answers to apply, 1 on her research list, 4 cards still waiting/);
  await page.click("[data-act=sync]"); await page.waitForTimeout(600);
  assert.ok(!repo.requests.some((r) => r.startsWith("PUT")), "reviewer mode made no writes");
  assert.strictEqual(repo.requests.filter((r) => r.includes("responses/2026-01-02/a.json")).length, 1, "response files are downloaded once");
});

test("accessibility: every screen passes the automated WCAG AA checks, light and dark", async (S) => {
  const axe = require("fs").readFileSync(require("path").join(__dirname, "vendor", "axe.min.js"), "utf8");
  const problems = [];
  const check = async (page, where) => {
    await page.waitForTimeout(350);                      // let panels finish sliding in before measuring colours
    await page.evaluate(axe);
    const res = await page.evaluate(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } }));
    res.violations.forEach((v) => v.nodes.forEach((n) => problems.push(`${where}: ${v.id} at ${n.target.join(" ")}`)));
  };
  for (const dark of [false, true]) {
    const tag = dark ? "dark" : "light";
    const intro = await S.open({ dark, intro: true }); await check(intro.page, `${tag} walkthrough`);
    const nokey = await S.open({ dark, key: "" }); await check(nokey.page, `${tag} welcome`);
    const { page, repo } = await S.open({ dark });
    await check(page, `${tag} home`);
    await page.click("[data-act=start]"); await check(page, `${tag} fact card`);
    await page.click("[data-opt=fine]"); await check(page, `${tag} reasons`);
    await answer(page, "later", { note: "x" }); await check(page, `${tag} research panel`); await next(page);
    await check(page, `${tag} quick-fix card`);
    await answer(page, "a"); await check(page, `${tag} answer panel`); await next(page);
    await answer(page, "a"); await next(page); await page.waitForTimeout(400); await check(page, `${tag} lesson complete`);
    await page.click("[data-act=home]");
    await page.click("[data-nav=later]"); await check(page, `${tag} research list`);
    await page.click("[data-nav=passport]"); await page.click("details.how summary"); await check(page, `${tag} passport`);
    await page.click("[data-redo]"); await check(page, `${tag} confirmation`); await page.click(".modal [data-a=no]");
    await page.click("[data-nav=settings]"); await page.click("details.conn summary"); await check(page, `${tag} settings`);
    repo.status = 401; await page.click("[data-act=sync]"); await page.waitForTimeout(600); await page.click("[data-nav=home]"); await check(page, `${tag} warning banner`);
    const rv = await S.open({ dark, repo: (() => { const r = newRepo(); const c = fixtureDeck().cards[2]; r.responses.push({ path: "responses/2026-01-02/a.json", body: { answers: [{ card_id: c.id, post: c.post, claim_quote: c.claim.quote, decision: "apply_option", option: c.options[0], answered_at: "2026-01-02T10:00:00Z" }] } }); return r; })(), hash: "&reviewer=1" });
    await check(rv.page, `${tag} reviewer`);
  }
  assert.deepStrictEqual(problems, []);
});

(async () => {
  const filter = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== "off" && a !== "on")[0];   // flags such as --trace off are not a name filter
  if (filter && !tests.some((x) => x.name.includes(filter))) { console.error(`No test name contains "${filter}".`); process.exit(2); }
  const server = await serve();
  const browser = await chromium.launch();
  let failed = 0;
  // Browser tests can trip on timing now and then. A failed test gets one more try; if it then passes it is
  // reported as flaky, so a real problem (fails twice) is never hidden and a shaky test is still visible.
  let flaky = 0;
  const chosen = tests.filter((x) => !filter || x.name.includes(filter));
  for (const t of chosen) {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const S = new Session(browser, server.url);
      const started = Date.now();
      try {
        await t.fn(S);
        assert.deepStrictEqual(S.errors, [], "errors in the page");
        console.log(`ok    ${t.name} (${((Date.now() - started) / 1000).toFixed(1)}s)${attempt > 1 ? "  [flaky: passed on the second try]" : ""}`);
        if (attempt > 1) { flaky++; console.log(`      first try failed with: ${String(lastError.message).split("\n").slice(0, 4).join(" | ")}`); }
        lastError = null;
      } catch (e) { lastError = e; }
      for (const c of browser.contexts()) await c.close();
      if (!lastError) break;
    }
    if (lastError) {
      failed++;
      console.log(`FAIL  ${t.name}\n      ${String(lastError.message).split("\n").slice(0, 8).join("\n      ")}`);
    }
  }
  await browser.close(); server.close();
  console.log(failed ? `\n${failed} failed` : `\nall ${chosen.length} passed${chosen.length < tests.length ? ` (of ${tests.length}; name filter "${filter}")` : ""}${flaky ? ` (${flaky} needed a second try)` : ""}`);
  process.exit(failed ? 1 : 0);
})();
