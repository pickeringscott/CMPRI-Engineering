from cmpri_fixture import *
import re
from datetime import datetime,timezone
BACKEND='http://127.0.0.1:3127'
def sid(n):return f'00000000-0000-4000-8000-{n:012d}'
H=sid(1)
async def api(request,path,user=2,method='GET',body=None):
 return await request.fetch(BACKEND+path,method=method,max_retries=2,headers={'Authorization':'Bearer fixture:'+sid(user)},**({'data':body} if body is not None else {}))
async def finish(context):
 # Assertions finish before teardown. A last invalidation read may still be forwarded;
 # removing interception can retire that route before its backend response arrives.
 await context.unroute_all(behavior='ignoreErrors');await context.close()
async def state(request):return await (await api(request,'/fixture/state')).json()
async def control(request,body):
 r=await api(request,'/fixture/control',method='POST',body=body);assert r.ok,await r.text()
async def setup(browser,width,role='chief_engineer',user=2):
 context=await browser.new_context(viewport={'width':width,'height':950},is_mobile=width<640,has_touch=width<640)
 await install(context,role,user_id=sid(user),hotel_id=H)
 requests=[]
 async def forward(route):
  u=urlparse(route.request.url);path=u.path+('?' + u.query if u.query else '')
  payload=route.request.post_data_json if route.request.method in ['POST','PATCH'] else None
  requests.append({'path':u.path,'method':route.request.method,'body':payload})
  response=await api(context.request,path,user,route.request.method,payload)
  await route.fulfill(status=response.status,content_type='application/json',body=await response.body())
 await context.route(re.compile(r'.*/api/staff-notes(?:[/?].*)?$'),forward)
 await context.route('**/api/work-orders/references?*',forward)
 async def ticket(route):
  response=await api(context.request,'/fixture/ticket?id='+sid(31),user)
  await route.fulfill(status=response.status,content_type='application/json',body=await response.body())
 await context.route(re.compile(r'.*/api/work-orders/'+sid(31)+r'(?:\?.*)?$'),ticket)
 page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 return context,page,requests,errors
async def choose(page,label,width):
 option=page.get_by_role('option',name=label,exact=True);await option.wait_for(timeout=15000);await option.scroll_into_view_if_needed()
 await page.get_by_role('listbox',name='Mention targets').screenshot(path=str(OUT/('picker-'+str(width)+'-'+re.sub(r'[^a-zA-Z0-9]+','_',label)+'.png')))
 if width<640:await option.tap()
 else:await option.click()
async def blue(locator):
 return await locator.evaluate("e=>{const c=document.createElement('canvas'),s=c.getContext('2d');s.fillStyle=getComputedStyle(e).color;s.fillRect(0,0,1,1);const p=s.getImageData(0,0,1,1).data;return p[2]>p[0]+40}")
async def note_by_body(request,body):
 for _ in range(40):
  s=await state(request);match=next((n for n in s['notes'] if n['body']==body.strip()),None)
  if match:return match,s
  await asyncio.sleep(.1)
 raise AssertionError('Posted note did not reach PostgreSQL: '+body)
async def fill_target(page,kind,prefix,width):
 text=page.get_by_role('textbox',name='Write a comment',exact=True)
 if kind=='person':
  await text.fill(prefix+'@Alex');await choose(page,'Mention Alex Chen (Person)',width)
  await text.fill(prefix+'@Alex R');await choose(page,'Mention Alex Rivera (Person)',width)
 elif kind=='role':await text.fill(prefix+'@Front Desk M');await choose(page,'Mention Front Desk Manager (Role)',width)
 elif kind=='front_desk_name':await text.fill(prefix+'@Alex R');await choose(page,'Mention Alex Rivera (Front Desk name)',width)
 elif kind=='location':
  await text.fill('room 204');await expect(page.get_by_role('listbox',name='Mention targets')).to_have_count(0)
  await text.fill(prefix+'@20');await choose(page,'Mention 204 (Location)',width)
 elif kind=='work_order':await text.fill(prefix+'#4218');await choose(page,'Mention WO#4218 (Work order)',width)
 elif kind=='hashtag':
  await text.fill(prefix+'#handoff');await expect(page.get_by_role('listbox',name='Mention targets')).to_have_count(0)
  assert await blue(page.locator('[aria-hidden=true] .staff-note-tag').last)
 await text.press('Control+Home');await page.keyboard.insert_text('Edited 😀 ')
 await text.press('Control+End');await page.keyboard.insert_text(' after 👩🏽‍🔧')
 return await text.input_value()
async def post(page,request):
 text=page.get_by_role('textbox',name='Write a comment',exact=True);body=await text.input_value()
 await page.get_by_role('button',name='Post',exact=True).click();await expect(text).to_have_value('',timeout=20000)
 note,s=await note_by_body(request,body);row=page.locator('#note-'+note['id']);await row.wait_for();return note,s
async def main():
 results=[]
 async with async_playwright() as p:
  probe=await p.request.new_context()
  for attempt in range(60):
   try:
    response=await probe.get(BACKEND+'/fixture/state')
    if response.ok:break
   except Exception:pass
   await asyncio.sleep(.2)
  else:raise AssertionError('The isolated backend did not start')
  await probe.dispose()
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  cleanup=await browser.new_context();await control(cleanup.request,{'clearNotes':True,'now':None,'failNextPost':False,'rename':{'id':sid(4),'name':'Alex Rivera'}});await cleanup.close()
  # Capture a real display-only Front Desk name, including the explicit handoff/change control.
  c,q,requests,errors=await setup(browser,390,'front_desk',6);await q.goto(BASE+'/staff-notes')
  name=q.get_by_role('textbox',name='Your actual name',exact=True);await name.wait_for();await name.fill('Alex Rivera');await name.press('Enter')
  await expect(q.get_by_role('textbox',name='Write a comment',exact=True)).to_be_visible();await expect(q.locator('.staff-confirmed-identity').filter(has_text='Alex Rivera')).to_be_visible()
  captured=next(n for n in (await state(c.request))['names'] if n['name']=='Alex Rivera')
  assert not [r for r in requests if r['path']=='/api/staff-notes' and r['method']=='POST']
  await q.reload();await expect(q.get_by_role('textbox',name='Write a comment',exact=True)).to_be_visible()
  await q.get_by_role('button',name='Change name',exact=True).click();await expect(q.get_by_role('textbox',name='Your actual name',exact=True)).to_be_visible();assert not errors,errors;await finish(c)
  # Only shared accounts can capture names; captured names never rename the profile.
  c=await browser.new_context()
  for value in ['', 'Front Desk', 'Staff', 'A'*81]:
   response=await api(c.request,'/api/staff-notes/names',6,'POST',{'name':value});assert response.status==400
  response=await api(c.request,'/api/staff-notes/names',2,'POST',{'name':'Manager Cannot Capture'});assert response.status==403
  response=await api(c.request,'/api/staff-notes',6,'POST',{'body':'Missing name','requestId':str(__import__('uuid').uuid4())});assert response.status==400
  await c.close()
  for width in [1440,390]:
   c,q,requests,errors=await setup(browser,width,'front_desk',6);await q.goto(BASE+'/staff-notes')
   name=q.get_by_role('textbox',name='Your actual name',exact=True);await name.wait_for();await name.fill('Alex Rivera');await name.press('Enter')
   text=q.get_by_role('textbox',name='Write a comment',exact=True);await text.fill(f'Named Front Desk handoff {width} 😀');note,s=await post(q,c.request)
   assert note['author_user_id']==sid(6) and note['author_name']=='Alex Rivera' and note['author_name_id']==captured['id']
   assert next(p for p in s['profiles'] if p['id']==sid(6))['full_name']=='Front Desk'
   await q.reload();await expect(q.locator('#note-'+note['id'])).to_contain_text('Alex Rivera')
   await q.locator('#note-'+note['id']).get_by_role('button',name='Alex Rivera',exact=True).click();await expect(text).to_have_value('@Alex ')
   shortcut,s=await post(q,c.request);assert shortcut['mentions'][0]['kind']=='front_desk_name' and shortcut['mentions'][0]['id']==captured['id']
   assert not errors,errors;await finish(c);results.append({'width':width,'sharedFrontDeskNameCaptureAndPost':True,'profileUnchanged':True});print(json.dumps(results[-1]),flush=True)
  expected={'person':('person',sid(4)),'role':('role','front_desk_manager'),'front_desk_name':('front_desk_name',captured['id']),'location':('location',sid(21)),'work_order':('work_order',sid(31))}
  for width in [1440,390]:
   for kind in ([] if os.environ.get('CMPRI_STAFF_PHASE')=='flags' else ['role','person','front_desk_name','location','work_order','hashtag']):
    c,q,requests,errors=await setup(browser,width);await q.goto(BASE+'/staff-notes');text=q.get_by_role('textbox',name='Write a comment',exact=True);await text.wait_for()
    # Bare @ offers every supported non-ticket target type. Actual tickets use the established numeric entry forms.
    await text.fill('@');await expect(q.get_by_role('listbox',name='Mention targets')).to_be_visible()
    for label in ['Mention Front Desk Manager (Role)','Mention Alex Rivera (Person)','Mention Alex Rivera (Front Desk name)','Mention 204 (Location)']:await expect(q.get_by_role('option',name=label,exact=True)).to_have_count(1)
    body=await fill_target(q,kind,f'{width}-{kind} ',width)
    await q.screenshot(path=str(OUT/f'staff-{width}-{kind}-draft.png'))
    note,s=await post(q,c.request);row=q.locator('#note-'+note['id'])
    own=[n for n in s['notifications'] if n['notification_key']=='staff-note:'+note['id']];recipients={n['recipient_user_id'] for n in own}
    assert (sid(4) in recipients)==(kind=='person'),(kind,recipients)
    assert sid(5) not in recipients and sid(6) not in recipients and sid(98) not in recipients
    if kind!='hashtag':
     target_kind,target_id=expected[kind];span=row.locator(f'[data-staff-target-kind="{target_kind}"][data-staff-target-id="{target_id}"]');await expect(span).to_have_count(1)
     assert any(m['kind']==target_kind and m['id']==target_id for m in note['mentions']),(kind,note)
     if kind=='work_order':assert await span.get_attribute('href')=='/work-orders/'+sid(31);assert await span.inner_text()=='WO#4218'
     else:assert await span.get_attribute('href') is None
    else:assert note['hashtags']==['#handoff'];assert await blue(row.locator('.staff-note-tag'))
    if kind=='person':
     deliveries=[d for d in s['deliveries'] if d['notification_key']=='staff-note:'+note['id'] and d['recipient_user_id']==sid(4)];assert len(deliveries)==1 and deliveries[0]['status']=='sent',deliveries
     assert any(x['recipient']==sid(4) and x['payload']['url'].endswith(note['id']) for x in s['sent'])
    # Replies use the same selection and persistence path, with a genuine same-property parent FK.
    await row.get_by_role('button',name='Reply to '+note['author_name'],exact=True).click()
    await fill_target(q,kind,f'{width}-{kind}-reply ',width);reply,s=await post(q,c.request);assert reply['parent_id']==note['id']
    await q.reload();await q.locator('#note-'+reply['id']).wait_for();await expect(q.locator('#note-'+reply['id']).get_by_role('button',name='↪ '+note['author_name'],exact=True)).to_be_visible()
    for saved in [note,reply]:
     rendered=q.locator('#note-'+saved['id']);assert '👩🏽‍🔧' in await rendered.inner_text() and '😀' in await rendered.inner_text()
     if kind!='hashtag':await expect(rendered.locator(f'[data-staff-target-kind="{expected[kind][0]}"][data-staff-target-id="{expected[kind][1]}"]')).to_have_count(1)
     else:assert await blue(rendered.locator('.staff-note-tag'))
    await q.screenshot(path=str(OUT/f'staff-{width}-{kind}-posted-reply.png'))
    if kind=='work_order':
     await q.locator('#note-'+note['id']).get_by_role('link',name='WO#4218',exact=True).click();ticket_frame=q.frame_locator('iframe[src*="/work-orders/'+sid(31)+'"]');await ticket_frame.get_by_role('heading',name='Notes & Ticket History',exact=True).wait_for();await expect(ticket_frame.get_by_text('Fixture drain repair',exact=True).first).to_be_visible();await q.locator('.cmpri-desktop-close').last.click()
    if kind=='person':
     await q.locator('#note-'+note['id']).get_by_role('button',name=note['author_name'],exact=True).click();shortcut,s=await post(q,c.request)
     assert shortcut['mentions'][0]['kind']=='person' and shortcut['mentions'][0]['id']==sid(2)
    # Raw POST retry must preserve target identity and delivery idempotence, not merely duplicate the body.
    submitted=next(r['body'] for r in requests if r['path']=='/api/staff-notes' and r['method']=='POST')
    retry=await api(c.request,'/api/staff-notes',method='POST',body=submitted);assert retry.ok,await retry.text();assert (await retry.json())['id']==note['id']
    after=await state(c.request);assert len([n for n in after['notes'] if n['id']==note['id']])==1
    if kind=='person':assert len([x for x in after['sent'] if x['recipient']==sid(4) and x['payload']['url'].endswith(note['id'])])==1
    assert not errors,errors;result={'width':width,'type':kind,'triggerSuggestionsSelection':True,'draftEdits':True,'postRendering':True,'reply':True,'reloadIdentity':True,'recipients':True,'retry':True};results.append(result);print(json.dumps(result),flush=True);await finish(c)
  if os.environ.get('CMPRI_STAFF_PHASE')!='flags':
   # Failed sends retain the exact edited selected-target draft. A successful retry saves it once.
   c,q,requests,errors=await setup(browser,1440);await q.goto(BASE+'/staff-notes');text=q.get_by_role('textbox',name='Write a comment',exact=True);await text.wait_for();body=await fill_target(q,'person','Failure/retry ',1440)
   await control(c.request,{'failNextPost':True});await q.get_by_role('button',name='Post',exact=True).click();await expect(q.locator('.cmpri-staff-notes [role=alert]')).to_contain_text('Fixture save failed');await expect(text).to_have_value(body)
   note,s=await post(q,c.request);assert note['mentions'][0]['id']==sid(4);assert len([r for r in requests if r['path']=='/api/staff-notes' and r['method']=='POST'])==2
   # Saved identity survives a later profile rename, independent of the current suggestion labels.
   await control(c.request,{'rename':{'id':sid(4),'name':'Renamed Individual'}});await q.reload();await expect(q.locator('#note-'+note['id']).locator('[data-staff-target-kind=person]')).to_have_text('@Alex Rivera');await control(c.request,{'rename':{'id':sid(4),'name':'Alex Rivera'}})
   # Foreign target selections, inactive and anonymous sessions cannot create a note or gain ticket access.
   before=len((await state(c.request))['notes'])
   for kind,target,label in [('person',sid(98),'Foreign Person'),('location',sid(22),'999'),('work_order',sid(32),'WO#9911')]:
    raw='@'+label;response=await api(c.request,'/api/staff-notes',method='POST',body={'body':raw,'requestId':sid(700+len(label)),'mentions':[{'start':0,'end':len(raw),'id':target,'kind':kind,'label':label}]});assert response.status==400,(kind,await response.text())
   assert len((await state(c.request))['notes'])==before
   for user in [13,97]:assert (await api(c.request,'/api/staff-notes',user)).status==401
   foreign=await (await api(c.request,'/api/work-orders/references?target=number:9911')).json();assert foreign['tickets']==[]
   assert (await api(c.request,'/fixture/ticket?id='+sid(32))).status==403
   assert not errors,errors;await finish(c)
   results.append({'failureDraftRetry':True,'renamedAccountIdentityRetained':True,'foreignInactiveAnonymousDenied':True});print(json.dumps(results[-1]),flush=True)
  # Each management role retains its flag over time; scrolling actual notes clears only that viewer's flag.
  role_users=[('manager',3),('assistant_manager',7),('front_desk_manager',8),('chief_engineer',2),('technician',9),('system_admin',10)]
  for width in [1440,390]:
   for role,user in role_users:
    c,q,requests,errors=await setup(browser,width,role,user)
    await api(c.request,'/api/staff-notes',method='POST',body={'body':f'Flag fixture {width}-{role}','requestId':str(__import__('uuid').uuid4())})
    await control(c.request,{'now':'2030-01-15T20:00:00Z'})
    await q.goto(BASE+'/engineering');button=q.locator('.cmpri-header-v23 [data-key="/staff-notes"]');await button.wait_for();await expect(button).to_have_attribute('data-staff-notes-unread',re.compile('[1-9][0-9]*'))
    assert not await q.locator('a.fixed[href="/staff-notes"]').count();await button.scroll_into_view_if_needed()
    await q.wait_for_function("()=>{const e=document.querySelector('.cmpri-header-v23 [data-key=\"/staff-notes\"][data-staff-notes-unread]');return e&&e.isConnected&&getComputedStyle(e,'::after').display==='block'}")
    flag=await button.evaluate("e=>{const s=getComputedStyle(e,'::after');return {content:s.content,width:s.width,height:s.height,display:s.display,background:s.backgroundColor,top:s.top}}")
    assert flag['content']=='\"\"' and flag['display']!='none' and flag['width']=='6px' and flag['height']=='6px',flag
    await q.screenshot(path=str(OUT/f'flag-{width}-{role}.png'));await button.screenshot(path=str(OUT/f'flag-pill-{width}-{role}.png'))
    await button.click();frame=q.frame_locator('iframe[src*="/staff-notes"]');feed=frame.locator('.cmpri-staff-notes > div.overflow-y-auto');await frame.get_by_text(f'Flag fixture {width}-{role}',exact=True).wait_for()
    height=await feed.evaluate('e=>e.scrollHeight')
    for y in range(0,int(height)+300,150):await feed.evaluate('(e,y)=>e.scrollTop=y',y);await q.wait_for_timeout(140)
    for _ in range(30):
     remaining=[n for n in (await state(c.request))['notifications'] if n['recipient_user_id']==sid(user) and n['read_at'] is None]
     if not remaining:break
     await q.wait_for_timeout(120)
    assert not remaining,(role,width,len(remaining));await expect(button).not_to_have_attribute('data-staff-notes-unread',re.compile('.+'));assert not errors,errors
    await control(c.request,{'now':None});await finish(c);results.append({'width':width,'managerRole':role,'retainedUntilViewed':True,'buttonFlagClearedByView':True});print(json.dumps(results[-1]),flush=True)
  # Exact Tuesday 2 PM -> Friday 6 AM example, property-local, without a timer-driven server read.
  for width in [1440,390]:
   c,q,requests,errors=await setup(browser,width,'front_desk',6)
   await control(c.request,{'clearNotes':True,'now':'2026-11-06T11:59:59Z','seed':[{'created_at':'2026-11-03T20:00:00Z','body':'Tuesday 2 PM handoff'}]})
   await q.clock.install(time=datetime(2026,11,6,11,58,0,tzinfo=timezone.utc))
   await q.goto(BASE+'/engineering');button=q.locator('.cmpri-header-v23 [data-key="/staff-notes"]');await button.wait_for();await expect(button).to_have_attribute('data-staff-notes-unread','1')
   await button.scroll_into_view_if_needed();await button.click();frame=q.frame_locator('iframe[src*="/staff-notes"]');await frame.get_by_text('Tuesday 2 PM handoff',exact=True).wait_for();await q.wait_for_timeout(150);await expect(button).to_have_attribute('data-staff-notes-unread','1')
   await q.locator('.cmpri-desktop-close').last.click();await q.wait_for_timeout(250);before=len([r for r in requests if r['path']=='/api/staff-notes' and r['method']=='GET'])
   await q.clock.fast_forward(int(datetime(2026,11,6,12,0,1,tzinfo=timezone.utc).timestamp()*1000-await q.evaluate('Date.now()')));await expect(button).not_to_have_attribute('data-staff-notes-unread',re.compile('.+'));after=len([r for r in requests if r['path']=='/api/staff-notes' and r['method']=='GET']);assert before==after,(before,after)
   await control(c.request,{'now':'2026-11-06T12:00:01Z'});await q.reload();button=q.locator('.cmpri-header-v23 [data-key="/staff-notes"]');await button.wait_for();await expect(button).not_to_have_attribute('data-staff-notes-unread',re.compile('.+'));assert not errors,errors
   await finish(c);results.append({'width':width,'frontDeskViewRetainsFlag':True,'tuesdayToFridaySixAM':True,'noBoundaryPolling':True});print(json.dumps(results[-1]),flush=True)
  probe=await browser.new_context();final=await state(probe.request);await probe.close()
  assert not final['failures'],final['failures'];assert final['untouched']==[{'value':{'hours':19,'profile':'unchanged','feedback':'private'}}]
  assert next(p for p in final['profiles'] if p['id']==sid(6))['full_name']=='Front Desk'
  await browser.close()
 OUT.joinpath('staff-notes-verification.json').write_text(json.dumps(results,indent=2))
asyncio.run(main())
