import contextlib
import io
import json
import unittest
from diagnostics import emit_result, is_login_landing, sanitize
from playwright._impl._helper import url_matches

class DiagnosticChecks(unittest.TestCase):
    def test_playwright_passes_strings(self):
        for path in ['/engineering', '/technician', '/work-orders']:
            self.assertTrue(url_matches(None, 'http://127.0.0.1:3112' + path, is_login_landing))

    def test_query_string(self):
        self.assertTrue(is_login_landing('http://localhost:3112/engineering?tab=orders'))

    def test_login_page_rejected(self):
        self.assertFalse(is_login_landing('http://127.0.0.1:3112/'))

    def test_external_origin_rejected(self):
        self.assertFalse(is_login_landing('https://example.invalid/engineering'))

    def test_password_removed(self):
        self.assertEqual(sanitize({'error': 'fill Synthetic-secret! failed'}, ['Synthetic-secret!']), {'error': 'fill [redacted] failed'})

    def test_json_escaped_password_removed(self):
        self.assertEqual(sanitize({'error': 'a"secret!'}, ['a"secret!']), {'error': '[redacted]'})

    def test_token_redaction(self):
        result = sanitize({'error': 'Bearer private-token https://localhost/?access_token=private-token&other=ok eyJtest.payload.signature'})
        self.assertNotIn('private-token', result['error'])
        self.assertNotIn('eyJtest', result['error'])

    def test_login_failure_is_logged_without_credentials(self):
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            emit_result({'role': 'Chief Engineer', 'phase': 'login', 'passed': False, 'error': 'password SECRET', 'password': 'SECRET', 'response': {'access_token': 'TOKEN'}}, ['SECRET'])
        result = json.loads(capture.getvalue())
        self.assertEqual(result['phase'], 'login')
        self.assertFalse(result['passed'])
        self.assertNotIn('SECRET', capture.getvalue())
        self.assertNotIn('TOKEN', capture.getvalue())

if __name__ == '__main__':
    unittest.main()
