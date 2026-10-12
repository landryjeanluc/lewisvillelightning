#!/usr/bin/env python3
"""
Adapter: Spordle captures  ->  the site's data contract.

Reads  private/spordle/223790/normalized/{roster,schedule}.json  (owner-only,
gitignored) and writes  data/{roster,schedule,opponents}.json  in the shape
docs/DATA-CONTRACT.md specifies.

Run from the repo root:   python3 tools/spordle/to_data.py
Verify:                   cd site && npm run validate
"""
from __future__ import annotations
import json, re, sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
NORM = ROOT / "private/spordle/223790/normalized"
DATA = ROOT / "data"
TZ = ZoneInfo("America/Moncton")

# Spordle's team label -> our stable team id. Unknown labels abort rather than
# silently inventing a team, because a wrong id flips home/away on the poster.
TEAM_IDS = {
    "U13-B DAVEY": "lewisville-lightning",
    "SHEDIAC": "shediac-cap-pele-predators",
    "DIEPPE": "dieppe",
}

POSITIONS = {"Forward": "F", "Defence": "D", "Goalie": "G"}

# ---------------------------------------------------------------- names ----

# ALL-CAPS source data destroys internal capitals. Default to plain title case:
# Landry, Daigle, Levesque, Lacasse, Davey and Despres are all plainly
# capitalised, and a generic Le/La/D prefix rule mangles every one of them
# (it produced "LaNdry" and "DAvey" on the first pass). Only surnames whose
# internal capital is near-universal get special handling, by EXACT match --
# and each of those is still reported for a human to confirm.
INTERNAL_CAPS = {
    "LEBLANC": "LeBlanc",
    "MACDONALD": "MacDonald", "MACKAY": "MacKay", "MACLEAN": "MacLean",
    "MCKAY": "McKay", "MCDONALD": "McDonald", "MCGRATH": "McGrath",
    "MCLAUGHLIN": "McLaughlin", "MCINNIS": "McInnis", "MCCARTHY": "McCarthy",
    "DESROCHES": "DesRoches", "DESROSIERS": "DesRosiers",
    "LAPOINTE": "LaPointe", "LAFRANCE": "LaFrance",
}

APOSTROPHES = ("-", "\u2019", "'")

def titlecase_word(w):
    """Plain title case; each hyphen/apostrophe part gets its own capital."""
    if not w:
        return w
    for sep in APOSTROPHES:
        if sep in w:
            return sep.join(titlecase_word(part) for part in w.split(sep))
    return w.capitalize()

def titlecase_name(n):
    return " ".join(INTERNAL_CAPS.get(w.upper()) or titlecase_word(w) for w in n.split())

def needs_review(raw):
    """True when we made a capitalisation or accent choice a human should confirm."""
    if any(w.upper() in INTERNAL_CAPS for w in raw.split()):
        return True
    if any(s in raw for s in ("\u2019", "'")):
        return True
    return any(ord(c) > 127 for c in raw)      # accented Acadian spellings

def load_overrides() -> dict:
    p = Path(__file__).parent / "name-overrides.json"
    if not p.exists():
        return {}
    return {k.upper(): v for k, v in json.loads(p.read_text()).get("overrides", {}).items()}

# ----------------------------------------------------------------- time ----

def to_iso(date_str: str, time_local: str) -> str:
    """'2026-10-13' + '17:30' -> '2026-10-13T17:30:00-03:00', DST-correct.

    America/Moncton is -03:00 in season and -04:00 after the November change.
    Attaching a fixed offset here is the bug this whole contract exists to stop.
    """
    naive = datetime.strptime(f"{date_str} {time_local}", "%Y-%m-%d %H:%M")
    return naive.replace(tzinfo=TZ).isoformat()

# ------------------------------------------------------------- transform ---

def team_id(label: str) -> str:
    key = label.strip()
    if key not in TEAM_IDS:
        sys.exit(
            f"\nUnknown team label {key!r} in the capture.\n"
            f"Add it to TEAM_IDS in this file AND to data/opponents.json\n"
            f"(name, short, crest, colours) in the same change.\n"
        )
    return TEAM_IDS[key]

def build_roster(src: dict, overrides: dict) -> dict:
    players, flagged = [], []
    for p in src["players"]:
        raw = p["name"].strip()
        display = overrides.get(raw.upper()) or titlecase_name(raw)
        parts = display.split()
        first, last = parts[0], " ".join(parts[1:]) or parts[0]
        if raw.upper() not in overrides and needs_review(raw):
            flagged.append(display)
        players.append({
            "id": f"pl-{p['jersey_number']:02d}",
            "number": p["jersey_number"],
            "firstName": first,
            "lastName": last,
            "position": POSITIONS.get(p["position"], p.get("position_code", "F")),
            "shoots": None,
            "birthYear": None,
            "photo": None,
            "cardArt": None,
            "captain": None,
            "affiliate": False,
        })
    players.sort(key=lambda x: x["number"])
    return {
        "version": 1,
        "source": {
            "provider": "spordle",
            "teamId": src["team_id"],
            "fetchedAt": src["captured_at"].replace("Z", "+00:00"),
            "note": f"Adapted from {src.get('source_capture','capture')} by tools/spordle/to_data.py",
        },
        "privacy": {
            "publicNameFormat": "full",
            "publishBirthYear": False,
            "publishPhotos": True,
            "note": "JL 2026-10-12: full names and photo cards, site served behind a login.",
        },
        "players": players,
        "staff": [
            {"id": f"st-{i+1}", "name": overrides.get(s["name"].upper()) or titlecase_name(s["name"]), "role": s["role"]}
            for i, s in enumerate(src.get("staff", []))
        ],
    }, sorted(set(flagged))

def build_schedule(src: dict) -> dict:
    events = []
    for g in src["games"]:
        home, away = team_id(g["home_team"]), team_id(g["away_team"])
        events.append({
            "id": f"g-{g['date']}-{away.split('-')[0] if home=='lewisville-lightning' else home.split('-')[0]}",
            "type": "game",
            "startsAt": to_iso(g["date"], g["time_local"]),
            "endsAt": None,
            "venue": {"name": g["venue_display"], "surface": None, "address": None, "mapUrl": None},
            "home": {"teamId": home, "score": g.get("score")},
            "away": {"teamId": away, "score": g.get("score")},
            "status": "final" if g.get("score") else "scheduled",
            "gameType": {"EXHIBITION": "exhibition", "REGULAR": "regular",
                         "PLAYOFF": "playoff", "TOURNAMENT": "tournament"}.get(
                             g.get("event_type", "").upper(), "regular"),
            "league": g.get("second_team_category") or None,
            "notes": None,
            "spordleId": g.get("game_number"),
        })
    events.sort(key=lambda e: e["startsAt"])
    return {
        "version": 1,
        "source": {
            "provider": "spordle",
            "teamId": src["team_id"],
            "fetchedAt": src["captured_at"].replace("Z", "+00:00"),
            "note": f"{src.get('coverage','')} filter={src.get('filter_display','')}".strip(),
        },
        "events": events,
    }

def write(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
    print(f"  wrote {path.relative_to(ROOT)}")

def main() -> None:
    if not NORM.exists():
        sys.exit(f"no captures at {NORM} — run the collector first")
    overrides = load_overrides()

    roster_src = json.loads((NORM / "roster.json").read_text())
    roster, flagged = build_roster(roster_src, overrides)
    write(DATA / "roster.json", roster)

    sched_src = json.loads((NORM / "schedule.json").read_text())
    write(DATA / "schedule.json", build_schedule(sched_src))

    print(f"\n  {len(roster['players'])} players, {len(roster['staff'])} staff, "
          f"{len(json.loads((DATA/'schedule.json').read_text())['events'])} events")

    if sched_src.get("incomplete_dates"):
        print(f"  ! {len(sched_src['incomplete_dates'])} date(s) captured without detail: "
              + ", ".join(d["date"] for d in sched_src["incomplete_dates"])
              + "\n    Re-capture the schedule view to pick these up.")
    if sched_src.get("status") == "partial_view":
        print(f"  ! schedule is a PARTIAL view ({sched_src.get('filter_display')}) — not the full season.")
    if flagged:
        print("\n  ! Capitalisation guessed for these names — Spordle stores ALL CAPS and")
        print("    Acadian surnames are person-specific. Confirm, then correct any wrong")
        print("    ones in tools/spordle/name-overrides.json:")
        for n in flagged:
            print(f"      {n}")

if __name__ == "__main__":
    main()
