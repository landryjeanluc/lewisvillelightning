import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_host', Path(__file__).with_name('native_host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class CaptureTest(unittest.TestCase):
    def sample(self):
        return {'version': 1, 'teamId': '223790', 'sourceUrl': 'https://page.spordle.com/lewisville/teams/223790',
                'data': {'tables': [{'rows': [['Number', 'Player'], ['7', 'Synthetic Player']]}], 'sections': {'team': {'id': 223790}}, 'access_token': 'not-for-storage'}}

    def test_private_save_and_credentials_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'team'
            result = host.save_capture(self.sample(), root)
            self.assertTrue(result['ok'])
            saved = root / 'latest-browser.json'
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertNotIn('not-for-storage', saved.read_text())
            self.assertEqual(json.loads(saved.read_text())['teamId'], '223790')

    def test_wrong_origin_or_team_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'team'
            for source in ['https://page.spordle.com.evil.test/lewisville/teams/223790', 'https://page.spordle.com/lewisville/teams/42', 'http://page.spordle.com/lewisville/teams/223790']:
                value = self.sample(); value['sourceUrl'] = source
                with self.assertRaises(ValueError): host.save_capture(value, root)
            value = self.sample(); value['teamId'] = '42'
            with self.assertRaises(ValueError): host.save_capture(value, root)
            self.assertFalse(root.exists())

    def test_all_views_retained_as_separate_captures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'team'
            first = host.save_capture(self.sample(), root)
            changed = self.sample(); changed['data']['tables'] = []
            second = host.save_capture(changed, root)
            self.assertNotEqual(first['filename'], second['filename'])
            self.assertEqual(len(list((root / 'browser-captures').glob('*.json'))), 2)


if __name__ == '__main__': unittest.main()
