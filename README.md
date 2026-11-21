# Blog Quest

A gamified, offline-first phone app for fact-checking a travel blog. Each lesson is a handful of "possible error" cards. Every card shows what the post says, what sources say, and suggested fixes. Pick one, and the answer gets uploaded so it can be applied to the blog.

- Streaks, miles (XP), a daily goal, badges and passport stamps. Your guide is Pip, a little globe explorer.
- Works offline once it's on your home screen. Answers queue on the phone and upload when you're back online.
- Cards and answers live in a **private** GitHub repo. This public repo contains only the app code.

## Setup

1. **Create an access key.** On GitHub, go to Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: *Only select repositories* → the private data repo.
   - Permissions: **Contents → Read and write**. Nothing else.
   - Expiration: whatever you're comfortable with (1 year is fine).
2. **Open the app** on the phone, go to ⚙️ Settings, paste the key, and tap *Save & sync*.
   Or skip the typing: open `https://<pages-url>/#token=<key>` once on the phone. The key is saved on the phone and removed from the address bar. Only send this link privately, because anyone with it can read and write the data repo.
3. **Add it to the home screen.** iPhone: Share → *Add to Home Screen*. Android: ⋮ → *Install app*.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The app (no build step, no dependencies) |
| `mascot.js` | Pip, drawn as inline SVG |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installability |
