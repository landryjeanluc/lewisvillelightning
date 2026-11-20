#!/usr/bin/env python3
"""
Cut one clip per goal out of a game replay.

The XbotGo recordings on the team's YouTube channel burn a score box into the
top-left corner. This reads the two score digits off every keyframe, treats
each change as a goal, and cuts a short MP4 around it. The digits are never
recognised, only compared: a row's score is how many distinct pictures it has
shown so far, so there is no OCR to get wrong.

Run from the repo root (needs ffmpeg, which the dev shell provides):

    python3 tools/replay/goal_clips.py "~/Downloads/Lewisville U13B vs Shediac.mkv" \
        --game g-2026-10-23-shediac

Clips and a goals.json manifest land in private/replays/<game id>/, which is
git-ignored: they show real children. Upload them in Admin → Game scoring →
Goal clips, where each goal gets its scorer, assists and players on the ice.

What it cannot know: the box is updated by hand, so a goal is some seconds
before its score change (hence the long lead-in), a missed tap is a missed
clip, and which row is ours is a guess (home on top) that --us-row overrides.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEAM_ID = "lewisville-lightning"

# Score digit cells of the XbotGo box, as fractions of the frame (measured on a
# 1920x1080 recording: both 60x56, at x=380, y=100 and y=168).
CELL_X, CELL_W, CELL_H = 380 / 1920, 60 / 1920, 56 / 1080
CELL_Y = {"top": 100 / 1080, "bottom": 168 / 1080}
ROWS = ("top", "bottom")

INK = 140           # darker than this is digit
PAPER = 190         # lighter than this is the box background
SAME = 0.02         # masks differing by less than this share of the cell are one digit
CONFIRM = 2         # keyframes a new digit must hold before it counts


@dataclass
class Cell:
    """One score digit, reduced to which pixels are ink."""
    mask: bytes

    @classmethod
    def read(cls, gray: bytes, width: int) -> "Cell | None":
        """None unless this looks like the score box: light card, dark digit."""
        size = len(gray)
        height = size // width
        ink = sum(1 for v in gray if v < INK)
        paper = sum(1 for v in gray if v > PAPER)
        if not (0.02 * size < ink < 0.40 * size and ink + paper > 0.85 * size):
            return None
        # The digit sits clear of the edges; play showing through does not.
        edge = [gray[y * width + x] for y in range(height) for x in range(width)
                if x < 3 or y < 3 or x >= width - 3 or y >= height - 3]
        if sum(1 for v in edge if v > PAPER) < 0.9 * len(edge):
            return None
        return cls(bytes(1 if v < INK else 0 for v in gray))

    def same(self, other: "Cell") -> bool:
        differing = sum(1 for a, b in zip(self.mask, other.mask) if a != b)
        return differing < SAME * len(self.mask)


class Row:
    """Follows one team's digit and reports when its score moves."""

    def __init__(self):
        self.seen: list[Cell] = []      # one picture per score, in order: 0, 1, 2…
        self.pending: Cell | None = None
        self.pending_since = 0.0
        self.pending_count = 0
        self.last_stable_at = 0.0

    @property
    def score(self) -> int:
        return max(len(self.seen) - 1, 0)

    def feed(self, at: float, cell: Cell | None):
        """Returns ("goal" | "undo", earliest, latest) when the score changes.

        The change happened somewhere between `earliest` (last frame showing
        the old score) and `latest` (first frame showing the new one).
        """
        if cell is None:                 # box hidden or covered: no information
            self.pending = None
            return None
        if self.seen and cell.same(self.seen[-1]):
            self.pending = None
            self.last_stable_at = at
            return None
        if self.pending is None or not cell.same(self.pending):
            self.pending, self.pending_since, self.pending_count = cell, at, 1
        else:
            self.pending_count += 1
        if self.pending_count < CONFIRM:
            return None
        window = (self.last_stable_at, self.pending_since)
        self.pending = None
        self.last_stable_at = at
        if not self.seen:                # first sight of the box: the opening score
            self.seen.append(cell)
            return None
        # Back to the picture before this one means the operator took a goal off.
        if len(self.seen) >= 2 and cell.same(self.seen[-2]):
            self.seen.pop()
            return ("undo", *window)
        self.seen.append(cell)
        return ("goal", *window)


def find_goals(samples):
    """samples: (seconds, {"top": Cell|None, "bottom": Cell|None}) in order.

    Returns [{"row", "earliest", "latest", "top", "bottom"}] with the score
    after each goal. A goal the operator took back off is dropped.
    """
    rows = {name: Row() for name in ROWS}
    goals = []
    for at, cells in samples:
        for name in ROWS:
            change = rows[name].feed(at, cells[name])
            if change is None:
                continue
            kind, earliest, latest = change
            if kind == "undo":
                for i in range(len(goals) - 1, -1, -1):
                    if goals[i]["row"] == name:
                        del goals[i]
                        break
                continue
            goals.append({"row": name, "earliest": earliest, "latest": latest})
    # Scores are counted after undos are settled, so they read as final history.
    tally = {name: 0 for name in ROWS}
    for goal in goals:
        tally[goal["row"]] += 1
        goal.update(tally)
    return goals


# ------------------------------------------------------------------ ffmpeg --

def run(cmd, **kw):
    try:
        return subprocess.run(cmd, check=True, **kw)
    except FileNotFoundError:
        sys.exit(f"{cmd[0]} not found. Run inside the dev shell (direnv allow, or nix develop).")
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode(errors="replace")[-600:] if isinstance(exc.stderr, bytes) else ""
        sys.exit(f"{cmd[0]} failed.\n{detail}")


def probe(video: Path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=width,height:format=duration", "-of", "json", str(video)],
              capture_output=True).stdout
    info = json.loads(out)
    stream = info["streams"][0]
    return stream["width"], stream["height"], float(info["format"]["duration"])


def geometry(width: int, height: int):
    """Crop box covering both digit cells, and each cell's offset inside it."""
    x, w, h = round(CELL_X * width), round(CELL_W * width), round(CELL_H * height)
    top, bottom = round(CELL_Y["top"] * height), round(CELL_Y["bottom"] * height)
    crop = (w, bottom + h - top, x, top)
    return crop, w, h, {"top": 0, "bottom": bottom - top}


def read_cells(video: Path, geo, *, start=None, length=None, fps=None):
    """Yield (seconds, {row: Cell|None}). Keyframes only unless fps is given."""
    (cw, ch, cx, cy), w, h, offsets = geo
    filters = f"crop={cw}:{ch}:{cx}:{cy},showinfo"
    cmd = ["ffmpeg", "-nostdin", "-nostats", "-loglevel", "info"]
    if fps is None:
        cmd += ["-skip_frame", "nokey"]
    else:
        filters = f"fps={fps}," + filters
    if start is not None:
        cmd += ["-ss", f"{start:.3f}", "-t", f"{length:.3f}"]
    cmd += ["-i", str(video), "-an", "-vf", filters, "-fps_mode", "passthrough",
            "-pix_fmt", "gray", "-f", "rawvideo", "-"]
    with tempfile.TemporaryFile() as log:
        raw = run(cmd, stdout=subprocess.PIPE, stderr=log).stdout
        log.seek(0)
        times = [float(m) for m in re.findall(
            rb"Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)", log.read())]
    frame = cw * ch
    if len(raw) // frame != len(times):
        sys.exit("Could not line frames up with their timestamps; is this a normal video file?")
    for i, at in enumerate(times):
        gray = raw[i * frame:(i + 1) * frame]
        cells = {}
        for name in ROWS:
            first = offsets[name] * cw
            cells[name] = Cell.read(gray[first:first + h * cw], cw)
        yield (start or 0.0) + at, cells


def pin_down(video: Path, geo, goal, before: Cell):
    """Narrow a keyframe-wide window to the quarter second the digit changed."""
    start = max(goal["earliest"] - 0.5, 0)
    length = goal["latest"] - start + 1.0
    for at, cells in read_cells(video, geo, start=start, length=length, fps=4):
        cell = cells[goal["row"]]
        if cell is not None and not cell.same(before):
            return round(at, 2)
    return round(goal["latest"], 2)


def cut(video: Path, start: float, length: float, target: Path):
    # Re-encoded, not copied: cuts land on the exact frame, and the site only
    # accepts H.264 with AAC audio (the replays carry Opus).
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
         "-i", str(video), "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1",
         "-c:v", "libx264", "-preset", "fast", "-crf", "25", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(target)],
        capture_output=True)


# --------------------------------------------------------------------- main --

def clock(seconds: float) -> str:
    whole = int(seconds)
    return f"{whole // 3600}:{whole % 3600 // 60:02d}:{whole % 60:02d}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0].strip())
    ap.add_argument("video", type=Path)
    ap.add_argument("--game", required=True, help="schedule id, e.g. g-2026-10-23-shediac")
    ap.add_argument("--us-row", choices=ROWS, help="which score row is ours (default: top at home)")
    ap.add_argument("--before", type=float, default=40, help="seconds kept before the score change")
    ap.add_argument("--after", type=float, default=8, help="seconds kept after it")
    ap.add_argument("--out", type=Path, help="default: private/replays/<game id>")
    ap.add_argument("--list", action="store_true", help="report the goals, cut nothing")
    args = ap.parse_args(argv)

    video = args.video.expanduser()
    if not video.is_file():
        sys.exit(f"No such file: {video}")
    events = json.loads((ROOT / "data/schedule.json").read_text())["events"]
    game = next((e for e in events if e["id"] == args.game and e["type"] == "game"), None)
    if game is None:
        sys.exit(f"{args.game} is not a game in data/schedule.json")
    us_row = args.us_row or ("top" if game["home"]["teamId"] == TEAM_ID else "bottom")

    width, height, duration = probe(video)
    geo = geometry(width, height)
    print(f"Reading the score box across {clock(duration)} of video…", file=sys.stderr)
    samples = list(read_cells(video, geo))
    goals = find_goals(samples)
    if not any(cell for _, cells in samples for cell in cells.values()):
        sys.exit("No score box found. This tool reads the XbotGo overlay in the top-left corner.")

    # The digit shown just before each goal, to find the exact frame it changed.
    previous = {}
    for goal in goals:
        for at, cells in samples:
            if at > goal["earliest"]:
                break
            if cells[goal["row"]] is not None:
                previous[id(goal)] = cells[goal["row"]]

    out = args.out or ROOT / "private/replays" / args.game
    manifest = {"game_id": args.game, "source": video.name, "us_row": us_row, "goals": []}
    for seq, goal in enumerate(goals, 1):
        changed = pin_down(video, geo, goal, previous[id(goal)])
        team = "us" if goal["row"] == us_row else "them"
        ours, theirs = (goal["top"], goal["bottom"]) if us_row == "top" else (goal["bottom"], goal["top"])
        start = max(changed - args.before, 0)
        length = min(changed + args.after, duration) - start
        name = f"{args.game}.goal-{seq:02d}.{team}.{ours}-{theirs}.mp4"
        manifest["goals"].append({"seq": seq, "team": team, "our_score": ours, "their_score": theirs,
                                  "score_changed_at": changed, "clip_start": round(start, 2),
                                  "clip_seconds": round(length, 2), "file": name})
        print(f"  {seq:2d}. {clock(changed)}  {'Lightning' if team == 'us' else 'Opponent ':9s}  {ours}-{theirs}")
        if not args.list:
            out.mkdir(parents=True, exist_ok=True)
            cut(video, start, length, out / name)
    if not goals:
        print("  No score changes found.")
    if not args.list:
        out.mkdir(parents=True, exist_ok=True)
        (out / "goals.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"{len(goals)} clip(s) in {out}")


if __name__ == "__main__":
    main()
