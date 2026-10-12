"""Continue independent cases; hard-stop only shared prerequisites/isolation."""
from contextlib import contextmanager

class HardStop(RuntimeError):pass
class Blocked(RuntimeError):pass

def failure(error):
    return {**getattr(error,'evidence',{}),'status':'BLOCKED' if isinstance(error,Blocked) else 'FAIL',
            'passed':False,'errorType':type(error).__name__,'error':str(error)}

async def case(meta,action,record,guard):
    try:
        value=await action()
        result={**meta,**(value or {}),'status':'PASS','passed':True}
    except HardStop:raise
    except Exception as error:
        await guard()
        result={**meta,**failure(error)}
    record(result)
    return result

@contextmanager
def response_listener(page,callback,enabled):
    if enabled:page.on('response',callback)
    try:yield
    finally:
        if enabled:page.remove_listener('response',callback)

def assert_saved_row(rows,fixture,notes):
    assert len(rows)==1,f'row count: expected 1, actual {len(rows)}'
    expected={'asset_id':fixture['asset_id'],'category':fixture['category'],
              'notes':notes,'issue':fixture['expected_issue'],'location_id':fixture['location_id']}
    differences={k:{'expected':v,'actual':rows[0].get(k)} for k,v in expected.items() if rows[0].get(k)!=v}
    assert not differences,f'Saved-row field mismatches: {differences}'

async def matrix(users,open_role,extras,scenario,close_role,record,guard):
    await guard()
    for user in users:
        resource=None
        try:
            try:
                resource=await open_role(user)
            except HardStop:raise
            except Exception as error:
                await guard()
                record({'role':user['label'],'phase':'browser login',**failure(error)})
                for fixture in user['fixtures']:
                    record({'role':user['label'],'storedRole':user['role'],'scenario':fixture['name'],
                            **failure(Blocked('Role browser login failed'))})
                continue
            await case({'role':user['label'],'phase':'browser extras harness'},
                       lambda:extras(resource,user),record,guard)
            for fixture in user['fixtures']:
                await case({'role':user['label'],'storedRole':user['role'],'scenario':fixture['name']},
                           lambda:scenario(resource,user,fixture),record,guard)
        finally:
            if resource is not None:
                await case({'role':user['label'],'phase':'browser diagnostics/cleanup'},
                           lambda:close_role(resource,user),record,guard)
