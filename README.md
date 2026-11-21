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
- **Start wave** sends the next wave. Once a wave has fully arrived you can call the next one early for bonus gold. Wave 30 is the exception: the run is won when it is over, so wave 31 can't be called during it.
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
Values in 1.1: `CFG.hpB` 0.021 (was 0.032), `CFG.themeBudget` 0.85 (a themed wave has 85% of the Mixed wave's HP), Quarry Run `hp` 1.05 (as in 1.0). Tower stats are unchanged. Stars: 3 for finishing with 16 or more lives, 2 for 10 or more, else 1.

`node tests/balance.js` checks them. A greedy bot plays every road (140 runs, about a minute on 4 cores) and the script prints PASS or FAIL per target. It is not part of `tests/run.js`. Results for 1.1:

| Profile | Easy | Normal | Hard | Target |
|---|---|---|---|---|
| smart (20 seeds) | 20/20 wins | 19/20 wins | 9/20 wins | Easy 19+, Normal 17+, Hard 8-12: met |
| early (smart, calls waves early) | 20/20 | 20/20 | 12/20 | median cleared wave on Normal within 2 of smart, played on until both fall: **not met** (59 against 49) |
| mlf (Mortar, Longshot, Frost only, 5 seeds) | | dies on wave 11 | | loses lives on an Air raid: met (12 on wave 7, 8 on wave 11) |
| spam (Bolts only, 5 seeds) | wins | wins | wins | dies on waves 15-23 on every road: **not met** |
| reader (smart reading the next 4 waves) | 20/20 | 20/20 | 18/20 | none (for comparison) |

Lives when wave 30 is cleared (smart): Easy 16-20, Normal 3-20 (median 10), Hard 1-14 (median 4). So the smart Normal winners split 7, 5 and 7 across 3, 2 and 1 stars, and no Hard winner earns 3.

How the bot plays:
- smart is the plan's profile, the design team's progression bot. It spends each wave's gold on the best value it can afford: a new tower where it covers the most road, or an upgrade. It does not read the coming waves, so it plays like someone who ignores the preview. It puts its Longshots on Toughest for a Warlord wave and back on First after it.
- reader is the same bot reading the next 4 waves, as a player reads the chips and their theme tag. It scales each tower by how much of those waves it can hurt: a Mortar can't hit fliers, and armor cuts small hits. It wins Hard 18/20 where smart wins 9/20. Most of the lives smart loses on Hard go on the Air raids of waves 7, 11 and 15, which the preview warns about.
- smart and early play Normal on past wave 30 until they fall (up to wave 100), so the early target compares how far each gets. Capped at 30, both win every Normal run, and the target would compare 30 with 30.

Why hpB went down rather than up:
- Themed waves are much harder than Mixed ones for a build that ignores them. At hpB 0.025 the smart bot won Normal 11/20 and Hard 2/20. With Quarry at 1.035, hpB 0.023 gave 15/20 and 4/20, 0.022 gave 18/20 and 7/20, and 0.021 gave 19/20 and 12/20.
- Then Quarry's `hp`: at hpB 0.021, 1.04 and 1.045 gave Hard 11/20, and 1.05 gives 9/20.
- `themeBudget` can't go much lower. Below about 0.82, wave 7 is more than 5% off 85% of the Mixed wave's HP, which the tests hold it to.

Known gaps:
- Bolt spam. A Bolts-only build wins every road (Hard with 1 life left). It also won Easy and Normal before themed waves and this retune. To make it fall before wave 24 on Easy, hpB has to be about 0.05, and there even the reader bot wins Easy only 2/10. Fixing it needs a change to the Bolt or to armor, which this pass did not touch.
- Early calls. On Normal the early bot clears wave 50 in 13 of 20 runs, against 9 of 20 for smart, and has more lives at wave 30 (median 16 against 10). Most of that is not the bonus. With `--earlyMul=0` it still clears wave 50 in 10 of 20 runs, with median lives 15; at 1 and 2 it is 11 of 20. When it calls early it also spends its gold mid-wave, which smart never does. The runs fall at the Warlord waves (40, 50, 60), so the median moves 10 waves when one run does. `CFG.earlyMul` (3, the most the early-call item allows) can't meet this target, and what it should measure is still to be decided.

## Files
- `index.html`: the whole game
- `manifest.webmanifest`, `sw.js`, `icons/`: home-screen install and offline caching
