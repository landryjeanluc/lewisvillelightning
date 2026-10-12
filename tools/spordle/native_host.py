#!/usr/bin/env python3
"""Chromium native-messaging receiver. Local files only; no network activity."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
from urllib.parse import urlsplit

TEAM = '223790'
ORIGIN = 'chrome-extension://oinaiobkbpedpffnkohdkfbhlgfkdbkh/'
ROOT = Path(__file__).resolve().parents[2] / 'private' / 'spordle' / TEAM


def sanitize(value):
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {key: sanitize(item) for key, item in value.items()
            if not re.search(r'token|password|secret|cookie|authorization|apikey', key.lower().replace('_', '').replace('-', ''))}


def save_capture(payload, root=ROOT):
    if not isinstance(payload, dict) or payload.get('version') != 1 or str(payload.get('teamId')) != TEAM:
        raise ValueError('Invalid team capture.')
    url = urlsplit(payload.get('sourceUrl', ''))
    if url.scheme != 'https' or url.netloc != 'page.spordle.com' or not re.fullmatch(r'/(?:en/|fr/)?lewisville/teams/223790/?', url.path):
        raise ValueError('Only the specified Lightning team page can be saved.')
    if not isinstance(payload.get('data'), dict):
        raise ValueError('No team data supplied.')
    payload = sanitize(payload)
    payload['sourceUrl'] = 'https://page.spordle.com' + url.path
    payload['receivedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    payload['contentHash'] = hashlib.sha256(json.dumps(payload['data'], sort_keys=True).encode()).hexdigest()
    payload['status'] = 'captured_needs_schema_validation'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshots = root / 'browser-captures'
    snapshots.mkdir(mode=0o700, exist_ok=True)
    filename = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json'
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    snapshot = snapshots / filename
    snapshot.write_text(encoded)
    snapshot.chmod(0o600)
    pending = root / f'latest-browser.{os.getpid()}.tmp'
    pending.write_text(encoded)
    pending.chmod(0o600)
    pending.replace(root / 'latest-browser.json')
    return {'ok': True, 'tableCount': len(payload['data'].get('tables', [])), 'filename': filename}


def main():
    os.umask(0o077)
    if len(sys.argv) < 2 or sys.argv[1] != ORIGIN:
        return 1
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return 1
    length = struct.unpack('=I', header)[0]
    if length > 2_000_000:
        return 1
    raw = sys.stdin.buffer.read(length)
    try:
        if len(raw) != length:
            raise ValueError('Incomplete message.')
        result = save_capture(json.loads(raw))
    except Exception:
        result = {'ok': False, 'error': 'Capture rejected or local save failed. No session credentials were requested.'}
    response = json.dumps(result).encode()
    sys.stdout.buffer.write(struct.pack('=I', len(response)) + response)
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
