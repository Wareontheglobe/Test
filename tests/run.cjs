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
  await page.click(".source a"); await page.waitForTimeout(200);              // open a source before deciding
  await answer(page, "a");
  assert.match(await text(page, "#sheet .xp"), /source checked/);
  await next(page);
  assert.ok(!(await page.$("text=Your first card.")), "hint goes away after the first answer");
  await answer(page, "other", { note: "Reword this please" }); await next(page);
  await answer(page, "fine", { reason: "first_hand" }); await next(page);
  await page.waitForTimeout(900);
  assert.strictEqual(await text(page, ".complete h1"), "Lesson complete!");
  assert.strictEqual(repo.responses.length, 1);
  const up = repo.responses[0];
  assert.match(up.path, /^responses\/\d{4}-\d\d-\d\d\/.+\.json$/);
  const [a1, a2, a3] = up.body.answers;
  assert.strictEqual(a1.card_id, first);
  assert.strictEqual(a1.decision, "apply_option");
  assert.ok(a1.option.new_text && a1.claim_quote && a1.post.id && a1.checked_source === true);
  assert.deepStrictEqual([a2.decision, a2.note], ["other", "Reword this please"]);
  assert.deepStrictEqual([a3.decision, a3.fine_reason], ["post_is_fine", "first_hand"]);
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

test("streak freezes when there is nothing left and picks up when cards arrive", async (S) => {
  const { page, repo, state } = await S.open();
  await playAll(page);
  let s = await state();
  assert.ok(s.frozen, "frozen once everything is answered");
  // Five days go by with nothing to do.
  await page.evaluate((old) => { const k = "blogquest.v1", s = JSON.parse(localStorage.getItem(k)); const t = Object.keys(s.days)[0]; s.days = { [old]: s.days[t] }; s.streak.lastDay = old; s.frozen = old; localStorage.setItem(k, JSON.stringify(s)); }, dayStr(-5));
  await page.reload(); await page.waitForTimeout(700);
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
  await page.reload(); await page.waitForTimeout(600);
  assert.strictEqual(await text(page, ".pill.streak"), "🔥 0");
  await page.click("[data-act=start]"); await answer(page, "a");
  assert.strictEqual((await state()).streak.count, 1);
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

test("a key that stops working shows a clear warning, and recovers", async (S) => {
  const { page, repo, state } = await S.open();
  await page.click("[data-act=start]"); await answer(page, "a"); await next(page);
  repo.status = 401;
  await page.click("[data-act=quit]"); await page.click(".modal [data-a=yes]"); await page.waitForTimeout(900);
  assert.ok(await page.$(".alert"), "warning banner on the home screen");
  assert.match(await text(page, ".alert"), /access key has stopped working/);
  assert.strictEqual((await state()).outbox.length, 1, "her answer is kept");
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

(async () => {
  const filter = process.argv[2];
  const server = await serve();
  const browser = await chromium.launch();
  let failed = 0;
  for (const t of tests.filter((x) => !filter || x.name.includes(filter))) {
    const S = new Session(browser, server.url);
    const started = Date.now();
    try {
      await t.fn(S);
      assert.deepStrictEqual(S.errors, [], "errors in the page");
      console.log(`ok    ${t.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${t.name}\n      ${String(e.message).split("\n").slice(0, 6).join("\n      ")}`);
    }
    for (const c of browser.contexts()) await c.close();
  }
  await browser.close(); server.close();
  console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
