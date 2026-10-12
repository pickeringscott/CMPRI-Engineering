import json
import urllib.parse
from diagnostics import sanitize,is_login_landing,local_secrets

async def diagnose_context(context,out,label):
    evidence={'role':label,'pageErrors':[],'consoleErrors':[],'failedRequests':[],'httpErrors':[],'blockedExternal':[]}
    async def guard(route):
        host=urllib.parse.urlparse(route.request.url).hostname
        if host not in ['127.0.0.1','localhost']:
            evidence['blockedExternal'].append(host)
            return await route.abort()
        await route.continue_()
    await context.route('**/*',guard)
    page=await context.new_page()
    page.on('pageerror',lambda error:evidence['pageErrors'].append(str(error)[:2000]))
    page.on('console',lambda message:evidence['consoleErrors'].append(message.text[:2000]) if message.type=='error' else None)
    page.on('requestfailed',lambda request:evidence['failedRequests'].append({'route':urllib.parse.urlparse(request.url).path,'type':request.resource_type,'error':request.failure}))
    page.on('response',lambda response:evidence['httpErrors'].append({'route':urllib.parse.urlparse(response.url).path,'status':response.status,'contentType':response.headers.get('content-type','')}) if response.status>=400 else None)
    return page,evidence

async def login(page,user):
    await page.goto('http://127.0.0.1:3112/',timeout=45000)
    await page.get_by_role('button',name='More…').click(timeout=20000)
    await page.get_by_role('textbox',name='Email',exact=True).fill(user['email'])
    await page.get_by_role('textbox',name='Password',exact=True).fill(user['password'])
    await page.get_by_role('button',name='Sign in with Password',exact=True).click()
    await page.wait_for_url(is_login_landing,timeout=45000)

async def save_browser_diagnostics(page,evidence,out):
    evidence['lastRoute']=urllib.parse.urlparse(page.url).path
    try:
        button=page.get_by_role('button',name='More…')
        evidence['passwordToggleDisabled']=await button.is_disabled() if await button.count() else None
    except Exception: pass
    for key in ['pageErrors','consoleErrors','failedRequests','httpErrors','blockedExternal']:
        evidence[key]=evidence[key][-15:]
    path=out/'browser-diagnostics.json'
    prior=json.loads(path.read_text()) if path.exists() else []
    safe=sanitize(evidence,local_secrets(out))
    path.write_text(json.dumps(prior+[safe],indent=2))
    print(json.dumps({'phase':'browser diagnostics',**safe}),flush=True)
