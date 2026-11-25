// Test harness: a tiny static server for the app, a pretend GitHub, and helpers.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium, devices } = require("playwright");

const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const REPO = "/repos/Wareontheglobe/blog-fixes";
const GOOD_KEY = "github_pat_TESTKEY";

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
      const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(file));
    }).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

const fixtureDeck = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-deck.json"), "utf8"));

// A stand-in for the private repo. Tests read and change `repo` directly.
function newRepo() {
  return { decks: { "2026-01-01": { sha: "d1", deck: fixtureDeck() } }, files: {}, responses: [], fixlog: null, requests: [], status: 0, n: 0 };
}

async function mockGitHub(ctx, repo) {
  await ctx.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname.replace(REPO, "");
    repo.requests.push(`${req.method()} ${p}`);
    if (repo.status) return route.fulfill({ status: repo.status, json: {} });
    if (req.headers()["authorization"] !== `Bearer ${GOOD_KEY}`) return route.fulfill({ status: 401, json: {} });
    const raw = (req.headers()["accept"] || "").includes("raw");
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData());
      const text = Buffer.from(body.content, "base64").toString("utf8");
      const file = p.replace("/contents/", "");
      if (file.startsWith("responses/")) { repo.responses.push({ path: file, body: JSON.parse(text), message: body.message }); return route.fulfill({ status: 201, json: { content: { sha: "x" } } }); }
      const cur = repo.files[file];
      if (cur && body.sha !== cur.sha) return route.fulfill({ status: 409, json: {} });
      if (!cur && body.sha) return route.fulfill({ status: 422, json: {} });
      repo.files[file] = { text, sha: "s" + ++repo.n, message: body.message };
      return route.fulfill({ status: cur ? 200 : 201, json: { content: { sha: repo.files[file].sha } } });
    }
    if (p === "") return route.fulfill({ json: { full_name: "x" } });
    if (p === "/contents/decks") return route.fulfill({ json: Object.keys(repo.decks).map((k) => ({ type: "file", name: `${k}.json`, path: `decks/${k}.json`, sha: repo.decks[k].sha })) });
    const m = p.match(/^\/contents\/decks\/(.+)\.json$/);
    if (m && repo.decks[m[1]]) return route.fulfill({ body: typeof repo.decks[m[1]].deck === "string" ? repo.decks[m[1]].deck : JSON.stringify(repo.decks[m[1]].deck), contentType: "application/json" });
    if (p === "/contents/fixes/applied.json") return repo.fixlog ? route.fulfill({ json: repo.fixlog }) : route.fulfill({ status: 404, json: {} });
    if (p === "/contents/responses") {
      const days = [...new Set(repo.responses.map((r) => r.path.split("/")[1]))];
      return days.length ? route.fulfill({ json: days.map((d) => ({ type: "dir", path: `responses/${d}` })) }) : route.fulfill({ status: 404, json: {} });
    }
    if (p.startsWith("/contents/responses/")) {
      const rest = p.replace("/contents/", "");
      const hit = repo.responses.find((r) => r.path === rest);
      if (hit) return route.fulfill({ json: hit.body });
      return route.fulfill({ json: repo.responses.filter((r) => r.path.startsWith(rest + "/")).map((r) => ({ name: r.path.split("/").pop(), path: r.path })) });
    }
    const file = p.replace("/contents/", "");
    if (repo.files[file]) return raw ? route.fulfill({ body: repo.files[file].text, contentType: "text/plain" }) : route.fulfill({ json: { sha: repo.files[file].sha } });
    return route.fulfill({ status: 404, json: {} });
  });
}

class Session {
  constructor(browser, base) { this.browser = browser; this.base = base; this.errors = []; }
  // Opens the app on a pretend phone. Options: device, dark, repo, key, intro (keep the walkthrough), state (saved state to start from).
  async open({ device = "iPhone 13", dark = false, repo = newRepo(), key = GOOD_KEY, intro = false, state = null, viewport = null } = {}) {
    const ctx = await this.browser.newContext({ ...devices[device], ...(viewport ? { viewport } : {}), colorScheme: dark ? "dark" : "light", permissions: [] });
    await mockGitHub(ctx, repo);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => this.errors.push(`page error: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) this.errors.push(`CSP: ${m.text()}`); });
    ctx.on("page", (p) => { if (p !== page) p.close().catch(() => {}); });      // source links open new tabs; close them
    if (state) await page.addInitScript((s) => { if (!localStorage.getItem("blogquest.v1")) localStorage.setItem("blogquest.v1", JSON.stringify(s)); }, state);
    await page.goto(this.base + (key ? `#token=${key}` : ""));
    await page.waitForTimeout(700);
    if (!intro && await page.$(".intro .skip")) { await page.click(".intro .skip"); await page.waitForTimeout(150); }
    return { ctx, page, repo, state: () => page.evaluate(() => JSON.parse(JSON.stringify(window.__bq.state))) };
  }
}

// Answer the card on screen. choice: "a" (first suggested fix), "fine", "other", or "later".
async function answer(page, choice = "a", { note = "", reason = "" } = {}) {
  if (choice === "later") { await page.click("[data-act=later]"); if (note) await page.fill("#rnote", note); }
  else {
    await page.click(choice === "fine" ? "[data-opt=fine]" : choice === "other" ? "[data-opt=other]" : `[data-opt="opt:${choice}"]`);
    if (reason) await page.click(`[data-reason=${reason}]`);
    if (note) await page.fill("#note", note);
    await page.click("[data-act=check]");
  }
  await page.waitForSelector("#sheet.show");
}
const next = async (page) => { await page.click("#sheet [data-act=next]"); await page.waitForTimeout(80); };

module.exports = { serve, newRepo, fixtureDeck, Session, answer, next, chromium, GOOD_KEY };
