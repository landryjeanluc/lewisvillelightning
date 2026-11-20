"""Goal clips cut from a game replay, and who was involved in each goal.

tools/replay/goal_clips.py finds the goals in a recording and cuts a clip per
goal. An admin uploads them here and tags each one: scorer, assists, and who
was on the ice. Those tags add up to the G, A and +/- columns of the game's
scoresheet. Nothing here writes the scoresheet; the editor copies the totals
in and the admin saves them, so the person entering the game stays the authority.
"""
import json
import os
import shutil
from pathlib import Path
from typing import Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool

from highlight_media import CHUNK_BYTES, MAX_BYTES, prepare_clip, same_chunk, write_chunk
from security import rate_limit

MEDIA_DIR = Path(os.environ.get("GOAL_CLIP_DIR", Path(__file__).parent / "private" / "goal-clips"))


class UploadIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    game_id: str
    seq: int = Field(ge=1, le=99, strict=True)
    team: Literal["us", "them"]
    bytes: int = Field(gt=0, le=MAX_BYTES)


class TagsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    team: Literal["us", "them"]
    scorer: str | None = None
    assist1: str | None = None
    assist2: str | None = None
    # Five skaters and a goalie, or six skaters with the goalie pulled.
    on_ice: list[str] = Field(default_factory=list, max_length=6)
    power_play: bool = False

    @model_validator(mode="after")
    def coherent(self):
        credited = [p for p in (self.scorer, self.assist1, self.assist2) if p]
        if self.team == "them" and credited:
            raise ValueError("Only Lightning goals have a scorer and assists")
        if len(set(credited)) != len(credited):
            raise ValueError("A player can be credited once per goal")
        if credited and not self.scorer:
            raise ValueError("Choose the scorer before the assists")
        if self.assist2 and not self.assist1:
            raise ValueError("Fill the first assist before the second")
        if len(set(self.on_ice)) != len(self.on_ice):
            raise ValueError("A player can be on the ice once")
        return self


def totals(clips, players):
    """Scoresheet columns implied by the tagged goals: {player_id: {g, a, plus_minus}}.

    Plus/minus follows the usual rule: everyone on the ice for a goal gets +1 or
    -1, except goalies, and except on a power-play goal, which counts for nobody.
    """
    lines = {}
    def line(pid):
        return lines.setdefault(pid, {"g": 0, "a": 0, "plus_minus": 0})
    for clip in clips:
        if clip["scorer"]:
            line(clip["scorer"])["g"] += 1
        for key in ("assist1", "assist2"):
            if clip[key]:
                line(clip[key])["a"] += 1
        if clip["power_play"]:
            continue
        for pid in clip["on_ice"]:
            if players.get(pid, {}).get("position") != "G":
                line(pid)["plus_minus"] += 1 if clip["team"] == "us" else -1
    return lines


def build_router(require_admin, db, contract):
    # Admin only, reads included: these are working material for the scoresheet.
    router = APIRouter(prefix="/goal-clips", dependencies=[Depends(require_admin)])

    def folder(id):
        return MEDIA_DIR / str(id)

    def item(row):
        return {"id": str(row["id"]), "game_id": row["game_id"], "seq": row["seq"], "team": row["team"],
                "scorer": row["scorer"], "assist1": row["assist1"], "assist2": row["assist2"],
                "on_ice": list(row["on_ice"]), "power_play": row["power_play"], "duration": row["duration"]}

    async def lock_upload(c, id, actor):
        row = await c.fetchrow("SELECT * FROM goal_clips WHERE id=$1 FOR UPDATE", id)
        if not row or row["created_by"] != actor.id:
            raise HTTPException(404, "Goal clip upload not found.")
        return row

    @router.get("")
    async def listing(game_id: str, pool=Depends(db)):
        if game_id not in contract.games:
            raise HTTPException(404, "Game not found.")
        rows = await pool.fetch("SELECT * FROM goal_clips WHERE game_id=$1 AND state='ready' ORDER BY seq", game_id)
        clips = [item(row) for row in rows]
        return {"clips": clips, "totals": totals(clips, contract.players),
                "our_goals": sum(c["team"] == "us" for c in clips),
                "their_goals": sum(c["team"] == "them" for c in clips)}

    @router.post("/uploads", status_code=201)
    async def start(body: UploadIn, actor=Depends(require_admin), pool=Depends(db)):
        if body.game_id not in contract.games:
            raise HTTPException(404, "Game not found.")
        await rate_limit(pool, "goal-clip-upload", str(actor.id), 120, 3600)
        expired = await pool.fetch("DELETE FROM goal_clips WHERE state='uploading' AND updated_at < now()-interval '48 hours' RETURNING id")
        for stale in expired:
            await run_in_threadpool(shutil.rmtree, folder(stale["id"]), True)
        try:
            async with pool.acquire() as c, c.transaction():
                await c.execute("INSERT INTO goal_clips(id,game_id,seq,team,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
                                body.id, body.game_id, body.seq, body.team, body.bytes, actor.id)
                row = await lock_upload(c, body.id, actor)
                if any(row[key] != getattr(body, key) for key in ("game_id", "seq", "team", "bytes")):
                    raise HTTPException(409, "This upload belongs to another clip. Start a new upload.")
                folder(body.id).mkdir(parents=True, exist_ok=True, mode=0o700)
        except asyncpg.UniqueViolationError:
            raise HTTPException(409, f"Goal {body.seq} of this game already has a clip. Remove it before uploading a replacement.")
        return {"id": str(body.id), "received": row["received"], "state": row["state"], "chunk_bytes": CHUNK_BYTES}

    @router.put("/uploads/{id}")
    async def chunk(id: UUID, request: Request, offset: int = Query(ge=0), actor=Depends(require_admin), pool=Depends(db)):
        data = await request.body()
        if not 0 < len(data) <= CHUNK_BYTES:
            raise HTTPException(413, "Upload a smaller piece of the clip.")
        async with pool.acquire() as c, c.transaction():
            row = await lock_upload(c, id, actor)
            if row["state"] != "uploading":
                raise HTTPException(409, "This clip is already saved.")
            path = folder(id) / "source.mp4"
            if offset < row["received"] and offset + len(data) <= row["received"]:
                if await run_in_threadpool(same_chunk, path, offset, data):
                    return {"received": row["received"]}
            if offset != row["received"] or offset + len(data) > row["bytes"]:
                raise HTTPException(409, "The upload position changed. Retry the upload.")
            await run_in_threadpool(write_chunk, path, offset, data)
            received = offset + len(data)
            await c.execute("UPDATE goal_clips SET received=$2, updated_at=now() WHERE id=$1", id, received)
        return {"received": received}

    @router.post("/uploads/{id}/publish")
    async def publish(id: UUID, actor=Depends(require_admin), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            row = await lock_upload(c, id, actor)
            if row["state"] == "ready":
                return item(row)
            if row["received"] != row["bytes"]:
                raise HTTPException(409, "The video has not finished uploading.")
            target = folder(id)
            try:
                media = await run_in_threadpool(prepare_clip, target / "source.mp4", target / "video.mp4", target / "poster.jpg")
            except ValueError as exc:
                for name in ("video.mp4", "poster.jpg"):
                    (target / name).unlink(missing_ok=True)
                raise HTTPException(422, str(exc)) from exc
            row = await c.fetchrow("UPDATE goal_clips SET state='ready',duration=$2,updated_at=now() WHERE id=$1 RETURNING *", id, media["duration"])
            await c.execute("INSERT INTO audit_log(user_id,action,game_id,payload) VALUES($1,'goal_clip_add',$2,$3)", actor.id,
                            row["game_id"], json.dumps({"id": str(id), "seq": row["seq"], "team": row["team"]}))
        (folder(id) / "source.mp4").unlink(missing_ok=True)
        return item(row)

    @router.put("/{id}")
    async def tag(id: UUID, body: TagsIn, actor=Depends(require_admin), pool=Depends(db)):
        named = {p for p in (body.scorer, body.assist1, body.assist2, *body.on_ice) if p}
        unknown = sorted(named - contract.players.keys())
        if unknown:
            raise HTTPException(400, f"Unknown player ids: {unknown}")
        # Whoever scored or assisted was on the ice, whether or not it was ticked.
        on_ice = list(body.on_ice)
        for pid in (body.scorer, body.assist1, body.assist2):
            if pid and pid not in on_ice:
                on_ice.append(pid)
        if len(on_ice) > 6:
            raise HTTPException(422, "At most six players can be on the ice for a goal.")
        async with pool.acquire() as c, c.transaction():
            row = await c.fetchrow("""UPDATE goal_clips SET team=$2,scorer=$3,assist1=$4,assist2=$5,on_ice=$6,
                power_play=$7,updated_at=now() WHERE id=$1 AND state='ready' RETURNING *""",
                id, body.team, body.scorer, body.assist1, body.assist2, on_ice, body.power_play)
            if not row:
                raise HTTPException(404, "Goal clip not found.")
            await c.execute("INSERT INTO audit_log(user_id,action,game_id,payload) VALUES($1,'goal_clip_tag',$2,$3)", actor.id,
                            row["game_id"], json.dumps(item(row)))
        return item(row)

    @router.delete("/{id}")
    async def remove(id: UUID, actor=Depends(require_admin), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            row = await c.fetchrow("DELETE FROM goal_clips WHERE id=$1 RETURNING game_id, seq", id)
            if not row:
                raise HTTPException(404, "Goal clip not found.")
            await c.execute("INSERT INTO audit_log(user_id,action,game_id,payload) VALUES($1,'goal_clip_remove',$2,$3)", actor.id,
                            row["game_id"], json.dumps({"id": str(id), "seq": row["seq"]}))
        await run_in_threadpool(shutil.rmtree, folder(id), True)
        return {"ok": True}

    @router.api_route("/{id}/{kind}", methods=["GET", "HEAD"])
    async def media(id: UUID, kind: str, pool=Depends(db)):
        if kind not in ("video", "poster") or not await pool.fetchval("SELECT 1 FROM goal_clips WHERE id=$1 AND state='ready'", id):
            raise HTTPException(404, "Goal clip not found.")
        path = folder(id) / ("video.mp4" if kind == "video" else "poster.jpg")
        if not path.is_file():
            raise HTTPException(404, "Goal clip media is unavailable.")
        return FileResponse(path, media_type="video/mp4" if kind == "video" else "image/jpeg")

    return router
