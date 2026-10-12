#!/usr/bin/env python3
"""Pull only private team captures from Helios, never the browser profile."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REMOTE = '/home/jl/.local/share/lewisville-collector/private/spordle/223790'


def main():
    os.umask(0o077)
    destination = ROOT / 'private/spordle/223790'
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='helios-pull-', dir=destination.parent) as staging:
        subprocess.run(['scp', '-q', '-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
                        'helios:' + REMOTE, staging], check=True)
        incoming = Path(staging) / '223790'
        files = list((incoming / 'browser-captures').glob('*.json'))
        if (incoming / 'latest-browser.json').exists():
            files.append(incoming / 'latest-browser.json')
        if not files:
            print('No browser captures yet. Use the extension in the loaded team page on Helios.')
            return 2
        validated = []
        for source in files:
            if source.is_symlink():
                raise ValueError('Unexpected link in capture transfer.')
            payload = json.loads(source.read_text())
            if str(payload.get('teamId')) != '223790' or payload.get('version') != 1:
                raise ValueError('Unexpected capture format; nothing imported.')
            validated.append((source.relative_to(incoming), payload))
        for relative, payload in validated:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            pending = target.with_suffix('.incoming')
            pending.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
            pending.chmod(0o600)
            pending.replace(target)
        print(f'Imported {len(validated)} private capture files. Login stayed on Helios.')
        return 0


if __name__ == '__main__':
    raise SystemExit(main())
