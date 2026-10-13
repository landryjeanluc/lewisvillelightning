"""Chat integration coverage, called by test_api.py against its real database."""
import asyncio
from uuid import uuid4

import httpx

from app import signer


async def run_chat_tests(app, pool, ok):
    results = []

    def check(name, condition):
        results.append(ok("chat: " + name, condition))

    ids = []
    for name, role in (("Chat parent", "parent"), ("Chat player", "player"), ("Chat admin", "admin")):
        ids.append(await pool.fetchval("""INSERT INTO users (email,display_name,password_hash,role)
            VALUES ($1,$2,'unused',$3) RETURNING id""", f"chat-{uuid4()}", name, role))
    await pool.execute("UPDATE users SET player_id='pl-02' WHERE id=ANY($1::bigint[])", ids[:2])
    transport = httpx.ASGITransport(app=app)
    clients = [httpx.AsyncClient(transport=transport, base_url="http://t/api",
               cookies={"lvlnb_session": signer.dumps([uid, 1])}) for uid in ids]
    parent, player, admin = clients
    anon = httpx.AsyncClient(transport=transport, base_url="http://t/api")
    try:
        for path in ("/chat/members", "/chat/conversations", "/chat/conversations/1/messages"):
            check(f"anonymous denied {path}", (await anon.get(path)).status_code == 401)
        for path, body in (("/chat/direct", {"user_id": ids[0]}),
                           ("/chat/conversations/1/messages", {"body": "hi", "client_id": str(uuid4())}),
                           ("/chat/conversations/1/read", {"message_id": 1})):
            check(f"anonymous write denied {path}", (await anon.post(path, json=body)).status_code == 401)
        check("anonymous delete denied", (await anon.delete("/chat/conversations/1/messages/1")).status_code == 401)
        members = await parent.get("/chat/members")
        check("member directory exposes names and ids only", all(set(m) == {"id", "display_name"} for m in members.json()))
        check("responses cannot be cached", members.headers.get("cache-control") == "no-store")
        team = (await parent.get("/chat/conversations")).json()[0]["id"]
        direct = (await parent.post("/chat/direct", json={"user_id": ids[1]})).json()["id"]
        reverse = (await player.post("/chat/direct", json={"user_id": ids[0]})).json()["id"]
        check("one direct conversation in either direction", direct == reverse)
        check("cannot message yourself", (await parent.post("/chat/direct", json={"user_id": ids[0]})).status_code == 400)
        check("unknown member rejected", (await parent.post("/chat/direct", json={"user_id": 999999})).status_code == 404)
        check("other members do not list a private conversation", direct not in [r["id"] for r in (await admin.get("/chat/conversations")).json()])
        for method, suffix, body in (("GET", "/messages", None),
                                     ("POST", "/messages", {"body": "intrusion", "client_id": str(uuid4())}),
                                     ("POST", "/read", {"message_id": 1}), ("DELETE", "/messages/1", None)):
            r = await admin.request(method, f"/chat/conversations/{direct}{suffix}", json=body)
            check(f"even admins cannot {method} someone else's private conversation", r.status_code == 404)
        path = f"/chat/conversations/{direct}/messages"
        check("whitespace rejected", (await parent.post(path, json={"body": " \n\t", "client_id": str(uuid4())})).status_code == 422)
        check("long message rejected", (await parent.post(path, json={"body": "x" * 2001, "client_id": str(uuid4())})).status_code == 422)
        check("cross-site writes denied", (await parent.post(path, headers={"Sec-Fetch-Site": "cross-site"}, json={"body": "hi", "client_id": str(uuid4())})).status_code == 403)
        body = {"body": "  See you at the rink!  ", "client_id": str(uuid4())}
        first, retry = await asyncio.gather(parent.post(path, json=body), parent.post(path, json=body))
        mid = first.json()["id"]
        check("concurrent retries insert once", first.status_code == retry.status_code == 200 and mid == retry.json()["id"])
        check("sender comes from session and body is trimmed", first.json()["sender_id"] == ids[0] and first.json()["body"] == "See you at the rink!")
        check("nonce cannot move a message to another room", (await parent.post(f"/chat/conversations/{team}/messages", json=body)).status_code == 409)
        page = (await player.get(path)).json()
        check("recipient receives the message", [m["id"] for m in page["messages"]] == [mid])
        room = next(r for r in (await player.get("/chat/conversations")).json() if r["id"] == direct)
        check("recipient gets unread count", room["unread"] == 1)
        check("recipient cannot delete sender's message", (await player.delete(f"{path}/{mid}")).status_code == 403)
        check("sender can remove their message", (await parent.delete(f"{path}/{mid}")).status_code == 200)
        updates = (await player.get(path, params={"after": page["cursor"]})).json()
        check("removal delivered through update cursor without body", len(updates["messages"]) == 1 and updates["messages"][0]["body"] == "" and updates["messages"][0]["deleted_at"])
        check("removed messages no longer unread", next(r for r in (await player.get("/chat/conversations")).json() if r["id"] == direct)["unread"] == 0)
        team_message = (await player.post(f"/chat/conversations/{team}/messages", json={"body": "Go Lightning!", "client_id": str(uuid4())})).json()
        check("viewer/player can post to the team", team_message["sender_id"] == ids[1])
        check("cannot mark a different room's message as read", (await parent.post(f"/chat/conversations/{direct}/read", json={"message_id": team_message["id"]})).status_code == 404)
        check("admins can moderate team messages", (await admin.delete(f"/chat/conversations/{team}/messages/{team_message['id']}")).status_code == 200)
        check("moderation audited without message contents", await pool.fetchval("SELECT count(*) FROM audit_log WHERE action='chat_remove' AND user_id=$1", ids[2]) == 1)
        # Populate older history outside the rate window; exercise real keyset pages.
        history = []
        for i in range(55):
            history.append(await pool.fetchval("""INSERT INTO chat_messages
                (conversation_id,sender_id,client_id,body,created_at)
                VALUES ($1,$2,$3,$4,now()-interval '2 minutes') RETURNING id""", direct, ids[0], uuid4(), f"History {i}"))
        recent = (await player.get(path)).json()
        earlier = (await player.get(path, params={"before": recent["messages"][0]["id"]})).json()
        all_ids = [m["id"] for m in earlier["messages"] + recent["messages"]]
        check("history pages have no gaps or duplicates", recent["has_more"] and not earlier["has_more"] and all_ids == [mid] + history)
        catchup = (await player.get(path, params={"after": 0})).json()
        catchup2 = (await player.get(path, params={"after": catchup["cursor"]})).json()
        check("updates page through bursts without losing messages", catchup["has_more"] and not catchup2["has_more"] and len(catchup["messages"] + catchup2["messages"]) == 56)
        check("negative cursor rejected", (await player.get(path, params={"after": -1})).status_code == 422)
        check("conflicting cursors rejected", (await player.get(path, params={"after": 0, "before": mid})).status_code == 400)
        await player.post(f"/chat/conversations/{direct}/read", json={"message_id": history[-1]})
        await player.post(f"/chat/conversations/{direct}/read", json={"message_id": history[0]})
        check("read marker never moves backwards", await pool.fetchval("SELECT last_read_id FROM chat_reads WHERE conversation_id=$1 AND user_id=$2", direct, ids[1]) == history[-1])
        check("reading clears unread count", next(r for r in (await player.get("/chat/conversations")).json() if r["id"] == direct)["unread"] == 0)
        # Deleted messages still count toward the send limit.
        await pool.execute("UPDATE chat_messages SET created_at=now() WHERE id=ANY($1::bigint[])", history[:28])
        sends = await asyncio.gather(*(parent.post(path, json={"body": "rate test", "client_id": str(uuid4())}) for _ in range(2)))
        check("concurrent sends enforce 30 per minute", sorted(r.status_code for r in sends) == [200, 429])
        check("rate limit includes retry hint", next(r for r in sends if r.status_code == 429).headers.get("retry-after") == "60")
        await pool.execute("UPDATE users SET session_epoch=session_epoch+1 WHERE id=$1", ids[0])
        check("revoked sessions lose chat access", (await parent.get(path)).status_code == 401)
        # Migration is rerunnable and does not duplicate the team room.
        from pathlib import Path
        await pool.execute(Path(__file__).with_name("schema.sql").read_text())
        check("schema safely reapplies with chat data", await pool.fetchval("SELECT count(*) FROM chat_conversations WHERE kind='team'") == 1)
    finally:
        for client in [*clients, anon]:
            await client.aclose()
    return results
