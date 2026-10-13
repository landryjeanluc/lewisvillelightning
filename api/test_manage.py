"""Exercise manage.py's family commands against a real Postgres.

Run from test.sh against its own database: manage.py is a CLI, so this drives
it as a subprocess the way JL does on the box, rather than importing it.
"""
import asyncio, os, subprocess, sys
import asyncpg, bcrypt

MANAGE = [sys.executable, "manage.py"]

def run(*args):
    r = subprocess.run(MANAGE + list(args), capture_output=True, text=True,
                       stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        raise SystemExit(f"manage.py {' '.join(args)} exited {r.returncode}")
    return r.stdout

async def names(pool):
    return {r["email"]: r["display_name"] for r in
            await pool.fetch("SELECT email, display_name FROM users")}

async def main():
    pool = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    results = []
    def ok(n, cond, extra=""):
        cond = bool(cond)
        print(f"  {'PASS' if cond else 'FAIL'}  {n} {'' if cond else extra}")
        results.append(cond)

    # --- seeding names a family by full name -------------------------------
    # Two players share a first name, so the first name alone names neither of
    # them — and both their surnames start with L, so an initial would not fix
    # it either. This is the whole reason the label carries the full name.
    run("seed-families")
    n = await names(pool)
    ok("a parent label carries the surname",
       n["mom.olivier-landry"] == "Mom to Olivier Landry", n.get("mom.olivier-landry"))
    ok("the two Oliviers' parents are told apart",
       n["mom.olivier-landry"] != n["mom.olivier-leblanc"]
       and n["mom.olivier-leblanc"] == "Mom to Olivier LeBlanc",
       f"{n.get('mom.olivier-landry')} / {n.get('mom.olivier-leblanc')}")
    ok("an accented surname survives intact",
       n["dad.benjamin-despres"] == "Dad to Benjamin Desprès", n.get("dad.benjamin-despres"))
    ok("the player's own login is still just their name",
       n["olivier-landry"] == "Olivier Landry", n.get("olivier-landry"))
    ok("no two logins read the same", len(set(n.values())) == len(n),
       f"{len(n)} logins, {len(set(n.values()))} distinct labels")

    # --- add-guardian follows the same rule -------------------------------
    out = run("add-guardian", "pl-08", "Grandma")
    n = await names(pool)
    ok("add-guardian uses the full name too",
       n["grandma.olivier-leblanc"] == "Grandma to Olivier LeBlanc",
       n.get("grandma.olivier-leblanc"))
    ok("add-guardian prints the label it stored",
       "Grandma to Olivier LeBlanc" in out, out.strip())

    # --- the backfill ------------------------------------------------------
    # Put the pre-2026-10-13 short labels back, and add two rows the backfill
    # must not touch: one player who has left the roster, one name a human
    # typed in the admin UI.
    await pool.execute(
        "UPDATE users SET display_name = relationship || ' to ' ||"
        " split_part(display_name, ' ', 3) WHERE role = 'parent'")
    pre = await names(pool)
    ok("the fixture really is the old ambiguous form",
       pre["mom.olivier-landry"] == "Mom to Olivier" == pre["mom.olivier-leblanc"],
       f"{pre.get('mom.olivier-landry')} / {pre.get('mom.olivier-leblanc')}")

    h = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt(rounds=4)).decode()
    await pool.execute(
        "INSERT INTO users (email, display_name, password_hash, role, player_id,"
        " relationship) VALUES ('aunt.departed','Aunt',$1,'parent','pl-99','Aunt')", h)
    await pool.execute(
        "INSERT INTO users (email, display_name, password_hash, role, player_id)"
        " VALUES ('handmade','Hand written',$1,'parent','pl-03')", h)

    async def creds():
        return {r["email"]: (r["session_epoch"], r["password_hash"]) for r in
                await pool.fetch("SELECT email, session_epoch, password_hash FROM users")}
    before = await creds()
    untouched = {"aunt.departed": "Aunt", "handmade": "Hand written"}

    out = run("rename-families", "--dry-run")
    ok("--dry-run writes nothing", await names(pool) == pre | untouched)
    ok("--dry-run says what it would do", "would be renamed" in out, out.strip())

    out = run("rename-families")
    n = await names(pool)
    ok("the backfill fixes the ambiguous labels",
       n["mom.olivier-landry"] == "Mom to Olivier Landry"
       and n["mom.olivier-leblanc"] == "Mom to Olivier LeBlanc",
       f"{n.get('mom.olivier-landry')} / {n.get('mom.olivier-leblanc')}")
    ok("a player_id that has left the roster is left alone",
       n["aunt.departed"] == "Aunt", n.get("aunt.departed"))
    ok("a row with no relationship is left alone",
       n["handmade"] == "Hand written", n.get("handmade"))
    ok("both skips are reported, not silent",
       "pl-99 is not on the roster" in out and "no relationship recorded" in out
       and "2 left alone" in out, out.strip())
    ok("no password and no session is touched — nobody is signed out",
       await creds() == before)

    out = run("rename-families")
    ok("running it twice is a no-op", "0 login(s) renamed" in out, out.strip())

    print(f"\n{sum(results)}/{len(results)} passed")
    await pool.close()
    return 0 if all(results) else 1

raise SystemExit(asyncio.run(main()))
