"""Exercise the API end to end against a real Postgres, in-process."""
import asyncio, os, bcrypt, asyncpg, httpx
from app import app, signer

async def main():
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        pool = app.state.pool
        # seed one admin and one viewer
        for email, role in (("admin@lvlnb.ca", "admin"), ("parent@lvlnb.ca", "viewer")):
            h = bcrypt.hashpw(b"hockey123", bcrypt.gensalt(rounds=4)).decode()
            await pool.execute(
                "INSERT INTO users (email, display_name, password_hash, role) VALUES ($1,$2,$3,$4)"
                " ON CONFLICT (email) DO NOTHING", email, email.split("@")[0], h, role)

        async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as c:
            def ok(n, cond, extra=""):
                cond = bool(cond)
                print(f"  {'PASS' if cond else 'FAIL'}  {n} {extra}")
                return cond
            results = []

            r = await c.get("/health")
            results.append(ok("health", r.status_code == 200 and r.json()["players"] == 19, r.text[:90]))

            r = await c.get("/auth/me")
            results.append(ok("anonymous /auth/me is null", r.json() is None))

            r = await c.put("/stats/game/g-2026-10-13-shediac", json={"lines": []})
            results.append(ok("write without session -> 401", r.status_code == 401))

            r = await c.post("/auth/login", json={"email": "admin@lvlnb.ca", "password": "wrong"})
            results.append(ok("wrong password -> 401", r.status_code == 401))

            r = await c.post("/auth/login", json={"email": "parent@lvlnb.ca", "password": "hockey123"})
            results.append(ok("viewer can log in", r.status_code == 200 and r.json()["role"] == "viewer"))
            r = await c.put("/stats/game/g-2026-10-13-shediac", json={"lines": []})
            results.append(ok("viewer write -> 403", r.status_code == 403, f"got {r.status_code}"))

            r = await c.post("/auth/login", json={"email": "admin@lvlnb.ca", "password": "hockey123"})
            results.append(ok("admin can log in", r.status_code == 200 and r.json()["role"] == "admin"))

            r = await c.put("/stats/game/not-a-real-game", json={"lines": []})
            results.append(ok("unknown game -> 404", r.status_code == 404))

            r = await c.put("/stats/game/g-2026-10-13-shediac",
                            json={"lines": [{"player_id": "pl-99", "g": 1}]})
            results.append(ok("unknown player -> 400", r.status_code == 400))

            r = await c.put("/stats/game/g-2026-10-13-shediac", json={
                "our_score": 3, "their_score": 2, "status": "final",
                "lines": [
                    {"player_id": "pl-02", "g": 2, "a": 0, "pim": 0,  "plus_minus": 2},
                    {"player_id": "pl-22", "g": 1, "a": 1, "pim": 4,  "plus_minus": 1},
                    {"player_id": "pl-03", "g": 0, "a": 2, "pim": 0,  "plus_minus": -1},
                ]})
            results.append(ok("admin saves scoresheet", r.status_code == 200 and r.json()["saved"] == 3))
            results.append(ok("consistent sheet -> no warning", r.json()["warnings"] == []))

            r = await c.put("/stats/game/g-2026-10-13-shediac", json={
                "our_score": 9, "status": "final",
                "lines": [{"player_id": "pl-02", "g": 1}]})
            results.append(ok("score mismatch warns but saves", r.status_code == 200 and r.json()["warnings"], r.json().get("warnings", [""])[0][:60]))

            # re-save the good sheet, then check the whole-sheet replace worked
            await c.put("/stats/game/g-2026-10-13-shediac", json={
                "our_score": 3, "their_score": 2, "status": "final",
                "lines": [
                    {"player_id": "pl-02", "g": 2, "a": 0, "pim": 0, "plus_minus": 2},
                    {"player_id": "pl-22", "g": 1, "a": 1, "pim": 4, "plus_minus": 1},
                    {"player_id": "pl-03", "g": 0, "a": 2, "pim": 0, "plus_minus": -1},
                ]})
            r = await c.get("/stats/game/g-2026-10-13-shediac")
            results.append(ok("whole-sheet PUT replaces, no leftovers", len(r.json()["lines"]) == 3,
                              f"got {len(r.json()['lines'])}"))

            r = await c.get("/stats/season")
            s = r.json()
            top = s["skaters"][0]
            results.append(ok("season totals derived", s["team"]["w"] == 1 and s["team"]["gf"] == 3,
                              f"team={s['team']}"))
            results.append(ok("leader sorted by points + enriched from roster",
                              top["pts"] == 2 and top["number"] is not None,
                              f"top={top['firstName']} {top['pts']}pts #{top['number']}"))
            results.append(ok("negative plus_minus survives",
                              any(x["plus_minus"] == -1 for x in s["skaters"])))

            n = await pool.fetchval("SELECT count(*) FROM audit_log")
            results.append(ok("only successful writes are audited (3), not the 401/403/404/400 attempts",
                              n == 3, f"{n} rows"))

            print(f"\n{sum(results)}/{len(results)} passed")
            return 0 if all(results) else 1

raise SystemExit(asyncio.run(main()))
