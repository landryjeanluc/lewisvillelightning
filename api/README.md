# lvlnb stats API

FastAPI + shared Postgres. Admins enter a whole scoresheet per game; season
totals are derived by query and never stored.

Roster and schedule are **not** owned here — they come from `data/*.json`,
written by the Spordle adapter. This service stores only what a human typed,
and validates every id against that contract.

## Run the tests

From the repository root, use the locked environment and an isolated PostgreSQL
cluster. HTTP requests run through ASGI; the mail-delivery boundary is mocked:

```
nix develop --command uv run --project api --frozen bash api/test.sh
```

`test_chat.py` and `test_plays.py` run inside `test_api.py`. `test_manage.py`
drives `manage.py` as a subprocess against a second database, because it seeds
whole families and should not assert around what the API tests left behind.
`test.sh` throws both databases away afterwards.

## Endpoints

| method | path | auth | |
|---|---|---|---|
| POST | `/api/auth/login` | — | email + password, sets HttpOnly cookie |
| POST | `/api/auth/logout` | session | |
| GET | `/api/auth/me` | — | current account, or null while signed out |
| GET | `/api/stats/season` | session | derived totals |
| GET | `/api/stats/game/{id}` | session | one scoresheet |
| PUT | `/api/stats/game/{id}` | **admin** | upsert the whole sheet |
| POST | `/api/reload` | **admin** | re-read data/*.json after a Spordle sync |
| GET | `/api/health` | — | |

## Deliberate behaviours

- **Whole-sheet PUT**, not per-player PATCH. The book is filled in one sitting,
  so "I fixed row 7" must be atomic. The endpoint deletes and re-inserts the
  game's rows inside one transaction.
- **A score mismatch warns, it does not reject.** If player goals do not sum to
  the final score the response carries a warning and still saves — real
  scoresheets disagree, and the person entering it is the authority.
- **Unknown accounts still run bcrypt** against a dummy hash to reduce account
  enumeration through timing. This does not promise identical response times.
- **Only successful writes are audited.** Rejected attempts (401/403/404/400)
  do not create audit rows.
- `plus_minus` may be negative; everything else is non-negative, enforced by
  CHECK constraints as well as by Pydantic.

## Environment (`/opt/lvlnb/.env`, mode 0600)

```
DATABASE_URL=postgresql:///lvlnb
SESSION_SECRET=<32+ random bytes; shorter keys are rejected>
PUBLIC_BASE_URL=https://lvlnb.ca
CHAT_PLAYER_DMS=peers
DATA_DIR=/srv/lvlnb-data
COOKIE_SECURE=1
```

## Creating an admin

```
cd api
uv run --frozen python manage.py add you@example.com "Team administrator" --admin
```

Run interactively so the CLI prompts for a password without putting it in shell
history. The database must already have been initialized by the API.

## Family logins

`manage.py` seeds one login per grown-up per player, plus one for the kid, and
writes a per-family handout under `api/private/family-logins/` (gitignored):

```
python manage.py seed-families                   # Mom + Dad + the player
python manage.py seed-families --relationships Mom,Dad,Guardian
python manage.py add-guardian pl-02 "Grandma"    # one more login for one family
python manage.py rename-families --dry-run       # re-label from the roster
```

A parent account is named **`<relationship> to <full name>`** — "Mom to Olivier
Landry", not "Mom to Olivier". That display name is the only thing the chat
directory, the admin user list and the account menu show, and two players can
share a first name: the roster carries both Olivier Landry and Olivier LeBlanc,
so the short form named neither of them. A last initial is no help either —
both of those surnames start with L.

`rename-families` recomputes those labels for every account with a `player_id`,
which is how the short names seeded before 2026-10-13 get fixed. It writes
nothing but `display_name` — no password, no `session_epoch` — so it is safe on
the live box and signs nobody out. Rows whose `player_id` has left the roster,
or that have no `relationship` recorded (a name typed by hand in the admin UI),
are reported and left alone. `--dry-run` prints the changes and writes nothing.

The login handle itself already carried the full name (`mom.olivier-leblanc`),
so no handle changes and no handout is stale.

## Game jobs

A job belongs to a **family**, not a person. The admin puts a family on the
hook; the parents sort out between themselves who actually turns up, and
whichever of them it is claims it so the rest of the team can see it is
covered. Reassigning a job to a different family drops the old claim.

| method | path | auth | |
|---|---|---|---|
| GET | `/api/jobs/types` | session | the reusable job list |
| GET | `/api/jobs/suggestions` | session | known extras this team has not added |
| POST | `/api/jobs/types` | **admin** | add a job; no `sort` lands it at the end |
| DELETE | `/api/jobs/types/{id}` | **admin** | drop a job; reports the assignments that cascaded |
| POST | `/api/jobs/seed-defaults` | **admin** | add the standard three, skipping any already there |
| GET | `/api/jobs/{game_id}` | session | every job for one game, who is on the hook, who claimed it |
| PUT | `/api/jobs/{game_id}` | **admin** | assign families; only the listed jobs are touched |
| POST | `/api/jobs/{game_id}/{type_id}/claim` | parent | take it, or hand it back with `?release=1` |

**Seeding stays small on purpose.** `seed-defaults` adds 50/50 tickets, the
scoresheet and the timekeeper — the jobs a night actually needs. Penalty box,
jerseys and snacks are in `OPTIONAL_JOBS` instead: real jobs for some teams,
but seeding them here filled every game page with rows nobody signed. The
admin panel offers them one at a time from `/jobs/suggestions`, and a job
already on the list stops being offered.

Anything else is typed in: a tournament gate, a hotel wrangler, a driver.
Those post without a `sort`, so they land after the standard set in creation
order rather than all colliding on the same number.

Dropping a job drops it from **every** game — `game_jobs` cascades on the
foreign key — so the delete counts the assignments first and returns
`assignments_removed`, which is what the panel warns with. There is no gentler
retire yet: `job_types.active` exists and `/jobs/{game_id}` filters on it, but
nothing flips it on a job that already exists, so dropping is the only way out
of the list today.

The panel is covered twice: the contracts above in `test_api.py`, and the
browser half by `node tools/test_jobs_ui.mjs` — adding an offered job,
inventing one, the confirm before a drop, and both views refreshing together.

## Team chat

`/chat` uses existing team logins, including parents, players and viewers. It
provides a shared team room and one-to-one conversations. The directory returns
display names and account IDs for permitted recipients, never email addresses.
Players may privately message other players and linked guardians; unrelated
adults communicate with players in the team room. All sends are screened and
flagged/reported message bodies can be reviewed by admins, as disclosed in chat. Each person needs their
own account to receive private messages under their own name.

All `/api/chat/*` endpoints require a valid session and return `Cache-Control:
no-store`. Only the two participants can list, read or write a direct
conversation, including when another account is an admin. Members can remove
their own messages; admins can also remove messages in the team room. Removal
erases the body and leaves a tombstone, with the actor and message ID audited.

| method | path | purpose |
|---|---|---|
| GET | `/api/chat/members` | Choose a recipient |
| GET | `/api/chat/conversations` | Rooms, latest message and unread counts |
| POST | `/api/chat/direct` | Open/reuse a conversation with `user_id` |
| GET | `/api/chat/conversations/{id}/messages` | Latest 50; `before` loads older IDs, `after` polls revisions |
| POST | `/api/chat/conversations/{id}/messages` | Send `body` and a retry-safe UUID `client_id` |
| POST | `/api/chat/conversations/{id}/read` | Advance to a displayed `message_id` |
| DELETE | `/api/chat/conversations/{id}/messages/{message_id}` | Remove a message |

Messages are plain text, limited to 2,000 characters and 30 sends per account
per minute. The browser polls every four seconds while visible; revision
cursors also deliver removals. History and update pages return `has_more`.
Unread markers advance only while the conversation is visible at the bottom.
Drafts stay in memory when switching conversations or retrying a failed send;
they do not survive a page reload. There are no attachments or push/email
notifications in this version.

Deployment uses the existing `deploy.sh`: it copies `chat.py` with the API and
restarts the service, which applies the additive tables in `schema.sql`.
No extra service or dependency is required. `test_chat.py` runs as part of
`test_api.py`; `test.sh` creates isolated temporary databases for each run.

## Plays of the week

`/plays` stores the coach's diagrams. Reading needs a session, as do the other
team-data endpoints, and writing needs an admin. Drafts are
invisible to everyone but admins, and all responses are `Cache-Control: no-store`.

| method | path | auth | |
|---|---|---|---|
| GET | `/api/plays` | session | every play the caller may see, newest week first |
| GET | `/api/plays/{slug}` | session | one play |
| POST | `/api/plays` | **admin** | create; the title becomes the slug |
| PUT | `/api/plays/{id}` | **admin** | replace the whole play |
| DELETE | `/api/plays/{id}` | **admin** | |

Deliberate behaviours:

- **The diagram is validated, not trusted.** It arrives as JSON from a browser
  and lands in JSONB, so `plays.py` bounds-checks every coordinate against the
  200 × 85 sheet, caps every collection, and rejects a document that could not
  be drawn: a line bound to a piece that is not on the ice, a step number past
  the end of the play, one piece running two lines in the same step, duplicate
  ids. A silently-dropped movement would leave the coach wondering why his
  winger never leaves the wall.
- **Whole-document PUT.** There is no "patch token 7".
- **Publishing stamps `published_at` once.** Re-saving a published play does not
  bump it back to the top of the board.
- **A play with nothing on it is allowed** — the coach saves the name first and
  draws it at the rink.
- `week_of` is a real `DATE`; null means evergreen rather than weekly.
- The list endpoint returns diagrams, so the index can draw a real miniature of
  each play. A season of documents is a few tens of kilobytes.

## Training goals

`/goals` is a live training board. Admins set either a **shared team target**
(e.g. 1,000 off-ice shots) or an **individual player target** (e.g. 50 squats).
Targets use shots, repetitions, minutes or seconds, with inclusive start/end
dates in `America/Moncton`. The page has this-week and next-week shortcuts.
Each date range is its own goal; nothing automatically resets or recurs.

Players and parents use their existing `users.player_id` family link. Both
can add activity and remove incorrect entries for that player. Admins can
record activity for any roster player. Unlinked accounts and viewers can
read shared team totals but cannot contribute. Individual goals and activity
history are visible only to admins and the linked family; team totals include
everyone, while a family's team activity history contains only its own entries.

| method | path | purpose |
|---|---|---|
| GET | `/api/goals` | Authorized goals, totals, available players and team-local date |
| POST | `/api/goals` | Admin creates a team or individual target |
| PUT | `/api/goals/{id}` | Admin edits or archives a goal |
| GET | `/api/goals/{id}/entries` | Latest 100 visible activity entries |
| POST | `/api/goals/{id}/entries` | Add `player_id`, `amount`, `performed_on`, retry-safe UUID `client_id` |
| DELETE | `/api/goals/{id}/entries/{entry_id}` | Remove an incorrect entry; retain audit history |

Progress is summed from activity entries, never overwritten with a browser's
running total. Retries reuse a client UUID, including after a lost response;
removing an entry does not let a retry resurrect it. One entry counts toward
one goal only. Activity can exceed a target and can be backfilled into a past
period, but cannot be future-dated or outside the goal's dates. Archived goals
reject new activity. Once a goal has activity, its player, scope, unit and date
range are fixed; its title, target and archived state can still change.

The shot counter and stopwatch are page-local tools. Saving subtracts the
logged amount only after success; the stopwatch saves whole units and retains
the remainder. Failed requests preserve the session for retry. Tools only log
to current goals of the matching unit. Leaving the page discards unsaved tool
state, with a browser navigation warning where supported. Saved progress lives
in Postgres and is shared across logins and devices.

`schema.sql` adds the tables on API restart; normal `deploy.sh` includes the
module. `test_goals.py` runs with `api/test.sh`. Build the site and run
`node tools/test_goals_ui.mjs` for browser coverage of admin creation, family
views, failed-save retries, counters, timer logging and mobile layout.


## Audit hardening

Every application route requires a session by default except the explicit
health/sign-in/recovery endpoints and anonymous session check. Responses use
no-store, including validation failures. New routers inherit these defaults.
The application rejects cross-origin writes and bounds request bytes; the proxy
must independently protect static pages and media. See `../docs/SECURITY-AUDIT.md`.

Use `uv sync --frozen` for development and `uv sync --frozen --no-dev` in production.
`uv run --project api --frozen bash api/test.sh` from the repository root runs the
unit/API/CLI suites against an isolated PostgreSQL cluster. PostgreSQL must be on
PATH; `nix develop` supplies it. Browser coverage and the build are included by
`tools/check.sh`.

`POST /api/chat/conversations/{id}/messages/{message_id}/report` shares that
message with admins. Reviewing a flag as removed now removes the matching
published content. Approving a held flag closes the review; it does not create
an unsent message or publish a rejected edit. Reports require staff attention;
there are no automated staff notifications.

Logout revokes all of the account's sessions and asks the browser to clear
site cache/storage. `/account` provides password changes and logout for every
role. New family handouts contain 144-bit random credentials; existing weak
credentials are not rotated by deployment. See the deployment transition steps.
