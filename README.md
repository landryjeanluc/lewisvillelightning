# Lewisville Lightning

Team website, brand assets and game-day graphics for the Lewisville Lightning
(Competitive U13 B, Lewisville Minor Hockey Association, New Brunswick).

Schedule and roster content are driven by JSON files in `data/`. The website renders them,
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
npm run validate      # type checks, security unit tests, data checks and build
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

**Read `docs/DATA-CONTRACT.md` before touching `data/`.** The roster and photo cards contain real children’s information. Treat the repository, generated output and backups as private team data.

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

## Card art

Each player's hockey card is a finished piece of artwork — crest, name, number
and position are already on it — kept in `assets/photos/` under the player's
name. `tools/spordle/to_data.py` matches those files to players on each sync
and writes the path into `roster.json` as `cardArt`; the import prints how many
it matched and names any file it could not place. Where a card exists it *is*
the card, and `PlayerCard.astro` drops the generated chrome rather than print
the name twice.

`/admin → Roster` shows which art each player has. Two things can supply it:
the repo file above, and an upload made in that panel, which is stored in the
`player_profiles.card_art` column and wins where both exist. Uploaded card art and biographies now load from the authenticated profiles API on team pages. Uploaded card art overrides the build-time card when photos are enabled. The hosting configuration must serve `/uploads/` behind the login gate.

`tools/test_roster_ui.mjs` drives that panel in a real browser: it was written
for a bug where the panel read the state from the database alone and reported
"no card art" for all nineteen players, every one of whom had art in the repo.

## Training goals on a player's page

A player's page carries their current training goals under the card:
their own targets with progress against each, and — for their own family —
the team goals with the share that player has put in. `PlayerGoals.astro`
fills it from `/api/goals`, the same board `/goals` uses.

Who sees it is the whole point. A player's page is **static and served behind the login gate**, so
nothing about a child's training is rendered into the build: the section ships
empty and hidden, and only appears if the API answers for a viewer entitled to
it — an admin, or that player's own family. A parent of another player gets
nothing, because `family_total` is always *their* child's work and would be
shown here under the wrong name. Signed out, or the API down, the section stays
shut and says nothing either way.

`tools/test_player_goals_ui.mjs` drives those rules in a real browser,
including that the static HTML carries no goal of the player's.

## Plays of the week

The coach draws a play on a rink in `/admin → Plays`; the team watches it run at
`/plays`. Pieces are dropped on the ice, lines are dragged out of them in
standard notation, and each line belongs to a numbered **step** — so a breakout
plays back as "D1 retrieves" → "rim it to the wall" → "LW chips it out", one
beat at a time, with the coach's caption under the board.

Unlike everything else on the site, **plays are live**. A play is written in the
browser and read from the API at page load, so publishing one does not need a
rebuild or a deploy. That is deliberate: the data contract below is synced from
Spordle and baked in at build time, but a play of the week is written on a
Tuesday night and has to be up on Tuesday night.

### The diagram document

One versioned JSON document per play, stored whole in `plays.diagram` and
replaced whole — a drawing is edited as a drawing, never field by field.

```
{ v: 1,
  steps:  [{ id, caption, duration }],              the beats, in order
  tokens: [{ id, kind, x, y, label, playerId }],    where the pieces start
  paths:  [{ id, kind, step, tokenId, points[] }],  what moves, and when
  notes:  [{ id, step, x, y, text }],
  pen:    [{ id, step, points[] }] }
```

A path with a `tokenId` is what turns a drawing into an animation: that piece
travels the line during its step. Without one it is just an arrow.

**Coordinates are feet on a standard 200 × 85 sheet**, origin at the top-left
corner of the left-end boards. Real units mean the markings sit where they sit
in an arena — blue lines 64 ft off each goal line, end-zone dots 20 ft off it —
and the four framings (full sheet, d-zone, neutral zone, o-zone) are a change of
viewBox only, so a play drawn on the full sheet still reads when cropped.

`site/src/lib/rink.ts` owns the ice, `site/src/lib/play.ts` the document and its
geometry, `site/src/scripts/playback.ts` the player, `playeditor.ts` the board.

### Testing it

The API half runs with the rest of the suite (`api/test_plays.py`, real
Postgres). The browser half cannot be unit-tested — it is a drawing tool — so
there is a harness that drives the built site in headless chromium and plays the
coach:

```
cd site && npm run build
node tools/test_plays_ui.mjs                 # add --shots <dir> to keep the screenshots
```

## Installing it on a phone

The team was on Spordle's app. The replacement is not an app: the site installs
itself. `/` and `/login` carry an **Install app** card, and the whole thing —
manifest, icons, service worker — lives in `site/public/`.

Two platforms, two different truths behind one button:

| | what the button does |
|---|---|
| Android, Chrome, Edge, desktop Chrome | a real install. Chrome fires `beforeinstallprompt`, the card catches it, one tap installs. |
| iPhone, iPad | iOS has no install API and never has. The button opens the **Share → Add to Home Screen** steps instead of pretending. |

Either way the result is the same: the crest on the home screen, opening full
screen with no browser bar, pointed at the live site. There is nothing to
publish to a store and nothing for a parent to update.

Three things that are easy to get wrong here, all of them silent:

- **The gate has to let the manifest through.** nginx answers a signed-out
  request with `302 /login`; a redirected manifest or worker reads to Chrome as
  "not installable" and the prompt simply never appears. `/manifest.webmanifest`,
  `/sw.js` and `/icons/` are `auth_request off` in
  `nixos-builds/hosts/arachnea/guests/default.nix` for exactly that reason — and
  that is why installing from the sign-in page works at all.
- **The worker caches assets, never team data.** `/_astro`, `/fonts`, `/brand`
  and `/icons` only. Pages, `/api`, `/photos` and `/team` go straight to the
  network every time: the roster is nineteen minors behind a login, and a cache
  outlives the session.
- **The installed app has its own cookie jar.** The first launch asks for a
  sign-in again even though Safari or Chrome is already signed in. Once.

```
cd site && npm run build
node tools/test_pwa.mjs
```

drives the built site in headless chromium and checks the whole contract: the
manifest parses, every icon it names exists at the size it claims, the worker
activates and takes control, the cache holds the font and not the photo, the
card shows in a browser and hides inside the installed app, and an iPhone UA
gets the Share-sheet steps.

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


## Quality and security

Run `nix develop --command bash tools/check.sh` before publishing. This includes
strict TypeScript checks, unit tests, the real-PostgreSQL API suite, importer
checks, browser regressions and a check that public bundles contain no roster
names. See [the audit](docs/SECURITY-AUDIT.md) for findings, fixes, verification
and deployment requirements, and [deployment](docs/DEPLOY.md) for the current
session-gated hosting setup.

Account management is available at `/account`. Chat allows players to message
other players and linked guardians; all messages are screened and members can
report harmful content. Flagged/reported messages are visible to team admins,
as stated in the chat interface. The keyword filter complements human review.

Coach-entered scores, notes, family jobs, statistics and profile updates load
through the API. Roster/schedule imports and build-time next-game selections
still require a rebuild and publish.
