import unittest
from server_diagnostics import extract
class ServerDiagnosticChecks(unittest.TestCase):
    def test_only_exception_frames_and_route_statuses(self):
        result=extract(['Guest notes should never appear',' POST /api/work-orders/drafts?token=secret 500 in 25ms','Error: fixture-secret user@example.invalid',' at POST (/app/route.ts:4:5)',' 42 | console.log(privateNote)','authorization: Bearer opaque'],['fixture-secret'])
        self.assertEqual(result['apiRequests'],[{'method':'POST','route':'/api/work-orders/drafts','status':500}])
        self.assertEqual(len(result['exceptions']),2)
        for private in ['Guest notes','fixture-secret','user@example.invalid','privateNote','opaque']:
            self.assertNotIn(private,str(result))
    def test_sensitive_error_is_omitted(self):
        self.assertEqual(extract(['Error: api_key=opaque'])['exceptions'],['[sensitive diagnostic line omitted]'])
