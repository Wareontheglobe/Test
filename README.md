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
- Tap a tower to upgrade it (up to level 3), sell it (tap twice), or change who it targets: **First** (closest to the keep), **Toughest** (Brutes and Warlords first) or **Fliers** (Wisps first). Selling gives a full refund until the next wave starts, then 70%.
- The icons beside Start wave show the next wave's enemies and how many. Tap one for its HP, speed and armor.
- **Start wave** sends the next wave. Once a wave has fully arrived you can call the next one early for bonus gold. Wave 30 is the exception: the run is won when it is over, so wave 31 can't be called during it.
- Survive 30 waves to win, then keep going in endless mode. A win earns stars for that road: 3 for finishing with 16 or more lives, 2 for 10 or more, otherwise 1. The end card shows what got through and which towers did the damage.
- Each road keeps its own saved run, saved whenever the road is clear: after a wave, once nothing is left on the road. While waves called early overlap, nothing is saved, so leaving then (or the phone closing the app) restarts from the last clear road, and Continue says which waves restart. Tap a road to pick up its run. To start a road over, use Pause > Restart road (tap twice, the second tap on its own).
- Keyboard: Escape or P pauses, Space or Enter sends the next wave, 1-5 pick a tower. Tab to the board, then the arrow keys move a tile cursor and Enter taps that tile.

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
Values in 1.1: `CFG.hpB` 0.021 (was 0.032), `CFG.themeBudget` 0.85 (a themed wave has 85% of the Mixed wave's HP), Quarry Run `hp` 1.06 (1.05 in 1.0), and armor: Brute 8 (was 3), Warlord 12 (was 6). Armor still grows 3% a wave (`CFG.armorGrow` 0.03) and a hit still keeps at least a quarter of its damage (`CFG.armorFloor` 0.25). `CFG.earlyMul` 2 (was 3), so calling wave w early pays 2 × (10 + w) gold: +30 for wave 5, +60 for wave 20, about what clearing a wave pays. Tower stats and prices are unchanged. Stars: 3 for finishing with 16 or more lives, 2 for 10 or more, else 1.

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
`node tests/balance.js` checks the values. A greedy bot plays every road (335 runs, about 90 seconds on 4 cores) and the script prints PASS or FAIL per target. It is not part of `tests/run.js`. Overrides such as `--bruteArmor=7 --bossArmor=10 --hard=1.07 --earlyMul=2` (the full list is in its header) let a later tuner sweep the knobs, and `--profiles`, `--roads`, `--seeds` and `--seedFrom` make a sweep quick.

How it plays:
- Every profile spends the same way: before each wave and once every second of game time while a wave runs, as people play. Each time it buys the best value it can afford, again and again: a new tower where it covers the most road, or an upgrade.
- The bot's Longshots are on Toughest while a Warlord wave is on the road and on First otherwise. That is the only targeting change it makes.
- smart is the plan's profile, the design team's progression bot. It does not read the coming waves, so it plays like someone who ignores the preview.
- early is smart that also calls the next wave early whenever it is safe (lives 15 or more and the front of the road clear), checked once a second right after it spends. That call is the only difference between the two.
- reader is smart reading the next 4 waves, as a player reads the chips and their theme tag: it scales each tower by how much of those waves it can hurt. It has no target; it shows what the preview is worth.
- Two profiles build only Bolts. spam spreads its gold over many Bolts, mostly at level 1 and 2 (when it dies on Normal it has about 36-40 Bolts, none or one at level 3 and most at level 2). spamUp upgrades first, as most people do: once it has 3 Bolts it builds no new one while any it owns is below level 3. spam has smart's noise, so its 5 seeds are 5 different runs. spamUp has the same noise, but its 5 seeds play the very same run on each road (the script says so), so each of its lines is one sample, not five.
- mlf builds only Mortars, Longshots and Frost.
- smart and early play Normal on past wave 30 until they fall (up to wave 100), so the early target compares how far each gets. Capped at 30, both win every Normal run. Every endless run falls on a Warlord wave (40, 50, 60), so the waves cleared come in steps of 10 and a median can only jump; the target compares the mean, over 40 seeds on Normal, because 20 seeds can move a mean by 2 or more. smart and early play Hard on 60 seeds (20 on Easy): 20 seeds can move smart's Hard wins by 5 (9, 9 and 12 on seeds 1-20, 21-40 and 41-60), which is as wide as the early target on Hard. The per-20 targets scale with the seeds played.

Results for 1.1:

| Profile | Easy | Normal | Hard | Target |
|---|---|---|---|---|
| smart (20 seeds, 40 on Normal, 60 on Hard) | 20/20 wins | 40/40 wins, falls on wave 50 (median; mean cleared 49.0) | 30/60 wins | Easy 19+, Normal 17+ in 20, Hard 8-12 in 20 (24-36 in 60): met |
| early (smart, calls waves early) | 20/20 | 40/40, mean cleared 51.1 | 39/60 | on Normal mean cleared wave within 3 of smart (51.1 and 49.0): met; median lives at wave 30 within 3 (14.5 and 13): met; Hard wins within 3 in 20, so 9 in 60 (39 and 30): met, right at the limit (see Known gaps) |
| spam (Bolts only, spread out, 5 seeds) | dies on wave 22 | dies on wave 18 | dies on wave 18 | Easy: waves 15-29, Normal: 15-23, Hard: 12-23: met |
| spamUp (Bolts only, upgrades first, 5 seeds that play one run) | dies on wave 30 | dies on wave 26 | dies on wave 22 | reaches wave 15 everywhere, dies before wave 28 on Normal and Hard: met |
| both Bolts-only profiles | | | | win no road: met |
| mlf (Mortar, Longshot, Frost only, 5 seeds) | | dies on wave 11 | | loses lives on an Air raid in every run: met (20 lives on waves 7 and 11) |
| reader (smart reading the next 4 waves) | 20/20 | 20/20 | 20/20 | none (for comparison) |

Lives when wave 30 is cleared: smart Easy 20 in every run, Normal 8-19 (median 13, 40 seeds), Hard 1-12 (60 seeds); reader Normal median 19.5 and Hard 14. So smart's Normal winners split 4, 28 and 8 across 3, 2 and 1 stars, and its 30 Hard winners split 0, 2 and 28 (both are targets). The thresholds stay at 16 and 10.

Which Bolt spammer the numbers describe matters. A spam run (spread out) gets a fair start and then meets armor. On Normal it loses 5 lives to the wave-10 Warlord, 6-8 to the wave-14 Armored wave and the rest on the wave-18 Armored wave. On Easy it loses 4-6 on the wave-18 Armored wave, then 10 to the two wave-20 Warlords, and falls on the wave-22 Armored wave. A player who builds only Bolts but upgrades them as they go (spamUp) gets much further, because a level-3 Bolt keeps 56% of each hit against a wave-18 Brute where a level-2 Bolt keeps 31%: on Normal it loses 10 to the wave-20 Warlords, 6 on the wave-22 Armored wave and falls on the wave-26 Armored wave; on Hard it falls on wave 22. On Easy it reaches the final Warlords: it loses 5 on wave 20 and 4 on the wave-26 Armored wave, then the three wave-30 Warlords take its last 11. So an upgrading Bolts-only player gets to the final Warlords on Easy and loses there; Warlords need Longshots. Neither kind of Bolt spammer loses a life on an Air raid: answering fliers is the Bolt's job. mlf, with no Bolt or Arc, loses all 20 on the Air raids (11 on wave 7, 9 on wave 11). smart is the other way round: its lives go on the Air raids (waves 7, 11 and 15) and to the Warlords (waves 20 and 30), and the Armored waves cost it nothing.

### What changed and why
- Release: `CFG.earlyMul` 3 to 2. With the shared spending rule the early call is the only difference between early and smart, and its edge grows with the bonus. Over 80 seeds of endless Normal (1-40 and 41-80) early's mean cleared wave beats smart's by 1.8 at `earlyMul` 1, 2.0 at 1.5, 2.2 at 2, 3.2 at 2.5 and 4.4 at 3. 2 is the largest bonus inside the target (within 3), and it still pays about what clearing a wave does, so the call stays worth the risk without being a button you must press every wave. On Hard over 60 seeds smart wins 30; early wins 29 at 1, 37 at 1.5, 39 at 2, 33 at 2.5 and 32 at 3. That does not rise with the bonus, so it is mostly noise, and the Hard comparison now plays 60 seeds instead of 20.
- Release review: the Bolt spam targets passed only because spam spreads its gold. A second Bolts-only profile, spamUp, upgrades first, and the targets now cover both: neither wins a road, spam keeps its windows, and spamUp must reach wave 15 and fall before wave 28 on Normal and Hard. Armor and the Bolt were not retuned for it. The early target used to compare median cleared waves within 10, which passed even one whole Warlord wave apart (59 and 49); it now compares means, within 3, over 40 seeds.
- Bolt spam won every road (Hard with 1 life) and lost nothing on Air raids, so the towers had no jobs. The fix is armor, which hurts a Bolts-only build far more than a mixed one: smart's damage comes about 60% from Longshots and 20% from Mortars, and its Bolts do 4-12%. Swept with 5 seeds, the wave spam falls on (Easy, Normal, Hard): Brute armor 3 wins all three; 6 (Warlord 10) wins Easy 4 of 5, then 22-26 and 20; 7 (Warlord 12) dies on 26, 20 and 18-20; 8 (Warlord 12) dies on 22, 18 and 18; 9 (Warlord 12) on 20, 18 and 18; 12 (Warlord 14) on 18-20, 16-18 and 14-16. Brute armor 8 alone (Warlord 6) also worked, but it would have left a Brute (10.2 on wave 10) with more armor than the Warlord its blurb calls heavily armored (7.6), so the Warlord went to 12 with it. Raising armor growth instead (Brute 6, +6% a wave) worked about as well, but changing one number per type is the smaller change. The Bolt's stats did not need to move.
- The shared spending rule made smart much stronger (it used to spend only between waves): with the old values it won Hard 10 of 10, and with the new armor at Quarry 1.05 it won 14 of 20. Quarry `hp` at 1.06 gives 9/20, 1.07 gives 6/20, 1.08 7/20 and 1.11 1/20. On two more samples of 20 seeds (21-40 and 41-60) 1.06 gives 9 and 12, so 30 of 60 in all. `hpB` did not need to move: Easy and Normal stay inside their targets.
- Early calls (the balance pass, before the release review changed the target). Once both bots spend during waves, the early call is the only difference, and its edge is modest at every `earlyMul` from 1 to 3. On Hard at Quarry 1.06, over the three samples of 20 seeds, smart wins 30 of 60; early wins 29 at `earlyMul` 1, 39 at 2 and 32 at 3. On Normal the median lives at wave 30 (seeds 1-20, then 21-40) are 13.5 and 11.5 for smart against 14 and 12.5 at 1, 15 and 12.5 at 2, and 14 and 14.5 at 3, and every one falls on wave 50 (median). So 3 stays: the bonus pays for the risk of two waves on the road at once without making the button a must. 1 gives no edge on Hard at all, and 2's larger edge there is noise in the bot's choices, not a trend: it failed the Hard target in two of the three samples.

### Known gaps
- The early target on Hard passes right at its limit: early wins 39 of 60, smart 30, and the limit is 9. Hard wins swing by about 5 in 20 seeds, so this target can flip with a small change elsewhere even when the early call did not change. The Normal targets have room (a mean of 2.1 waves against 3, and 1.5 lives against 3).
- An upgrading Bolts-only player (spamUp) reaches the final Warlords on Easy and loses there, so on Easy Bolts-only holds right up to the last wave. On Normal and Hard it falls 4 and 8 waves short.
- spamUp's 5 seeds all play the same run on each road, so each of its results is one sample.
- Hard is steep and noisy. One hundredth of Quarry's `hp` moves smart's Hard wins by up to 5, and two samples of 20 seeds at the same values can differ by as much (14 and 9 at 1.05). That is why smart and early play Hard on 60 seeds.
- Easy offers the bot no challenge: smart, early and reader lose no lives there. Easy is the easy road, and its target (19 or more wins) is met.
- spam's 5 seeds are different builds (34-56 towers), and on Easy and Normal they lose different numbers of lives along the way, but on each road all 5 fall on the same wave, because the Armored waves are walls for Bolts.
- smart's Normal winners lean to 2 stars (4, 28 and 8 over 40 seeds). They spread across all three, as the target asks, but less evenly than before the balance pass (7, 5 and 7).
- The Longshot does about 60% of the smart bot's damage, as it did before this pass.

## Files
- `index.html`: the whole game
- `manifest.webmanifest`, `sw.js`, `icons/`: home-screen install and offline caching
