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

if __name__ == '__main__':
    unittest.main()
