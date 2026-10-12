import itertools,unittest
from browser_support import request_metadata,preflight_passes
from server_diagnostics import extract
class Request:
    url='http://127.0.0.1:3112/engineering?_rsc=cache&access_token=private'
    method='GET';resource_type='fetch'
    def is_navigation_request(self):return False
class NavigationDiagnosticChecks(unittest.TestCase):
    def test_rsc_metadata_never_contains_query_values(self):
        value=request_metadata(Request(),1,'client',0)
        self.assertEqual(value['route'],'/engineering');self.assertTrue(value['rsc'])
        self.assertNotIn('private',str(value));self.assertNotIn('cache',str(value))
        self.assertEqual(value['state'],'pending')
    def test_direct_load_can_never_bypass_client_failure(self):
        keys=['clientNavigationPassed','directNavigationPassed','createFormPassed']
        for values in itertools.product([False,True],repeat=3):
            self.assertEqual(preflight_passes(dict(zip(keys,values))),all(values))
        self.assertFalse(preflight_passes({}))
    def test_server_keeps_navigation_compile_and_memory_metadata(self):
        value=extract(['○ Compiling /engineering ...',' GET /engineering?_rsc=private 200 in 50ms','FATAL ERROR: heap out of memory'])
        self.assertEqual(value['navigationRequests'],[{'method':'GET','route':'/engineering','status':200}])
        self.assertEqual(value['compilation'],[{'route':'/engineering','event':'compiling'}])
        self.assertIn('[runtime memory/process failure observed]',value['exceptions'])
        self.assertNotIn('private',str(value))
