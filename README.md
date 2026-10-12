# Lewisville Lightning

Team website, brand assets and game-day graphics for the Lewisville Lightning
(Competitive U13 B, Lewisville Minor Hockey Association, New Brunswick).

Everything is driven by five JSON files in `data/`. The website renders them,
and the poster renderer screenshots the website — so the graphics and the site
can never drift apart, and no image model ever retypes a date.

## Layout

```
data/          the contract — schedule, roster, stats, news, opponents
docs/          DATA-CONTRACT.md: what the Spordle sync must produce
assets/
  brand/       crest extracted at 533x522 + opponent crests
  fonts/       Barlow Condensed / Semi Condensed (OFL), vendored
site/          Astro site (static output)
render/        headless-chromium game-day graphics renderer
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
