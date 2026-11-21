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

From wave 5 most waves have a theme, shown as a tag in front of the next wave's enemies: **Swarm** (Scouts and Splitters), **Armored** (Brutes, from wave 14) and **Air raid** (mostly Wisps, which Mortars can't hit). Mixed waves have no tag.

## Balance
Values in 1.1: `CFG.hpB` 0.025 (was 0.032), `CFG.themeBudget` 0.85 (a themed wave has 85% of the Mixed wave's HP), Quarry Run `hp` 1.035 (was 1.05). Tower stats are unchanged.

`node tests/balance.js` checks them. A greedy bot plays every road (140 runs, under a minute on 4 cores) and the script prints PASS or FAIL per target. It is not part of `tests/run.js`. Results for 1.1:

| Profile | Easy | Normal | Hard | Target |
|---|---|---|---|---|
| smart (20 seeds) | 20/20 wins | 20/20 wins | 10/20 wins | Easy 19+, Normal 17+, Hard 8-12: met |
| early (smart, calls waves early) | 20/20 | 20/20 | 10/20 | median cleared wave on Normal within 2 of smart (30 and 30): met |
| mlf (Mortar, Longshot, Frost only, 5 seeds) | | dies on wave 11 | | loses lives on an Air raid: met (12 on wave 7, 8 on wave 11) |
| spam (Bolts only, 5 seeds) | wins | wins | dies on wave 30 | dies on waves 15-23 on every road: **not met** |
| plain (smart without reading the coming waves) | 20/20 | 11/20 | 2/20 | none (for comparison) |

How the bot plays:
- It is the design team's progression bot. It spends each wave's gold on the best value it can afford: a new tower where it covers the most road, or an upgrade.
- The smart profile also reads the next 4 waves, as a player reads the chips and their theme tag. It scales each tower by how much of those waves it can hurt: a Mortar can't hit fliers, and armor cuts small hits.
- It puts its Longshots on Toughest for a Warlord wave and back on First after it.
- Without reading ahead (plain), the same bot wins Normal 11/20, mostly because it loses Air raids. This is the decision the themes are meant to create.

Why hpB went down rather than up:
- Themed waves are much harder than Mixed ones for a Mortar-led build. Before the retune, at hpB 0.032, the smart bot won Normal 2/10 and Hard 0/10, and most of the lives it lost went on Air raids.
- `themeBudget` can't go much lower. Below about 0.82, wave 7 is more than 5% off 85% of the Mixed wave's HP, which the tests hold it to. Even 0.80 with hpB 0.028 left Normal at 9/10. So hpB and Quarry's hp did the work.

Known gap: Bolt spam. A Bolts-only build also won Easy and Normal before themed waves and this retune. To make it fall before wave 24 on Easy, hpB has to be about 0.05, and there the smart bot wins Easy 2/10. Fixing it needs a change to the Bolt or to armor, which this pass did not touch.

## Files
- `index.html`: the whole game
- `manifest.webmanifest`, `sw.js`, `icons/`: home-screen install and offline caching
