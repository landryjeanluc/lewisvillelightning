#!/usr/bin/env python3
"""Normalize captured team views into private local data for cards and a future site."""
import hashlib
import json
from pathlib import Path
import re
from datetime import datetime

ROOT = Path(__file__).resolve().parents[2] / 'private/spordle/223790'


def lines(cell):
    return [part.strip() for part in cell.splitlines() if part.strip()]


def parse_person(cell, with_number):
    parts = lines(cell)
    if len(parts) > 1 and len(parts[0]) <= 2:
        parts.pop(0)  # The circular avatar initial is not part of the person's name.
    number = None
    if with_number:
        if not parts or not re.fullmatch(r'\d{1,3}', parts[-1]):
            raise ValueError('Player row is missing a jersey number; refusing a partial roster.')
        number = int(parts.pop())
    name = ' '.join(parts).strip()
    if not name:
        raise ValueError('A roster row is missing its name.')
    return name, number


def roster_from_capture(capture):
    tables = capture['data']['tables']
    players, staff = [], []
    groups = set()
    for table in tables:
        rows = table.get('rows', [])
        if not rows or len(rows[0]) != 2:
            continue
        group = rows[0][0].upper()
        if group not in {'GOALIES', 'PLAYERS', 'TEAM STAFF'}:
            continue
        groups.add(group)
        for row in rows[1:]:
            if len(row) != 2:
                raise ValueError('Unexpected roster row shape.')
            name, number = parse_person(row[0], group != 'TEAM STAFF')
            if group == 'TEAM STAFF':
                staff.append({'name': name, 'role': row[1].strip()})
            else:
                position = row[1].strip()
                if position not in {'G', 'D', 'F'}:
                    raise ValueError('Unknown position in roster; needs review.')
                local_id = hashlib.sha256(('223790:' + name.casefold()).encode()).hexdigest()[:16]
                players.append({'local_id': local_id, 'name': name, 'jersey_number': number,
                                'position_code': position, 'position': {'G': 'Goalie', 'D': 'Defence', 'F': 'Forward'}[position]})
    if not {'GOALIES', 'PLAYERS'}.issubset(groups) or not players:
        raise ValueError('Not a complete displayed roster view.')
    if len({p['local_id'] for p in players}) != len(players):
        raise ValueError('Duplicate player names require review before assigning local IDs.')
    if len({p['jersey_number'] for p in players}) != len(players):
        raise ValueError('Duplicate jersey numbers require review.')
    return {'team_id': '223790', 'team_name': capture['data']['headings'][0],
            'source_url': capture['sourceUrl'], 'captured_at': capture['capturedAt'],
            'players': players, 'staff': staff,
            'coverage': 'All player rows in the captured roster view; not an API-verified season registration list.'}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    pending = path.with_suffix('.incoming')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    pending.chmod(0o600)
    pending.replace(path)


def schedule_from_capture(capture):
    text = capture['data']['visibleText']
    if 'Print Schedule' not in text or 'Add to Calendar' not in text:
        raise ValueError('Not a schedule view.')
    day = r'((?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY), [A-Z]+ \d{1,2}, \d{4})'
    pieces = re.split(r'^' + day + r'$', text, flags=re.MULTILINE)
    games, incomplete = [], []
    window = re.search(r'Next \d+ days \([^\n]+\)', text)
    for i in range(1, len(pieces), 2):
        date = datetime.strptime(pieces[i].title(), '%A, %B %d, %Y').date().isoformat()
        block = lines(pieces[i + 1])
        event = next((j for j,line in enumerate(block) if re.fullmatch(r'EXHIBITION\s*•\s*\d+', line)), None)
        if event is None:
            incomplete.append({'date': date, 'reason': 'Date heading captured without event details.'})
            continue
        time_index = next((j for j,line in enumerate(block) if re.fullmatch(r'\d{1,2}:\d{2}\s*[AP]\.M\.', line)), None)
        if event < 1 or time_index is None:
            incomplete.append({'date': date, 'reason': 'Event details incomplete.'})
            continue
        before = [line for line in block[event+1:time_index] if line != '?' and not re.match(r'^(?:MON|TUE|WED|THU|FRI|SAT|SUN),', line)]
        after = [line for line in block[time_index+1:] if line not in {'?', 'Previous', 'Next'}]
        if len(before) != 2 or len(after) != 2:
            incomplete.append({'date': date, 'reason': 'Unexpected team layout; requires inspection.'})
            continue
        clock = datetime.strptime(block[time_index].replace('.', ''), '%I:%M %p').strftime('%H:%M')
        games.append({'date': date, 'time_local': clock, 'venue_display': block[event-1],
                      'event_type': 'EXHIBITION', 'game_number': block[event].split('•')[-1].strip(),
                      'first_listed_team': before[0], 'first_team_category': before[1],
                      'second_listed_team': after[0], 'second_team_category': after[1],
                      'away_team': before[0], 'home_team': after[0],
                      'home_away_basis': 'Page display order; corroborated by the user-confirmed October 13 home game.',
                      'score': None})
    return {'team_id': '223790', 'captured_at': capture['capturedAt'], 'source_url': capture['sourceUrl'],
            'filter_display': window.group() if window else None,
            'status': 'partial_view' if incomplete else 'captured_view',
            'games': games, 'incomplete_dates': incomplete,
            'coverage': 'Rendered schedule view only, not a complete season schedule.'}


def main():
    captures = [(p, json.loads(p.read_text())) for p in sorted((ROOT / 'browser-captures').glob('*.json'))]
    roster_views = []
    schedule_views = []
    inventory = []
    for path, capture in captures:
        headers = [table['rows'][0] for table in capture['data']['tables'] if table.get('rows')]
        is_roster = any(header and header[0].upper() == 'GOALIES' for header in headers)
        is_schedule = 'Print Schedule' in capture['data']['visibleText'] and 'Add to Calendar' in capture['data']['visibleText']
        kind = 'roster' if is_roster else 'schedule' if is_schedule else 'unclassified_view'
        inventory.append({'file': str(path.relative_to(ROOT)), 'captured_at': capture['capturedAt'],
                          'kind': kind, 'table_headers': headers})
        if is_roster:
            roster_views.append((path, capture))
        if is_schedule:
            schedule_views.append((path, capture))
    write_json(ROOT / 'normalized/capture-inventory.json', inventory)
    if schedule_views:
        schedule_path, schedule_capture = max(schedule_views, key=lambda item: item[1]['capturedAt'])
        schedule = schedule_from_capture(schedule_capture)
        schedule['source_capture'] = str(schedule_path.relative_to(ROOT))
        write_json(ROOT / 'normalized/schedule.json', schedule)
        print(f"Schedule: {len(schedule['games'])} rendered games; {len(schedule['incomplete_dates'])} dates need more detail.")
    if not roster_views:
        raise SystemExit('No roster view available yet.')
    path, capture = max(roster_views, key=lambda item: item[1]['capturedAt'])
    roster = roster_from_capture(capture)
    roster['source_capture'] = str(path.relative_to(ROOT))
    previous_path = ROOT / 'normalized/roster.json'
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else None
    write_json(previous_path, roster)
    cards = {'team_id': '223790', 'team_name': roster['team_name'], 'source_capture': roster['source_capture'],
             'visibility': 'private', 'players': [dict(p, photo=None, photo_status='not_available_in_capture',
                                                      statistics=None) for p in roster['players']]}
    write_json(ROOT / 'normalized/player-card-data.json', cards)
    before = {p['local_id']: p for p in previous['players']} if previous else {}
    after = {p['local_id']: p for p in roster['players']}
    changes = {'first_import': previous is None, 'source_capture': roster['source_capture'],
               'added': [p for key,p in after.items() if key not in before],
               'removed': [p for key,p in before.items() if key not in after],
               'updated': [{'before': before[key], 'after': p} for key,p in after.items() if key in before and p != before[key]]}
    if previous is None or any(changes[key] for key in ['added','removed','updated']):
        write_json(ROOT / 'normalized/roster-changes' / path.name, changes)
    print(f"Normalized {len(roster['players'])} players and {len(roster['staff'])} staff. Player-card data saved privately; photos and statistics remain unset.")


if __name__ == '__main__':
    main()
