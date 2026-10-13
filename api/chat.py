"""Private, account-only team chat. Existing invited accounts are members."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator


class DirectChat(BaseModel):
    user_id: int = Field(gt=0)


class MessageBody(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    client_id: UUID

    @field_validator("body")
    @classmethod
    def trim_body(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("write a message first")
        return value


class ReadBody(BaseModel):
    message_id: int = Field(gt=0)


MESSAGE_SELECT = """SELECT m.id, m.conversation_id, m.sender_id, m.body,
    m.created_at, m.deleted_at, m.revision,
    coalesce(u.display_name, 'Former member') AS sender_name
    FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id"""


def chat_router(current_user, db):
    async def member(request: Request, user=Depends(current_user)):
        if user is None:
            raise HTTPException(401, "sign in to use chat")
        # Same-origin browser writes; cookies remain HttpOnly and SameSite=Lax.
        if request.method != "GET" and request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "use chat from the team website")
        return user

    router = APIRouter(prefix="/chat", dependencies=[Depends(member)])

    @router.middleware if False else (lambda f: f)
    def _unused():
        pass

    async def conversation(c, cid, uid, lock=False):
        row = await c.fetchrow(
            "SELECT * FROM chat_conversations WHERE id=$1"
            " AND (kind='team' OR user_low=$2 OR user_high=$2)"
            + (" FOR UPDATE" if lock else ""), cid, uid)
        if row is None:
            raise HTTPException(404, "conversation not found")
        return row

    @router.get("/members")
    async def members(user=Depends(member), pool=Depends(db)):
        rows = await pool.fetch(
            "SELECT id, display_name FROM users WHERE id <> $1 ORDER BY lower(display_name), id", user.id)
        return [dict(r) for r in rows]

    @router.get("/conversations")
    async def conversations(user=Depends(member), pool=Depends(db)):
        rows = await pool.fetch("""
            SELECT c.id, c.kind,
                CASE WHEN c.kind='team' THEN 'Team room' ELSE u.display_name END AS name,
                last.body AS last_message, last.created_at AS last_message_at,
                last.deleted_at IS NOT NULL AS last_deleted,
                (SELECT count(*) FROM chat_messages m WHERE m.conversation_id=c.id
                    AND m.id > coalesce(r.last_read_id, 0)
                    AND m.sender_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL) AS unread
            FROM chat_conversations c
            LEFT JOIN users u ON u.id=CASE WHEN c.user_low=$1 THEN c.user_high ELSE c.user_low END
            LEFT JOIN chat_reads r ON r.conversation_id=c.id AND r.user_id=$1
            LEFT JOIN LATERAL (SELECT body, created_at, deleted_at FROM chat_messages
                WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last ON true
            WHERE c.kind='team' OR c.user_low=$1 OR c.user_high=$1
            ORDER BY (c.kind='team') DESC, last.created_at DESC NULLS LAST, c.id
        """, user.id)
        return [dict(r) for r in rows]

    @router.post("/direct")
    async def direct(body: DirectChat, user=Depends(member), pool=Depends(db)):
        if body.user_id == user.id:
            raise HTTPException(400, "choose another team member")
        async with pool.acquire() as c, c.transaction():
            if not await c.fetchval("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", body.user_id):
                raise HTTPException(404, "team member not found")
            low, high = sorted((user.id, body.user_id))
            cid = await c.fetchval("""INSERT INTO chat_conversations (kind, user_low, user_high)
                VALUES ('direct',$1,$2) ON CONFLICT (user_low,user_high)
                DO UPDATE SET kind='direct' RETURNING id""", low, high)
        return {"id": cid}

    @router.get("/conversations/{cid}/messages")
    async def messages(cid: int,
                       before: Annotated[int | None, Query(gt=0)] = None,
                       after: Annotated[int | None, Query(ge=0)] = None,
                       user=Depends(member), pool=Depends(db)):
        if before is not None and after is not None:
            raise HTTPException(400, "choose history or updates, not both")
        # Cursor and initial history must reflect the same committed snapshot.
        async with pool.acquire() as c, c.transaction(isolation="repeatable_read"):
            await conversation(c, cid, user.id)
            if after is not None:
                rows = await c.fetch(MESSAGE_SELECT + " WHERE m.conversation_id=$1"
                                    " AND m.revision>$2 ORDER BY m.revision LIMIT 51", cid, after)
                page = rows[:50]
                cursor = page[-1]["revision"] if page else after
            else:
                cursor = await c.fetchval(
                    "SELECT coalesce(max(revision),0) FROM chat_messages WHERE conversation_id=$1", cid)
                rows = await c.fetch(MESSAGE_SELECT + " WHERE m.conversation_id=$1"
                                    " AND ($2::bigint IS NULL OR m.id<$2) ORDER BY m.id DESC LIMIT 51", cid, before)
                page = list(reversed(rows[:50]))
        return {"messages": [dict(r) for r in page], "cursor": cursor, "has_more": len(rows) > 50}

    @router.post("/conversations/{cid}/messages")
    async def send(cid: int, body: MessageBody, user=Depends(member), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            # Serialize a sender's rate check and nonce, and a room's revisions.
            await c.execute("SELECT id FROM users WHERE id=$1 FOR UPDATE", user.id)
            await conversation(c, cid, user.id, lock=True)
            existing = await c.fetchrow(MESSAGE_SELECT + " WHERE m.sender_id=$1 AND m.client_id=$2",
                                       user.id, body.client_id)
            if existing:
                if existing["conversation_id"] != cid:
                    raise HTTPException(409, "message already sent to another conversation")
                return dict(existing)
            count = await c.fetchval("""SELECT count(*) FROM chat_messages
                WHERE sender_id=$1 AND created_at > now() - interval '1 minute'""", user.id)
            if count >= 30:
                raise HTTPException(429, "please wait a minute before sending more messages",
                                    headers={"Retry-After": "60"})
            mid = await c.fetchval("""INSERT INTO chat_messages
                (conversation_id,sender_id,client_id,body) VALUES ($1,$2,$3,$4) RETURNING id""",
                cid, user.id, body.client_id, body.body)
            row = await c.fetchrow(MESSAGE_SELECT + " WHERE m.id=$1", mid)
        return dict(row)

    @router.post("/conversations/{cid}/read")
    async def read(cid: int, body: ReadBody, user=Depends(member), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            await conversation(c, cid, user.id)
            if not await c.fetchval("SELECT id FROM chat_messages WHERE id=$1 AND conversation_id=$2",
                                    body.message_id, cid):
                raise HTTPException(404, "message not found")
            await c.execute("""INSERT INTO chat_reads (conversation_id,user_id,last_read_id)
                VALUES ($1,$2,$3) ON CONFLICT (conversation_id,user_id) DO UPDATE
                SET last_read_id=greatest(chat_reads.last_read_id,EXCLUDED.last_read_id)""",
                cid, user.id, body.message_id)
        return {"ok": True}

    @router.delete("/conversations/{cid}/messages/{mid}")
    async def remove(cid: int, mid: int, user=Depends(member), pool=Depends(db)):
        async with pool.acquire() as c, c.transaction():
            room = await conversation(c, cid, user.id, lock=True)
            msg = await c.fetchrow("SELECT sender_id,deleted_at FROM chat_messages WHERE id=$1 AND conversation_id=$2", mid, cid)
            if msg is None:
                raise HTTPException(404, "message not found")
            if msg["sender_id"] != user.id and not (user.role == "admin" and room["kind"] == "team"):
                raise HTTPException(403, "you can only remove your own messages")
            if not msg["deleted_at"]:
                await c.execute("""UPDATE chat_messages SET body='',deleted_at=now(),
                    revision=nextval('chat_revision_seq') WHERE id=$1""", mid)
                await c.execute("""INSERT INTO audit_log (user_id,action,payload)
                    VALUES ($1,'chat_remove',jsonb_build_object('message_id',$2::bigint))""", user.id, mid)
        return {"ok": True}

    return router
