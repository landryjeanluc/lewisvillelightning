import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('normalize', Path(__file__).with_name('normalize.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RosterTest(unittest.TestCase):
    def capture(self):
        return {'sourceUrl':'https://page.spordle.com/lewisville/teams/223790','capturedAt':'2026-10-12T00:00:00Z',
                'data':{'headings':['Synthetic U13 B'], 'tables':[
                    {'rows':[['GOALIES','POSITION'],['G\nGOALIE EXAMPLE\n31','G']]},
                    {'rows':[['PLAYERS','POSITION'],['P\nPLAYER EXAMPLE\n7','F']]},
                    {'rows':[['TEAM STAFF','POSITION'],['C\nCOACH EXAMPLE','Head Coach']]}]}}

    def test_avatar_removed_number_and_position_preserved(self):
        roster=module.roster_from_capture(self.capture())
        self.assertEqual(roster['players'][0]['name'],'GOALIE EXAMPLE')
        self.assertEqual(roster['players'][0]['jersey_number'],31)
        self.assertEqual(roster['players'][1]['position'],'Forward')
        self.assertEqual(roster['staff'][0]['role'],'Head Coach')

    def test_incomplete_or_duplicate_roster_rejected(self):
        missing=self.capture();missing['data']['tables'][1]['rows'][1][0]='P\nPLAYER EXAMPLE'
        with self.assertRaises(ValueError): module.roster_from_capture(missing)
        duplicate=self.capture();duplicate['data']['tables'][1]['rows'][1][0]='P\nPLAYER EXAMPLE\n31'
        with self.assertRaises(ValueError): module.roster_from_capture(duplicate)

    def test_schedule_keeps_incomplete_dates_and_never_invents_scores(self):
        capture = self.capture()
        capture['data']['visibleText'] = 'Next 30 days (Oct 12, 2026 - Nov 10, 2026)\nPrint Schedule\nAdd to Calendar\nTUESDAY, OCTOBER 13, 2026\nKay Arena (Main) - Moncton, NB\nEXHIBITION•10\n?\nSHEDIAC\nU13 BMixed\nTUE, OCT 13\n05:30 P.M.\nU13-B DAVEY\nU13 BMixed\nFRIDAY, OCTOBER 16, 2026\nPrevious\nNext'
        schedule = module.schedule_from_capture(capture)
        self.assertEqual(schedule['games'][0]['time_local'], '17:30')
        self.assertEqual(schedule['games'][0]['home_team'], 'U13-B DAVEY')
        self.assertIsNone(schedule['games'][0]['score'])
        self.assertEqual(schedule['status'], 'partial_view')
        self.assertEqual(schedule['incomplete_dates'][0]['date'], '2026-10-16')

    def test_today_practices_regular_games_and_multiple_events_per_day(self):
        capture = self.capture()
        capture['data']['visibleText'] = """Season 2026-27 (Sep 12, 2026 - Jan 3, 2027)
Print Schedule
Add to Calendar
TODAY, SUNDAY, OCTOBER 18, 2026
Test Arena
PRACTICE
U13-B DAVEY
U13 BMixed
SUN, OCT 18
01:15 P.M.
to02:15 p.m.
Test Arena
EXHIBITION•12
?
SHEDIAC
U13 BMixed
SUN, OCT 18
05:30 P.M.
U13-B DAVEY
U13 BMixed
WEDNESDAY, OCTOBER 21, 2026
Test Arena
PRACTICE
U13-B DAVEY
U13 BMixed
WED, OCT 21
06:30 P.M.
to07:30 p.m.
FRIDAY, OCTOBER 23, 2026
Test Arena
REGULAR SEASON•980825
?
SHEDIAC CAP-PELÉ U13B
U13 BMixed
FRI, OCT 23
06:15 P.M.
U13-B DAVEY
U13 BMixed
Previous
Next"""
        schedule = module.schedule_from_capture(capture)
        self.assertEqual(schedule['status'], 'captured_view')
        self.assertEqual(schedule['filter_display'], 'Season 2026-27 (Sep 12, 2026 - Jan 3, 2027)')
        self.assertEqual(len(schedule['games']), 2)
        self.assertEqual(len(schedule['practices']), 2)
        self.assertEqual(schedule['practices'][0]['date'], '2026-10-18')
        self.assertEqual(schedule['practices'][0]['time_local'], '13:15')
        self.assertEqual(schedule['practices'][0]['end_time_local'], '14:15')
        self.assertEqual(schedule['practices'][1]['time_local'], '18:30')
        self.assertEqual(schedule['games'][1]['event_type'], 'REGULAR SEASON')
        self.assertEqual(schedule['games'][1]['game_number'], '980825')
        self.assertEqual(schedule['games'][1]['home_team'], 'U13-B DAVEY')

    def test_unsupported_schedule_cannot_replace_last_successful_capture(self):
        capture = self.capture()
        capture['data']['visibleText'] = 'Print Schedule\nAdd to Calendar\nSUNDAY, OCTOBER 18, 2026\nUnknown event'
        with self.assertRaisesRegex(ValueError, 'existing schedule preserved'):
            module.schedule_from_capture(capture)

    def standings_capture(self):
        capture = self.capture()
        capture['data']['headings'] = ['U13-B TEST', 'STANDINGS']
        capture['data']['visibleText'] = 'STANDINGS\nExhibition Games Other\n'
        capture['data']['tables'] = [{'rows': [['#','TEAM','GP','W','L','PTS'],
                                              ['1','U7 TEST','0','0','0','0'],
                                              ['1','U13-B TEST','0','0','0','0']]}]
        return capture

    def test_zero_game_mixed_division_table_is_not_verified_league_standings(self):
        standings = module.standings_from_capture(self.standings_capture())
        self.assertTrue(standings['mixed_divisions'])
        self.assertTrue(standings['all_displayed_teams_have_zero_games'])
        self.assertFalse(standings['league_standings_verified'])
        self.assertEqual(standings['team']['games_played'], 0)
        self.assertEqual(standings['team']['name'], 'U13-B TEST')

    def test_standings_requires_exact_target_team_and_intact_rows(self):
        capture = self.standings_capture()
        capture['data']['tables'][0]['rows'][2][1] = 'U13-AA OTHER'
        with self.assertRaises(ValueError): module.standings_from_capture(capture)
        capture = self.standings_capture()
        capture['data']['tables'][0]['rows'][2].pop()
        with self.assertRaises(ValueError): module.standings_from_capture(capture)


if __name__ == '__main__': unittest.main()
