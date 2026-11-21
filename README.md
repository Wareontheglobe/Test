# Pathwarden

An original tower defense game for phones. It is one HTML file with no outside dependencies, so it runs with no internet connection.

## Play it offline on your phone

**Best: install it as an app (works fully offline afterwards)**
1. Host this folder on any static web host (for example GitHub Pages: repository Settings → Pages → deploy from this branch).
2. Open the page once on your phone.
3. Add it to your home screen:
   - iPhone (Safari): Share → *Add to Home Screen*
   - Android (Chrome): menu ⋮ → *Install app* / *Add to Home screen*
4. Launch it from the home screen icon. The service worker has cached everything, so airplane mode is fine.

**Quick: just the file**
`index.html` is self-contained. Copy it to an Android phone and open it in Chrome or Firefox and it plays without a connection.
(iPhone's Files app previews HTML without running scripts, so on iPhone use the install route above.)

## How to play
- Tap a grass tile, pick a tower, then tap it again to build. Or pick the tower first, then tap a grass tile twice. It stays picked, so the next one takes two taps.
- Tap a tower to upgrade it (up to level 3), sell it (tap twice), or change who it targets. Selling gives a full refund until the next wave starts, then 70%.
- **Start wave** sends the next wave. Once a wave has fully arrived you can call the next one early for bonus gold.
- Survive 30 waves to win, then keep going in endless mode.
- Each road keeps its own saved run, saved after every cleared wave. Tap a road to pick up its run. To start a road over, use Pause > Restart road (tap twice).

| Tower | Cost | Notes |
|---|---|---|
| Bolt | 50 | Fast, cheap, hits fliers |
| Mortar | 90 | Splash damage, **cannot hit fliers** |
| Frost | 70 | Slows groups, small damage |
| Arc | 130 | Lightning chains between enemies |
| Longshot | 120 | Very long range, ignores armor |

Enemies: Grunts, fast Scouts, armored Brutes, flying Wisps, Splitters (burst into two Scouts), and a Warlord boss every 10 waves.

Roads: Long Switchback (easy), Meadow Bend (normal), Quarry Run (hard).

## Files
- `index.html`: the whole game
- `manifest.webmanifest`, `sw.js`, `icons/`: home-screen install and offline caching
