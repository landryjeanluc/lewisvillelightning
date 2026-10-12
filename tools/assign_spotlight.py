#!/usr/bin/env python3
"""
Player spotlight rotation.

Every game banner features one player. Selection is random *from the players who
have not been featured yet this cycle*, so the whole roster gets a turn before
anyone repeats. Once a game is assigned the choice is written to
data/spotlight.json and never changes — re-rendering a poster must not silently
hand a kid's game to someone else.

  python3 tools/assign_spotlight.py            # assign any unassigned games
  python3 tools/assign_spotlight.py --status   # show the rotation, assign nothing
  python3 tools/assign_spotlight.py --reassign g-2026-10-13-shediac
"""
from __future__ import annotations
import json, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SPOT = DATA / "spotlight.json"

def load(name):
    return json.loads((DATA / name).read_text())

def save(obj):
    SPOT.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")

def blank():
    return {"version": 1,
            "note": "Written by tools/assign_spotlight.py. assignments are permanent once made; cycle restarts when every player has been featured.",
            "assignments": {}, "cycle": 1}

def main():
    args = sys.argv[1:]
    roster = load("roster.json")
    schedule = load("schedule.json")
    spot = json.loads(SPOT.read_text()) if SPOT.exists() else blank()

    players = [p["id"] for p in roster["players"]]
    by_id = {p["id"]: p for p in roster["players"]}
    games = sorted((e for e in schedule["events"] if e["type"] == "game"),
                   key=lambda e: e["startsAt"])

    if "--reassign" in args:
        gid = args[args.index("--reassign") + 1]
        spot["assignments"].pop(gid, None)
        print(f"cleared assignment for {gid}")

    if "--status" in args:
        used = list(spot["assignments"].values())
        print(f"cycle {spot['cycle']} — {len(set(used) & set(players))}/{len(players)} players featured")
        for g in games:
            pid = spot["assignments"].get(g["id"])
            who = f"#{by_id[pid]['number']} {by_id[pid]['firstName']} {by_id[pid]['lastName']}" if pid in by_id else "—"
            print(f"  {g['startsAt'][:10]}  {g['id']:<28} {who}")
        remaining = [p for p in players if p not in used]
        print(f"  not yet featured this cycle: {len(remaining)}")
        return

    rng = random.SystemRandom()
    made = 0
    for g in games:
        if g["id"] in spot["assignments"]:
            continue
        used = [v for v in spot["assignments"].values()]
        pool = [p for p in players if p not in used]
        if not pool:                      # everyone has had a turn — new cycle
            spot["cycle"] += 1
            spot["assignments"] = {}      # history is the git log; the cycle resets clean
            pool = list(players)
            print(f"  all {len(players)} players featured — starting cycle {spot['cycle']}")
        pick = rng.choice(pool)
        spot["assignments"][g["id"]] = pick
        p = by_id[pick]
        print(f"  {g['id']}  ->  #{p['number']} {p['firstName']} {p['lastName']}")
        made += 1

    save(spot)
    used = set(spot["assignments"].values())
    print(f"\n{made} new assignment(s). Cycle {spot['cycle']}: "
          f"{len(used & set(players))}/{len(players)} featured, {len(players) - len(used & set(players))} remaining.")

if __name__ == "__main__":
    main()
