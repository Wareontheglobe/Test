# Blog Quest

A gamified, offline-first phone app for fact-checking a travel blog. Each lesson is a handful of "possible error" cards. Every card shows what the post says, what sources say, and suggested fixes. Pick one, and the answer gets uploaded so it can be applied to the blog.

- Streaks, miles (XP), a daily goal, badges and passport stamps. Your guide is Pip, a little globe explorer.
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

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The app (no build step, no dependencies) |
| `mascot.js` | Pip, drawn as inline SVG |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installability |
