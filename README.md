# Lewisville Lightning

Team website, brand assets and game-day graphics for the Lewisville Lightning
(Competitive U13 B, Lewisville Minor Hockey Association, New Brunswick).

Everything is driven by five JSON files in `data/`. The website renders them,
and the poster renderer screenshots the website — so the graphics and the site
can never drift apart, and no image model ever retypes a date.

## Layout

```
data/          the contract — schedule, roster, stats, news, opponents, spotlight
docs/          DATA-CONTRACT.md: what the Spordle sync must produce
assets/
  brand/       crest extracted at 533x522 + opponent crests
  fonts/       Barlow Condensed / Semi Condensed (OFL), vendored
site/          Astro site (static output)
render/        headless-chromium game-day graphics renderer
tools/spordle/ capture collector + to_data.py adapter onto the contract
output/<date>/ rendered posters
```

## Running it

The repo ships a nix devshell with node, chromium and imagemagick:

```
direnv allow          # or: nix develop
cd site && npm install
npm run dev           # http://localhost:4321
npm run build
npm run validate      # checks data/ against the contract; fails loudly
```

Game-day graphics (4K poster, 9:16 story, 1:1 square):

```
cd site && npm run build
node render/render.mjs --all
node render/render.mjs --game g-2026-10-13-shediac --formats poster
```

Output lands in `output/<game-date>/`. A 4K poster takes about two seconds.

## How the graphics work

`/render/<format>/<id>` are real pages on the site with a fixed pixel canvas and
no chrome. `render/render.mjs` serves `site/dist`, points headless chromium at
those routes at 2x device scale, and screenshots the viewport:

| format | canvas | output |
|---|---|---|
| `poster` | 1920×1080 | 3840×2160 |
| `story`  | 1080×1920 | 2160×3840 |
| `square` | 1080×1080 | 2160×2160 |

Because those routes import the same `tokens.css` and the same `Matchup.astro`
the website uses, the poster inherits the real crests, the real fonts and the
real data. Text is typeset, not generated, so it is correct by construction.

The arena background is currently drawn procedurally in CSS. It is deliberately
pluggable — dropping a photographic 4K plate into `assets/plates/` and pointing
`.plate` at it is the next quality step, and the only part of the old
image-model pipeline worth keeping.

## Data and the Spordle sync

**Read `docs/DATA-CONTRACT.md` before touching `data/`.** Current contents are
fixtures apart from the 2026-10-13 game; the placeholder player names are not
real children.

Two rules that matter more than the rest:

- **Datetimes carry an explicit offset.** `America/Moncton` is `-03:00` in
  season and `-04:00` after the time change. A naive timestamp silently moves
  every game by an hour. `npm run validate` rejects them.
- **`roster.privacy` gates what the public build shows about minors.** The
  default publishes neither photos nor birth years and abbreviates surnames.

## Brand

Palette is sampled from the official crest: navy `#0B1D54`, blue `#2D6DAB`,
steel `#707277`, ice `#ADBFD7`, with `#1C8FE8` as the electric accent. Display
face is Barlow Condensed Black Italic; UI face is Barlow Semi Condensed. The
site is dark-only by design — the crest, the ice and the arena light are the
identity, and a light variant weakened all three.


## Syncing from Spordle

The collector captures Spordle views into `private/spordle/223790/` (gitignored
— it holds real minors' data). The adapter maps those onto the contract:

```
python3 tools/spordle/to_data.py     # normalized captures -> data/*.json
cd site && npm run validate
```

It reports anything it had to guess. Spordle stores names in **ALL CAPS**, and
on an Acadian roster the correct spelling of a surname is person-specific
(*LeBlanc* vs *Leblanc*, *Degrâce* vs *DeGrâce*). Names are title-cased with an
exact-match table for genuinely internal-capital surnames; everything it guesses
is printed for confirmation and can be pinned in
`tools/spordle/name-overrides.json`.

Known gaps in the current capture: the schedule is a **partial view** (next 30
days, 2 games), two dates were captured without detail, and no stats or news
view has been collected. Standings exist in a capture but are the whole
association at zero — the season has not started.

## Player spotlight

Every game banner features one player, drawn at random from those not yet
featured this cycle, so the whole roster gets a turn before anyone repeats.

```
python3 tools/assign_spotlight.py            # assign any unassigned games
python3 tools/assign_spotlight.py --status   # show the rotation
python3 tools/assign_spotlight.py --reassign <game-id>
```

Assignments persist in `data/spotlight.json` — once a game is assigned, a
re-render never hands that game to a different player. When all 19 have been
featured the cycle increments and the pool refills. The card falls back to the
jersey number until `cardArt` lands in `data/roster.json`.

## Deploying

```
./deploy.sh              # validate, build, publish to arachnea, verify
./deploy.sh --posters    # also re-render the game graphics
```

The build **bakes in `data/`** — the spotlight player, the schedule, the roster
are all resolved at build time. Editing `data/` and rsyncing without rebuilding
publishes a stale page; that is how the game banner kept naming the wrong
featured player. `deploy.sh` always builds first, for that reason.

Full detail, including first-time setup and account creation, in
`docs/DEPLOY.md`.
