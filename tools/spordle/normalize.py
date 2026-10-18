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
    day = r'(?:TODAY, |TOMORROW, |YESTERDAY, )?((?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY), [A-Z]+ \d{1,2}, \d{4})'
    pieces = re.split(r'^' + day + r'$', text, flags=re.MULTILINE)
    games, practices, incomplete = [], [], []
    window = re.search(r'Next \d+ days \([^\n]+\)', text)
    event_pattern = r'(?:EXHIBITION|REGULAR SEASON|REGULAR|PLAYOFF|TOURNAMENT)\s*•\s*\d+|PRACTICE'
    clock_pattern = r'\d{1,2}:\d{2}\s*[AP]\.?M\.?'

    def clock(value):
        return datetime.strptime(value.upper().replace('.', ''), '%I:%M %p').strftime('%H:%M')

    for i in range(1, len(pieces), 2):
        date = datetime.strptime(pieces[i].title(), '%A, %B %d, %Y').date().isoformat()
        block = lines(pieces[i + 1])
        markers = [j for j, line in enumerate(block) if re.fullmatch(event_pattern, line)]
        if not markers:
            incomplete.append({'date': date, 'reason': 'Date heading captured without supported event details.'})
            continue
        for n, event in enumerate(markers):
            # Each next event is preceded by its own venue line.
            stop = markers[n + 1] - 1 if n + 1 < len(markers) else len(block)
            details = block[event + 1:stop]
            time_index = next((j for j, line in enumerate(details)
                               if re.fullmatch(clock_pattern, line, re.IGNORECASE)), None)
            if event < 1 or time_index is None:
                incomplete.append({'date': date, 'reason': 'Event details incomplete.'})
                continue
            common = {'date': date, 'time_local': clock(details[time_index]),
                      'venue_display': block[event - 1]}
            if block[event] == 'PRACTICE':
                end = next((re.fullmatch(r'to\s*(' + clock_pattern + ')', line, re.IGNORECASE)
                            for line in details[time_index + 1:] if line.lower().startswith('to')), None)
                if not end or len(details[:time_index]) != 3:
                    incomplete.append({'date': date, 'reason': 'Practice details incomplete.'})
                    continue
                practices.append(dict(common, end_time_local=clock(end[1])))
                continue
            before = [line for line in details[:time_index]
                      if line != '?' and not re.match(r'^(?:MON|TUE|WED|THU|FRI|SAT|SUN),', line)]
            after = [line for line in details[time_index + 1:] if line not in {'?', 'Previous', 'Next'}]
            if len(before) != 2 or len(after) != 2:
                incomplete.append({'date': date, 'reason': 'Unexpected team layout; requires inspection.'})
                continue
            games.append(dict(common, event_type=block[event].split('•')[0].strip(),
                              game_number=block[event].split('•')[-1].strip(),
                              first_listed_team=before[0], first_team_category=before[1],
                              second_listed_team=after[0], second_team_category=after[1],
                              away_team=before[0], home_team=after[0],
                              home_away_basis='Page display order; corroborated by the user-confirmed October 13 home game.',
                              score=None))
    if not games and not practices:
        raise ValueError('No supported schedule events found; existing schedule preserved.')
    return {'team_id': '223790', 'captured_at': capture['capturedAt'], 'source_url': capture['sourceUrl'],
            'filter_display': window.group() if window else None,
            'status': 'partial_view' if incomplete else 'captured_view',
            'games': games, 'practices': practices, 'incomplete_dates': incomplete,
            'coverage': 'Rendered schedule view only, not a complete season schedule.'}


def standings_from_capture(capture):
    candidates = [table['rows'] for table in capture['data']['tables']
                  if table.get('rows') and {'TEAM', 'GP', 'PTS'}.issubset(table['rows'][0])]
    if len(candidates) != 1:
        raise ValueError('Expected one identifiable standings table.')
    rows = candidates[0]
    headers = rows[0]
    if len(set(headers)) != len(headers) or any(len(row) != len(headers) for row in rows[1:]):
        raise ValueError('Malformed standings table; existing standings preserved.')
    records = [dict(zip(headers, row)) for row in rows[1:]]
    team_name = capture['data']['headings'][0]
    matching = [row for row in records if row['TEAM'].strip().casefold() == team_name.casefold()]
    if len(matching) != 1:
        raise ValueError('The requested team could not be uniquely identified in standings.')
    source_row = matching[0]
    integer_fields = {'#':'displayed_rank', 'GP':'games_played', 'W':'wins', 'RW':'regulation_wins',
                      'OTW':'overtime_wins', 'SOW':'shootout_wins', 'T':'ties', 'L':'losses',
                      'RL':'regulation_losses', 'OTL':'overtime_losses', 'SOL':'shootout_losses',
                      'PTS':'points', 'GF':'goals_for', 'GA':'goals_against', 'DIFF':'goal_difference', 'PIM':'penalty_minutes'}
    team = {'name': team_name, 'source_values': source_row}
    for column, field in integer_fields.items():
        if column in source_row:
            team[field] = int(source_row[column])
    for column, field in {'PTS%':'points_percentage', 'GF/GP':'goals_for_per_game', 'GA/GP':'goals_against_per_game'}.items():
        if column in source_row:
            team[field] = float(source_row[column])
    if 'PIM/GP' in source_row:
        team['penalty_minutes_per_game_display'] = source_row['PIM/GP']
    context = re.search(r'^STANDINGS\n([^\n]+)', capture['data']['visibleText'], re.MULTILINE)
    competition = context.group(1) if context else None
    divisions = sorted({match.group() for row in records if (match := re.search(r'\bU\d+\b', row['TEAM']))})
    all_zero_games = bool(records) and all(int(row['GP']) == 0 for row in records)
    return {'team_id': '223790', 'source_url': capture['sourceUrl'], 'captured_at': capture['capturedAt'],
            'competition_display': competition, 'team': team, 'displayed_team_count': len(records),
            'observed_divisions': divisions, 'mixed_divisions': len(divisions) > 1,
            'all_displayed_teams_have_zero_games': all_zero_games,
            'league_standings_verified': False,
            'rank_interpretation': 'Zero-game display order, not an earned league position.' if all_zero_games else 'Position in the captured table only.',
            'coverage': 'Requested team row only. Table context retained; competition must be verified before presenting this as U13 B league standings.'}


def main():
    captures = [(p, json.loads(p.read_text())) for p in sorted((ROOT / 'browser-captures').glob('*.json'))]
    roster_views = []
    schedule_views = []
    standings_views = []
    inventory = []
    for path, capture in captures:
        headers = [table['rows'][0] for table in capture['data']['tables'] if table.get('rows')]
        is_roster = any(header and header[0].upper() == 'GOALIES' for header in headers)
        is_schedule = 'Print Schedule' in capture['data']['visibleText'] and 'Add to Calendar' in capture['data']['visibleText']
        is_standings = any({'TEAM', 'GP', 'PTS'}.issubset(header) for header in headers)
        kind = 'roster' if is_roster else 'schedule' if is_schedule else 'standings' if is_standings else 'unclassified_view'
        inventory.append({'file': str(path.relative_to(ROOT)), 'captured_at': capture['capturedAt'],
                          'kind': kind, 'table_headers': headers})
        if is_roster:
            roster_views.append((path, capture))
        if is_schedule:
            schedule_views.append((path, capture))
        if is_standings:
            standings_views.append((path, capture))
    write_json(ROOT / 'normalized/capture-inventory.json', inventory)
    if standings_views:
        standings_path, standings_capture = max(standings_views, key=lambda item: item[1]['capturedAt'])
        standings = standings_from_capture(standings_capture)
        standings['source_capture'] = str(standings_path.relative_to(ROOT))
        write_json(ROOT / 'normalized/standings.json', standings)
        print(f"Standings: team row saved; competition={standings['competition_display']}; league standings not verified.")
    if schedule_views:
        schedule_path, schedule_capture = max(schedule_views, key=lambda item: item[1]['capturedAt'])
        schedule = schedule_from_capture(schedule_capture)
        schedule['source_capture'] = str(schedule_path.relative_to(ROOT))
        write_json(ROOT / 'normalized/schedule.json', schedule)
        print(f"Schedule: {len(schedule['games'])} games, {len(schedule['practices'])} practices; {len(schedule['incomplete_dates'])} dates need more detail.")
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
    status_file = ROOT / 'collection-status.json'
    status = json.loads(status_file.read_text()) if status_file.exists() else {'team_id': '223790'}
    status.update({'roster_collected': True, 'player_count': len(roster['players']),
                   'schedule_collected': bool(schedule_views), 'standings_collected': bool(standings_views),
                   'visibility': 'local_only', 'automatic_checks_enabled': False})
    if schedule_views:
        status.update({'schedule_status': schedule['status'], 'rendered_game_count': len(schedule['games']),
                       'incomplete_event_dates': [row['date'] for row in schedule['incomplete_dates']]})
    if standings_views:
        status.update({'standings_competition_display': standings['competition_display'], 'league_standings_verified': False})
    write_json(status_file, status)


if __name__ == '__main__':
    main()
