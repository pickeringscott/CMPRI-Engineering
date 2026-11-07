"""Local-only checks for PM, location management and pool-log layout and editing."""
from cmpri_fixture import *
import re

async def main():
 results=[]
 first_task=json.loads((Path(__file__).resolve().parents[2]/'src/lib/pm/source-catalog.json').read_text())['daily'][0]['id']
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,1440]:
   ctx=await browser.new_context(viewport={'width':width,'height':1000},is_mobile=width<640,has_touch=width<640,timezone_id='America/Chicago')
   await install(ctx,'chief_engineer')
   exports=[]
   locations=[{'id':'10','name':'Room 10','room_number':'10','area':'Guest Rooms','location_type':'Guest Room','active':True},{'id':'lobby','name':'Lobby','room_number':None,'area':'Lobby','location_type':'Public Area','active':True},{'id':'2','name':'Room 2','room_number':'2','area':'Guest Rooms','location_type':'Guest Room','active':True}]
   writes=[]
   async def extras(route):
    path=urlparse(route.request.url).path
    if path=='/api/preventive-maintenance/export':
     exports.append(route.request.post_data_json)
     return await route.fulfill(body=(Path(__file__).resolve().parents[2]/'.bridge/Copy of Preventative Maintenance Tracking - CMPRI.xlsx').read_bytes(),headers={'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="cmpri-pm-sample.xlsx"','X-PM-Export-Duration-Ms':'800'})
    if path=='/api/rooms':
     if route.request.method in ['POST','PATCH']:
      body=route.request.post_data_json;writes.append((route.request.method,body))
      if route.request.method=='POST':record={'id':'new-location','active':True,**body};locations.append(record)
      else:
       record=next(x for x in locations if x['id']==body['id']);record.update(body)
      return await route.fulfill(json={'location':record})
     return await route.fulfill(json={'locations':locations,'work_orders':[{'id':WID,'location_id':'2','room':'2','issue':'Inspect bathroom fan','status':'Open'}],'pm_plans':[{'id':'plan','location_id':'2','asset_id':None,'title':'Room inspection','description':'Systems and safety checks','frequency_value':3,'frequency_unit':'MONTH','last_completed_on':'2026-10-01','next_due_on':'2027-01-01','active':True}],'pm_completions':[],'can_edit':True,'can_manage_corporate_pm':True})
    if path=='/api/preventive-maintenance':
     if route.request.method=='POST':
      body=route.request.post_data_json
      return await route.fulfill(json={'entry':{'id':'saved-draft','template_id':body['templateId'],'period_start':body['periodStart'],'scope_key':body['scopeKey'],'responses':body.get('responses',{}),'form_data':body.get('formData',{}),'notes':body.get('notes',''),'deficiency_notes':body.get('deficiencyNotes',''),'completed_on':body.get('completedOn'),'is_complete':False,'status':'pending','can_edit_entry':True,'revision':1}})
     week=parse_qs(urlparse(route.request.url).query)['week'][0]
     entry={'id':'pm-entry','template_id':'workbook:daily','period_start':week,'scope_key':'property','responses':{},'form_data':{},'notes':'','deficiency_notes':'','completed_on':None,'is_complete':False,'completed_by_name':None,'revision':1,'updated_at':'2026-11-06T12:00:00Z','task_states':{first_task:{'status':'needs','workerChecked':True,'workerId':'tech','workerName':'Sample Tech'}}}
     return await route.fulfill(json={'entries':[entry],'workbook':{'daily':{},'weekly':{},'monthly':{},'rooms':[],'fetchedAt':'2026-11-06T12:00:00Z'},'review_queue':[],'locations':locations,'can_edit':True,'can_review':True,'spreadsheet_sync_enabled':False,'actor_id':UID,'actor_name':'Sample Chief','access_roles':['Chief Engineer']})
    if path=='/api/pool-log':
     facility={'id':'pool','pool_name':'Indoor Pool','facility_name':'CMPRI','sanitizer':'Bromine'}
     return await route.fulfill(json={'facility':facility,'facilities':[facility],'log':None,'retests':[],'can_edit':True,'can_edit_saved':True})
    await route.fallback()
   await ctx.route('**/api/**',extras)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
   await page.wait_for_timeout(2500) # Allow dashboard session/bootstrap navigation to finish before opening a frame.
   async def open_modal(path,title):
    await page.evaluate("d=>window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:d}))",{'href':path,'title':title})
    shell=page.locator('.cmpri-modal-shell').last;await shell.wait_for()
    await expect(shell.get_by_text('Manage Locations' if path=='/management/rooms' else title,exact=True)).to_be_visible()
    frame=await (await shell.locator('iframe').element_handle()).content_frame()
    await frame.wait_for_selector('html[data-cmpri-framed=true]')
    return shell,frame
   shell,f=await open_modal('/engineering/preventive-maintenance','Preventive Maintenance')
   approval=f.get_by_role('button',name='Needs Approval (1)',exact=True);await approval.wait_for(timeout=60000)
   toolbar=f.locator('.pm-toolbar');tb=await toolbar.bounding_box();a=await approval.bounding_box();e=await f.get_by_role('button',name='Export Weekly CSV',exact=True).bounding_box();date=await toolbar.locator('input').bounding_box()
   assert abs(a['y']-e['y'])<2 and abs(a['y']-date['y'])<3,(width,a,e,date)
   if not await toolbar.evaluate('e=>e.scrollWidth<=e.clientWidth'):print(await toolbar.evaluate("e=>[...e.querySelectorAll('button,input,div')].map(b=>({text:b.textContent,width:b.getBoundingClientRect().width,font:getComputedStyle(b).fontSize,pad:getComputedStyle(b).padding,gap:getComputedStyle(b).gap}))"),flush=True)
   assert await toolbar.evaluate('e=>e.scrollWidth<=e.clientWidth'),(width,await toolbar.evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth})'))
   tabs=f.get_by_role('navigation',name='PM sections');boxes=[await b.bounding_box() for b in await tabs.get_by_role('button').all()]
   assert len(boxes)==4 and max(x['y'] for x in boxes)-min(x['y'] for x in boxes)<2,(width,boxes)
   for text in ['Google Sheets integration is disconnected','Google Sheets sync is temporarily disabled']:
    assert await f.get_by_text(text,exact=False).count()==0
   for card in await f.locator('.pm-inspection-card').all():assert '.pdf' not in (await card.inner_text()).lower()
   await approval.click()
   await expect(f.locator('section[aria-label="PM approvals"]')).to_be_visible()
   await f.get_by_role('button',name='Inspection Forms',exact=True).click()
   await f.get_by_role('button',name='Open form',exact=True).first.click()
   form=f.locator('section[role=dialog].pm-inspection');await expect(form).to_be_visible()
   await form.get_by_placeholder('Record observations, readings, or context…').fill('Unsaved export browser check')
   async with page.expect_download() as downloaded:
    await form.get_by_role('button',name='Export Excel',exact=True).click()
   download=await downloaded.value
   assert download.suggested_filename.endswith('.xlsx')
   assert len(exports)==1 and any(e.get('notes')=='Unsaved export browser check' and e.get('status')=='Current form (unsaved)' for e in exports[0]['entries']),exports
   await form.get_by_role('button',name='Close',exact=True).click()
   await shell.get_by_role('button',name='Close Preventive Maintenance',exact=True).click()
   await expect(page.locator('.cmpri-modal-shell')).to_have_count(0)
   print(json.dumps({'width':width,'modal':'PM','passed':True}),flush=True)
   shell,f=await open_modal('/management/rooms','Manage Rooms')
   await expect(shell.get_by_text('Manage Locations',exact=True)).to_be_visible()
   group=f.locator('.location-group').filter(has=f.get_by_role('heading',name=re.compile('Guest Room')));await group.wait_for(timeout=60000)
   names=[await b.inner_text() for b in await group.locator('.location-toggle').all()];assert 'Room 2' in names[0] and 'Room 10' in names[1],names
   assert await f.locator('.location-details').count()==0
   await group.locator('.location-toggle').first.click();region=f.get_by_role('region',name='Room 2 details');await expect(region).to_be_visible()
   await expect(region.get_by_text('Room inspection',exact=True)).to_be_visible();await expect(region.get_by_text('Inspect bathroom fan',exact=True)).to_be_visible()
   await region.get_by_role('button',name='Edit Location',exact=True).click();editor=f.get_by_role('dialog',name='Edit Location',exact=True)
   await editor.get_by_role('textbox',name='Name',exact=True).fill('Renamed room');await editor.get_by_role('combobox',name='Location Type',exact=True).fill('Suite')
   await editor.get_by_role('button',name='Save Location',exact=True).click();await expect(editor).to_have_count(0)
   await expect(f.locator('.location-group').filter(has=f.get_by_role('heading',name=re.compile('Suite')))).to_be_visible()
   add=f.locator('.location-add').get_by_role('button',name='Add Location',exact=True);await add.click();editor=f.get_by_role('dialog',name='Add Location',exact=True)
   await editor.get_by_role('textbox',name='Name',exact=True).fill('Storage');await editor.get_by_role('textbox',name='Area',exact=True).fill('Back of House');await editor.get_by_role('combobox',name='Location Type',exact=True).fill('Storage')
   await editor.get_by_role('button',name='Add Location',exact=True).click();await expect(editor).to_have_count(0)
   await expect(f.locator('.location-toggle').filter(has_text='Storage')).to_be_visible()
   assert [w[0] for w in writes]==['PATCH','POST'],writes
   await shell.get_by_role('button',name='Close Manage Locations',exact=True).click()
   await expect(page.locator('.cmpri-modal-shell')).to_have_count(0)
   print(json.dumps({'width':width,'modal':'locations','passed':True}),flush=True)
   shell,f=await open_modal('/engineering/pool-log','Pool Log')
   await f.locator('#pool-ph_am').wait_for(timeout=60000)
   await f.get_by_role('button',name='Pool Specs',exact=True).click();specs=f.get_by_role('dialog',name='Pool Specs',exact=True)
   await expect(specs.get_by_role('heading',name='Pool Specs',exact=True)).to_be_visible();await expect(specs.get_by_text('17,909 gal',exact=True)).to_be_visible()
   await specs.get_by_role('button',name='Close Pool Specs',exact=True).click();await expect(specs).to_be_hidden()
   await f.get_by_role('button',name='Pool Specs',exact=True).click()
   await specs.get_by_role('button',name='Close Pool Specs',exact=True).press('Escape');await expect(specs).to_be_hidden();await expect(shell).to_be_visible()
   cards=f.locator('.pool-water-sample');am=await cards.nth(0).bounding_box();pm=await cards.nth(1).bounding_box();assert abs(am['y']-pm['y'])<2 and pm['x']>am['x'],(width,am,pm)
   for label in ['Attention Needed','Keep Closed for Another Reason']:
    c=f.get_by_role('checkbox',name=label,exact=True);cb=await c.bounding_box();assert cb['height']==14,cb;await c.check();await expect(c).to_be_checked();await c.uncheck()
   save=f.get_by_role('button',name='Save Pool Log',exact=True);sb=await save.bounding_box();actions=await f.locator('.pool-save-actions').bounding_box();assert abs(sb['x']+sb['width']-actions['x']-actions['width'])<2,(width,sb,actions)
   for main in [f.locator('main')]:assert not await main.evaluate('e=>e.scrollWidth>document.documentElement.clientWidth'),width
   assert not errors,errors
   await ctx.close();results.append({'width':width,'pm':True,'locations':True,'pool':True,'writes':'local fixtures only'})
  await browser.close()
 OUT.joinpath('workflow-modal-layout.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))

asyncio.run(main())
