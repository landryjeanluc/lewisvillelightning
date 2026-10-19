"""Private player highlights, uploaded by admins in bounded, retryable pieces."""
import json
import os
import shutil
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from highlight_media import CHUNK_BYTES, MAX_BYTES, prepare_clip, same_chunk, write_chunk
from security import rate_limit

MEDIA_DIR = Path(os.environ.get("HIGHLIGHT_DIR", Path(__file__).parent / "private" / "highlights"))


class UploadIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: UUID
    player_id: str
    title: str = Field(min_length=1, max_length=100)
    game_id: str | None = None
    bytes: int = Field(gt=0, le=MAX_BYTES)


def build_router(require_admin, current_user, db, contract):
    router = APIRouter(prefix="/highlights")

    def folder(id):
        return MEDIA_DIR / str(id)

    def item(row):
        game = contract.games.get(row["game_id"])
        return {"id": str(row["id"]), "title": row["title"], "player_id": row["player_id"],
                "game_id": row["game_id"], "game_date": game["startsAt"][:10] if game else None,
                "duration": row["duration"], "created_at": row["created_at"],
                "video_url": f"/api/highlights/{row['id']}/video",
                "poster_url": f"/api/highlights/{row['id']}/poster"}

    async def lock_upload(c, id, actor):
        row = await c.fetchrow("SELECT * FROM player_highlights WHERE id=$1 FOR UPDATE", id)
        if not row or row["created_by"] != actor.id:
            raise HTTPException(404, "Highlight upload not found.")
        return row

    @router.get("")
    async def listing(player_id: str, user=Depends(current_user), pool=Depends(db)):
        if player_id not in contract.players:
            raise HTTPException(404, "Player not found.")
        rows = await pool.fetch("SELECT * FROM player_highlights WHERE player_id=$1 AND state='ready' ORDER BY created_at DESC, id DESC", player_id)
        return {"highlights": [item(row) for row in rows], "can_manage": user.role == "admin"}

    @router.post("/uploads", status_code=201)
    async def start(body: UploadIn, actor=Depends(require_admin), pool=Depends(db)):
        if body.player_id not in contract.players:
            raise HTTPException(404, "Player not found.")
        if body.game_id is not None and body.game_id not in contract.games:
            raise HTTPException(422, "Choose a game from the schedule.")
        await rate_limit(pool, "highlight-upload", str(actor.id), 30, 3600)
        # A browser may close mid-upload. Reclaim abandoned originals without
        # touching published clips or uploads that are still making progress.
        expired = await pool.fetch("DELETE FROM player_highlights WHERE state='uploading' AND updated_at < now()-interval '48 hours' RETURNING id")
        for stale in expired:
            await run_in_threadpool(shutil.rmtree, folder(stale["id"]), True)
        async with pool.acquire() as c, c.transaction():
            await c.execute("INSERT INTO player_highlights(id,player_id,title,game_id,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
                            body.id, body.player_id, body.title, body.game_id, body.bytes, actor.id)
            row = await lock_upload(c, body.id, actor)
            if any(row[key] != getattr(body, key) for key in ("player_id", "title", "game_id", "bytes")):
                raise HTTPException(409, "This upload belongs to another clip. Start a new upload.")
            folder(body.id).mkdir(parents=True, exist_ok=True, mode=0o700)
        return {"id": str(body.id), "received": row["received"], "state": row["state"], "chunk_bytes": CHUNK_BYTES}

    @router.put("/uploads/{id}")
    async def chunk(id: UUID, request: Request, offset: int = Query(ge=0), actor=Depends(require_admin), pool=Depends(db)):
        data = await request.body()
        if not 0 < len(data) <= CHUNK_BYTES:
            raise HTTPException(413, "Upload a smaller piece of the clip.")
        async with pool.acquire() as c, c.transaction():
            row = await lock_upload(c, id, actor)
            if row["state"] != "uploading":
                raise HTTPException(409, "This clip is already published.")
            path = folder(id) / "source.mp4"
            if offset < row["received"] and offset + len(data) <= row["received"]:
                if await run_in_threadpool(same_chunk, path, offset, data):
                    return {"received": row["received"]}
            if offset != row["received"] or offset + len(data) > row["bytes"]:
                raise HTTPException(409, "The upload position changed. Retry the upload.")
            await run_in_threadpool(write_chunk, path, offset, data)
            received = offset + len(data)
            await c.execute("UPDATE player_highlights SET received=$2, updated_at=now() WHERE id=$1", id, received)
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
            row = await c.fetchrow("UPDATE player_highlights SET state='ready',duration=$2,updated_at=now() WHERE id=$1 RETURNING *", id, media["duration"])
            await c.execute("INSERT INTO audit_log(user_id,action,payload) VALUES($1,'highlight_publish',$2)", actor.id,
                            json.dumps({"id": str(id), "player_id": row["player_id"], "game_id": row["game_id"]}))
        (folder(id) / "source.mp4").unlink(missing_ok=True)
        return item(row)

    @router.delete("/{id}")
    async def remove(id: UUID, actor=Depends(require_admin), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            row = await c.fetchrow("DELETE FROM player_highlights WHERE id=$1 RETURNING player_id", id)
            if not row:
                raise HTTPException(404, "Highlight not found.")
            await c.execute("INSERT INTO audit_log(user_id,action,payload) VALUES($1,'highlight_remove',$2)", actor.id,
                            json.dumps({"id": str(id), "player_id": row["player_id"]}))
        for name in ("source.mp4", "video.mp4", "poster.jpg"):
            (folder(id) / name).unlink(missing_ok=True)
        if folder(id).is_dir():
            folder(id).rmdir()
        return {"ok": True}

    @router.api_route("/{id}/{kind}", methods=["GET", "HEAD"])
    async def media(id: UUID, kind: str, pool=Depends(db)):
        if kind not in ("video", "poster") or not await pool.fetchval("SELECT 1 FROM player_highlights WHERE id=$1 AND state='ready'", id):
            raise HTTPException(404, "Highlight not found.")
        path = folder(id) / ("video.mp4" if kind == "video" else "poster.jpg")
        if not path.is_file():
            raise HTTPException(404, "Highlight media is unavailable.")
        return FileResponse(path, media_type="video/mp4" if kind == "video" else "image/jpeg")

    return router
