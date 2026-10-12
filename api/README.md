# lvlnb stats API

FastAPI + shared Postgres. Admins enter a whole scoresheet per game; season
totals are derived by query and never stored.

Roster and schedule are **not** owned here — they come from `data/*.json`,
written by the Spordle adapter. This service stores only what a human typed,
and validates every id against that contract.

## Run the tests

Real Postgres, in-process ASGI, no mocks:

```
nix-shell -p postgresql \
  "python312.withPackages(ps: with ps; [ fastapi uvicorn asyncpg bcrypt itsdangerous pydantic httpx ])" \
  --run "bash test.sh"
```

## Endpoints

| method | path | auth | |
|---|---|---|---|
| POST | `/api/auth/login` | — | email + password, sets HttpOnly cookie |
| POST | `/api/auth/logout` | session | |
| GET | `/api/auth/me` | session | who am I |
| GET | `/api/stats/season` | — | derived totals |
| GET | `/api/stats/game/{id}` | — | one scoresheet |
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
- **Login timing is constant** whether or not the email exists: an unknown user
  is compared against a dummy hash so a wrong email and a wrong password take
  the same time.
- **Only successful writes are audited.** Rejected attempts (401/403/404/400)
  do not create audit rows.
- `plus_minus` may be negative; everything else is non-negative, enforced by
  CHECK constraints as well as by Pydantic.

## Environment (`/opt/lvlnb/.env`, mode 0600)

```
DATABASE_URL=postgresql:///lvlnb
SESSION_SECRET=<32+ random bytes; the app refuses to start without it>
DATA_DIR=/srv/lvlnb-data
COOKIE_SECURE=1
```

## Creating an admin

```
python3 -c "import bcrypt,sys; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt()).decode())" 'THE-PASSWORD'
psql lvlnb -c "INSERT INTO users (email, display_name, password_hash, role)
               VALUES ('you@hexpi.ca', 'JL', '<hash>', 'admin')"
```
