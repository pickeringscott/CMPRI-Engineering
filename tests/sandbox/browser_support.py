import json,time
import urllib.parse
from diagnostics import sanitize,is_login_landing,local_secrets

def request_metadata(request,sequence,phase,started):
    parsed=urllib.parse.urlparse(request.url)
    return {'id':sequence,'phase':phase,'route':parsed.path,'method':request.method,
            'type':request.resource_type,'documentNavigation':request.is_navigation_request(),
            'rsc':'_rsc' in urllib.parse.parse_qs(parsed.query),'state':'pending',
            'startedMs':round((time.monotonic()-started)*1000)}

async def diagnose_context(context,out,label):
    evidence={'role':label,'phase':'initial','pageErrors':[],'consoleErrors':[],'failedRequests':[],'httpErrors':[],'blockedExternal':[],'requests':[],'frames':[],'sessionResponses':[],'snapshots':[]}
    active={};started=time.monotonic();sequence=0
    async def guard(route):
        host=urllib.parse.urlparse(route.request.url).hostname
        if host not in ['127.0.0.1','localhost']:
            evidence['blockedExternal'].append(host)
            return await route.abort()
        await route.continue_()
    await context.route('**/*',guard)
    page=await context.new_page()
    def requested(request):
        nonlocal sequence
        sequence+=1
        row=request_metadata(request,sequence,evidence['phase'],started)
        active[request]=row;evidence['requests'].append(row)
    def finished(request):
        row=active.pop(request,None)
        if row:row.update(state='completed',elapsedMs=round((time.monotonic()-started)*1000)-row['startedMs'])
    def failed(request):
        row=active.pop(request,None)
        if row:row.update(state='failed',elapsedMs=round((time.monotonic()-started)*1000)-row['startedMs'])
        evidence['failedRequests'].append({'phase':evidence['phase'],'route':urllib.parse.urlparse(request.url).path,'type':request.resource_type,'error':request.failure})
    async def responded(response):
        route=urllib.parse.urlparse(response.url).path
        row=active.get(response.request)
        if row:row.update(status=response.status,contentType=response.headers.get('content-type',''),responseMs=round((time.monotonic()-started)*1000))
        if response.status>=400:evidence['httpErrors'].append({'phase':evidence['phase'],'route':route,'status':response.status,'contentType':response.headers.get('content-type','')})
        if route=='/api/session' and response.status==200:
            # Only these two allowlisted fields, never user identity or bearer/session data.
            try:
                body=await response.json()
                landing=body.get('landing')
                role=body.get('user',{}).get('role')
                evidence['sessionResponses'].append({'phase':evidence['phase'],'status':200,'landing':landing if landing in ['/engineering','/technician','/work-orders'] else 'unexpected','role':role if role in ['manager','assistant_manager','front_desk_manager','technician','chief_engineer','housekeeping','front_desk'] else 'unexpected'})
            except Exception:evidence['sessionResponses'].append({'phase':evidence['phase'],'status':200,'jsonParseFailed':True})
    page.on('request',requested);page.on('requestfinished',finished);page.on('requestfailed',failed);page.on('response',responded)
    page.on('framenavigated',lambda frame:evidence['frames'].append({'phase':evidence['phase'],'main':frame==page.main_frame,'route':urllib.parse.urlparse(frame.url).path,'atMs':round((time.monotonic()-started)*1000)}))
    page.on('pageerror',lambda error:evidence['pageErrors'].append(str(error)[:2000]))
    page.on('console',lambda message:evidence['consoleErrors'].append(message.text[:2000]) if message.type=='error' else None)
    return page,evidence

async def redirect_snapshot(page,evidence,label,expected_user_id=None):
    # Booleans and route metadata only; no DOM text dump, form values or storage values.
    snapshot=await page.evaluate('''(expectedId)=>{
      const buttons=Array.from(document.querySelectorAll('button'));
      const toggle=buttons.find(b=>b.textContent.trim()==='More…');
      const submit=buttons.find(b=>['Sign in with Password','Signing in…'].includes(b.textContent.trim()));
      let sessionPresent=false,sessionUserMatches=null;
      try {const s=JSON.parse(sessionStorage.getItem('cmpri:auth:v1')||localStorage.getItem('cmpri:auth:v1')||'null');sessionPresent=Boolean(s?.access_token);sessionUserMatches=expectedId?Boolean(s?.user?.id===expectedId):null;}catch{}
      return {route:location.pathname,readyState:document.readyState,historyLength:history.length,
        loadingDashboard:Array.from(document.querySelectorAll('[role="status"]')).some(e=>e.textContent.includes('Loading Dashboard')),
        passwordTogglePresent:Boolean(toggle),passwordToggleDisabled:toggle?.disabled??null,
        submitPresent:Boolean(submit),submitDisabled:submit?.disabled??null,
        dashboardTitlePresent:Boolean(document.querySelector('[data-dashboard-title]')),
        sessionPresent,sessionUserMatches,userAgent:navigator.userAgent};
    }''',expected_user_id)
    evidence['snapshots'].append({'label':label,'phase':evidence['phase'],**snapshot})
    return snapshot

async def login(page,user,evidence=None):
    if evidence is not None:evidence['phase']='login page'
    await page.goto('http://127.0.0.1:3112/',timeout=45000)
    await page.get_by_role('button',name='More…').click(timeout=20000)
    await page.get_by_role('textbox',name='Email',exact=True).fill(user['email'])
    await page.get_by_role('textbox',name='Password',exact=True).fill(user['password'])
    if evidence is not None:
        await redirect_snapshot(page,evidence,'before submit',user.get('id'))
        evidence['phase']='client login navigation'
    await page.get_by_role('button',name='Sign in with Password',exact=True).click()
    await page.wait_for_url(is_login_landing,timeout=45000)
    if evidence is not None:await redirect_snapshot(page,evidence,'client navigation passed',user.get('id'))

async def save_browser_diagnostics(page,evidence,out):
    evidence['lastRoute']=urllib.parse.urlparse(page.url).path
    try:await redirect_snapshot(page,evidence,'final')
    except Exception:pass
    for key in ['pageErrors','consoleErrors','failedRequests','httpErrors','blockedExternal']:
        evidence[key]=evidence[key][-15:]
    # Keep every pending request plus bounded completed navigation/API/chunk records.
    requests=evidence['requests']
    evidence['requests']=[r for r in requests if r['state']=='pending'][-30:]+[r for r in requests if r['state']!='pending' and (r['rsc'] or r['documentNavigation'] or r['route'].startswith('/api/') or r['route'].startswith('/auth/'))][-60:]
    evidence['frames']=evidence['frames'][-20:]
    path=out/'browser-diagnostics.json'
    prior=json.loads(path.read_text()) if path.exists() else []
    safe=sanitize(evidence,local_secrets(out))
    path.write_text(json.dumps(prior+[safe],indent=2))
    print(json.dumps({'phase':'browser diagnostics',**safe}),flush=True)


def preflight_passes(result):
    return all(result.get(key) is True for key in ['clientNavigationPassed','directNavigationPassed','createFormPassed'])
