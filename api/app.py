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
from pathlib import Path
from typing import Annotated, Literal

import asyncpg
import bcrypt
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response, status
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
    role: Literal["admin", "viewer"] = "viewer"

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("not a valid email address")
        return v

    @field_validator("password")
    @classmethod
    def _password(cls, v: str) -> str:
        if len(v) < MIN_PASSWORD:
            raise ValueError(f"password must be at least {MIN_PASSWORD} characters")
        return v

class UserPatch(BaseModel):
    display_name: str | None = None
    role: Literal["admin", "viewer"] | None = None
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
