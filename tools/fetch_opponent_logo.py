#!/usr/bin/env python3
"""
Find a crest for an opponent we have not played before.

Minor-hockey clubs do not sit in any registry we can query — the TeamLinkt CDN
path that holds the Predators crest is not enumerable (neighbouring ids 403),
so the logo has to come from the club's own site. This searches for that site,
pulls every plausible logo off it, and shows you what it found.

It does NOT pick for you by default. A sponsor banner and a club crest look
identical to a scraper, and the wrong badge on a game poster is worse than no
badge at all — the site already falls back to a monogram.

  python3 tools/fetch_opponent_logo.py dieppe
  python3 tools/fetch_opponent_logo.py dieppe --from https://hockeydieppememramcook.ca/
  python3 tools/fetch_opponent_logo.py dieppe --apply 2      # adopt candidate 2
"""
from __future__ import annotations

import argparse, json, re, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets/brand"
PUBLIC = ROOT / "site/public/brand"
OPPONENTS = ROOT / "data/opponents.json"
CACHE = ROOT / "tmp/logo-candidates"
UA = "Mozilla/5.0 (compatible; lvlnb-logo-finder/1.0)"

def get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def search_sites(name: str) -> list[str]:
    """Best-effort: find the club's own site. DuckDuckGo's HTML endpoint needs
    no key and no JS."""
    q = urllib.parse.quote(f"{name} minor hockey association New Brunswick")
    try:
        html = get(f"https://html.duckduckgo.com/html/?q={q}").decode("utf8", "ignore")
    except Exception as exc:
        print(f"  search failed ({exc}) — pass --from <url> instead")
        return []
    hits = re.findall(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"', html)
    out = []
    for h in hits:
        # ddg wraps results in a redirect
        m = re.search(r"uddg=([^&]+)", h)
        u = urllib.parse.unquote(m.group(1)) if m else h
        host = urllib.parse.urlparse(u).netloc
        if not host or any(host.endswith(b) for b in
                           ("facebook.com", "twitter.com", "instagram.com", "youtube.com")):
            continue
        base = f"{urllib.parse.urlparse(u).scheme}://{host}/"
        if base not in out:
            out.append(base)
    return out[:4]

def logo_candidates(page_url: str) -> list[str]:
    try:
        html = get(page_url).decode("utf8", "ignore")
    except Exception:
        return []
    pats = [
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
        r'<link[^>]+apple-touch-icon[^>]*href=["\']([^"\']+)',
        r'<link[^>]+rel=["\'][^"\']*icon[^"\']*["\'][^>]+href=["\']([^"\']+)',
        r'<img[^>]+(?:src|data-src)=["\']([^"\']*(?:logo|crest|badge)[^"\']*)["\']',
    ]
    found: list[str] = []
    for p in pats:
        for m in re.findall(p, html, re.I):
            u = urllib.parse.urljoin(page_url, m)
            if u not in found and re.search(r"\.(svg|png|jpe?g|webp)(\?|$)", u, re.I):
                found.append(u)
    return found[:8]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("team_id", help="the id used in data/opponents.json, e.g. dieppe")
    ap.add_argument("--from", dest="site", help="skip the search; scrape this page")
    ap.add_argument("--apply", type=int, metavar="N", help="adopt candidate N")
    args = ap.parse_args()

    opponents = json.loads(OPPONENTS.read_text())
    team = next((t for t in opponents["teams"] if t["id"] == args.team_id), None)
    if team is None:
        print(f"no team '{args.team_id}' in data/opponents.json")
        return 1

    CACHE.mkdir(parents=True, exist_ok=True)
    pages = [args.site] if args.site else search_sites(team["name"])
    if not pages:
        print("  no candidate sites found — pass --from <url>")
        return 1

    cands: list[tuple[str, Path]] = []
    for page in pages:
        print(f"  scanning {page}")
        for url in logo_candidates(page):
            try:
                data = get(url)
            except Exception:
                continue
            if len(data) < 500:                    # favicons and spacers
                continue
            ext = re.search(r"\.(svg|png|jpe?g|webp)", url, re.I).group(1).lower()
            dest = CACHE / f"{args.team_id}-{len(cands)+1}.{ext}"
            dest.write_bytes(data)
            cands.append((url, dest))
            print(f"    [{len(cands)}] {len(data):>7}B  {url[:88]}")

    if not cands:
        print("  nothing usable found. The monogram fallback still works.")
        return 1

    if args.apply is None:
        print("\n  Look at them, then adopt one:")
        print(f"    python3 tools/fetch_opponent_logo.py {args.team_id} --apply N")
        print(f"  Files are in {CACHE.relative_to(ROOT)}/")
        return 0

    if not 1 <= args.apply <= len(cands):
        print(f"  no candidate {args.apply}"); return 1
    _, src = cands[args.apply - 1]

    # Normalise to PNG so the site and the 4K poster treat every crest alike.
    out = BRAND / f"{args.team_id}-crest.png"
    import subprocess
    magick = subprocess.run(["magick", "-background", "none", str(src),
                             "-trim", "+repage", "-resize", "600x600>", str(out)],
                            capture_output=True)
    if magick.returncode != 0:
        print(f"  convert failed: {magick.stderr.decode()[:160]}"); return 1
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / out.name).write_bytes(out.read_bytes())

    team["crest"] = f"assets/brand/{out.name}"
    OPPONENTS.write_text(json.dumps(opponents, ensure_ascii=False, indent=2) + "\n")
    print(f"  adopted -> {out.relative_to(ROOT)}")
    print(f"  data/opponents.json updated for {team['name']}")
    print("  run ./deploy.sh to publish it")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
