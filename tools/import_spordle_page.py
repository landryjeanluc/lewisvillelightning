#!/usr/bin/env python3
"""Import a locally saved Spordle team page. No network requests.

Usage: python3 tools/import_spordle_page.py private/imports/SAVED_PAGE.html
Output stays in git-ignored private/spordle/223790/.
This extracts embedded page data, not data absent from the saved HTML.
"""

import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
from datetime import datetime, timezone

TEAM_ID = "223790"
SOURCE_URL = "https://page.spordle.com/lewisville/teams/223790"
ROOT = Path(__file__).resolve().parents[1]


class NextDataParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.collect = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("id") == "__NEXT_DATA__":
            self.collect = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.collect = False

    def handle_data(self, data):
        if self.collect:
            self.parts.append(data)


def clean(value):
    """Omit application configuration and authentication/account context."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            normalized = key.lower().replace("_", "").replace("-", "")
            if any(word in normalized for word in
                   ("token", "password", "secret", "cookie", "authorization", "apikey")):
                continue
            if normalized in {"apiprovider", "apiproviders", "spordleclient", "session",
                              "currentuser", "user", "account", "auth", "authuser"}:
                continue
            result[key] = clean(item)
        return result
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def extract(html):
    parser = NextDataParser()
    parser.feed(html)
    if not parser.parts:
        raise ValueError("No embedded page data found. A browser response export is needed; no roster was imported.")
    data = json.loads("".join(parser.parts))
    query = data.get("query", {})
    if str(query.get("teamId", "")) != TEAM_ID:
        raise ValueError("Saved page does not identify team 223790; refusing to import another page.")
    return clean(data.get("props", {}).get("pageProps", {}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    source = args.html.resolve()
    private = (ROOT / "private").resolve()
    if not source.is_relative_to(private):
        parser.error("Place the saved page under private/imports before importing it.")
    content = source.read_bytes()
    try:
        payload = extract(content.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        parser.exit(1, str(exc) + "\n")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    out = private / "spordle" / TEAM_ID / stamp
    out.mkdir(parents=True, mode=0o700)
    (out / "page-data.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    manifest = {
        "source_url": SOURCE_URL,
        "team_id": TEAM_ID,
        "imported_at_utc": stamp,
        "source_sha256": hashlib.sha256(content).hexdigest(),
        "top_level_data_keys": list(payload),
        "status": "embedded_page_data_imported; roster_and_schedule_not_yet_validated",
        "visibility": "local_only",
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Saved private page data to", out.relative_to(ROOT))
    print("Embedded sections:", ", ".join(payload))
    print("Roster and schedule still require inspection; missing data is not inferred.")


if __name__ == "__main__":
    main()
