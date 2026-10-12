# Handoff to the Spordle session

Two sessions built toward each other today without a shared interface. This
note closes that gap. Nothing is broken and nothing was lost — but our two
halves do not currently meet.

## What exists on each side

**Your side** (`tools/spordle/`) — extension capture on Helios →
`pull_helios.py` → `normalize.py`, writing:

```
private/spordle/223790/normalized/schedule.json   { games: [...], incomplete_dates: [...] }
private/spordle/223790/normalized/roster.json     { team_name, players: [...] }
```

**My side** (`site/`, `render/`) — an Astro site and a 4K game-day renderer that
read five files with different names, a different location and a different shape:

```
data/schedule.json    { version, source, events: [ {type:"game"|"practice", ...} ] }
data/roster.json      { version, source, privacy, players: [...], staff: [...] }
data/stats.json  data/news.json  data/opponents.json
```

`docs/DATA-CONTRACT.md` is the full specification of mine.

## The join

Please write `tools/spordle/to_data.py` mapping your normalized output onto
`data/*.json`. I deliberately did not write it myself: it has to be shaped by a
real capture, and you are the one who will have one. Keep your normalized files
as the raw layer — the adapter is a separate, testable step.

The mapping is mostly mechanical, with four things that will bite:

1. **`games` → `events`.** My file holds games *and* practices in one array
   discriminated by `type`. Practices matter — they are half of what parents
   come to the site for.
2. **Datetimes need an explicit offset.** `2026-10-13T17:30:00-03:00`, never
   naive. `America/Moncton` is `-03:00` in season and `-04:00` after the
   November change. A naive timestamp silently moves every game by an hour.
   The build rejects it rather than shipping it.
3. **Team ids must resolve.** `home.teamId` / `away.teamId` have to exist in
   `data/opponents.json`. When you meet a new club, add it there (name, short
   name, crest path, colours) in the same change.
4. **Unknown is `null`, not `0` or `""`.** A `0` score means they were shut
   out; `null` means the game has not been played.

Verify with `cd site && npm run validate` — it names the file, the JSON path and
the expected type. I tested it against both a naive datetime and a drifted team
id and it caught each.

## Privacy

`data/roster.json` carries a `privacy` block that gates what the public build
renders about minors. Sync the full data; the *site* decides what to show.
Defaults publish no photos, no birth years, and abbreviate surnames. Your
captures stay under `private/`, which is now gitignored.

## Housekeeping

My `git add -A` in commit `001ef41` swept your in-flight `tools/spordle/` files
into my commit. Nothing was lost and the tree is clean, but the commit is mixed
— apologies for the noise. I have since gitignored `tools/spordle/node_modules`,
`__pycache__` and `private/` and removed them from the index.

Also: **please claim the board** (`wip claim`) before further work here. I hold
`42753e0e` covering this repo; I own `site/`, `render/`, `assets/`, `docs/` and
the shape of `data/`. `tools/spordle/` and the contents of `data/` are yours.
