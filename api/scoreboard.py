"""Live scores share game results, but never replace individual player statistics."""
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator


class LiveScore(BaseModel):
    model_config = ConfigDict(extra="forbid")
    our_score: int = Field(ge=0, le=1000, strict=True)
    their_score: int = Field(ge=0, le=1000, strict=True)
    status: Literal["scheduled", "in_progress", "final", "postponed", "cancelled"]
    period: Literal["1", "2", "3", "OT", "SO", "INT1", "INT2"] | None = None
    expected_revision: int = Field(ge=0, le=2**53-1, strict=True)

    @model_validator(mode="after")
    def live_period(self):
        if self.status == "in_progress" and self.period is None:
            raise ValueError("choose a period before starting the game")
        return self


def build_router(require_admin, db, contract):
    router = APIRouter(prefix="/scoreboard")

    @router.get("")
    async def scores(pool=Depends(db)):
        rows = {r["game_id"]: dict(r) for r in await pool.fetch(
            "SELECT game_id,our_score,their_score,status,period,revision,updated_at FROM game_results")}
        games = []
        for gid, game in contract.games.items():
            home = game["home"]["teamId"] == "lewisville-lightning"
            ours, theirs = (game["home"], game["away"]) if home else (game["away"], game["home"])
            games.append({"game_id": gid, "starts_at": game["startsAt"],
                          "our_score": ours["score"], "their_score": theirs["score"],
                          "status": game["status"], "period": None, "revision": 0,
                          "updated_at": None, **rows.get(gid, {})})
        return {"games": games}

    @router.put("/{game_id}")
    async def update(game_id: str, body: LiveScore, user=Depends(require_admin), pool=Depends(db)):
        if game_id not in contract.games:
            raise HTTPException(404, "unknown game")
        async with pool.acquire() as c, c.transaction():
            # Shared with full scoresheet writes, including the first insert.
            await c.execute("SELECT pg_advisory_xact_lock(hashtextextended($1, 71004))", game_id)
            revision = await c.fetchval("SELECT revision FROM game_results WHERE game_id=$1", game_id) or 0
            if revision != body.expected_revision:
                raise HTTPException(409, "The score changed on another device. Load the latest score before saving again.")
            row = await c.fetchrow("""INSERT INTO game_results
                (game_id,our_score,their_score,status,period,revision,updated_by)
                VALUES($1,$2,$3,$4,$5,1,$6)
                ON CONFLICT(game_id) DO UPDATE SET our_score=EXCLUDED.our_score,
                their_score=EXCLUDED.their_score,status=EXCLUDED.status,period=EXCLUDED.period,
                revision=game_results.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now()
                RETURNING game_id,our_score,their_score,status,period,revision,updated_at""",
                game_id, body.our_score, body.their_score, body.status,
                body.period if body.status in ("in_progress", "final") else None, user.id)
            await c.execute("INSERT INTO audit_log(user_id,action,game_id,payload) VALUES($1,'live_score',$2,$3)",
                            user.id, game_id, json.dumps(body.model_dump()))
        return dict(row)

    return router
