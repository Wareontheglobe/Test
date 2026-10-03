# Stargate SG-1 episode game: design plan

A single-player story game that walks through Stargate SG-1 one episode at a time. One program (the "SGC shell") holds the menus, saves, persistent state and shared art. Each episode is a separate pack you drop into the game folder and play once it's built. The whole thing is meant to be built with Claude Code, one episode at a time, over as long as it takes.

## The short version

| Decision | Choice |
|---|---|
| Format | Story adventure in visual-novel form, with scenes, choices, investigation, small puzzles and choice-driven firefights |
| Player role | The SG-1 team as a unit. At each decision you choose what happens and who does it |
| Engine | Ren'Py 8 |
| Episode delivery | One folder per episode that registers itself with the shell's mission select |
| Text | Original scene writing in each character's voice, following the real plot beat by beat |
| Art | Local Stable Diffusion through ComfyUI, driven by a script that reads a per-episode asset list |
| Repo | A new private repo. This one is public |

## Game format

### You play the team

There's no original character. A new recruit tagging along would push the real characters to the side, and the show is about them. So you control SG-1 as a unit. Most scenes have a lead, whoever the episode puts up front. At decision points you choose both the action and who takes it. O'Neill talks down the Jaffa, Daniel reads the inscription, Carter rewires the DHD, Teal'c handles Goa'uld customs and the fighting. The roster changes when the show's does (Jonas Quinn in season 6, Mitchell and Vala in seasons 9 and 10). Hammond, Fraiser and later Landry appear as base and briefing characters.

### What an episode looks like

Every pack uses the same five-part shape, which is roughly how most SG-1 episodes are built.

1. **Briefing.** The briefing room, a MALP feed, or a problem on base. Sets objectives and hands you information you'll need later. Some checks depend on whether you were paying attention here.
2. **Dialing.** A short sequence on the SGC dial screen. Usually ceremony, sometimes a puzzle (finding an address, a gate that won't lock).
3. **Off-world.** Investigation scenes with clickable spots on the background, conversations with locals, and a translation or tech puzzle where the episode has one.
4. **Crisis.** The episode's turn. A firefight is a short run of tactical choices: who moves, who covers, when to fall back. No dice. Outcomes follow from your choices and what the team knows.
5. **Debrief.** Mission report, what changed in the campaign, codex entries unlocked, and an optional "how it went in the show" note you can switch off.

Base-bound episodes (lab accidents, body swaps, time loops) skip the dialing and replace off-world with the SGC itself. The shape bends to fit the episode. The debrief is always there.

Target 30 to 45 minutes of play per episode, so each one fits in a sitting.

### Choices against a fixed canon

The plot has to land where the show lands, or episode 40 stops making sense. The rule is a fixed spine with loose ribs.

Spine beats can't change. Teal'c defects in Children of the Gods. Daniel ascends at the end of season 5. If your choices make a spine beat impossible, say you lose your chance to win Teal'c over, the mission fails and you retry from the last checkpoint.

Rib outcomes vary and carry forward: who got hurt, which villagers got out, whether you brought the device home, what the team learned. These feed rapport, the codex, and small callbacks later, like a briefing that mentions the sample you did or didn't bring back.

### What carries between episodes

- **Rapport.** Between the team and each recurring character, and among the team. Opens optional scenes and dialogue, never touches the spine.
- **Knowledge flags.** What the team has learned, such as how a zat works or what a Goa'uld word means. Later checks read these, so paying attention early pays off.
- **Codex.** Races, Goa'uld, worlds, technology, people, unlocked through play. It doubles as a "previously on" when you come back after a month away.
- **Gate address book.** Addresses dialed or found, shown on the dial screen.
- **SGC standing.** One number covering personnel, materiel and goodwill with Washington. Rises and falls with how missions go. Mostly flavor, occasionally decides whether backup arrives.

Keep the systems few. Every stat has to be accounted for in every episode, and that cost multiplies by 200.

### Left out on purpose

Real-time combat, inventory management and RPG leveling. Each would need its own content in every episode, and none of them is what the show is about.

## Where the text comes from

Full episode transcripts are copyrighted, and this repo is public, so the scripts don't get reproduced. The practical reason matters as much: recall of exact dialogue across 214 episodes is unreliable, and a misremembered line in O'Neill's mouth reads worse than a fresh one written in his voice.

1. Claude writes each episode as original scenes and dialogue that follow the real plot in each character's established voice. A few short signature lines can appear as said. The rest is new writing.
2. Before writing, Claude produces a beat sheet (the plot, scene by scene) and you check it against your memory or a synopsis. Recall of the big episodes is good. Mid-season ones can drift, and five minutes of review catches a wrong beat before 4,000 words get built on it.
3. If you own the discs, you can pull an episode's subtitle track (Subtitle Edit or MKVToolNix) into a local `reference/` folder. Claude Code reads it while drafting that episode so the scene flow tracks the real one closely. That folder is gitignored and never leaves your machine.
4. A voice guide in `CLAUDE.md` pins each character down. O'Neill deflects with jokes and hates long briefings. Daniel argues for the locals and gets cut off. Carter explains, then gets asked to explain it simpler. Teal'c says the least. The guide changes as the characters do over ten seasons.

The series is 214 episodes. Clip shows become a short codex-review episode or get skipped. The two follow-up films, The Ark of Truth and Continuum, fit as two final packs. The 1994 film can be a short playable prologue on Abydos.

## Engine: Ren'Py

Ren'Py instead of a custom engine (Godot, or a web app built on Ink) because it already has what a story game needs, and those would otherwise take weeks to build: save/load with thumbnails, rollback, a history log, text speed and skip settings, layered sprites, transitions, music and sound channels, and a screen language for custom UI like the dial computer and codex. Scripts are plain text, which suits Claude Code. `renpy.sh <project> lint` catches missing labels, missing images and syntax errors, so Claude can check its own work before you play. It runs on Windows, Mac and Linux.

The cost is that puzzles and tactical sequences are built from Ren'Py screens and Python, which is clunkier than a game engine. The puzzles and firefights planned here are small enough for that not to matter.

### Project layout

```
sg1/
  game/
    shell/                     menus, mission select, codex, dial screen, debrief, campaign state
    characters/                character definitions and sprite layers
    images/
      shared/                  gate room, briefing room, corridors, recurring planets
      cast/                    main and recurring cast sprites
      eps/s01e01/              episode-only art, filenames prefixed s01e01_
    episodes/
      s01e01_children_of_the_gods/
        episode.rpy            registers the episode and holds its scenes
        puzzles.rpy            optional
    audio/
  content/
    canon/continuity.yaml      team roster, who's alive, what's known, per episode
    beats/s01e01.md            approved beat sheet
    assets/s01e01.yaml         art list for the generator
  reference/                   your subtitle extracts, gitignored
  tools/
    gen_assets.py              sends asset lists to ComfyUI, files the results
    check_episode.py           registration checks, missing art, branch coverage
  .claude/skills/new-episode/SKILL.md
  CLAUDE.md                    voice guide, style rules, conventions
```

### How an episode plugs in

Each `episode.rpy` calls `register_episode(...)` at init with its ID, title, season, number, entry label, and the campaign flags it reads and writes. Mission select lists whatever has registered, in order, and locks each episode until the one before it is done (with a setting to turn that off). Adding an episode means copying its folder into `game/episodes/` and restarting. Unwritten episodes don't appear, so you can play season 1 while season 2 is in progress.

Campaign state lives in one object that every episode goes through, with helpers like `campaign.learn("zat_mechanics")` and `campaign.rapport("tealc", +1)`. Episodes never create their own globals. That's what keeps old saves loading after new episodes arrive.

### Testing

`lint` runs on every change. `check_episode.py` validates the registration, confirms every image the script references exists or has a placeholder, and walks the choice graph to make sure every branch reaches the debrief. Each episode also gets a Ren'Py testcase that clicks through the canon path from briefing to debrief.

## Art pipeline

### Tools

Stable Diffusion on your machine is the right call. There's no per-image cost, so you can generate 20 candidates and keep one, and nothing leaves your computer. Run it through ComfyUI rather than a point-and-click web UI. ComfyUI accepts a whole workflow as JSON over a local HTTP API (port 8188 by default), so `tools/gen_assets.py` can read an episode's asset list, drop the prompts into a saved workflow, queue the batch and file the results while you do something else.

The model depends on your GPU. With 8 GB of VRAM, SDXL and its fine-tunes, which have the largest set of style models and consistency tools (IP-Adapter, ControlNet). With 12 GB or more, Flux.1 dev in a quantized build follows prompts better and draws hands better. Its license is non-commercial, which is fine for this. Newer models will keep coming out, and switching means swapping the workflow JSON. Nothing else in the pipeline changes.

### Style

Illustrated, not photoreal. A graphic-novel look with clean ink lines, flat lighting, a muted military palette and gold for anything Goa'uld. Photoreal shows every small inconsistency between images. An illustrated style hides them and keeps hundreds of images looking like one game. Characters are designed to read as their show counterparts through hair, build, uniform and signature details (Teal'c's gold forehead mark, O'Neill's cap, Carter's short blonde hair, Daniel's glasses). They aren't trained on the actors' photos, and I'd keep photo-likeness models of real people out of the pipeline entirely. A stylized design also holds together better across a thousand images than a likeness does.

The style is fixed once as a prompt block, negative prompt, sampler settings and, if needed, a style LoRA, all saved in the workflow so every image shares them.

### Character consistency

This is the hardest part of using Stable Diffusion for a game.

1. For each main character, generate a few dozen candidates of the design and pick a canonical front portrait plus a turnaround sheet.
2. Feed that portrait through IP-Adapter, or the equivalent reference input for your model, on every later generation of that character.
3. If they still drift, train a small LoRA with kohya_ss on 20 to 40 curated images of your own generated character. The training set is the game's own design, so that's what the LoRA learns.
4. Sprites get one base pose per outfit (BDUs, dress uniform, off-world gear, Jaffa armor for Teal'c). Expressions come from inpainting only the face: neutral, smile, angry, worried, surprised, deadpan. Background removal (BiRefNet or rembg) runs inside the same ComfyUI workflow.

### What each episode needs

The shared library does most of the work and is built once: the gate room from several angles with the gate idle and active, the control room, briefing room, infirmary, corridors, Daniel's office, Carter's lab, a set of reusable planets (forest, desert, snow, ruins, village), a Goa'uld ship interior and a Jaffa camp. Plus the main cast sprites.

A typical episode then adds 2 to 6 backgrounds, 2 to 4 full-screen illustrations for its big moments, and sprites for its guest characters. An asset list entry looks like this:

```yaml
- id: s01e01_chulak_cells
  kind: background
  prompt: "stone prison cell beneath a Goa'uld temple, torchlight, gold inlay on the walls"
  candidates: 12
- id: s01e01_cg_tealc_defects
  kind: cg
  prompt: "..."
  reference: cast/tealc_portrait.png
  candidates: 20
```

The script writes a contact sheet (one HTML page per batch) so you can pick the winners, then copies them into `game/images/` under the right names. Until art exists the game shows labeled placeholders, so the writing never waits on the art.

### Glyphs and UI

Gate glyphs, the dial screen, chevron lights and codex frames are vector work, not diffusion. Claude draws the 39 glyphs and the UI pieces as SVG and exports PNGs. They come out sharper, and the dial screen can animate each chevron locking.

## Sound

Not in the first build. Ren'Py's music and sound channels are there when you want them, whether that's royalty-free ambient tracks or locally generated music. No voice acting.

## Per-episode workflow

A Claude Code skill in `.claude/skills/new-episode/` turns this into one request ("build S02E05"):

1. Read `continuity.yaml` and the last two debriefs for the current state of the campaign.
2. Draft the beat sheet and stop for your approval.
3. Design the interaction: decision points, which ones are spine and which are rib, which flags each check reads, any puzzle.
4. Write `episode.rpy`.
5. Write the asset list, reusing shared art first.
6. Run lint and `check_episode.py`, fix until clean.
7. Update `continuity.yaml` and add codex entries.
8. On your PC, run `gen_assets.py` and pick the winners.
9. Play it.

Steps 1 to 7 can run anywhere, including a cloud session. Step 8 needs your GPU, so art generation means running Claude Code locally with ComfyUI open.

## Build order

1. **Setup.** Private repo, Ren'Py SDK, ComfyUI with your chosen model, `CLAUDE.md` with the voice guide.
2. **Shell with placeholders.** Main menu, mission select, campaign state, codex, dial screen, debrief. A dummy two-scene episode proves that registration and saves work.
3. **Vertical slice: Children of the Gods.** Complete, with real art. It has a briefing, a dial, an off-world rescue, a firefight, a spine beat (Teal'c) and a Goa'uld. If the format has a problem, it shows up here, before 213 more episodes are built on it.
4. **Shared art library and cast sprites,** reworked with what the slice taught.
5. **Season 1** in order, with a review every three or four episodes to adjust the format.
6. **Seasons 2 to 10,** adding cast as the show does, then the two films.

## Repo note

This repository (Wareontheglobe/Test) is public. The plan is fine here, but the game, the episode scripts, the art and anything in `reference/` belong in a new private repo, with `reference/` gitignored even there.

## Needed from you before phase 1

- Your GPU and how much VRAM it has. This decides SDXL or Flux.
- Whether you own the series on disc. This decides whether the subtitle reference step exists.
- Whether the graphic-novel style suits you, or you'd rather something else (painterly, anime, pixel art). Pixel art would change the art pipeline the most.
- Strict episode order, or free choice once an episode is unlocked.
