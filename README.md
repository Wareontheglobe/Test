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
| Bolt | 50 | Fast, cheap, hits fliers, weak against armor |
| Mortar | 90 | Splash damage, **cannot hit fliers** |
| Frost | 70 | Slows groups, small damage |
| Arc | 130 | Lightning chains between enemies |
| Longshot | 120 | Very long range, ignores armor: the answer to Brutes and Warlords |

Enemies: Grunts, fast Scouts, armored Brutes, flying Wisps, Splitters (burst into two Scouts), and a Warlord boss every 10 waves.

Roads: Long Switchback (easy), Meadow Bend (normal), Quarry Run (hard).

From wave 5 most waves have a theme, shown as a tag in front of the next wave's enemies: **Swarm** (Scouts and Splitters), **Armored** (Brutes, from wave 14) and **Air raid** (mostly Wisps, which Mortars can't hit). Mixed waves have no tag.

## Balance
Values in 1.1: `CFG.hpB` 0.021 (was 0.032), `CFG.themeBudget` 0.85 (a themed wave has 85% of the Mixed wave's HP), Quarry Run `hp` 1.06 (1.05 in 1.0), and armor: Brute 8 (was 3), Warlord 12 (was 6). Armor still grows 3% a wave (`CFG.armorGrow` 0.03) and a hit still keeps at least a quarter of its damage (`CFG.armorFloor` 0.25). `CFG.earlyMul` stays 3, so calling wave w early pays 3 × (10 + w) gold. Tower stats and prices are unchanged. Stars: 3 for finishing with 16 or more lives, 2 for 10 or more, else 1.

### What each tower is for
Armor is what gives the towers their jobs. Every hit but a Longshot's loses the target's armor, so many small hits suffer most:

| Tower | Its job | Against a wave-18 Brute (armor 12.1), a hit keeps |
|---|---|---|
| Bolt | Cheap and fast: fliers and light units. Poor against armor | 25% at level 1, 31% at 2, 56% at 3 |
| Mortar | Splash for ground crowds (Swarms) | 60%, 75%, 84% |
| Frost | Slows a group, so the others get more shots | 25% (it is there to slow) |
| Arc | Chains through groups, hits fliers | 43%, 64%, 77% (first jump) |
| Longshot | Range, ignores armor: Brutes and Warlords | 100% |

A Warlord on wave 20 has armor 18.8, so a level-3 Bolt keeps 31% of its hit and a level-3 Mortar 75%. The chip detail shows a type's armor for the coming wave ('Armor 9' for the wave-6 Brute, 'Armor 19' for the wave-20 Warlords).

### The bot
`node tests/balance.js` checks the values. A greedy bot plays every road (200 runs, about 70 seconds on 4 cores) and the script prints PASS or FAIL per target. It is not part of `tests/run.js`. Overrides such as `--bruteArmor=7 --bossArmor=10 --hard=1.07 --earlyMul=2` (the full list is in its header) let a later tuner sweep the knobs, and `--profiles`, `--roads`, `--seeds` and `--seedFrom` make a sweep quick.

How it plays:
- Every profile spends the same way: before each wave and once every second of game time while a wave runs, as people play. Each time it buys the best value it can afford, again and again: a new tower where it covers the most road, or an upgrade.
- The bot's Longshots are on Toughest while a Warlord wave is on the road and on First otherwise. That is the only targeting change it makes.
- smart is the plan's profile, the design team's progression bot. It does not read the coming waves, so it plays like someone who ignores the preview.
- early is smart that also calls the next wave early whenever it is safe (lives 15 or more and the front of the road clear), checked once a second right after it spends. That call is the only difference between the two.
- reader is smart reading the next 4 waves, as a player reads the chips and their theme tag: it scales each tower by how much of those waves it can hurt. It has no target; it shows what the preview is worth.
- spam builds only Bolts and mlf only Mortars, Longshots and Frost. spam has smart's noise, so its 5 seeds are 5 different runs.
- smart and early play Normal on past wave 30 until they fall (up to wave 100), so the early target compares how far each gets. Capped at 30, both win every Normal run.

Results for 1.1:

| Profile | Easy | Normal | Hard | Target |
|---|---|---|---|---|
| smart (20 seeds) | 20/20 wins | 20/20 wins, falls on wave 50 (median) | 9/20 wins | Easy 19+, Normal 17+, Hard 8-12: met |
| early (smart, calls waves early) | 20/20 | 20/20, falls on wave 50 | 11/20 | on Normal median cleared wave within 10 of smart (49 and 49) and median lives at wave 30 within 3 (14 and 13.5); Hard wins within 3 (11 and 9): met |
| spam (Bolts only, 5 seeds) | dies on wave 22 | dies on wave 18 | dies on wave 18 | Easy: waves 15-29, Normal: 15-23, Hard: 12-23: met |
| mlf (Mortar, Longshot, Frost only, 5 seeds) | | dies on wave 11 | | loses lives on an Air raid in every run: met (20 lives on waves 7 and 11) |
| reader (smart reading the next 4 waves) | 20/20 | 20/20 | 20/20 | none (for comparison) |

Lives when wave 30 is cleared: smart Easy 20 in every run, Normal 9-19 (median 13.5), Hard 1-8 (median 2); reader Normal median 19.5 and Hard 14. So smart's Normal winners split 3, 15 and 2 across 3, 2 and 1 stars, and no Hard winner earns 3 (both are targets). The thresholds stay at 16 and 10.

A spam run gets a fair start and then meets armor. On Normal it loses 5 lives to the wave-10 Warlord, 6-8 to the wave-14 Armored wave and the rest on the wave-18 Armored wave. On Easy it loses nothing until the wave-18 Armored wave, then 10 to the two wave-20 Warlords, and falls on the wave-22 Armored wave. It never loses a life on an Air raid: answering fliers is the Bolt's job. mlf, with no Bolt or Arc, loses all 20 on the Air raids (11 on wave 7, 9 on wave 11). smart is the other way round: its lives go on the Air raids (waves 7, 11 and 15) and to the Warlords (waves 20 and 30), and the Armored waves cost it nothing.

### What changed and why
- Bolt spam won every road (Hard with 1 life) and lost nothing on Air raids, so the towers had no jobs. The fix is armor, which hurts a Bolts-only build far more than a mixed one: smart's damage comes about 60% from Longshots and 20% from Mortars, and its Bolts do 4-12%. Swept with 5 seeds, the wave spam falls on (Easy, Normal, Hard): Brute armor 3 wins all three; 6 (Warlord 10) wins Easy 4 of 5, then 22-26 and 20; 7 (Warlord 12) dies on 26, 20 and 18-20; 8 (Warlord 12) dies on 22, 18 and 18; 9 (Warlord 12) on 20, 18 and 18; 12 (Warlord 14) on 18-20, 16-18 and 14-16. Brute armor 8 alone (Warlord 6) also worked, but it would have left a Brute (10.2 on wave 10) with more armor than the Warlord its blurb calls heavily armored (7.6), so the Warlord went to 12 with it. Raising armor growth instead (Brute 6, +6% a wave) worked about as well, but changing one number per type is the smaller change. The Bolt's stats did not need to move.
- The shared spending rule made smart much stronger (it used to spend only between waves): with the old values it won Hard 10 of 10, and with the new armor at Quarry 1.05 it won 14 of 20. Quarry `hp` at 1.06 gives 9/20, 1.07 gives 6/20, 1.08 7/20 and 1.11 1/20. On two more samples of 20 seeds (21-40 and 41-60) 1.06 gives 9 and 12, so 30 of 60 in all. `hpB` did not need to move: Easy and Normal stay inside their targets.
- Early calls. Once both bots spend during waves, the early call is the only difference, and its edge is modest at every `earlyMul` from 1 to 3. On Hard at Quarry 1.06, over the three samples of 20 seeds, smart wins 30 of 60; early wins 29 at `earlyMul` 1, 39 at 2 and 32 at 3. On Normal the median lives at wave 30 (seeds 1-20, then 21-40) are 13.5 and 11.5 for smart against 14 and 12.5 at 1, 15 and 12.5 at 2, and 14 and 14.5 at 3, and every one falls on wave 50 (median). So 3 stays: the bonus pays for the risk of two waves on the road at once without making the button a must. 1 gives no edge on Hard at all, and 2's larger edge there is noise in the bot's choices, not a trend: it failed the Hard target in two of the three samples.

### Known gaps
- Hard is steep and noisy. One hundredth of Quarry's `hp` moves smart's Hard wins by up to 5, and two samples of 20 seeds at the same values can differ by as much (14 and 9 at 1.05). The early target on Hard (within 3 of 20) is about as wide as that noise, so a small change elsewhere can flip it even when the early call did not change.
- Easy offers the bot no challenge: smart, early and reader lose no lives there. Easy is the easy road, and its target (19 or more wins) is met.
- spam's 5 seeds are different builds (34-56 towers), and on Easy and Normal they lose different numbers of lives along the way, but on each road all 5 fall on the same wave, because the Armored waves are walls for Bolts.
- smart's Normal winners lean to 2 stars (3, 15 and 2). They spread across all three, as the target asks, but less evenly than before this pass (7, 5 and 7).
- The Longshot does about 60% of the smart bot's damage, as it did before this pass.

## Files
- `index.html`: the whole game
- `manifest.webmanifest`, `sw.js`, `icons/`: home-screen install and offline caching
