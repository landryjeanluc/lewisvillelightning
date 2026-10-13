"""Adversarial regression coverage against real PostgreSQL and the ASGI app."""
import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import patch

import bcrypt
import httpx

from app import signer, contract


async def run_security_tests(app, pool, ok):
    results = []
    def check(name, condition):
        results.append(ok("security: " + name, condition))

    transport = httpx.ASGITransport(app=app)
    password_hash = bcrypt.hashpw(b"test-password", bcrypt.gensalt(rounds=4)).decode()
    ids = {}
    for role, pid in (("admin", None), ("parent", "pl-02"), ("player", "pl-02"), ("viewer", None)):
        ids[role] = await pool.fetchval("INSERT INTO users(email,display_name,password_hash,role,player_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
                                       f"audit-{role}", f"Audit {role}", password_hash, role, pid)
    clients = {role: httpx.AsyncClient(transport=transport, base_url="http://t/api", cookies={"lvlnb_session": signer.dumps([uid, 1])}) for role, uid in ids.items()}
    async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
        admin, parent, player, viewer = (clients[k] for k in ("admin", "parent", "player", "viewer"))
        try:
            gid = next(iter(contract.games))
            for path in ("/stats/season", f"/stats/game/{gid}", "/profiles", "/news", f"/notes/{gid}", "/jobs/types", f"/jobs/{gid}", "/goals", "/plays", "/users", "/moderation/queue"):
                response = await anon.get(path)
                check(f"unauthenticated {path} denied without caching", response.status_code == 401 and response.headers.get("cache-control") == "no-store")
            check("API documentation is not public", (await anon.get("/openapi.json")).status_code == 404)
            for payload in ([1], [1, 1, 1], {"id": 1}, "1", [True, 1], [2**64, 1]):
                anon.cookies.set("lvlnb_session", signer.dumps(payload))
                check("malformed signed cookie rejected", (await anon.get("/auth/me")).json() is None)
            anon.cookies.clear()
            for headers in ({"origin": "https://evil.invalid"}, {"origin": "null"}, {"sec-fetch-site": "cross-site"}, {"sec-fetch-site": "same-site"}):
                check("cross-origin writes rejected globally", (await admin.post("/reload", headers=headers)).status_code == 403)
            check("same-origin write works", (await admin.post("/reload", headers={"origin": "http://t"})).status_code == 200)
            check("oversized body rejected before JSON parsing", (await anon.post("/auth/login", content=b"x" * (1024*1024+1))).status_code == 413)
            response = await anon.post("/auth/login", json={"email": "nobody", "password": "é" * 40})
            check("bcrypt byte limit returns validation error without echoing password", response.status_code == 422 and "é" * 40 not in response.text)
            # The request address comes from the trusted ASGI proxy handling, not an arbitrary header.
            await pool.execute("DELETE FROM login_attempts")
            responses = await asyncio.gather(*(anon.post("/auth/login", headers={"X-Forwarded-For": f"fake-{i}"}, json={"email": "missing-audit-user", "password": "wrong"}) for i in range(8)))
            check("concurrent login attempts cannot bypass account throttle", sorted(r.status_code for r in responses) == [401]*5 + [429]*3)
            check("forwarded client input is not trusted", not await pool.fetchval("SELECT EXISTS(SELECT 1 FROM login_attempts WHERE ip LIKE 'fake-%')"))
            await pool.execute("DELETE FROM login_attempts")
            await pool.execute("DELETE FROM auth_limits")
            # Exercise configured SMTP without sending real mail.
            with patch("app.SMTP_HOST", "test.invalid"), patch("app.send_mail", return_value=True) as mail:
                await pool.execute("UPDATE users SET email='audit-parent@example.invalid' WHERE id=$1", ids['parent'])
                known = await anon.post("/auth/forgot", json={"email": "audit-parent@example.invalid"})
                unknown = await anon.post("/auth/forgot", json={"email": "missing@example.invalid"})
                check("reset response does not disclose account/delivery", known.status_code == unknown.status_code == 200 and known.json() == unknown.json() and "delivered" not in known.json())
                check("configured mail is sent once", mail.call_count == 1)
                raw = mail.call_args.args[2].split("token=")[1].split()[0]
                check("only token hash persists", await pool.fetchval("SELECT token_hash FROM password_resets WHERE user_id=$1 ORDER BY id DESC LIMIT 1", ids['parent']) == hashlib.sha256(raw.encode()).hexdigest())
                responses = await asyncio.gather(*(anon.post("/auth/reset", json={"token": raw, "password": "replacement-password"}) for _ in range(2)))
                check("simultaneous reset reuse succeeds exactly once", sorted(r.status_code for r in responses) == [200,400])
                check("reset revokes previous sessions", (await parent.get("/auth/verify")).status_code == 401)
                parent.cookies.set("lvlnb_session", signer.dumps([ids['parent'], 2]))
            for _ in range(3):
                response = await anon.post("/auth/forgot", json={"email": "missing@example.invalid"})
            check("forgot requests are throttled for unknown accounts too", response.status_code == 429)
            raw = uuid4().hex
            await pool.execute("INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,$3)", ids['viewer'], hashlib.sha256(raw.encode()).hexdigest(), datetime.now(timezone.utc)+timedelta(hours=1))
            await admin.patch(f"/users/{ids['viewer']}", json={"password": "admin-replacement"})
            check("admin password change invalidates pending reset links", (await anon.post("/auth/reset", json={"token": raw, "password": "attacker-password"})).status_code == 400)
            created = await admin.post("/users", json={"email": "audit-family", "display_name": "Guardian", "password": "strong-enough", "role": "parent", "player_id": "pl-02", "relationship": "Guardian"})
            check("account creation persists family link", created.status_code == 201 and created.json().get("player_id") == "pl-02")
            uid = created.json()["id"]
            await admin.patch(f"/users/{uid}", json={"player_id": "pl-03", "relationship": "Parent"})
            check("account patch changes family link", await pool.fetchval("SELECT player_id FROM users WHERE id=$1", uid) == "pl-03")
            check("unknown family link rejected", (await admin.patch(f"/users/{uid}", json={"player_id": "unknown"})).status_code == 400)
            check("blank display name rejected", (await admin.patch(f"/users/{uid}", json={"display_name": "   "})).status_code == 422)
            # Scoresheets must not crash on partial scores or double-count duplicate rows.
            check("duplicate scoresheet players rejected", (await admin.put(f"/stats/game/{gid}", json={"lines": [{"player_id":"pl-02"}]*2})).status_code == 422)
            await admin.put(f"/stats/game/{gid}", json={"our_score": 3, "their_score": None, "lines": [{"player_id":"pl-02", "g":3}]})
            totals = await admin.get("/stats/season")
            check("partial final scores do not crash or count", totals.status_code == 200 and totals.json()["team"]["gp"] == 0 and totals.json()["skaters"] == [])
            check("remote profile image rejected", (await admin.put("/profiles/pl-02", json={"photo":"https://tracker.invalid/image.jpg"})).status_code == 422)
            # Restrict new and existing private rooms, in both directions.
            for a,b in ((admin,ids['player']), (player,ids['admin']), (viewer,ids['player'])):
                check("unrelated adult-child DM rejected", (await a.post("/chat/direct", json={"user_id": b})).status_code in (401,403))
            peer_id = await pool.fetchval("INSERT INTO users(email,display_name,password_hash,role,player_id) VALUES('audit-peer','Peer','unused','player','pl-03') RETURNING id")
            peer_room = await player.post("/chat/direct", json={"user_id": peer_id})
            check("player-to-player private messages are allowed", peer_room.status_code == 200)
            peer_message = await player.post(f"/chat/conversations/{peer_room.json()['id']}/messages", json={"body":"Great practice", "client_id":str(uuid4())})
            check("players can send to their peer conversation", peer_message.status_code == 200)
            direct = await parent.post("/chat/direct", json={"user_id": ids['player']})
            check("linked guardian-child DM works", direct.status_code == 200)
            cid = direct.json()["id"]
            msgpath = f"/chat/conversations/{cid}/messages"
            sent = await parent.post(msgpath, json={"body":"See you at practice", "client_id":str(uuid4())})
            mid = sent.json()["id"]
            check("member can report a private message", (await player.post(f"{msgpath}/{mid}/report")).status_code == 200)
            flag = await pool.fetchval("SELECT id FROM flagged_content WHERE surface='chat' AND ref_id=$1 ORDER BY id DESC LIMIT 1", str(mid))
            check("report removal erases the actual message", (await admin.post(f"/moderation/{flag}/review", json={"action":"remove"})).status_code == 200 and await pool.fetchval("SELECT body FROM chat_messages WHERE id=$1", mid) == "")
            blocked = await player.post(msgpath, json={"body":"I am going to kill you", "client_id":str(uuid4())})
            check("harmful chat is held and retained for review", blocked.status_code == 422 and await pool.fetchval("SELECT count(*) FROM flagged_content WHERE surface='chat' AND held AND author_id=$1", ids['player']) == 1)
            await pool.execute("UPDATE users SET player_id='pl-03' WHERE id=$1", ids['parent'])
            check("changed family link revokes access to existing child DMs", (await parent.get(msgpath)).status_code == 404 and cid not in [r['id'] for r in (await parent.get('/chat/conversations')).json()])
            await admin.put(f"/notes/{gid}/preview", json={"body":"that was a stupid play"})
            flag = await pool.fetchval("SELECT id FROM flagged_content WHERE surface='note:preview' ORDER BY id DESC LIMIT 1")
            await admin.post(f"/moderation/{flag}/review", json={"action":"remove"})
            check("moderation removes published note", not await pool.fetchval("SELECT body FROM game_notes WHERE game_id=$1 AND kind='preview'", gid))
            post = await admin.post("/news", json={"title":"Audit news", "body":"Great game"})
            check("news edits cannot bypass moderation", (await admin.put(f"/news/{post.json()['id']}", json={"title":"Audit news", "body":"I am going to kill you", "status":"published"})).status_code == 422)
            # User deletion with authored data must preserve history.
            goal = await pool.fetchval("INSERT INTO training_goals(title,scope,unit,target,starts_on,ends_on,created_by) VALUES('Audit','team','shots',10,current_date,current_date,$1) RETURNING id", uid)
            await pool.execute("INSERT INTO goal_entries(goal_id,player_id,amount,performed_on,created_by,client_id) VALUES($1,'pl-02',1,current_date,$2,$3)", goal, uid, uuid4())
            check("account with training history can be deleted", (await admin.delete(f"/users/{uid}")).status_code == 200)
            check("history survives account deletion", await pool.fetchval("SELECT amount FROM goal_entries WHERE goal_id=$1", goal) == 1)
            check("admin self-deletion is safely refused", (await admin.delete(f"/users/{ids['admin']}")).status_code == 409)
            cookie = signer.dumps([ids['admin'], 1])
            logged_out = await admin.post("/auth/logout")
            check("logout asks the browser to clear cached private data", logged_out.headers.get("clear-site-data") == '"cache", "storage"')
            admin.cookies.set("lvlnb_session", cookie)
            check("logout revokes a copied session", (await admin.get("/auth/verify")).status_code == 401)
        finally:
            for client in clients.values():
                await client.aclose()
    return results
