"""
Lewisville Lightning stats API.

Admins enter a whole scoresheet per game; season totals are derived by query.
Roster and schedule are NOT owned here — they come from data/*.json, which the
Spordle adapter writes. This service only stores what a human typed.

Run:  uvicorn app:app --host 127.0.0.1 --port 8112
Env:  DATABASE_URL, SESSION_SECRET, DATA_DIR, COOKIE_SECURE
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import smtplib
from email.message import EmailMessage
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from math import isfinite
from pathlib import Path
from typing import Annotated, Literal

import asyncpg
import bcrypt
from fastapi import (Cookie, Depends, FastAPI, File, Form, HTTPException,
                     Request, Response, UploadFile, status)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field, field_validator

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql:///lvlnb")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"
SESSION_MAX_AGE = 60 * 60 * 24 * 30          # 30 days — a season's worth of games
COOKIE_NAME = "lvlnb_session"

# Brute force: a wrong password is cheap for an attacker and expensive for us,
# so count failures in a rolling window and refuse past a threshold. Per-email
# stops someone grinding one account; per-IP stops them spraying many.
LOCKOUT_WINDOW   = timedelta(minutes=15)
MAX_FAILS_EMAIL  = 5
MAX_FAILS_IP     = 20
RESET_TTL        = timedelta(hours=1)
PUBLIC_BASE_URL  = os.environ.get("PUBLIC_BASE_URL", "https://lvlnb.ca")

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", "no-reply@lvlnb.ca")

log = logging.getLogger("lvlnb")

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

@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    """Return 422 even when the rejected value cannot be written as JSON.

    Pydantic echoes the offending input back inside the error detail, and JSON
    has no NaN or Infinity — so a single not-a-number coordinate made the error
    response itself fail to serialise, and the caller got an opaque 500 instead
    of being told which field was wrong. Scrub those values out of the detail.
    """
    def clean(v):
        if isinstance(v, float) and not isfinite(v):
            return repr(v)                      # "nan" / "inf", as a string
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [clean(x) for x in v]
        if isinstance(v, (str, int, bool, type(None))):
            return v
        return str(v)
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        content={"detail": clean(exc.errors())})

async def db() -> asyncpg.Pool:
    return app.state.pool

# -------------------------------------------------------------------- auth --

class User(BaseModel):
    id: int
    email: str
    display_name: str
    role: Literal["admin", "parent", "player", "viewer"]

async def current_user(
    pool: Annotated[asyncpg.Pool, Depends(db)],
    lvlnb_session: Annotated[str | None, Cookie()] = None,
) -> User | None:
    if not lvlnb_session:
        return None
    try:
        payload = signer.loads(lvlnb_session, max_age=SESSION_MAX_AGE)
    except BadSignature:
        return None
    # Older cookies carried a bare id; treat them as epoch 1.
    uid, epoch = payload if isinstance(payload, list) else (payload, 1)
    row = await pool.fetchrow(
        "SELECT id, email, display_name, role, session_epoch FROM users WHERE id = $1", uid
    )
    if row is None or row["session_epoch"] != epoch:
        return None          # password changed since this cookie was issued
    return User(**{k: row[k] for k in ("id", "email", "display_name", "role")})

async def require_admin(user: Annotated[User | None, Depends(current_user)]) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin role required")
    return user

def client_ip(request) -> str:
    # nginx sets X-Forwarded-For; trust the first hop since only our own proxy
    # can reach this service (it listens on loopback).
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")

def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()

def send_mail(to: str, subject: str, body: str) -> bool:
    """Send if SMTP is configured; otherwise say so rather than pretending."""
    if not SMTP_HOST:
        return False
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP_FROM, to, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            s.starttls()
            if SMTP_USER:
                s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
        return True
    except Exception as exc:                      # noqa: BLE001 - never 500 a login flow
        log.warning("reset email to %s failed: %s", to, exc)
        return False

async def _recent_failures(c, email: str, ip: str) -> tuple[int, int]:
    since = datetime.now(timezone.utc) - LOCKOUT_WINDOW
    by_email = await c.fetchval(
        "SELECT count(*) FROM login_attempts"
        " WHERE lower(email) = lower($1) AND success = false AND at > $2", email, since)
    by_ip = await c.fetchval(
        "SELECT count(*) FROM login_attempts"
        " WHERE ip = $1 AND success = false AND at > $2", ip, since)
    return by_email, by_ip

class LoginBody(BaseModel):
    email: str
    password: str

@app.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response,
                pool: Annotated[asyncpg.Pool, Depends(db)]):
    ip = client_ip(request)
    async with pool.acquire() as c:
        fails_email, fails_ip = await _recent_failures(c, body.email, ip)
        if fails_email >= MAX_FAILS_EMAIL or fails_ip >= MAX_FAILS_IP:
            # Record the blocked try too, so hammering extends the window
            # rather than resetting it.
            await c.execute(
                "INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,false)",
                body.email, ip)
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "too many failed sign-ins — wait 15 minutes and try again",
                headers={"Retry-After": str(int(LOCKOUT_WINDOW.total_seconds()))},
            )

        row = await c.fetchrow(
            "SELECT id, email, display_name, role, password_hash, session_epoch"
            " FROM users WHERE lower(email) = lower($1)", body.email)
        # Compare against a dummy hash when the user is unknown so a wrong email
        # and a wrong password take the same time to answer.
        stored = row["password_hash"] if row else "$2b$12$" + "." * 53
        ok = bcrypt.checkpw(body.password.encode(), stored.encode())

        await c.execute(
            "INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,$3)",
            body.email, ip, bool(row and ok))

        if not row or not ok:
            left = MAX_FAILS_EMAIL - (fails_email + 1)
            detail = "wrong email or password"
            if 0 < left <= 2:
                detail += f" — {left} attempt{'s' if left > 1 else ''} left before a 15 minute lockout"
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail)

        await c.execute("UPDATE users SET last_login_at = now() WHERE id = $1", row["id"])

    response.set_cookie(
        COOKIE_NAME, signer.dumps([row["id"], row["session_epoch"]]),
        max_age=SESSION_MAX_AGE, httponly=True, samesite="lax", secure=COOKIE_SECURE, path="/",
    )
    return User(**{k: row[k] for k in ("id", "email", "display_name", "role")})

@app.get("/auth/verify")
async def verify(user: Annotated[User | None, Depends(current_user)]):
    """For nginx auth_request: 204 when the session is good, 401 otherwise.

    nginx consults this for every request to the static site, which is how a
    plain static build can still be behind a login.
    """
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not signed in")
    return Response(status_code=status.HTTP_204_NO_CONTENT)

class ForgotBody(BaseModel):
    email: str

@app.post("/auth/forgot")
async def forgot(body: ForgotBody, request: Request,
                 pool: Annotated[asyncpg.Pool, Depends(db)]):
    """Always answers the same, whether or not the address has an account —
    otherwise this endpoint becomes a way to enumerate who is on the team."""
    ip = client_ip(request)
    row = await pool.fetchrow(
        "SELECT id, email, display_name FROM users WHERE lower(email) = lower($1)", body.email)
    emailed = False
    if row:
        raw = secrets.token_urlsafe(32)
        await pool.execute(
            "INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)"
            " VALUES ($1,$2,$3,$4)",
            row["id"], _hash_token(raw),
            datetime.now(timezone.utc) + RESET_TTL, ip)
        link = f"{PUBLIC_BASE_URL}/reset?token={raw}"
        emailed = send_mail(
            row["email"], "Reset your Lewisville Lightning password",
            f"Hi {row['display_name']},\n\n"
            f"Use this link within the hour to choose a new password:\n\n{link}\n\n"
            "If you did not ask for this, you can ignore it — nothing has changed.\n")
        if not emailed:
            # No SMTP configured. Do not drop it silently: record it so an admin
            # can hand the link over, and say so in the log.
            await pool.execute(
                "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'reset_link_undelivered',$2)",
                row["id"], json.dumps({"email": row["email"], "link": link}))
            log.warning("SMTP not configured — reset link for %s: %s", row["email"], link)
    return {"ok": True,
            "detail": "If that address has an account, a reset link is on its way.",
            "delivered": emailed}

class ResetBody(BaseModel):
    token: str
    password: str

    @field_validator("password")
    @classmethod
    def _pw(cls, v: str) -> str:
        if len(v) < MIN_PASSWORD:
            raise ValueError(f"password must be at least {MIN_PASSWORD} characters")
        return v

@app.post("/auth/reset")
async def reset(body: ResetBody, pool: Annotated[asyncpg.Pool, Depends(db)]):
    async with pool.acquire() as c, c.transaction():
        row = await c.fetchrow(
            "SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1",
            _hash_token(body.token))
        now = datetime.now(timezone.utc)
        if row is None or row["used_at"] is not None or row["expires_at"] < now:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "that reset link is invalid or has expired")
        # Bumping session_epoch logs out every device that was already signed in
        # as this user — the point of a reset.
        await c.execute(
            "UPDATE users SET password_hash = $1, session_epoch = session_epoch + 1"
            " WHERE id = $2", hash_password(body.password), row["user_id"])
        await c.execute("UPDATE password_resets SET used_at = now() WHERE id = $1", row["id"])
        # Any other outstanding link for this user is now moot.
        await c.execute(
            "UPDATE password_resets SET used_at = now()"
            " WHERE user_id = $1 AND used_at IS NULL", row["user_id"])
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'password_reset',$2)",
            row["user_id"], json.dumps({"via": "reset_link"}))
        # A successful reset clears the lockout, so a locked-out user who
        # resets can get straight back in.
        await c.execute(
            "DELETE FROM login_attempts WHERE lower(email) ="
            " (SELECT lower(email) FROM users WHERE id = $1)", row["user_id"])
    return {"ok": True}

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

# ------------------------------------------------------------------- users --

MIN_PASSWORD = 8

def hash_password(raw: str) -> str:
    return bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()

class NewUser(BaseModel):
    email: str
    display_name: str
    password: str
    role: Literal["admin", "parent", "player", "viewer"] = "viewer"
    player_id: str | None = None
    relationship: str | None = None

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        """Accept an email OR a plain handle.

        Seeded family logins look like "mom.olivier-landry" — JL has no parent
        email list, and demanding one would block handing out accounts at all.
        """
        v = v.strip().lower()
        if "@" in v:
            if "." not in v.split("@")[-1]:
                raise ValueError("not a valid email address")
        elif not __import__("re").fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", v):
            raise ValueError("handle must be 3-64 chars: letters, digits, dot, dash, underscore")
        return v

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        if len(v) < MIN_PASSWORD:
            raise ValueError(f"password must be at least {MIN_PASSWORD} characters")
        return v

class UserPatch(BaseModel):
    display_name: str | None = None
    role: Literal["admin", "parent", "player", "viewer"] | None = None
    player_id: str | None = None
    relationship: str | None = None
    password: str | None = None

    @field_validator("password")
    @classmethod
    def _password(cls, v: str | None) -> str | None:
        if v is not None and len(v) < MIN_PASSWORD:
            raise ValueError(f"password must be at least {MIN_PASSWORD} characters")
        return v

async def _admin_count(c) -> int:
    return await c.fetchval("SELECT count(*) FROM users WHERE role = 'admin'")

async def _guard_last_admin(c, target_id: int, *, becoming: str | None) -> None:
    """Refuse any change that would leave the team with no admin.

    Losing the last admin means nobody can add one back without shell access to
    the box, so this is a hard stop rather than a warning.
    """
    row = await c.fetchrow("SELECT role FROM users WHERE id = $1", target_id)
    if row is None or row["role"] != "admin":
        return
    if becoming == "admin":
        return
    if await _admin_count(c) <= 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this is the only admin — promote someone else first, "
            "otherwise nobody could manage the team",
        )

@app.get("/users")
async def list_users(
    _: Annotated[User, Depends(require_admin)],
    pool: Annotated[asyncpg.Pool, Depends(db)],
):
    rows = await pool.fetch(
        "SELECT id, email, display_name, role, created_at, last_login_at"
        " FROM users ORDER BY role, lower(display_name)"
    )
    return [dict(r) for r in rows]

@app.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user(
    body: NewUser,
    actor: Annotated[User, Depends(require_admin)],
    pool: Annotated[asyncpg.Pool, Depends(db)],
):
    async with pool.acquire() as c, c.transaction():
        exists = await c.fetchval("SELECT 1 FROM users WHERE lower(email) = $1", body.email)
        if exists:
            raise HTTPException(status.HTTP_409_CONFLICT, "that email already has an account")
        row = await c.fetchrow(
            "INSERT INTO users (email, display_name, password_hash, role)"
            " VALUES ($1,$2,$3,$4) RETURNING id, email, display_name, role",
            body.email, body.display_name.strip(), hash_password(body.password), body.role,
        )
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'create_user',$2)",
            actor.id, json.dumps({"email": body.email, "role": body.role}),
        )
    return dict(row)

@app.patch("/users/{user_id}")
async def update_user(
    user_id: int,
    body: UserPatch,
    actor: Annotated[User, Depends(require_admin)],
    pool: Annotated[asyncpg.Pool, Depends(db)],
):
    async with pool.acquire() as c, c.transaction():
        if body.role is not None:
            await _guard_last_admin(c, user_id, becoming=body.role)
        sets, args = [], []
        for col, val in (("display_name", body.display_name and body.display_name.strip()),
                         ("role", body.role)):
            if val is not None:
                args.append(val); sets.append(f"{col} = ${len(args)}")
        if body.password is not None:
            args.append(hash_password(body.password))
            sets.append(f"password_hash = ${len(args)}")
            sets.append("session_epoch = session_epoch + 1")
        if not sets:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "nothing to change")
        args.append(user_id)
        row = await c.fetchrow(
            f"UPDATE users SET {', '.join(sets)} WHERE id = ${len(args)}"
            " RETURNING id, email, display_name, role", *args)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such user")
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'update_user',$2)",
            actor.id,
            json.dumps({"target": user_id, "role": body.role,
                        "password_changed": body.password is not None}),
        )
    return dict(row)

@app.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    actor: Annotated[User, Depends(require_admin)],
    pool: Annotated[asyncpg.Pool, Depends(db)],
):
    async with pool.acquire() as c, c.transaction():
        await _guard_last_admin(c, user_id, becoming=None)
        # Keep their audit trail and the stats they entered; null the author.
        await c.execute("UPDATE audit_log  SET user_id    = NULL WHERE user_id    = $1", user_id)
        await c.execute("UPDATE game_stats SET updated_by = NULL WHERE updated_by = $1", user_id)
        await c.execute("UPDATE game_results SET updated_by = NULL WHERE updated_by = $1", user_id)
        gone = await c.execute("DELETE FROM users WHERE id = $1", user_id)
        if gone.endswith("0"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such user")
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'delete_user',$2)",
            actor.id, json.dumps({"target": user_id}),
        )
    return {"ok": True}

# ======================================================================= #
#  Admin-authored content: news, player profiles, coach notes, uploads.   #
#  Spordle owns the roster and schedule; everything here is written by a  #
#  team admin and keyed to the contract ids.                              #
# ======================================================================= #

import re as _re
from pathlib import Path as _Path

UPLOAD_DIR = _Path(os.environ.get("UPLOAD_DIR", "/srv/lvlnb-uploads"))
MAX_UPLOAD = 12 * 1024 * 1024          # 12 MB; phone photos land around 3-5
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

def slugify(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = _re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s[:80] or "post"

# ------------------------------------------------------------------- news --

class NewsIn(BaseModel):
    title: str
    summary: str | None = None
    body: str = ""
    image: str | None = None
    lang: Literal["en", "fr"] = "en"
    status: Literal["draft", "published"] = "draft"

    @field_validator("title")
    @classmethod
    def _t(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("a post needs a title")
        return v

@app.get("/news")
async def list_news(
    pool: Annotated[asyncpg.Pool, Depends(db)],
    user: Annotated[User | None, Depends(current_user)],
    include_drafts: bool = False,
):
    # Drafts are only ever visible to an admin — a half-written recap must not
    # appear on the team's front page.
    admin = user is not None and user.role == "admin"
    rows = await pool.fetch(
        """SELECT n.id, n.slug, n.title, n.summary, n.body, n.image, n.lang, n.status,
                  n.published_at, n.updated_at, u.display_name AS author
             FROM news_posts n LEFT JOIN users u ON u.id = n.author_id
            WHERE ($1 AND $2) OR n.status = 'published'
            ORDER BY coalesce(n.published_at, n.updated_at) DESC""",
        include_drafts, admin,
    )
    return [dict(r) for r in rows]

@app.post("/news", status_code=status.HTTP_201_CREATED)
async def create_news(body: NewsIn, actor: Annotated[User, Depends(require_admin)],
                      pool: Annotated[asyncpg.Pool, Depends(db)]):
    screened = await screen(pool, author_id=actor.id, surface="news",
                            ref_id=None, body=f"{body.title}\n{body.summary or ''}\n{body.body}")
    if screened["held"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "that post was held for review")
    base = slugify(body.title)
    async with pool.acquire() as c, c.transaction():
        slug, n = base, 1
        while await c.fetchval("SELECT 1 FROM news_posts WHERE slug = $1", slug):
            n += 1
            slug = f"{base}-{n}"
        row = await c.fetchrow(
            """INSERT INTO news_posts (slug, title, summary, body, image, lang, status,
                                       published_at, author_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7='published' THEN now() END, $8)
               RETURNING id, slug, title, status, published_at""",
            slug, body.title, body.summary, body.body, body.image, body.lang,
            body.status, actor.id)
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'news_create',$2)",
            actor.id, json.dumps({"slug": slug, "status": body.status}))
    return dict(row)

@app.put("/news/{post_id}")
async def update_news(post_id: int, body: NewsIn,
                      actor: Annotated[User, Depends(require_admin)],
                      pool: Annotated[asyncpg.Pool, Depends(db)]):
    async with pool.acquire() as c, c.transaction():
        row = await c.fetchrow(
            """UPDATE news_posts SET title=$1, summary=$2, body=$3, image=$4, lang=$5,
                      status=$6,
                      -- first publish stamps the date; later edits keep it
                      published_at = CASE WHEN $6='published' AND published_at IS NULL
                                          THEN now() ELSE published_at END,
                      updated_at = now()
                WHERE id=$7
                RETURNING id, slug, title, status, published_at""",
            body.title, body.summary, body.body, body.image, body.lang,
            body.status, post_id)
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such post")
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'news_update',$2)",
            actor.id, json.dumps({"id": post_id, "status": body.status}))
    return dict(row)

@app.delete("/news/{post_id}")
async def delete_news(post_id: int, actor: Annotated[User, Depends(require_admin)],
                      pool: Annotated[asyncpg.Pool, Depends(db)]):
    gone = await pool.execute("DELETE FROM news_posts WHERE id = $1", post_id)
    if gone.endswith("0"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such post")
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'news_delete',$2)",
        actor.id, json.dumps({"id": post_id}))
    return {"ok": True}

# -------------------------------------------------------- player profiles --

class ProfileIn(BaseModel):
    bio: str | None = None
    position: Literal["C", "LW", "RW", "F", "D", "G"] | None = None
    shoots: Literal["L", "R"] | None = None
    captain: Literal["C", "A"] | None = None
    nickname: str | None = None
    favourite_player: str | None = None
    card_art: str | None = None
    photo: str | None = None

@app.get("/profiles")
async def list_profiles(pool: Annotated[asyncpg.Pool, Depends(db)]):
    rows = await pool.fetch("SELECT * FROM player_profiles")
    return {r["player_id"]: {k: v for k, v in dict(r).items()
                             if k not in ("updated_by",)} for r in rows}

@app.put("/profiles/{player_id}")
async def put_profile(player_id: str, body: ProfileIn,
                      actor: Annotated[User, Depends(require_admin)],
                      pool: Annotated[asyncpg.Pool, Depends(db)]):
    if player_id not in contract.players:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown player {player_id}")
    if body.bio:
        screened = await screen(pool, author_id=actor.id, surface="bio",
                                ref_id=player_id, body=body.bio)
        if screened["held"]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "that bio was held for review")
    # Only one captain and two alternates are legal on a hockey team.
    if body.captain == "C":
        other = await pool.fetchval(
            "SELECT player_id FROM player_profiles WHERE captain='C' AND player_id <> $1",
            player_id)
        if other:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{contract.players[other]['firstName']} is already captain — "
                "change them to alternate first")
    async with pool.acquire() as c, c.transaction():
        row = await c.fetchrow(
            """INSERT INTO player_profiles
                 (player_id, bio, position, shoots, captain, nickname,
                  favourite_player, card_art, photo, updated_by, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
               ON CONFLICT (player_id) DO UPDATE SET
                 bio=EXCLUDED.bio, position=EXCLUDED.position, shoots=EXCLUDED.shoots,
                 captain=EXCLUDED.captain, nickname=EXCLUDED.nickname,
                 favourite_player=EXCLUDED.favourite_player,
                 card_art=EXCLUDED.card_art, photo=EXCLUDED.photo,
                 updated_by=EXCLUDED.updated_by, updated_at=now()
               RETURNING *""",
            player_id, body.bio, body.position, body.shoots, body.captain,
            body.nickname, body.favourite_player, body.card_art, body.photo, actor.id)
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'profile_update',$2)",
            actor.id, json.dumps({"player_id": player_id}))
    return {k: v for k, v in dict(row).items() if k not in ("updated_by",)}

# ------------------------------------------------------------ coach notes --

class NoteIn(BaseModel):
    body: str

@app.get("/notes/{game_id}")
async def get_notes(game_id: str, pool: Annotated[asyncpg.Pool, Depends(db)]):
    rows = await pool.fetch(
        """SELECT n.kind, n.body, n.updated_at, u.display_name AS author
             FROM game_notes n LEFT JOIN users u ON u.id = n.author_id
            WHERE n.game_id = $1""", game_id)
    return {r["kind"]: {"body": r["body"], "updated_at": r["updated_at"],
                        "author": r["author"]} for r in rows}

@app.put("/notes/{game_id}/{kind}")
async def put_note(game_id: str, kind: Literal["preview", "recap"], body: NoteIn,
                   actor: Annotated[User, Depends(require_admin)],
                   pool: Annotated[asyncpg.Pool, Depends(db)]):
    if game_id not in contract.games:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown game {game_id}")
    text = body.body.strip()
    screened = await screen(pool, author_id=actor.id, surface=f"note:{kind}",
                            ref_id=game_id, body=text)
    if screened["held"]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "that wording was held for review — an admin has been notified")
    async with pool.acquire() as c, c.transaction():
        if not text:                       # clearing a note deletes it
            await c.execute("DELETE FROM game_notes WHERE game_id=$1 AND kind=$2",
                            game_id, kind)
        else:
            await c.execute(
                """INSERT INTO game_notes (game_id, kind, body, author_id, updated_at)
                   VALUES ($1,$2,$3,$4, now())
                   ON CONFLICT (game_id, kind) DO UPDATE SET
                     body=EXCLUDED.body, author_id=EXCLUDED.author_id, updated_at=now()""",
                game_id, kind, text, actor.id)
        await c.execute(
            "INSERT INTO audit_log (user_id, action, game_id, payload) VALUES ($1,'note',$2,$3)",
            actor.id, game_id, json.dumps({"kind": kind, "cleared": not text}))
    return {"ok": True, "cleared": not text}

# --------------------------------------------------------------- uploads --

@app.get("/uploads")
async def list_uploads(_: Annotated[User, Depends(require_admin)],
                       pool: Annotated[asyncpg.Pool, Depends(db)]):
    rows = await pool.fetch(
        "SELECT path, kind, bytes, uploaded_at FROM uploads ORDER BY uploaded_at DESC LIMIT 200")
    return [dict(r) for r in rows]

@app.post("/uploads", status_code=status.HTTP_201_CREATED)
async def upload(
    actor: Annotated[User, Depends(require_admin)],
    pool: Annotated[asyncpg.Pool, Depends(db)],
    file: UploadFile = File(...),
    kind: str = Form("card_art"),
):
    """Accept an image, strip it, resize it, and hand back the path to use.

    EXIF is discarded deliberately, not incidentally: a phone photo of a child
    usually carries GPS coordinates and a capture timestamp, and this site
    exists partly so that information does not travel.
    """
    if kind not in {"card_art", "team_photo", "news_image"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown kind {kind}")
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"{file.content_type or 'that file'} is not an image we accept "
            f"({', '.join(sorted(ALLOWED_TYPES))})")

    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            f"image is larger than {MAX_UPLOAD // (1024*1024)} MB")
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "that file was empty")

    from io import BytesIO
    from PIL import Image, ImageOps

    try:
        img = Image.open(BytesIO(raw))
        img.load()
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "that file is not a readable image")

    # honour the EXIF rotation flag, then drop EXIF entirely
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    longest = {"card_art": 1200, "team_photo": 2048, "news_image": 1600}[kind]
    img.thumbnail((longest, longest), Image.LANCZOS)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    stem = f"{kind}-{stamp}-{secrets.token_hex(4)}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    # A clean image with no metadata: Pillow writes only what we give it.
    clean = Image.new(img.mode, img.size)
    clean.putdata(list(img.getdata()))

    jpg = UPLOAD_DIR / f"{stem}.jpg"
    webp = UPLOAD_DIR / f"{stem}.webp"
    clean.convert("RGB").save(jpg, "JPEG", quality=84, optimize=True)
    clean.convert("RGB").save(webp, "WEBP", quality=80, method=4)

    path = f"/uploads/{stem}.jpg"
    await pool.execute(
        """INSERT INTO uploads (path, kind, bytes, content_type, uploaded_by)
           VALUES ($1,$2,$3,'image/jpeg',$4)""",
        path, kind, jpg.stat().st_size, actor.id)
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'upload',$2)",
        actor.id, json.dumps({"path": path, "kind": kind}))

    return {"path": path, "webp": f"/uploads/{stem}.webp",
            "width": img.width, "height": img.height,
            "bytes": jpg.stat().st_size}

# ---------------------------------------------- self-service password change --

class ChangePwBody(BaseModel):
    current: str
    new: str

    @field_validator("new")
    @classmethod
    def _pw(cls, v: str) -> str:
        if len(v) < MIN_PASSWORD:
            raise ValueError(f"password must be at least {MIN_PASSWORD} characters")
        return v

@app.post("/auth/change-password")
async def change_password(
    body: ChangePwBody,
    user: Annotated[User | None, Depends(current_user)],
    response: Response,
    pool: Annotated[asyncpg.Pool, Depends(db)],
):
    """Anyone signed in can change their own password.

    Families are handed a generated password on a printed sheet, so they need a
    way to replace it that does not involve asking an admin.
    """
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
    row = await pool.fetchrow(
        "SELECT password_hash FROM users WHERE id = $1", user.id)
    if not bcrypt.checkpw(body.current.encode(), row["password_hash"].encode()):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "that is not your current password")
    if body.current == body.new:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "the new password is the same as the old one")

    async with pool.acquire() as c, c.transaction():
        # Bumping the epoch signs out every other device — the point of a change.
        new_epoch = await c.fetchval(
            "UPDATE users SET password_hash=$1, session_epoch=session_epoch+1"
            " WHERE id=$2 RETURNING session_epoch",
            hash_password(body.new), user.id)
        await c.execute(
            "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'password_change','{}')",
            user.id)
    # ...but not this one: re-issue the cookie at the new epoch.
    response.set_cookie(
        COOKIE_NAME, signer.dumps([user.id, new_epoch]),
        max_age=SESSION_MAX_AGE, httponly=True, samesite="lax",
        secure=COOKIE_SECURE, path="/")
    return {"ok": True}

# ------------------------------------------------------------- game jobs --
# Jobs belong to a FAMILY, not a person: the parents decide between themselves
# who actually turns up, then one of them claims it so the team can see.

# The jobs every game actually needs filling. "Add the standard jobs" seeds
# these and nothing else, so the game page is not a wall of rows nobody signs.
DEFAULT_JOBS = [
    ("50/50 tickets",  "Sell 50/50 tickets in the stands", 10),
    ("Scoresheet",     "Keep the official scoresheet",      20),
    ("Timekeeper",     "Run the clock",                     30),
]

# Jobs this team does not run every night but might want back one day. Offered
# one at a time instead of seeded, alongside whatever the admin invents for a
# tournament weekend.
OPTIONAL_JOBS = [
    ("Penalty box", "Penalty box door",             40),
    ("Jerseys",     "Collect and wash the jerseys", 50),
    ("Snacks",      "Post-game snacks",             60),
]

class JobTypeIn(BaseModel):
    name: str
    description: str | None = None
    sort: int | None = None           # unset: land at the end of the list
    active: bool = True

class JobAssign(BaseModel):
    job_type_id: int
    player_id: str | None = None      # the family on the hook; null clears it
    note: str | None = None

@app.get("/jobs/types")
async def list_job_types(pool: Annotated[asyncpg.Pool, Depends(db)]):
    rows = await pool.fetch(
        "SELECT id, name, description, sort, active FROM job_types ORDER BY sort, name")
    return [dict(r) for r in rows]

@app.get("/jobs/suggestions")
async def suggest_job_types(pool: Annotated[asyncpg.Pool, Depends(db)]):
    """The extras we know about that this team has not added, for one-tap adding."""
    have = {r["n"] for r in await pool.fetch("SELECT lower(name) AS n FROM job_types")}
    return [{"name": n, "description": d, "sort": srt}
            for n, d, srt in OPTIONAL_JOBS if n.lower() not in have]

@app.post("/jobs/types", status_code=status.HTTP_201_CREATED)
async def create_job_type(body: JobTypeIn, actor: Annotated[User, Depends(require_admin)],
                          pool: Annotated[asyncpg.Pool, Depends(db)]):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a job needs a name")
    if await pool.fetchval("SELECT 1 FROM job_types WHERE lower(name)=lower($1)", name):
        raise HTTPException(status.HTTP_409_CONFLICT, f"there is already a job called {name}")
    sort = body.sort
    if sort is None:
        sort = await pool.fetchval("SELECT coalesce(max(sort), 0) + 10 FROM job_types")
    row = await pool.fetchrow(
        "INSERT INTO job_types (name, description, sort, active) VALUES ($1,$2,$3,$4)"
        " RETURNING id, name, description, sort, active",
        name, body.description, sort, body.active)
    return dict(row)

@app.delete("/jobs/types/{type_id}")
async def delete_job_type(type_id: int, actor: Annotated[User, Depends(require_admin)],
                          pool: Annotated[asyncpg.Pool, Depends(db)]):
    # Counted before the delete, because the assignments cascade away with it.
    assigned = await pool.fetchval(
        "SELECT count(*) FROM game_jobs WHERE job_type_id=$1", type_id)
    gone = await pool.execute("DELETE FROM job_types WHERE id=$1", type_id)
    if gone.endswith("0"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such job")
    return {"ok": True, "assignments_removed": assigned}

@app.post("/jobs/seed-defaults")
async def seed_default_jobs(actor: Annotated[User, Depends(require_admin)],
                            pool: Annotated[asyncpg.Pool, Depends(db)]):
    made = 0
    for name, desc, sort in DEFAULT_JOBS:
        r = await pool.execute(
            "INSERT INTO job_types (name, description, sort) VALUES ($1,$2,$3)"
            " ON CONFLICT (name) DO NOTHING", name, desc, sort)
        made += 0 if r.endswith("0") else 1
    return {"added": made}

@app.get("/jobs/{game_id}")
async def game_jobs(game_id: str, pool: Annotated[asyncpg.Pool, Depends(db)]):
    """Every job for this game, with who is on the hook and who has claimed it."""
    if game_id not in contract.games:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown game {game_id}")
    rows = await pool.fetch(
        """SELECT t.id AS job_type_id, t.name, t.description, t.sort,
                  j.player_id, j.note, j.updated_at,
                  u.display_name AS claimed_by, u.id AS claimed_by_id
             FROM job_types t
             LEFT JOIN game_jobs j ON j.job_type_id = t.id AND j.game_id = $1
             LEFT JOIN users u     ON u.id = j.claimed_by
            WHERE t.active
            ORDER BY t.sort, t.name""", game_id)
    out = []
    for r in rows:
        d = dict(r)
        p = contract.players.get(d["player_id"]) if d["player_id"] else None
        # name the family, since that is who the job belongs to
        d["family"] = f"{p['firstName']} {p['lastName']}" if p else None
        d["family_number"] = p["number"] if p else None
        out.append(d)
    return out

@app.put("/jobs/{game_id}")
async def set_game_jobs(game_id: str, assignments: list[JobAssign],
                        actor: Annotated[User, Depends(require_admin)],
                        pool: Annotated[asyncpg.Pool, Depends(db)]):
    if game_id not in contract.games:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown game {game_id}")
    bad = [a.player_id for a in assignments if a.player_id and a.player_id not in contract.players]
    if bad:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown player ids: {bad}")
    for a in assignments:
        if a.note:
            s = await screen(pool, author_id=actor.id, surface="job_note",
                             ref_id=game_id, body=a.note)
            if s["held"]:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                    "a note was held for review")
    async with pool.acquire() as c, c.transaction():
        for a in assignments:
            if a.player_id is None and a.note is None:
                await c.execute("DELETE FROM game_jobs WHERE game_id=$1 AND job_type_id=$2",
                                game_id, a.job_type_id)
                continue
            await c.execute(
                """INSERT INTO game_jobs (game_id, job_type_id, player_id, note, updated_by, updated_at)
                   VALUES ($1,$2,$3,$4,$5, now())
                   ON CONFLICT (game_id, job_type_id) DO UPDATE SET
                     player_id = EXCLUDED.player_id,
                     note      = EXCLUDED.note,
                     -- reassigning to a different family drops the old claim
                     claimed_by = CASE WHEN game_jobs.player_id IS DISTINCT FROM EXCLUDED.player_id
                                       THEN NULL ELSE game_jobs.claimed_by END,
                     updated_by = EXCLUDED.updated_by, updated_at = now()""",
                game_id, a.job_type_id, a.player_id, a.note, actor.id)
        await c.execute(
            "INSERT INTO audit_log (user_id, action, game_id, payload) VALUES ($1,'jobs',$2,$3)",
            actor.id, game_id, json.dumps({"count": len(assignments)}))
    return {"ok": True, "saved": len(assignments)}

@app.post("/jobs/{game_id}/{job_type_id}/claim")
async def claim_job(game_id: str, job_type_id: int,
                    user: Annotated[User | None, Depends(current_user)],
                    pool: Annotated[asyncpg.Pool, Depends(db)],
                    release: bool = False):
    """A parent takes (or hands back) a job assigned to their own family."""
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in to continue")
    row = await pool.fetchrow(
        "SELECT player_id, claimed_by FROM game_jobs WHERE game_id=$1 AND job_type_id=$2",
        game_id, job_type_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that job is not assigned for this game")

    me = await pool.fetchrow("SELECT player_id, role FROM users WHERE id=$1", user.id)
    if me["role"] == "player":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "game jobs are for the grown-ups — ask a parent to claim it")
    # Admins can sort out anyone's job; a parent only their own family's.
    if me["role"] != "admin" and me["player_id"] != row["player_id"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "that job belongs to another family — you can only take your own")
    await pool.execute(
        "UPDATE game_jobs SET claimed_by=$1, updated_at=now() WHERE game_id=$2 AND job_type_id=$3",
        None if release else user.id, game_id, job_type_id)
    return {"ok": True, "claimed": not release}


from chat import chat_router

app.include_router(chat_router(current_user, db))

# ------------------------------------------------------------ moderation --

import moderation as _mod

async def screen(pool, *, author_id: int | None, surface: str, ref_id: str | None,
                 body: str) -> dict:
    """Scan user text, record anything worth a look, and say whether to hold it.

    Called on the way in, before the text reaches the site. Returns
    {"held": bool, "severity": str|None} so the caller can refuse to publish
    high-severity content rather than publishing and apologising.
    """
    findings = _mod.scan(body or "")
    if not findings:
        return {"held": False, "severity": None, "flag_id": None}
    severity = _mod.worst(findings)
    held = _mod.should_hold(findings)
    flag_id = await pool.fetchval(
        """INSERT INTO flagged_content (author_id, surface, ref_id, body, severity,
                                        findings, held)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""",
        author_id, surface, ref_id, body, severity, json.dumps(findings), held)
    log.warning("moderation: %s severity on %s by user %s (flag %s)",
                severity, surface, author_id, flag_id)
    return {"held": held, "severity": severity, "flag_id": flag_id}

@app.get("/moderation/queue")
async def moderation_queue(_: Annotated[User, Depends(require_admin)],
                           pool: Annotated[asyncpg.Pool, Depends(db)],
                           status_filter: str = "pending"):
    rows = await pool.fetch(
        """SELECT f.id, f.at, f.surface, f.ref_id, f.body, f.severity, f.findings,
                  f.held, f.status, u.display_name AS author, u.role AS author_role,
                  u.player_id AS author_player
             FROM flagged_content f LEFT JOIN users u ON u.id = f.author_id
            WHERE ($1 = 'all' OR f.status = $1)
            ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                     f.at DESC
            LIMIT 200""", status_filter)
    queue = []
    for row in rows:
        flag = dict(row)
        # asyncpg returns JSONB as text; the review panel needs an array.
        if isinstance(flag["findings"], str):
            flag["findings"] = json.loads(flag["findings"])
        queue.append(flag)
    return queue

@app.get("/moderation/count")
async def moderation_count(_: Annotated[User, Depends(require_admin)],
                           pool: Annotated[asyncpg.Pool, Depends(db)]):
    """For the badge on the admin tab."""
    row = await pool.fetchrow(
        "SELECT count(*) FILTER (WHERE status='pending') AS pending,"
        " count(*) FILTER (WHERE status='pending' AND held) AS held FROM flagged_content")
    return dict(row)

class ReviewBody(BaseModel):
    action: Literal["approve", "remove"]

@app.post("/moderation/{flag_id}/review")
async def review_flag(flag_id: int, body: ReviewBody,
                      actor: Annotated[User, Depends(require_admin)],
                      pool: Annotated[asyncpg.Pool, Depends(db)]):
    row = await pool.fetchrow(
        """UPDATE flagged_content SET status=$1, reviewed_by=$2, reviewed_at=now(),
                  held = CASE WHEN $1 = 'approved' THEN false ELSE held END
            WHERE id=$3 RETURNING id, surface, ref_id, status""",
        "approved" if body.action == "approve" else "removed", actor.id, flag_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such flag")
    await pool.execute(
        "INSERT INTO audit_log (user_id, action, payload) VALUES ($1,'moderation',$2)",
        actor.id, json.dumps({"flag": flag_id, "action": body.action}))
    return dict(row)

@app.post("/moderation/reload-terms")
async def reload_terms(_: Annotated[User, Depends(require_admin)]):
    """Pick up edits to moderation-terms.json without restarting the service."""
    _mod.reload_terms()
    return {"ok": True}

# ------------------------------------------------------------------ plays --
# The coach's whiteboard lives in its own module: it is a self-contained
# document store with its own validation, and app.py is long enough already.
from plays import plays_router                                    # noqa: E402

app.include_router(plays_router(current_user, require_admin, db, slugify, contract))
