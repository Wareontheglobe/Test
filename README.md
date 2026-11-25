# Blog Quest

A gamified, offline-first phone app for fact-checking a travel blog. Each lesson is a handful of "possible error" cards. Every card shows what the post says, what sources say, and suggested fixes. Pick one, and the answer gets uploaded so it can be applied to the blog.

- Three-card lessons, a daily goal, a streak with a week view, miles and levels, badges and passport stamps. Your guide is Pip, a little globe explorer.
- The streak freezes when there's nothing left to check, so running out of cards never breaks it.
- A research list for cards that need digging first. It's saved to the private repo and can be emailed, shared or copied from the app.
- Daily quests, a weekly recap, and gear for Pip that unlocks with each level.
- A daily reminder she can add to her calendar in one tap (the app itself can't send notifications).
- Lessons open with a quick fix as a warm-up, then one fact check, and typo cards show the change highlighted in place.
- Long cards stay short on a phone: with three or more sources, the first shows and the rest fold away behind one tap, and the bottom button jumps straight to the choices.
- Answers can be changed until they've been applied to the blog.
- Miles, streak and badges are backed up to the private repo, so a new phone picks up where the old one stopped.
- If the access key stops working, the home screen says so plainly instead of failing quietly.
- Works offline once it's on your home screen. Answers queue on the phone and upload when you're back online.
- Cards and answers live in a **private** GitHub repo. This public repo contains only the app code.

## Live app

https://wareontheglobe.github.io/Test/ is served by GitHub Pages from the **`gh-pages`** branch. After changing the app, push the same commit to `gh-pages` as well, or the phone won't get it.

## Setup

1. **Create an access key.** On GitHub, go to Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: *Only select repositories* → the private data repo.
   - Permissions: **Contents → Read and write**. Nothing else.
   - Expiration: whatever you're comfortable with (1 year is fine).
2. **Add it to the home screen first.** iPhone: Share → *Add to Home Screen*. Android: ⋮ → *Install app*.
3. **Open it from the home screen,** copy the key, and tap **📋 Paste key** on the welcome screen. The app checks the key before saving it.
   On iPhone, the home-screen app keeps its own storage separate from Safari, so connect *inside* the installed app.
   On Android, you can also open `https://wareontheglobe.github.io/Test/#token=<key>` once. The key is saved and removed from the address bar. Only send that link privately.

## Reviewer mode

For the person who applies the fixes. The same app shows her answers, her research list and what has been applied, instead of the game. It only reads; it never writes to the data repo.

Open `https://wareontheglobe.github.io/Test/#token=<key>&reviewer=1` once on your own phone, or switch it on under Settings → Connection. A second fine-grained token with **Contents: Read-only** on the data repo is enough for this.

## Tests

```
node tests/run.cjs            # all end-to-end tests
node tests/run.cjs streak     # only tests whose name contains "streak"
```

`./publish.sh` runs the tests and, if they pass, pushes the current branch and updates `gh-pages`. It then waits for GitHub Pages to finish, retries GitHub's deploy step once if it fails, and says whether the new version is live.

The tests drive the real app in headless Chromium against a pretend GitHub (`tests/harness.cjs`) and a made-up deck (`tests/fixture-deck.json`). Nothing leaves the machine. They need Playwright with Chromium installed. Run them before pushing a change to `gh-pages`.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The app (no build step, no dependencies) |
| `mascot.js` | Pip, drawn as inline SVG |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installability |
| `publish.sh` | Test, then publish to GitHub Pages |
| `tests/` | End-to-end tests. `tests/vendor/axe.min.js` is the axe-core accessibility checker (MPL-2.0), used only by the tests |
