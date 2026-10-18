import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import to_data


class ImportSafety(unittest.TestCase):
    def test_sync_preserves_privacy_and_rejects_identity_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            privacy = {'publicNameFormat':'number-only','publishPhotos':False,'publishBirthYear':False}
            prior = {'id':'pl-02','firstName':'Test','lastName':'Child','photo':None,'cardArt':None}
            (data/'roster.json').write_text(json.dumps({'privacy':privacy,'players':[prior]}))
            capture = {'team_id':'223790','captured_at':'2026-10-13T12:00:00Z','players':[{'jersey_number':2,'name':'TEST CHILD','position':'Forward'}]}
            with patch.object(to_data,'DATA',data), patch.object(to_data,'discover_card_art',return_value={}):
                roster, _ = to_data.build_roster(capture,{})
                self.assertEqual(roster['privacy'],privacy)
                capture['players'][0]['name']='OTHER CHILD'
                with self.assertRaisesRegex(ValueError,'identity changed'):
                    to_data.build_roster(capture,{})

    def test_new_roster_defaults_to_minimum_disclosure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(to_data,'DATA',Path(directory)), patch.object(to_data,'discover_card_art',return_value={}):
            roster, _ = to_data.build_roster({'team_id':'223790','captured_at':'2026-10-13T12:00:00Z','players':[]},{})
            self.assertFalse(roster['privacy']['publishPhotos'])
            self.assertNotEqual(roster['privacy']['publicNameFormat'],'full')

    def test_a_single_ambiguous_score_is_never_copied_to_both_teams(self):
        game = {'home_team':'U13-B DAVEY','away_team':'SHEDIAC','date':'2026-10-13','time_local':'17:30','venue_display':'Test Rink','score':3}
        capture={'team_id':'223790','captured_at':'2026-10-13T12:00:00Z','games':[game]}
        result=to_data.build_schedule(capture)['events'][0]
        self.assertIsNone(result['home']['score'])
        self.assertIsNone(result['away']['score'])
        game.update(home_score=0,away_score=0)
        result=to_data.build_schedule(capture)['events'][0]
        self.assertEqual(result['status'],'final')
        self.assertEqual(result['home']['score'],0)

    def test_practice_times_and_dst_are_preserved(self):
        capture = {'team_id':'223790','captured_at':'2026-10-18T13:53:17Z','games':[],
                   'practices':[{'date':'2026-10-18','time_local':'13:15','end_time_local':'14:15','venue_display':'Test Arena'},
                                {'date':'2026-11-04','time_local':'18:30','end_time_local':'19:30','venue_display':'Test Arena'}]}
        events = to_data.build_schedule(capture)['events']
        self.assertEqual(events[0]['type'], 'practice')
        self.assertEqual(events[0]['startsAt'], '2026-10-18T13:15:00-03:00')
        self.assertEqual(events[0]['endsAt'], '2026-10-18T14:15:00-03:00')
        self.assertEqual(events[1]['startsAt'], '2026-11-04T18:30:00-04:00')

    def test_complete_rendered_window_preserves_history_and_rescheduled_ids(self):
        prior = {'events':[
            {'id':'old-game','type':'game','spordleId':'10','startsAt':'2026-10-13T17:30:00-03:00'},
            {'id':'stable-game','type':'game','spordleId':'11','startsAt':'2026-10-15T17:30:00-03:00'}]}
        incoming = {'events':[
            {'id':'new-date-game','type':'game','spordleId':'11','startsAt':'2026-10-23T18:15:00-03:00'},
            {'id':'practice','type':'practice','spordleId':None,'startsAt':'2026-10-21T18:30:00-03:00'}]}
        merged = to_data.merge_schedule(prior, incoming)
        self.assertEqual([e['id'] for e in merged['events']], ['old-game','practice','stable-game'])
        self.assertEqual(merged['events'][0], prior['events'][0])
        self.assertEqual(merged['events'][2]['startsAt'], incoming['events'][0]['startsAt'])
        self.assertEqual(to_data.merge_schedule(merged, incoming), merged)

    def test_schedule_collisions_require_review(self):
        event = {'id':'same-game','type':'game','spordleId':'10','startsAt':'2026-10-13T17:30:00-03:00'}
        with self.assertRaisesRegex(ValueError, 'duplicate IDs'):
            to_data.merge_schedule({'events':[]}, {'events':[event,event]})
        with self.assertRaisesRegex(ValueError, 'another Spordle game'):
            to_data.merge_schedule({'events':[event]}, {'events':[dict(event,spordleId='11')]})

    def test_regular_season_opponent_keeps_existing_identity(self):
        game = {'home_team':'U13-B DAVEY','away_team':'SHEDIAC CAP-PELÉ U13B','date':'2026-10-23',
                'time_local':'18:15','venue_display':'Test Arena','event_type':'REGULAR SEASON'}
        event = to_data.build_schedule({'team_id':'223790','captured_at':'2026-10-18T13:53:17Z','games':[game]})['events'][0]
        self.assertEqual(event['away']['teamId'], 'shediac-cap-pele-predators')
        self.assertEqual(event['gameType'], 'regular')

if __name__ == '__main__':
    unittest.main()
