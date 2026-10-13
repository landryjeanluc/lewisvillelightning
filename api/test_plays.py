"""Plays coverage, called by test_api.py against its real database.

The interesting surface here is not CRUD, it is the diagram validator: the
document arrives as free-form JSON from a browser and goes into JSONB, so the
cases worth writing down are the malformed ones.
"""
from uuid import uuid4

import httpx

from app import signer


def diagram(**over):
    """A small but complete two-step play: D1 skates it out, rims it to the wing."""
    d = {
        "v": 1,
        "steps": [
            {"id": "s1", "caption": "D1 retrieves, centre swings low", "duration": 1400},
            {"id": "s2", "caption": "Rim it to the wall", "duration": 1100},
        ],
        "tokens": [
            {"id": "t1", "kind": "us", "x": 30, "y": 40, "label": "D1"},
            {"id": "t2", "kind": "us", "x": 60, "y": 20, "label": "LW"},
            {"id": "t3", "kind": "puck", "x": 30, "y": 41, "label": ""},
        ],
        "paths": [
            {"id": "p1", "kind": "skate", "step": 0, "tokenId": "t1",
             "points": [{"x": 30, "y": 40}, {"x": 38, "y": 34}, {"x": 45, "y": 30}]},
            {"id": "p2", "kind": "pass", "step": 1, "tokenId": "t3",
             "points": [{"x": 45, "y": 30}, {"x": 60, "y": 20}]},
        ],
        "notes": [{"id": "n1", "step": 0, "x": 50, "y": 10, "text": "wall support"}],
        "pen": [],
    }
    d.update(over)
    return d


async def run_plays_tests(app, pool, ok):
    results = []

    def check(name, condition, extra=""):
        results.append(ok("plays: " + name, condition, extra))

    async def account(name, role):
        return await pool.fetchval(
            """INSERT INTO users (email, display_name, password_hash, role)
               VALUES ($1,$2,'unused',$3) RETURNING id""",
            f"plays-{uuid4()}", name, role)

    coach_id = await account("Plays coach", "admin")
    parent_id = await account("Plays parent", "viewer")

    transport = httpx.ASGITransport(app=app)
    session = lambda uid: {"lvlnb_session": signer.dumps([uid, 1])}
    coach = httpx.AsyncClient(transport=transport, base_url="http://t/api", cookies=session(coach_id))
    parent = httpx.AsyncClient(transport=transport, base_url="http://t/api", cookies=session(parent_id))
    anon = httpx.AsyncClient(transport=transport, base_url="http://t/api")

    try:
        # --- who may look -------------------------------------------------
        check("anonymous cannot list plays -> 401", (await anon.get("/plays")).status_code == 401)
        check("anonymous cannot write -> 401",
              (await anon.post("/plays", json={"title": "x"})).status_code == 401)
        r = await parent.post("/plays", json={"title": "Not yours"})
        check("a viewer cannot create a play -> 403", r.status_code == 403, f"got {r.status_code}")

        # --- creating ------------------------------------------------------
        body = {"title": "Wheel breakout", "subtitle": "Out clean under pressure",
                "category": "breakout", "surface": "dzone", "status": "draft",
                "week_of": "2026-10-12", "diagram": diagram()}
        r = await coach.post("/plays", json=body)
        check("an admin can create a play", r.status_code == 201, r.text[:120])
        first = r.json()
        check("the title becomes the slug", first["slug"] == "wheel-breakout", first["slug"])

        r = await coach.post("/plays", json={**body, "title": "Wheel breakout"})
        check("a second play of the same name gets its own slug",
              r.status_code == 201 and r.json()["slug"] == "wheel-breakout-2", r.text[:90])
        dupe_id = r.json()["id"]

        # --- drafts stay in the room ---------------------------------------
        r = await parent.get("/plays")
        check("a viewer sees no drafts", r.status_code == 200 and r.json() == [], r.text[:90])
        r = await parent.get(f"/plays/{first['slug']}")
        check("a viewer cannot open a draft by slug -> 404", r.status_code == 404)
        r = await coach.get("/plays")
        check("an admin sees the drafts", len(r.json()) == 2, str(len(r.json())))
        check("plays are not cached", r.headers.get("cache-control") == "no-store",
              str(r.headers.get("cache-control")))

        # --- the diagram survives the round trip ---------------------------
        r = await coach.get(f"/plays/{first['slug']}")
        got = r.json()["diagram"]
        check("the diagram comes back as a document, not a string", isinstance(got, dict))
        check("every piece and line round-trips",
              len(got["tokens"]) == 3 and len(got["paths"]) == 2
              and got["paths"][0]["points"][1] == {"x": 38.0, "y": 34.0},
              str(got["paths"][0]["points"][1]))
        check("the week comes back as a plain date", r.json()["week_of"] == "2026-10-12",
              str(r.json()["week_of"]))

        # --- publishing -----------------------------------------------------
        r = await coach.put(f"/plays/{first['id']}", json={**body, "status": "published"})
        check("publishing works", r.status_code == 200 and r.json()["status"] == "published")
        published_at = await pool.fetchval("SELECT published_at FROM plays WHERE id=$1", first["id"])
        check("publishing stamps the date", published_at is not None)
        await coach.put(f"/plays/{first['id']}",
                        json={**body, "status": "published", "subtitle": "edited"})
        again = await pool.fetchval("SELECT published_at FROM plays WHERE id=$1", first["id"])
        check("re-saving a published play does not re-date it", again == published_at)
        r = await parent.get("/plays")
        check("the team sees the published play", len(r.json()) == 1, str(len(r.json())))

        # --- the validator ---------------------------------------------------
        async def rejects(name, diag):
            r = await coach.post("/plays", json={"title": f"Bad {name}", "diagram": diag})
            check(f"rejects {name}", r.status_code == 422, f"got {r.status_code}")

        await rejects("a piece off the end boards", diagram(
            tokens=[{"id": "t1", "kind": "us", "x": 240, "y": 40, "label": ""}], paths=[], notes=[]))
        await rejects("a piece through the side boards", diagram(
            tokens=[{"id": "t1", "kind": "us", "x": 40, "y": 99, "label": ""}], paths=[], notes=[]))
        await rejects("a line bound to a piece that is not there", diagram(
            paths=[{"id": "p1", "kind": "skate", "step": 0, "tokenId": "ghost",
                    "points": [{"x": 10, "y": 10}, {"x": 20, "y": 20}]}], notes=[]))
        await rejects("a step number past the end of the play", diagram(
            paths=[{"id": "p1", "kind": "skate", "step": 7, "tokenId": "t1",
                    "points": [{"x": 10, "y": 10}, {"x": 20, "y": 20}]}], notes=[]))
        await rejects("one piece running two lines in the same step", diagram(
            paths=[{"id": "p1", "kind": "skate", "step": 0, "tokenId": "t1",
                    "points": [{"x": 10, "y": 10}, {"x": 20, "y": 20}]},
                   {"id": "p2", "kind": "skate", "step": 0, "tokenId": "t1",
                    "points": [{"x": 10, "y": 10}, {"x": 30, "y": 40}]}], notes=[]))
        await rejects("two things sharing an id", diagram(
            tokens=[{"id": "same", "kind": "us", "x": 10, "y": 10, "label": ""},
                    {"id": "same", "kind": "them", "x": 20, "y": 20, "label": ""}],
            paths=[], notes=[]))
        await rejects("a line of one point", diagram(
            paths=[{"id": "p1", "kind": "skate", "step": 0, "tokenId": None,
                    "points": [{"x": 10, "y": 10}]}], notes=[]))
        await rejects("an unknown line kind", diagram(
            paths=[{"id": "p1", "kind": "teleport", "step": 0, "tokenId": None,
                    "points": [{"x": 10, "y": 10}, {"x": 20, "y": 20}]}], notes=[]))

        # A browser that has lost its transform produces NaN. json.dumps cannot
        # write it, so this one has to go out as raw text rather than as `json=`.
        r = await coach.post(
            "/plays",
            content=('{"title":"NaN coords","diagram":{"v":1,'
                     '"steps":[{"id":"s1","caption":"","duration":1400}],'
                     '"tokens":[{"id":"t1","kind":"us","x":NaN,"y":1,"label":""}],'
                     '"paths":[],"notes":[],"pen":[]}}'),
            headers={"content-type": "application/json"})
        check("a not-a-number coordinate is a clean 422, not a 500",
              r.status_code == 422, f"got {r.status_code}: {r.text[:120]}")
        check("and the error response itself is valid JSON",
              r.headers.get("content-type", "").startswith("application/json")
              and isinstance(r.json().get("detail"), list), r.text[:120])

        r = await coach.post("/plays", json={"title": "   ", "diagram": diagram()})
        check("a play needs a name -> 422", r.status_code == 422, f"got {r.status_code}")
        r = await coach.post("/plays", json={"title": "Ghost game", "game_id": "g-not-real",
                                             "diagram": diagram()})
        check("an unknown game id -> 404", r.status_code == 404, f"got {r.status_code}")

        # A play with no pieces at all is a legitimate starting point — the
        # coach saves the name first and draws it at the rink.
        r = await coach.post("/plays", json={"title": "Empty for now"})
        check("an empty play is allowed", r.status_code == 201, r.text[:90])
        empty_id = r.json()["id"]

        # --- deleting ---------------------------------------------------------
        r = await parent.delete(f"/plays/{dupe_id}")
        check("a viewer cannot delete -> 403", r.status_code == 403, f"got {r.status_code}")
        r = await coach.delete(f"/plays/{dupe_id}")
        check("an admin can delete", r.status_code == 200)
        check("deleting twice -> 404", (await coach.delete(f"/plays/{dupe_id}")).status_code == 404)
        await coach.delete(f"/plays/{empty_id}")

        n = await pool.fetchval(
            "SELECT count(*) FROM audit_log WHERE action LIKE 'play\\_%'")
        check("every write is audited", n >= 6, f"{n} rows")
    finally:
        for client in (coach, parent, anon):
            await client.aclose()

    return results
