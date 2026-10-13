# Lewisville Lightning — data contract v1

The website builds **only** from the five JSON files in `data/`. Nothing in the site
scrapes Spordle at runtime. If you are the session wiring up Spordle: your job is to
replace these files wholesale and keep them valid against this contract.

| File | Owner | Contains |
|---|---|---|
| `data/schedule.json`  | Spordle session | games + practices, past and future |
| `data/roster.json`    | Spordle session | players and staff |
| `data/stats.json`     | Spordle session | skater + goalie + team stats |
| `data/news.json`      | Spordle session | news articles |
| `data/opponents.json` | site session    | opponent names, crests, colours |

Everything currently in those files except the 2026-10-13 game is **fixture data**,
marked with a `note` in its `source` block. Placeholder player names are deliberately
fake ("Player Nine") — do not treat them as a real roster.

## Rules that apply to every file

1. **`version` is `1`.** Bump only with a matching change here.
2. **Every file carries a `source` block**: `{ provider, teamId, fetchedAt }`.
   `fetchedAt` is a full ISO-8601 timestamp *with offset*, or `null` if never synced.
3. **All datetimes are ISO-8601 with an explicit offset** — `2026-10-13T17:30:00-03:00`.
   Never emit a naive local time. New Brunswick is `America/Moncton`
   (ADT `-03:00` summer, AST `-04:00` winter) — a DST-naive sync *will* put
   games at the wrong hour, which is the single most damaging bug this site can ship.
4. **IDs are stable strings** and must not change between syncs — they become URLs.
   Keep the upstream Spordle id in the `spordleId` field alongside.
5. **Unknown values are `null`, never `""`, `0`, or omitted.** The build
   distinguishes "no score yet" from "scored zero".
6. Writes are atomic: write a temp file, validate, then rename over the target.

## `schedule.json`

One `events` array holding both games and practices, discriminated by `type`.

```jsonc
{
  "id": "g-2026-10-13-shediac",   // stable; becomes /schedule/<id>
  "type": "game",                  // "game" | "practice"
  "startsAt": "2026-10-13T17:30:00-03:00",
  "endsAt": null,
  "venue": { "name": "Kay Arena", "surface": null, "address": null, "mapUrl": null },
  "home": { "teamId": "lewisville-lightning", "score": null },
  "away": { "teamId": "shediac-cap-pele-predators", "score": null },
  "status": "scheduled",           // scheduled | in_progress | final | postponed | cancelled
  "gameType": "regular",           // regular | exhibition | playoff | tournament
  "league": "U13 B",
  "notes": null,
  "spordleId": null
}
```

- `home.teamId` / `away.teamId` **must** match an `id` in `opponents.json`. If you meet a
  team that isn't there, add it there too — an unknown id fails the build loudly.
- Which side Lewisville is on determines home vs away everywhere, including poster layout.
  Do not encode home/away any other way.
- `score` stays `null` until `status` is `final`.
- Practices may set `practiceKind` to `on_ice` (the default for existing records) or `off_ice`. Off-ice sessions use the same venue, timing, cancellation and calendar fields as ice sessions.
- `practice` events carry `id, type, startsAt, endsAt, venue, status, notes` and no teams.

## `roster.json`

```jsonc
{ "id": "pl-09", "number": 9, "firstName": "...", "lastName": "...",
  "position": "C",      // C | LW | RW | F | D | G
  "shoots": "L",        // L | R | null
  "birthYear": null, "photo": null, "cardArt": null,
  "captain": "C",       // "C" | "A" | null
  "affiliate": false }
```

`photo` and `cardArt` are repo-relative paths under `assets/photos/`, or `null`.
`cardArt` is the hockey-card artwork; the player page falls back to a generated card
when it is `null`.

### Privacy — read this before you sync real children

These are minors. The roster file has a `privacy` block that gates what the public
build renders:

```jsonc
"privacy": {
  "publicNameFormat": "first-initial-last",  // full | first-initial-last | first-only | number-only
  "publishBirthYear": false,
  "publishPhotos": false
}
```

Sync the full data into `roster.json` — the *site* decides what to show. The default
is deliberately conservative: a public page combining a child's full name, photo, and
a schedule saying exactly which arena they'll be at on Tuesday at 5:30 is a genuine
safety problem, not a hypothetical one. JL decides the setting; the contract just makes
it one line instead of a rewrite.

## `stats.json`

`team` is the record. `skaters[]` and `goalies[]` key to players by `playerId`, which
**must** exist in `roster.json`.

- Skater: `gp g a pts pim ppg shg gwg`
- Goalie: `gp w l otl ga sa sv svPct gaa so min`
- Derived values (`pts`, `svPct`, `gaa`) — send them if Spordle gives them, else `null`
  and the site computes. Don't send `0` to mean "unknown".
- `asOf` is the date the stats were current.

## `news.json`

```jsonc
{ "id": "n-0001", "title": "...", "slug": "...",
  "publishedAt": "2026-10-12T09:00:00-03:00",
  "author": null, "summary": "...",
  "body": "markdown",
  "image": null, "tags": [], "spordleId": null, "lang": "en" }
```

`body` is **Markdown**, not HTML — if Spordle hands you HTML, convert it and strip
scripting/styling. `slug` is URL-safe and stable; it becomes `/news/<slug>`.
`lang` is `"en"` or `"fr"` (see below).

## Bilingual content

Lewisville is in greater Moncton and the division includes strongly francophone clubs
(Shediac, Cap-Pelé). `lang` exists on articles from day one. Full site bilingualism is
an open question for JL, but **do not drop French content** if Spordle carries it —
tag it `fr` and keep it.

## Validating your output

```
cd site && npm run validate      # checks all five files against the Zod schemas
```

It prints the offending file, JSON path, and expected type. A failing validate must
never be committed — the site build runs the same schemas and will fail the same way.

## Coordination

The site session holds the WIP claim `42753e0e` covering this repo. **Claim the board
before you write here** (`wip board`, then `wip claim`), and stay inside `data/`
plus whatever fetcher directory you create. The site session owns `site/`, `assets/`,
`render/`, and `docs/`.
