"""
Game-night broadcast: the stream, the clock, and the log the overlay is drawn from.

Three ideas carry this module.

**The clock is intent, not ticks.** One row per game holds the reading that was
true at `anchor_at` plus whether it is running. Every client derives the
countdown from the server's own `now`, which each response carries, so a
three-second poll drives a smooth local countdown, every phone in the building
agrees, and nothing depends on a device clock. Nothing here wakes up on a timer.

**`elapsed_ms` is the only time penalties know about.** It is total game time
played and advances only while the clock runs, so a penalty measured against it
stops during stoppages and carries across periods of any length — no period
arithmetic, no second timer, no special case for overtime. Correcting the clock
within a period moves `elapsed_ms` by the same delta, so a timekeeper's fix does
not quietly shift every penalty on the ice.

**The log is append-only and derivation is server-side.** Score, shots, the
penalties on ice and the scoring summary are all computed from `game_events`, so
there is exactly one reducer and it lives here rather than being reimplemented
in the overlay. A mis-tap is voided, never deleted. Taps are idempotent on
`(game_id, client_id)` because arena wifi retries, and a double-counted goal on
the scorebug is the one error everyone in the stands notices.

What the operator taps is *not* the official scoresheet. Team score and period
publish straight to `game_results`, so the homepage hero and `/api/scoreboard`
need no changes; per-player goals and assists stay in this log until an admin
reviews them through the existing audited scoresheet editor (see
`derived_scoresheet`). That is deliberate: a fat thumb on GOAL should not edit a
child's season statistics.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Literal
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Period = Literal["1", "2", "3", "OT", "SO", "INT1", "INT2"]
Side = Literal["us", "them"]
Kind = Literal["goal", "shot", "penalty", "highlight", "timeout", "goalie", "note"]

# A whole game is a few hundred taps. The cap is far above that and only exists
# so a stuck client cannot grow one game without bound.
MAX_EVENTS_PER_GAME = 4000

PENALTY_MINUTES = (2, 4, 5, 10)

# ------------------------------------------------------------------ stream --

# YouTube video ids are exactly 11 characters of the URL-safe alphabet.
_VIDEO_ID = re.compile(r"\A[A-Za-z0-9_-]{11}\Z")
_YOUTUBE_HOSTS = frozenset({
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
})
_ID_PATH_PREFIXES = frozenset({"live", "embed", "shorts", "v"})


def parse_youtube_id(value: str) -> str:
    """Reduce anything a phone's share sheet produces to a bare video id.

    Only the id is ever stored. The embed address is rebuilt from it, so no
    pasted string can turn into an arbitrary third-party frame on our page —
    which matters because that frame is the one element of the broadcast page we
    do not control.
    """
    value = value.strip()
    if _VIDEO_ID.match(value):
        return value
    parts = urlsplit(value if "//" in value else "https://" + value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("paste the YouTube link for the stream")
    if parts.hostname.lower() not in _YOUTUBE_HOSTS:
        raise ValueError("that is not a YouTube link")
    segments = [s for s in parts.path.split("/") if s]
    found = None
    if parts.hostname.lower().endswith("youtu.be"):
        found = segments[0] if segments else None
    else:
        found = (parse_qs(parts.query).get("v") or [None])[0]
        if not found and len(segments) >= 2 and segments[0] in _ID_PATH_PREFIXES:
            found = segments[1]
    if not found or not _VIDEO_ID.match(found):
        raise ValueError("that link does not contain a video id")
    return found


def stream_urls(video_id: str) -> dict[str, str]:
    """Addresses the page may use. nocookie for the frame, canonical for links."""
    return {
        "embed_url": f"https://www.youtube-nocookie.com/embed/{video_id}",
        "watch_url": f"https://www.youtube.com/watch?v={video_id}",
    }


class StreamIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=400)
    label: str | None = Field(default=None, max_length=120)
    state: Literal["scheduled", "live", "ended"] = "scheduled"

    @field_validator("url")
    @classmethod
    def _video(cls, value: str) -> str:
        return parse_youtube_id(value)

    @field_validator("label")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        return (value or "").strip() or None


# ------------------------------------------------------------------- clock --

class ClockIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period: Period
    period_length_ms: int = Field(ge=60_000, le=3_600_000, strict=True)
    remaining_ms: int = Field(ge=0, le=3_600_000, strict=True)
    running: bool = Field(strict=True)
    expected_revision: int = Field(ge=0, le=2**53 - 1, strict=True)
    # Only the operator resetting the whole game clears total elapsed time, and
    # with it every penalty's measuring stick.
    reset_elapsed: bool = False

    @model_validator(mode="after")
    def _within_period(self):
        if self.remaining_ms > self.period_length_ms:
            raise ValueError("the clock cannot read longer than the period")
        if self.running and self.remaining_ms == 0:
            raise ValueError("the clock cannot run from zero")
        return self


def settle(row, now: datetime) -> tuple[int, int]:
    """The clock as it reads *now*: (remaining_ms, elapsed_ms).

    A running clock is stored as a reading plus the instant it was true, so
    reading it means subtracting the wall time since. Remaining stops at zero;
    elapsed only counts the time the clock actually had left to give, so a
    period left running past zero does not inflate every penalty's measuring
    stick.
    """
    remaining, elapsed = int(row["remaining_ms"]), int(row["elapsed_ms"])
    if not row["running"]:
        return remaining, elapsed
    ran = max(0, int((now - row["anchor_at"]).total_seconds() * 1000))
    spent = min(ran, remaining)
    return remaining - spent, elapsed + spent


# ------------------------------------------------------------------ events --

class EventIn(BaseModel):
    """One tap. The clock reading is the server's, never the phone's.

    The operator presses GOAL at the moment it happens; what time that was is a
    fact about the game clock, and the game clock is here. A phone deciding it
    would let two operators disagree about when a penalty started.
    """
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    team: Side | None = None
    player_id: str | None = None
    assist1: str | None = None
    assist2: str | None = None
    minutes: int | None = None
    infraction: str | None = Field(default=None, max_length=40)
    strength: Literal["even", "pp", "pk", "en", "ps", "sh"] | None = None
    note: str | None = Field(default=None, max_length=200)
    client_id: UUID

    @field_validator("infraction", "note")
    @classmethod
    def _trim(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @model_validator(mode="after")
    def _coherent(self):
        if self.kind in ("goal", "shot", "penalty", "timeout", "goalie") and self.team is None:
            raise ValueError(f"a {self.kind} belongs to a team")
        if self.kind == "penalty" and self.minutes not in PENALTY_MINUTES:
            raise ValueError("a penalty is 2, 4, 5 or 10 minutes")
        if self.kind != "penalty" and self.minutes is not None:
            raise ValueError("only a penalty carries minutes")
        if self.kind != "goal" and (self.assist1 or self.assist2):
            raise ValueError("only a goal carries assists")
        if self.assist1 and not self.player_id:
            raise ValueError("record the scorer before the assists")
        if self.assist2 and not self.assist1:
            raise ValueError("record the first assist before the second")
        names = [n for n in (self.player_id, self.assist1, self.assist2) if n]
        if len(set(names)) != len(names):
            raise ValueError("a player cannot appear twice on one goal")
        # The opponent's roster is not ours to hold, so only our own events name
        # a player. An opponent goal is a goal; who scored it is not our record.
        if self.team == "them" and self.player_id:
            raise ValueError("opponent players are not on our roster")
        return self


def build_router(current_user, require_admin, db, contract):
    async def no_store(response: Response):
        response.headers["Cache-Control"] = "no-store"

    router = APIRouter(prefix="/broadcast", dependencies=[Depends(no_store)])

    def known_game(game_id: str) -> dict:
        game = contract.games.get(game_id)
        if game is None:
            raise HTTPException(404, "unknown game")
        return game

    def known_players(body: EventIn) -> None:
        for pid in (body.player_id, body.assist1, body.assist2):
            if pid is not None and pid not in contract.players:
                raise HTTPException(400, f"unknown player {pid}")

    async def member(user=Depends(current_user)):
        if user is None:
            raise HTTPException(401, "sign in to watch")
        return user

    # ------------------------------------------------------------ helpers --

    async def clock_row(c, game_id: str):
        """The clock for this game, created on first read at its default."""
        row = await c.fetchrow("SELECT * FROM game_clock WHERE game_id=$1", game_id)
        if row is None:
            row = await c.fetchrow(
                "INSERT INTO game_clock (game_id) VALUES ($1)"
                " ON CONFLICT (game_id) DO UPDATE SET game_id=EXCLUDED.game_id RETURNING *",
                game_id)
        return row

    async def publish_result(c, game_id: str, user_id: int | None) -> None:
        """Push the running score and period onto the row the whole site reads.

        Only while the game is still open. Once an admin marks it Final the
        scoresheet editor owns that row, and a half-finished log must not reach
        back and overwrite a reviewed result. The revision bump is deliberate:
        a device holding the old scoresheet should fail with 409 and reload.
        """
        status = await c.fetchval("SELECT status FROM game_results WHERE game_id=$1", game_id)
        if status not in (None, "scheduled", "in_progress"):
            return
        goals = await c.fetchrow("""SELECT
                count(*) FILTER (WHERE team='us')   AS us,
                count(*) FILTER (WHERE team='them') AS them
            FROM game_events WHERE game_id=$1 AND kind='goal' AND voided_at IS NULL""", game_id)
        clock = await clock_row(c, game_id)
        period = clock["period"]
        await c.execute("""INSERT INTO game_results
            (game_id,our_score,their_score,status,period,revision,updated_by)
            VALUES($1,$2,$3,'in_progress',$4,1,$5)
            ON CONFLICT(game_id) DO UPDATE SET our_score=EXCLUDED.our_score,
              their_score=EXCLUDED.their_score, status='in_progress', period=EXCLUDED.period,
              revision=game_results.revision+1, updated_by=EXCLUDED.updated_by, updated_at=now()""",
            game_id, int(goals["us"]), int(goals["them"]), period, user_id)

    async def snapshot(c, game_id: str) -> dict:
        """Everything the overlay and the console draw, derived in one place."""
        now = await c.fetchval("SELECT now()")
        clock = await clock_row(c, game_id)
        remaining, elapsed = settle(clock, now)
        stream = await c.fetchrow("SELECT * FROM game_streams WHERE game_id=$1", game_id)
        result = await c.fetchrow(
            "SELECT our_score,their_score,status,period,revision,updated_at"
            " FROM game_results WHERE game_id=$1", game_id)
        rows = await c.fetch("""SELECT id,kind,team,period,clock_ms,elapsed_ms,player_id,
                assist1,assist2,minutes,infraction,strength,note,stream_offset_ms,created_at
            FROM game_events WHERE game_id=$1 AND voided_at IS NULL ORDER BY id""", game_id)
        events = [dict(r) for r in rows]

        score = {side: sum(1 for e in events if e["kind"] == "goal" and e["team"] == side)
                 for side in ("us", "them")}
        # Shots on goal include the ones that went in — the operator taps GOAL,
        # not GOAL and then SHOT.
        shots: dict[str, dict] = {}
        for side in ("us", "them"):
            attempts = [e for e in events if e["kind"] in ("shot", "goal") and e["team"] == side]
            by_period: dict[str, int] = {}
            for e in attempts:
                by_period[e["period"]] = by_period.get(e["period"], 0) + 1
            shots[side] = {"total": len(attempts), "by_period": by_period}

        return {
            "game_id": game_id,
            "server_now": now.isoformat(),
            "stream": (dict(stream) | stream_urls(stream["video_id"])) if stream else None,
            "clock": {
                "period": clock["period"],
                "period_length_ms": int(clock["period_length_ms"]),
                "remaining_ms": remaining,
                "elapsed_ms": elapsed,
                "running": clock["running"],
                "anchor_at": now.isoformat(),
                "revision": int(clock["revision"]),
            },
            "score": score,
            "shots": shots,
            # Penalties carry the elapsed reading they were called at; the client
            # subtracts the live elapsed to tick each box down.
            "penalties": [
                {**{k: e[k] for k in ("id", "team", "player_id", "minutes", "infraction",
                                      "period", "clock_ms", "elapsed_ms")},
                 "seconds": e["minutes"] * 60}
                for e in events if e["kind"] == "penalty"
            ],
            "goals": [
                {k: e[k] for k in ("id", "team", "player_id", "assist1", "assist2",
                                   "period", "clock_ms", "elapsed_ms", "strength")}
                for e in events if e["kind"] == "goal"
            ],
            "timeouts": {side: sum(1 for e in events
                                   if e["kind"] == "timeout" and e["team"] == side)
                         for side in ("us", "them")},
            "highlights": [
                {k: e[k] for k in ("id", "period", "clock_ms", "note",
                                   "stream_offset_ms", "created_at")}
                for e in events if e["kind"] == "highlight"
            ],
            # Newest first, and bounded: the console shows a feed, not a ledger.
            "events": list(reversed(events))[:60],
            "result": dict(result) if result else None,
        }

    # -------------------------------------------------------------- reading --

    @router.get("")
    async def index(_=Depends(member), pool=Depends(db)):
        """Which games have a stream, for the Watch page and the homepage link."""
        rows = await pool.fetch("""SELECT s.game_id, s.provider, s.video_id, s.label, s.state,
                   s.started_at, r.status AS result_status
            FROM game_streams s LEFT JOIN game_results r USING (game_id)""")
        streams = [dict(r) | stream_urls(r["video_id"])
                   for r in rows if r["game_id"] in contract.games]
        streams.sort(key=lambda s: contract.games[s["game_id"]]["startsAt"], reverse=True)
        return {"streams": streams}

    @router.get("/{game_id}")
    async def read(game_id: str, _=Depends(member), pool=Depends(db)):
        known_game(game_id)
        async with pool.acquire() as c:
            return await snapshot(c, game_id)

    @router.get("/{game_id}/scoresheet")
    async def derived_scoresheet(game_id: str, _=Depends(require_admin), pool=Depends(db)):
        """What the log says the scoresheet should be, for review before saving.

        Returned rather than written: the existing `PUT /stats/game/{id}` is the
        one audited path into season statistics, and it should stay that way.
        Plus/minus is not in here — it cannot be derived without tracking who was
        on the ice, so the editor keeps whatever a human entered.
        """
        known_game(game_id)
        async with pool.acquire() as c:
            snap = await snapshot(c, game_id)
        lines: dict[str, dict] = {}

        def line(pid: str) -> dict:
            return lines.setdefault(pid, {"player_id": pid, "g": 0, "a": 0, "pim": 0, "plus_minus": 0})

        warnings = []
        for goal in snap["goals"]:
            if goal["team"] != "us":
                continue
            if goal["player_id"]:
                line(goal["player_id"])["g"] += 1
            else:
                warnings.append("A Lightning goal has no scorer recorded.")
            for assist in (goal["assist1"], goal["assist2"]):
                if assist:
                    line(assist)["a"] += 1
        for penalty in snap["penalties"]:
            if penalty["team"] == "us" and penalty["player_id"]:
                line(penalty["player_id"])["pim"] += penalty["minutes"]
        if any(p["team"] == "us" and not p["player_id"] for p in snap["penalties"]):
            warnings.append("A Lightning penalty has no player recorded.")
        return {"our_score": snap["score"]["us"], "their_score": snap["score"]["them"],
                "lines": sorted(lines.values(), key=lambda line: line["player_id"]),
                "warnings": sorted(set(warnings)),
                "plus_minus_note": "Plus/minus is not derived from the broadcast log."}

    # -------------------------------------------------------------- stream --

    @router.put("/{game_id}/stream")
    async def set_stream(game_id: str, body: StreamIn, user=Depends(require_admin),
                         pool=Depends(db)):
        known_game(game_id)
        async with pool.acquire() as c, c.transaction():
            row = await c.fetchrow("""INSERT INTO game_streams
                    (game_id,provider,video_id,label,state,started_at,updated_by)
                VALUES ($1,'youtube',$2,$3,$4,CASE WHEN $4='live' THEN now() END,$5)
                ON CONFLICT (game_id) DO UPDATE SET video_id=EXCLUDED.video_id,
                  label=EXCLUDED.label, state=EXCLUDED.state,
                  -- The first moment it went live is what highlight offsets are
                  -- measured from; going live again must not move it.
                  started_at=CASE WHEN EXCLUDED.state='live'
                                  THEN coalesce(game_streams.started_at, now()) END,
                  updated_by=EXCLUDED.updated_by, updated_at=now()
                RETURNING *""", game_id, body.url, body.label, body.state, user.id)
            await c.execute(
                "INSERT INTO audit_log(user_id,action,game_id,payload) VALUES($1,'stream',$2,$3)",
                user.id, game_id, json.dumps({"video_id": body.url, "state": body.state}))
        return dict(row) | stream_urls(row["video_id"])

    @router.delete("/{game_id}/stream", status_code=204)
    async def clear_stream(game_id: str, user=Depends(require_admin), pool=Depends(db)):
        known_game(game_id)
        async with pool.acquire() as c, c.transaction():
            await c.execute("DELETE FROM game_streams WHERE game_id=$1", game_id)
            await c.execute(
                "INSERT INTO audit_log(user_id,action,game_id,payload) VALUES($1,'stream',$2,$3)",
                user.id, game_id, json.dumps({"removed": True}))
        return Response(status_code=204)

    # --------------------------------------------------------------- clock --

    @router.put("/{game_id}/clock")
    async def set_clock(game_id: str, body: ClockIn, user=Depends(require_admin),
                        pool=Depends(db)):
        known_game(game_id)
        async with pool.acquire() as c, c.transaction():
            await c.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 71004))", game_id)
            current = await clock_row(c, game_id)
            if int(current["revision"]) != body.expected_revision:
                raise HTTPException(409, "The clock changed on another device. "
                                         "Reload the console before setting it again.")
            now = await c.fetchval("SELECT now()")
            remaining, elapsed = settle(current, now)
            if body.reset_elapsed:
                elapsed = 0
            elif body.period == current["period"]:
                # The timekeeper nudging the clock inside a period must carry the
                # penalty boxes with it, or every box on the ice silently drifts.
                elapsed = max(0, elapsed - (body.remaining_ms - remaining))
            row = await c.fetchrow("""UPDATE game_clock SET period=$2, period_length_ms=$3,
                    remaining_ms=$4, elapsed_ms=$5, running=$6, anchor_at=now(),
                    revision=revision+1, updated_by=$7, updated_at=now()
                WHERE game_id=$1 RETURNING *""", game_id, body.period, body.period_length_ms,
                body.remaining_ms, elapsed, body.running, user.id)
            await publish_result(c, game_id, user.id)
            snap = await snapshot(c, game_id)
        return snap

    # -------------------------------------------------------------- events --

    @router.post("/{game_id}/events", status_code=201)
    async def add_event(game_id: str, body: EventIn, user=Depends(require_admin),
                        pool=Depends(db)):
        known_game(game_id)
        known_players(body)
        async with pool.acquire() as c, c.transaction():
            await c.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 71004))", game_id)
            existing = await c.fetchrow(
                "SELECT id FROM game_events WHERE game_id=$1 AND client_id=$2",
                game_id, body.client_id)
            if existing is None:
                total = await c.fetchval(
                    "SELECT count(*) FROM game_events WHERE game_id=$1", game_id)
                if total >= MAX_EVENTS_PER_GAME:
                    raise HTTPException(409, "this game already holds too many events")
                clock = await clock_row(c, game_id)
                now = await c.fetchval("SELECT now()")
                remaining, elapsed = settle(clock, now)
                stream = await c.fetchrow(
                    "SELECT started_at FROM game_streams WHERE game_id=$1", game_id)
                offset = None
                if stream and stream["started_at"]:
                    offset = max(0, int((now - stream["started_at"]).total_seconds() * 1000))
                await c.execute("""INSERT INTO game_events
                        (game_id,kind,team,period,clock_ms,elapsed_ms,player_id,assist1,assist2,
                         minutes,infraction,strength,note,stream_offset_ms,client_id,created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)""",
                    game_id, body.kind, body.team, clock["period"], remaining, elapsed,
                    body.player_id, body.assist1, body.assist2, body.minutes, body.infraction,
                    body.strength, body.note, offset, body.client_id, user.id)
                if body.kind == "goal":
                    await publish_result(c, game_id, user.id)
                    await c.execute("""INSERT INTO audit_log(user_id,action,game_id,payload)
                        VALUES($1,'broadcast_goal',$2,$3)""", user.id, game_id,
                        json.dumps({"team": body.team, "player_id": body.player_id,
                                    "assists": [body.assist1, body.assist2]}))
            snap = await snapshot(c, game_id)
        return snap

    @router.post("/{game_id}/events/{event_id}/void")
    async def void_event(game_id: str, event_id: int, user=Depends(require_admin),
                         pool=Depends(db)):
        """Undo a mis-tap. The row stays; the log is what happened."""
        known_game(game_id)
        async with pool.acquire() as c, c.transaction():
            await c.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 71004))", game_id)
            row = await c.fetchrow("""UPDATE game_events SET voided_at=now(), voided_by=$3
                WHERE game_id=$1 AND id=$2 AND voided_at IS NULL RETURNING kind""",
                game_id, event_id, user.id)
            if row is None:
                raise HTTPException(404, "that entry is already gone")
            if row["kind"] == "goal":
                await publish_result(c, game_id, user.id)
                await c.execute("""INSERT INTO audit_log(user_id,action,game_id,payload)
                    VALUES($1,'broadcast_void',$2,$3)""", user.id, game_id,
                    json.dumps({"event_id": event_id, "kind": row["kind"]}))
            snap = await snapshot(c, game_id)
        return snap

    return router
