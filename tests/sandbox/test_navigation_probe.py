import json,unittest
from navigation_probe import rsc_summary

class ProbeChecks(unittest.TestCase):
    def test_rsc_keeps_structure_not_payload(self):
        body=b'1:I[123,["456","static/chunks/app/engineering/page.js"],"default"]\n0:{"b":"development","secret":"private-password","email":"fixture@example.invalid"}\n2:E{"message":"private-error-token"}\n'
        value=rsc_summary(body)
        self.assertEqual(value['moduleRecords'],1)
        self.assertEqual(value['errorRecords'],1)
        self.assertTrue(value['rootJsonObject'])
        self.assertEqual(value['buildId'],'development')
        self.assertEqual(value['staticModules'],['static/chunks/app/engineering/page.js'])
        self.assertEqual(value['bytes'],len(body))
        self.assertEqual(len(value['sha256']),64)
        for private in ['private-password','fixture@example.invalid','private-error-token']:
            self.assertNotIn(private,json.dumps(value))

    def test_html_and_truncated_records_do_not_look_like_valid_root(self):
        for body in [b'<html>private</html>',b'0:{"b":"development"',b'']:
            value=rsc_summary(body)
            self.assertFalse(value['rootJsonObject'])
            self.assertIsNone(value['buildId'])
            self.assertNotIn('private',json.dumps(value))

    def test_unsafe_build_id_is_not_exported(self):
        value=rsc_summary(b'0:{"b":"Bearer secret@example.invalid"}\n')
        self.assertIsNone(value['buildId'])
