"""
Lewisville Lightning stats API.

Admins enter a whole scoresheet per game; season totals are derived by query.
Roster and schedule are NOT owned here — they come from data/*.json, which the
Spordle adapter writes. This service only stores what a human typed.

Run:  uvicorn app:app --host 127.0.0.1 --port 8112
Env:  DATABASE_URL, SESSION_SECRET, DATA_DIR, COOKIE_SECURE
"""
from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

import asyncpg
import bcrypt
from fastapi import Cookie, Depends, FastAPI, HTTPException, Response, status
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql:///lvlnb")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"
SESSION_MAX_AGE = 60 * 60 * 24 * 30          # 30 days — a season's worth of games
COOKIE_NAME = "lvlnb_session"

if not SESSION_SECRET:
    # Refuse to start rather than silently sign sessions with a guessable key.
    raise SystemExit("SESSION_SECRET is required (set it in /opt/lvlnb/.env)")

signer = URLSafeTimedSerializer(SESSION_SECRET, salt="lvlnb-session")

# ---------------------------------------------------------------- contract --

class Contract:
    """Valid game and player ids, read from the data contract on disk.

    Reloadable: the Spordle sync rewrites these files, and the API must not
    need a restart to accept a newly scheduled game.
    """

    def __init__(self) -> None:
        self.games: dict[str, dict] = {}
        self.players: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        sched = json.loads((DATA_DIR / "schedule.json").read_text())
        roster = json.loads((DATA_DIR / "roster.json").read_text())
        self.games = {e["id"]: e for e in sched["events"] if e["type"] == "game"}
        self.players = {p["id"]: p for p in roster["players"]}

contract = Contract()

# ---------------------------------------------------------------- lifespan --

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=8)
    async with app.state.pool.acquire() as c:
        await c.execute((Path(__file__).parent / "schema.sql").read_text())
    yield
    await app.state.pool.close()

app = FastAPI(title="lvlnb stats", lifespan=lifespan, root_path="/api")

async def db() -> asyncpg.Pool:
    return app.state.pool

# -------------------------------------------------------------------- auth --

class User(BaseModel):
    id: int
    email: str
    display_name: str
    role: Literal["admin", "viewer"]

async def current_user(
    pool: Annotated[asyncpg.Pool, Depends(db)],
    lvlnb_session: Annotated[str | None, Cookie()] = None,
) -> User | None:
    if not lvlnb_session:
        return None
    try:
        uid = signer.loads(lvlnb_session, max_age=SESSION_MAX_AGE)
    except BadSignature:
        return None
    row = await pool.fetchrow(
        "SELECT id, email, display_name, role FROM users WHERE id = $1", uid
    )
    return User(**dict(row)) if row else None

async def require_admin(user: Annotated[User | None, Depends(current_user)]) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin role required")
    return user

class LoginBody(BaseModel):
    email: str
    password: str

@app.post("/auth/login")
async def login(body: LoginBody, response: Response, pool: Annotated[asyncpg.Pool, Depends(db)]):
    row = await pool.fetchrow(
        "SELECT id, email, display_name, role, password_hash FROM users WHERE lower(email) = lower($1)",
        body.email,
    )
    # Compare against a dummy hash when the user is unknown so a wrong email and
    # a wrong password take the same time to answer.
    stored = row["password_hash"] if row else "$2b$12$" + "." * 53
    ok = bcrypt.checkpw(body.password.encode(), stored.encode())
    if not row or not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong email or password")

    await pool.execute("UPDATE users SET last_login_at = now() WHERE id = $1", row["id"])
    response.set_cookie(
        COOKIE_NAME, signer.dumps(row["id"]),
        max_age=SESSION_MAX_AGE, httponly=True, samesite="lax", secure=COOKIE_SECURE, path="/",
    )
    return User(**{k: row[k] for k in ("id", "email", "display_name", "role")})

@app.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}

@app.get("/auth/me")
async def me(user: Annotated[User | None, Depends(current_user)]):
    return user

# ------------------------------------------------------------------- stats --

class PlayerLine(BaseModel):
    player_id: str
    g: int = Field(0, ge=0)
    a: int = Field(0, ge=0)
    pim: int = Field(0, ge=0)
    plus_minus: int = 0          # negative is legitimate

class Scoresheet(BaseModel):
    our_score: int | None = Field(None, ge=0)
    their_score: int | None = Field(None, ge=0)
    status: Literal["scheduled", "in_progress", "final", "postponed", "cancelled"] = "final"
    lines: list[PlayerLine] = []

@app.get("/health")
async def health(pool: Annotated[asyncpg.Pool, Depends(db)]):
    await pool.fetchval("SELECT 1")
    return {"ok": True, "games": len(contract.games), "players": len(contract.players)}

@app.post("/reload")
async def reload_contract(_: Annotated[User, Depends(require_admin)]):
    """Re-read data/*.json after a Spordle sync, without a restart."""
    contract.load()
    return {"games": len(contract.games), "players": len(contract.players)}

@app.get("/stats/game/{game_id}")
async def game_stats(game_id: str, pool: Annotated[asyncpg.Pool, Depends(db)]):
    if game_id not in contract.games:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown game {game_id}")
    result = await pool.fetchrow(
        "SELECT our_score, their_score, status, updated_at FROM game_results WHERE game_id = $1",
        game_id,
    )
    rows = await pool.fetch(
        "SELECT player_id, g, a, pim, plus_minus FROM game_stats WHERE game_id = $1", game_id
    )
    return {
        "game_id": game_id,
        "result": dict(result) if result else None,
        "lines": [dict(r) for r in rows],
    }

@app.put("/stats/game/{game_id}")
async def put_game_stats(
    game_id: str,
    sheet: Scoresheet,
    user: Annotated[User, Depends(require_admin)],
    pool: Annotated[asyncpg.Pool, Depends(db)],
):
    if game_id not in contract.games:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown game {game_id}")
    unknown = [l.player_id for l in sheet.lines if l.player_id not in contract.players]
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown player ids: {unknown}")

    # The whole sheet is written at once so "I fixed row 7" is atomic.
    async with pool.acquire() as c, c.transaction():
        await c.execute(
            """INSERT INTO game_results (game_id, our_score, their_score, status, updated_by, updated_at)
               VALUES ($1,$2,$3,$4,$5, now())
               ON CONFLICT (game_id) DO UPDATE SET
                 our_score=EXCLUDED.our_score, their_score=EXCLUDED.their_score,
                 status=EXCLUDED.status, updated_by=EXCLUDED.updated_by, updated_at=now()""",
            game_id, sheet.our_score, sheet.their_score, sheet.status, user.id,
        )
        await c.execute("DELETE FROM game_stats WHERE game_id = $1", game_id)
        if sheet.lines:
            await c.executemany(
                """INSERT INTO game_stats (game_id, player_id, g, a, pim, plus_minus, updated_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7)""",
                [(game_id, l.player_id, l.g, l.a, l.pim, l.plus_minus, user.id) for l in sheet.lines],
            )
        await c.execute(
            "INSERT INTO audit_log (user_id, action, game_id, payload) VALUES ($1,'put_scoresheet',$2,$3)",
            user.id, game_id, json.dumps(sheet.model_dump()),
        )

    # A scoresheet that disagrees with the final score is reported, not refused:
    # real scoresheets disagree, and the person entering it is the authority.
    goals = sum(l.g for l in sheet.lines)
    warnings = []
    if sheet.our_score is not None and goals != sheet.our_score:
        warnings.append(
            f"player goals total {goals} but the final score says {sheet.our_score}"
        )
    return {"ok": True, "saved": len(sheet.lines), "warnings": warnings}

@app.get("/stats/season")
async def season(pool: Annotated[asyncpg.Pool, Depends(db)]):
    """Season totals, derived. Nothing aggregate is ever stored."""
    skaters = await pool.fetch(
        """SELECT player_id,
                  count(*)              AS gp,
                  coalesce(sum(g),0)    AS g,
                  coalesce(sum(a),0)    AS a,
                  coalesce(sum(g+a),0)  AS pts,
                  coalesce(sum(pim),0)  AS pim,
                  coalesce(sum(plus_minus),0) AS plus_minus
             FROM game_stats GROUP BY player_id"""
    )
    res = await pool.fetch(
        "SELECT our_score, their_score FROM game_results WHERE status = 'final'"
    )
    w = sum(1 for r in res if r["our_score"] is not None and r["our_score"] > r["their_score"])
    l = sum(1 for r in res if r["our_score"] is not None and r["our_score"] < r["their_score"])
    t = sum(1 for r in res if r["our_score"] is not None and r["our_score"] == r["their_score"])
    gf = sum(r["our_score"] or 0 for r in res)
    ga = sum(r["their_score"] or 0 for r in res)

    def enrich(r):
        p = contract.players.get(r["player_id"], {})
        return {**dict(r), "number": p.get("number"),
                "firstName": p.get("firstName"), "lastName": p.get("lastName"),
                "position": p.get("position")}

    return {
        "asOf": datetime.now(timezone.utc).isoformat(),
        "team": {"gp": len(res), "w": w, "l": l, "t": t, "otl": 0,
                 "gf": gf, "ga": ga, "pts": w * 2 + t},
        "skaters": sorted((enrich(r) for r in skaters),
                          key=lambda x: (-x["pts"], -x["g"], x["number"] or 99)),
    }
