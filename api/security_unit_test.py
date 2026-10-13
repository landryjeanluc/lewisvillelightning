import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image
import moderation
from images import write_image
from manage import readable_password


class SecurityUnits(unittest.TestCase):
    def test_generated_passwords_have_144_bits_and_are_not_small_word_combinations(self):
        values = {readable_password() for _ in range(100)}
        self.assertEqual(len(values), 100)
        self.assertTrue(all(len(value) == 24 for value in values))

    def test_moderation_catches_obfuscation_and_french(self):
        for value in ['I am going to kill you', 'send nudes', 'je vais te tuer', 'kill your\u200bself']:
            self.assertTrue(moderation.should_hold(moderation.scan(value)), value)
        for value in ['f u c k', 'f**k', 'ｆｕｃｋ', 'imbécile', 'tabarnak']:
            self.assertTrue(moderation.scan(value), value)
        self.assertEqual(moderation.scan('Great pass! See you at practice.'), [])

    def test_moderation_does_not_silently_disable_if_terms_disappear(self):
        with patch.object(moderation, 'TERMS_FILE', Path('/nonexistent/terms.json')):
            with self.assertRaises(FileNotFoundError):
                moderation._load_terms()

    def test_uploads_strip_metadata_and_bound_dimensions(self):
        raw = BytesIO()
        image = Image.new('RGB', (100, 80), 'red')
        exif = Image.Exif()
        exif[270] = 'private metadata'
        image.save(raw, 'JPEG', exif=exif)
        with tempfile.TemporaryDirectory() as directory:
            result = write_image(raw.getvalue(), Path(directory), 'test', 50)
            self.assertEqual((result['width'], result['height']), (50, 40))
            for suffix in ('jpg', 'webp'):
                with Image.open(Path(directory) / f'test.{suffix}') as clean:
                    self.assertFalse(clean.getexif())
            with patch('images.MAX_PIXELS', 100):
                with self.assertRaises(HTTPException) as error:
                    write_image(raw.getvalue(), Path(directory), 'oversized', 50)
                self.assertEqual(error.exception.status_code, 400)
                self.assertFalse((Path(directory) / 'oversized.jpg').exists())
            with self.assertRaises(HTTPException):
                write_image(b'<svg onload=alert(1)>', Path(directory), 'not-image', 50)


if __name__ == '__main__':
    unittest.main()
