import unittest
from pyee import EventEmitter
from collection import matrix,case,HardStop,Blocked,response_listener,assert_saved_row

class CollectionChecks(unittest.IsolatedAsyncioTestCase):
    async def test_role_and_scenario_failures_do_not_abort_independent_cases(self):
        users=[{'label':str(i),'role':str(i),'fixtures':[{'name':str(j)} for j in range(4)]} for i in range(7)]
        records=[];visited=[];closed=[]
        async def guard():pass
        async def login(user):
            if user['label']=='1':raise ValueError('Role-specific login rejected')
            return user['label']
        async def extras(resource,user):
            if user['label']=='2':raise RuntimeError('Extras harness error')
        async def scenario(resource,user,fixture):
            visited.append((user['label'],fixture['name']))
            if visited[-1]==('0','0'):raise AssertionError('First scenario mismatch')
        async def close(resource,user):closed.append(resource)
        await matrix(users,login,extras,scenario,close,records.append,guard)
        scenarios=[r for r in records if 'scenario' in r]
        self.assertEqual(len(scenarios),28)
        self.assertEqual(sum(r['status']=='BLOCKED' for r in scenarios),4)
        self.assertEqual(sum(r['status']=='FAIL' for r in scenarios),1)
        self.assertEqual(sum(r['status']=='PASS' for r in scenarios),23)
        self.assertIn(('6','3'),visited);self.assertEqual(len(closed),6)
        self.assertFalse(all(r['passed'] for r in records))

    async def test_shared_failure_hard_stops_and_closes_current_context(self):
        users=[{'label':'one','role':'one','fixtures':[{'name':'first'},{'name':'second'}]}]
        closed=[];checks=0
        async def guard():
            nonlocal checks
            checks+=1
            if checks>1:raise HardStop('Shared database unavailable')
        async def login(user):return 'context'
        async def extras(*args):pass
        async def scenario(*args):raise RuntimeError('Database read failed')
        async def close(*args):closed.append(True)
        with self.assertRaises(HardStop):await matrix(users,login,extras,scenario,close,lambda r:None,guard)
        self.assertEqual(closed,[True])

    async def test_blocked_never_passes_and_failure_retains_row_evidence(self):
        async def guard():pass
        async def action():raise Blocked('Missing photo submission')
        records=[];r=await case({},action,records.append,guard)
        self.assertEqual(r['status'],'BLOCKED');self.assertFalse(r['passed'])
        async def mismatch():
            error=AssertionError('Issue mismatch');error.evidence={'rows':[{'id':'synthetic'}]};raise error
        r=await case({},mismatch,records.append,guard)
        self.assertEqual(r['rows'],[{'id':'synthetic'}]);self.assertEqual(r['errorType'],'AssertionError')

class ListenerAndRowChecks(unittest.TestCase):
    def test_listener_removed_exactly_once_and_only_if_registered(self):
        emitter=EventEmitter();baseline=lambda response:None;capture=lambda response:None
        emitter.on('response',baseline)
        # This is the exact pyee failure hidden by the old broad "login" catch.
        with self.assertRaises(KeyError):emitter.remove_listener('response',capture)
        for enabled in [False,True]:
            with self.assertRaisesRegex(ValueError,'scenario'):
                with response_listener(emitter,capture,enabled):raise ValueError('scenario')
            self.assertEqual(emitter.listeners('response'),[baseline])

    def test_capitalized_contract_is_explicit_and_all_fields_stay_strict(self):
        fixture={'issue':'desk lamp not working','expected_issue':'Desk lamp not working','asset_id':'lamp','category':'Electrical','location_id':'room'}
        row={k:fixture[k] for k in ['asset_id','category','location_id']};row.update(issue='Desk lamp not working',notes='Exact notes')
        assert_saved_row([row],fixture,'Exact notes')
        for key in row:
            bad={**row,key:'wrong'}
            with self.assertRaisesRegex(AssertionError,key):assert_saved_row([bad],fixture,'Exact notes')
        with self.assertRaisesRegex(AssertionError,'row count'):assert_saved_row([],fixture,'Exact notes')
