"""Exercise the API end to end against a real Postgres, in-process."""
import asyncio, json, os, pathlib, bcrypt, asyncpg, httpx
from app import app, signer

async def main():
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        pool = app.state.pool

        # --- bootstrap: the first admin cannot come from the API ---
        import subprocess
        env = {**os.environ}
        boot = subprocess.run([__import__("sys").executable, "manage.py", "bootstrap"],
                              capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
        first = await pool.fetchrow("SELECT email, role FROM users")
        print(f"  {'PASS' if first and first['email']=='jl@hexpi.ca' and first['role']=='admin' else 'FAIL'}"
              f"  bootstrap creates jl@hexpi.ca as admin ({first['email'] if first else 'none'})")
        assert first and first['email']=='jl@hexpi.ca' and first['role']=='admin', "bootstrap failed"
        again = subprocess.run([__import__("sys").executable, "manage.py", "bootstrap"],
                               capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
        print(f"  {'PASS' if again.returncode == 1 else 'FAIL'}"
              f"  bootstrap refuses when accounts already exist")
        assert again.returncode == 1, "bootstrap must refuse a populated database"
        await pool.execute("DELETE FROM users WHERE email = 'jl@hexpi.ca'")

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

            # ---------------- user management ----------------
            r = await c.get("/users")
            results.append(ok("admin lists users", r.status_code == 200 and len(r.json()) == 2))

            r = await c.post("/users", json={"email": "COACH@Example.CA", "display_name": "Coach",
                                             "password": "short", "role": "viewer"})
            results.append(ok("short password rejected", r.status_code == 422))

            r = await c.post("/users", json={"email": "COACH@Example.CA", "display_name": "Coach",
                                             "password": "benchboss1", "role": "viewer"})
            results.append(ok("admin creates user, email normalised",
                              r.status_code == 201 and r.json()["email"] == "coach@example.ca"))
            coach_id = r.json()["id"]

            r = await c.post("/users", json={"email": "coach@example.ca", "display_name": "Dup",
                                             "password": "benchboss1"})
            results.append(ok("duplicate email -> 409", r.status_code == 409))

            # the new account really works
            r = await c.post("/auth/login", json={"email": "coach@example.ca", "password": "benchboss1"})
            results.append(ok("created user can sign in", r.status_code == 200))
            r = await c.get("/users")
            results.append(ok("viewer cannot list users -> 403", r.status_code == 403))

            # back to admin
            await c.post("/auth/login", json={"email": "admin@lvlnb.ca", "password": "hockey123"})

            admin_id = (await c.get("/auth/me")).json()["id"]
            r = await c.patch(f"/users/{admin_id}", json={"role": "viewer"})
            results.append(ok("demoting the only admin -> 409 (no lockout)", r.status_code == 409,
                              (r.json() or {}).get("detail", "")[:48]))
            r = await c.delete(f"/users/{admin_id}")
            results.append(ok("deleting the only admin -> 409", r.status_code == 409))

            r = await c.patch(f"/users/{coach_id}", json={"role": "admin"})
            results.append(ok("admin promotes the coach", r.status_code == 200 and r.json()["role"] == "admin"))

            r = await c.patch(f"/users/{admin_id}", json={"role": "viewer"})
            results.append(ok("with a second admin, demotion is allowed", r.status_code == 200))
            # restore so the rest of the checks still have an admin session
            await pool.execute("UPDATE users SET role='admin' WHERE id=$1", admin_id)

            r = await c.patch(f"/users/{coach_id}", json={"password": "newbenchboss"})
            results.append(ok("admin resets a password", r.status_code == 200))
            r = await c.post("/auth/login", json={"email": "coach@example.ca", "password": "newbenchboss"})
            results.append(ok("reset password works", r.status_code == 200))
            await c.post("/auth/login", json={"email": "admin@lvlnb.ca", "password": "hockey123"})

            before = await pool.fetchval("SELECT count(*) FROM game_stats")
            r = await c.delete(f"/users/{coach_id}")
            after = await pool.fetchval("SELECT count(*) FROM game_stats")
            results.append(ok("deleting a user keeps the stats they entered",
                              r.status_code == 200 and before == after, f"{before} -> {after}"))

            # ---------------- gate, brute force, password reset ----------------
            import hashlib
            from datetime import datetime, timedelta, timezone

            # a clean session for the gate checks
            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
                r = await anon.get("/auth/verify")
                results.append(ok("nginx gate: anonymous verify -> 401", r.status_code == 401))
            r = await c.get("/auth/verify")
            results.append(ok("nginx gate: signed-in verify -> 204", r.status_code == 204,
                              f"got {r.status_code}"))

            # --- brute force ---
            await pool.execute("DELETE FROM login_attempts")
            await pool.execute(
                "INSERT INTO users (email, display_name, password_hash, role)"
                " VALUES ('target@lvlnb.ca','Target',$1,'viewer') ON CONFLICT DO NOTHING",
                bcrypt.hashpw(b"correct-horse", bcrypt.gensalt(rounds=4)).decode())
            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as bf:
                codes = []
                for _ in range(6):
                    rr = await bf.post("/auth/login",
                                       json={"email": "target@lvlnb.ca", "password": "nope"})
                    codes.append(rr.status_code)
                results.append(ok("5 wrong passwords -> 401, the 6th -> 429",
                                  codes[:5] == [401] * 5 and codes[5] == 429, f"{codes}"))
                rr = await bf.post("/auth/login",
                                   json={"email": "target@lvlnb.ca", "password": "correct-horse"})
                results.append(ok("locked out even with the RIGHT password",
                                  rr.status_code == 429, f"got {rr.status_code}"))
                results.append(ok("429 carries Retry-After", "retry-after" in rr.headers))

                # a different account is unaffected by that lockout
                rr = await bf.post("/auth/login",
                                   json={"email": "admin@lvlnb.ca", "password": "hockey123"})
                results.append(ok("lockout is per-account, not global", rr.status_code == 200,
                                  f"got {rr.status_code}"))

            # --- forgot: must not reveal who has an account ---
            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
                r1 = await anon.post("/auth/forgot", json={"email": "target@lvlnb.ca"})
                r2 = await anon.post("/auth/forgot", json={"email": "nobody@nowhere.ca"})
                results.append(ok("forgot: same answer for known and unknown address",
                                  r1.status_code == r2.status_code == 200
                                  and r1.json()["detail"] == r2.json()["detail"]))
                n_tokens = await pool.fetchval("SELECT count(*) FROM password_resets")
                results.append(ok("forgot: no undeliverable token is created without SMTP", n_tokens == 0,
                                  f"{n_tokens} tokens"))

                # the raw token is never stored
                stored = await pool.fetchval("SELECT token_hash FROM password_resets LIMIT 1")
                results.append(ok("no raw reset link is logged", await pool.fetchval("SELECT count(*) FROM audit_log WHERE action='reset_link_undelivered'") == 0))

                r = await anon.post("/auth/reset", json={"token": "garbage", "password": "brandnew1"})
                results.append(ok("bad reset token -> 400", r.status_code == 400))

                # mint one we know the plaintext of
                raw = "known-test-token-value"
                uid = await pool.fetchval("SELECT id FROM users WHERE email='target@lvlnb.ca'")
                await pool.execute(
                    "INSERT INTO password_resets (user_id, token_hash, expires_at)"
                    " VALUES ($1,$2,$3)", uid, hashlib.sha256(raw.encode()).hexdigest(),
                    datetime.now(timezone.utc) + timedelta(hours=1))

                r = await anon.post("/auth/reset", json={"token": raw, "password": "short"})
                results.append(ok("reset enforces password length -> 422", r.status_code == 422))

                r = await anon.post("/auth/reset", json={"token": raw, "password": "brandnewpass"})
                results.append(ok("reset succeeds with a good token", r.status_code == 200))
                r = await anon.post("/auth/reset", json={"token": raw, "password": "anotherpass1"})
                results.append(ok("reset token is single use -> 400", r.status_code == 400))

                r = await anon.post("/auth/login",
                                    json={"email": "target@lvlnb.ca", "password": "brandnewpass"})
                results.append(ok("reset clears the lockout and the new password works",
                                  r.status_code == 200, f"got {r.status_code}"))

                # expired token
                raw2 = "expired-token-value"
                await pool.execute(
                    "INSERT INTO password_resets (user_id, token_hash, expires_at)"
                    " VALUES ($1,$2,$3)", uid, hashlib.sha256(raw2.encode()).hexdigest(),
                    datetime.now(timezone.utc) - timedelta(minutes=1))
                r = await anon.post("/auth/reset", json={"token": raw2, "password": "yetanother1"})
                results.append(ok("expired reset token -> 400", r.status_code == 400))

            # --- a reset must log out sessions that were already open ---
            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as sess:
                await sess.post("/auth/login",
                                json={"email": "target@lvlnb.ca", "password": "brandnewpass"})
                results.append(ok("session valid before reset",
                                  (await sess.get("/auth/verify")).status_code == 204))
                raw3 = "third-token-value"
                await pool.execute(
                    "INSERT INTO password_resets (user_id, token_hash, expires_at)"
                    " VALUES ($1,$2,$3)", uid, hashlib.sha256(raw3.encode()).hexdigest(),
                    datetime.now(timezone.utc) + timedelta(hours=1))
                async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as other:
                    await other.post("/auth/reset", json={"token": raw3, "password": "finalpass123"})
                results.append(ok("existing session is invalidated by the reset",
                                  (await sess.get("/auth/verify")).status_code == 401,
                                  f"got {(await sess.get('/auth/verify')).status_code}"))

            await c.post("/auth/login", json={"email": "admin@lvlnb.ca", "password": "hockey123"})

            # ---------------- news ----------------
            r = await c.post("/news", json={"title": "Season opener recap!", "body": "We won.",
                                            "status": "draft"})
            results.append(ok("admin creates a draft post", r.status_code == 201))
            post_id, slug = r.json()["id"], r.json()["slug"]
            results.append(ok("title is slugified", slug == "season-opener-recap", slug))
            results.append(ok("a draft has no published_at", r.json()["published_at"] is None))

            r2 = await c.post("/news", json={"title": "Season opener recap!", "body": "again"})
            results.append(ok("duplicate title gets a distinct slug",
                              r2.json()["slug"] == "season-opener-recap-2", r2.json()["slug"]))

            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
                await anon.post("/auth/login", json={"email": "parent@lvlnb.ca", "password": "hockey123"})
                pub = await anon.get("/news")
                results.append(ok("drafts are invisible to non-admins", pub.json() == []))
            r = await c.get("/news?include_drafts=true")
            results.append(ok("admin can see drafts", len(r.json()) == 2, f"{len(r.json())}"))

            r = await c.put(f"/news/{post_id}", json={"title": "Season opener recap",
                                                      "body": "We won 3-2.", "status": "published"})
            results.append(ok("publishing stamps published_at", r.json()["published_at"] is not None))
            first_stamp = r.json()["published_at"]
            r = await c.put(f"/news/{post_id}", json={"title": "Season opener recap",
                                                      "body": "We won 3-2. Edited.",
                                                      "status": "published"})
            results.append(ok("later edits keep the original publish date",
                              r.json()["published_at"] == first_stamp))
            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
                await anon.post("/auth/login", json={"email": "parent@lvlnb.ca", "password": "hockey123"})
                results.append(ok("published post is now visible",
                                  len((await anon.get("/news")).json()) == 1))
            r = await c.delete(f"/news/{r2.json()['id']}")
            results.append(ok("admin deletes a post", r.status_code == 200))

            # ---------------- player profiles ----------------
            r = await c.put("/profiles/pl-02", json={"bio": "Loves the breakaway.",
                                                     "position": "C", "shoots": "L", "captain": "C"})
            results.append(ok("admin writes a player bio + details", r.status_code == 200
                              and r.json()["position"] == "C"))
            r = await c.put("/profiles/pl-03", json={"captain": "C"})
            results.append(ok("a second captain is refused -> 409", r.status_code == 409,
                              (r.json() or {}).get("detail", "")[:46]))
            r = await c.put("/profiles/pl-03", json={"captain": "A"})
            results.append(ok("alternates are fine", r.status_code == 200))
            r = await c.put("/profiles/pl-99", json={"bio": "ghost"})
            results.append(ok("unknown player -> 404", r.status_code == 404))
            r = await c.get("/profiles")
            results.append(ok("profiles come back keyed by player", "pl-02" in r.json()))

            # ---------------- coach notes ----------------
            gid = "g-2026-10-13-shediac"
            r = await c.put(f"/notes/{gid}/preview", json={"body": "Watch their #9 on the rush."})
            results.append(ok("coach writes a game preview", r.status_code == 200))
            r = await c.put(f"/notes/{gid}/recap", json={"body": "Great backcheck all night."})
            results.append(ok("coach writes a recap", r.status_code == 200))
            r = await c.get(f"/notes/{gid}")
            results.append(ok("both notes come back with the author",
                              set(r.json()) == {"preview", "recap"}
                              and r.json()["preview"]["author"] is not None))
            r = await c.put(f"/notes/{gid}/preview", json={"body": "   "})
            results.append(ok("clearing a note removes it", r.json()["cleared"] is True))
            r = await c.get(f"/notes/{gid}")
            results.append(ok("cleared note is gone", set(r.json()) == {"recap"}))
            r = await c.put("/notes/not-a-game/recap", json={"body": "x"})
            results.append(ok("notes on an unknown game -> 404", r.status_code == 404))

            # ---------------- uploads ----------------
            import io
            from PIL import Image

            def jpeg_with_gps() -> bytes:
                """A JPEG carrying EXIF including GPS, like a phone photo of a child."""
                im = Image.new("RGB", (2400, 1800), (20, 40, 90))
                buf = io.BytesIO()
                exif = Image.Exif()
                exif[0x010F] = "TestPhone"                      # Make
                exif[0x0110] = "TestCam 1"                      # Model
                exif[0x0132] = "2026:10:13 17:30:00"            # DateTime
                # GPS lives in its own IFD; rationals must be plain numbers.
                gps = exif.get_ifd(0x8825)
                gps[1] = "N"
                gps[2] = (46.0, 5.0, 0.0)                       # GPSLatitude
                gps[3] = "W"
                gps[4] = (64.0, 47.0, 0.0)                      # GPSLongitude
                im.save(buf, "JPEG", exif=exif)
                return buf.getvalue()

            src = jpeg_with_gps()
            _fx = Image.open(io.BytesIO(src)).getexif()
            results.append(ok("test fixture really does carry EXIF incl. GPS",
                              bool(_fx) and bool(_fx.get_ifd(0x8825)),
                              f"{len(_fx)} tags, gps={len(_fx.get_ifd(0x8825))}"))

            files = {"file": ("photo.jpg", src, "image/jpeg")}
            r = await c.post("/uploads", files=files, data={"kind": "card_art"})
            results.append(ok("admin uploads an image", r.status_code == 201, f"{r.status_code} {r.text[:70]}"))
            up = r.json()
            results.append(ok("oversized image is scaled down to the card bound",
                              max(up["width"], up["height"]) == 1200, f"{up['width']}x{up['height']}"))

            saved = pathlib.Path(os.environ["UPLOAD_DIR"]) / pathlib.Path(up["path"]).name
            results.append(ok("the file is actually on disk", saved.exists()))
            stored_exif = Image.open(saved).getexif()
            results.append(ok("EXIF (incl. GPS) is stripped from what we store",
                              len(stored_exif) == 0 and not stored_exif.get_ifd(0x8825),
                              f"{len(stored_exif)} tags, gps={len(stored_exif.get_ifd(0x8825))}"))
            results.append(ok("a webp twin is written too",
                              saved.with_suffix(".webp").exists()))

            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as anon:
                rr = await anon.post("/uploads", files={"file": ("x.jpg", src, "image/jpeg")},
                                     data={"kind": "card_art"})
                results.append(ok("anonymous upload -> 401", rr.status_code == 401))

            r = await c.post("/uploads", files={"file": ("x.svg", b"<svg/>", "image/svg+xml")},
                             data={"kind": "card_art"})
            results.append(ok("svg is refused -> 415", r.status_code == 415, f"got {r.status_code}"))

            r = await c.post("/uploads", files={"file": ("x.jpg", b"not an image", "image/jpeg")},
                             data={"kind": "card_art"})
            results.append(ok("a non-image claiming to be a jpeg -> 400", r.status_code == 400))

            r = await c.post("/uploads", files={"file": ("x.jpg", src, "image/jpeg")},
                             data={"kind": "nonsense"})
            results.append(ok("unknown upload kind -> 400", r.status_code == 400))

            # the uploaded art can then be attached to a player
            r = await c.put("/profiles/pl-03", json={"card_art": up["path"], "captain": "A"})
            results.append(ok("uploaded art attaches to a player",
                              r.json()["card_art"] == up["path"]))

            # ---------------- families, game jobs, password change ----------------
            # two families, each with a parent login
            fam = {}
            for pid, who, kid in (("pl-02", "landry", "Olivier Landry"),
                                  ("pl-03", "goguen", "Henry Goguen")):
                h = bcrypt.hashpw(b"familypass1", bcrypt.gensalt(rounds=4)).decode()
                uid = await pool.fetchval(
                    "INSERT INTO users (email, display_name, password_hash, role, player_id,"
                    " relationship) VALUES ($1,$2,$3,'parent',$4,'Mom') RETURNING id",
                    f"mom.{who}", f"Mom to {kid}", h, pid)
                fam[pid] = (f"mom.{who}", uid)
            results.append(ok("parent accounts can be created with a handle, not an email",
                              len(fam) == 2))

            r = await c.post("/jobs/seed-defaults")
            results.append(ok("the standard three seed, and only those",
                              r.status_code == 200 and r.json()["added"] == 3, str(r.json())))
            types = (await c.get("/jobs/types")).json()
            tid = {t_["name"]: t_["id"] for t_ in types}
            r = await c.post("/jobs/types", json={"name": "50/50 tickets"})
            results.append(ok("duplicate job name -> 409", r.status_code == 409))

            # the ones this team does not run every night are offered, not seeded
            sugg = (await c.get("/jobs/suggestions")).json()
            results.append(ok("the jobs we stopped seeding are offered instead",
                              {s_["name"] for s_ in sugg} == {"Penalty box", "Jerseys", "Snacks"},
                              str([s_["name"] for s_ in sugg])))
            r = await c.post("/jobs/types",
                             json=next(s_ for s_ in sugg if s_["name"] == "Jerseys"))
            results.append(ok("an offered job can be added on its own", r.status_code == 201))
            results.append(ok("a job already on the list stops being offered",
                              "Jerseys" not in {s_["name"] for s_ in
                                                (await c.get("/jobs/suggestions")).json()}))

            # something nobody planned for — a tournament needs a person on the gate
            r = await c.post("/jobs/types", json={"name": "Tournament gate",
                                                  "description": "Take admission at the door"})
            results.append(ok("a job invented on the spot can be added", r.status_code == 201))
            types = (await c.get("/jobs/types")).json()
            results.append(ok("a job added without a sort lands at the end",
                              types[-1]["name"] == "Tournament gate",
                              str([t_["name"] for t_ in types])))
            tid = {t_["name"]: t_["id"] for t_ in types}

            gid = "g-2026-10-13-shediac"
            r = await c.put(f"/jobs/{gid}", json=[
                {"job_type_id": tid["50/50 tickets"], "player_id": "pl-02"},
                {"job_type_id": tid["Scoresheet"],    "player_id": "pl-03"},
                {"job_type_id": tid["Timekeeper"],    "player_id": None},
            ])
            results.append(ok("admin assigns jobs to families", r.status_code == 200))
            r = await c.put(f"/jobs/{gid}", json=[{"job_type_id": tid["Jerseys"], "player_id": "pl-99"}])
            results.append(ok("assigning to an unknown player -> 400", r.status_code == 400))

            jobs = (await c.get(f"/jobs/{gid}")).json()
            byname = {j["name"]: j for j in jobs}
            results.append(ok("job list names the family on the hook",
                              byname["50/50 tickets"]["family"].startswith("Olivier"),
                              str(byname["50/50 tickets"]["family"])))
            results.append(ok("unassigned jobs still listed", byname["Timekeeper"]["player_id"] is None))

            # the Landry parent
            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as mom:
                await mom.post("/auth/login", json={"email": "mom.landry", "password": "familypass1"})
                r = await mom.post(f"/jobs/{gid}/{tid['50/50 tickets']}/claim")
                results.append(ok("a parent claims their own family's job", r.status_code == 200))
                r = await mom.post(f"/jobs/{gid}/{tid['Scoresheet']}/claim")
                results.append(ok("a parent CANNOT claim another family's job -> 403",
                                  r.status_code == 403, (r.json() or {}).get("detail","")[:42]))
                # jobs are the parent's own business, but editing them is not
                r = await mom.put(f"/jobs/{gid}", json=[])
                results.append(ok("a parent cannot assign jobs -> 403", r.status_code == 403))

                # self-service password change
                r = await mom.post("/auth/change-password",
                                   json={"current": "wrong", "new": "brandnewpass1"})
                results.append(ok("wrong current password -> 403", r.status_code == 403))
                r = await mom.post("/auth/change-password",
                                   json={"current": "familypass1", "new": "familypass1"})
                results.append(ok("reusing the same password -> 400", r.status_code == 400))
                r = await mom.post("/auth/change-password",
                                   json={"current": "familypass1", "new": "brandnewpass1"})
                results.append(ok("parent changes their own password", r.status_code == 200))
                results.append(ok("their session survives the change",
                                  (await mom.get("/auth/verify")).status_code == 204))

            jobs = {j["name"]: j for j in (await c.get(f"/jobs/{gid}")).json()}
            results.append(ok("the claim shows who took it",
                              jobs["50/50 tickets"]["claimed_by"] is not None,
                              str(jobs["50/50 tickets"]["claimed_by"])))
            # reassigning to a different family must not keep the old claim
            await c.put(f"/jobs/{gid}", json=[{"job_type_id": tid["50/50 tickets"], "player_id": "pl-03"}])
            jobs = {j["name"]: j for j in (await c.get(f"/jobs/{gid}")).json()}
            results.append(ok("reassigning to another family drops the stale claim",
                              jobs["50/50 tickets"]["claimed_by"] is None))

            # the tournament is over: dropping the job takes its assignments with it
            await c.put(f"/jobs/{gid}",
                        json=[{"job_type_id": tid["Tournament gate"], "player_id": "pl-02"}])
            r = await c.delete(f"/jobs/types/{tid['Tournament gate']}")
            results.append(ok("dropping a job reports the assignments that went with it",
                              r.status_code == 200 and r.json()["assignments_removed"] == 1,
                              str(r.json())))
            results.append(ok("a dropped job leaves every game's list",
                              "Tournament gate" not in
                              {j["name"] for j in (await c.get(f"/jobs/{gid}")).json()}))

            # ---------------- moderation ----------------
            r = await c.put(f"/notes/{gid}/preview", json={"body": "Clean hit, great backcheck."})
            results.append(ok("clean text saves normally", r.status_code == 200))
            q = (await c.get("/moderation/queue")).json()
            results.append(ok("clean text is not flagged", len(q) == 0, f"{len(q)} flags"))

            r = await c.put(f"/notes/{gid}/preview", json={"body": "their goalie is an idiot"})
            results.append(ok("an insult still saves but is flagged", r.status_code == 200))
            q = (await c.get("/moderation/queue")).json()
            results.append(ok("it reaches the review queue",
                              len(q) == 1 and q[0]["severity"] == "medium", str(len(q))))
            results.append(ok("the queue names the author",
                              q[0]["author"] is not None, str(q[0]["author"])))
            findings = q[0]["findings"]
            results.append(ok("review findings are an array of objects, not JSON text",
                              isinstance(findings, list) and len(findings) > 0
                              and all(isinstance(f, dict) and isinstance(f.get("category"), str)
                                      for f in findings)))

            r = await c.put(f"/notes/{gid}/recap",
                            json={"body": "I am gonna kill you after the game"})
            results.append(ok("a threat is REFUSED, not published -> 422",
                              r.status_code == 422, f"got {r.status_code}"))
            q = (await c.get("/moderation/queue")).json()
            held = [x for x in q if x["held"]]
            results.append(ok("the held item is queued as high severity",
                              len(held) == 1 and held[0]["severity"] == "high"))
            r = await c.get(f"/notes/{gid}")
            results.append(ok("the held text never reached the site",
                              "kill you" not in json.dumps(r.json())))

            cnt = (await c.get("/moderation/count")).json()
            results.append(ok("the badge count is right",
                              cnt["pending"] == 2 and cnt["held"] == 1, str(cnt)))

            r = await c.post(f"/moderation/{q[0]['id']}/review", json={"action": "approve"})
            results.append(ok("an admin can clear a flag", r.status_code == 200))
            cnt = (await c.get("/moderation/count")).json()
            results.append(ok("clearing it drops the count", cnt["pending"] == 1, str(cnt)))

            async with httpx.AsyncClient(transport=transport, base_url="http://t/api") as mom2:
                await mom2.post("/auth/login", json={"email": "mom.goguen", "password": "familypass1"})
                r = await mom2.get("/moderation/queue")
                results.append(ok("a parent cannot see the moderation queue -> 403",
                                  r.status_code == 403))

            n = await pool.fetchval("SELECT count(*) FROM audit_log")
            results.append(ok("user-management actions are audited too", n >= 3, f"{n} rows"))

            from test_chat import run_chat_tests
            results.extend(await run_chat_tests(app, pool, ok))

            from test_plays import run_plays_tests
            results.extend(await run_plays_tests(app, pool, ok))

            from test_goals import run_goals_tests
            results.extend(await run_goals_tests(app, pool, ok))

            from test_security import run_security_tests
            results.extend(await run_security_tests(app, pool, ok))

            from test_account import run_account_tests
            results.extend(await run_account_tests(app, pool, ok))

            from test_scoreboard import run_scoreboard_tests
            results.extend(await run_scoreboard_tests(app, pool, ok))

            print(f"\n{sum(results)}/{len(results)} passed")
            return 0 if all(results) else 1

raise SystemExit(asyncio.run(main()))
