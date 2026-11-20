"""Synthetic-only PM queue/close/restart checks on desktop and phone.
CMPRI_UI_BASE=http://127.0.0.1:3050 CMPRI_UI_OUTPUT=/tmp/cmpri-pm-close python tests/browser/pm_close_save.py
"""
import asyncio
import copy
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
import cmpri_fixture as fixture

BASE=os.environ.get('CMPRI_UI_BASE','http://127.0.0.1:3050').rstrip('/')
assert urlparse(BASE).hostname in {'localhost','127.0.0.1'},'Fixtures are local only'
OUT=Path(os.environ.get('CMPRI_UI_OUTPUT','/tmp/cmpri-pm-close'));OUT.mkdir(parents=True,exist_ok=True)
WINDOW='[data-cmpri-desktop-window="/engineering/preventive-maintenance"]'
WEEK='2026-11-09'
TASKS=['daily-7','daily-8']

async def launch(p,profile,width,state):
 context=await p.chromium.launch_persistent_context(str(profile),executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'],viewport={'width':width,'height':1000 if width>640 else 844},is_mobile=width<640,has_touch=width<640,timezone_id='America/Chicago',service_workers='block')
 await fixture.install(context,'chief_engineer')
 async def pm_route(route):
  u=urlparse(route.request.url)
  if u.path not in ['/api/preventive-maintenance','/api/preventive-maintenance/task']:return await route.fallback()
  if route.request.method=='PATCH':
   body=route.request.post_data_json;state['attempts'].append(copy.deepcopy(body))
   if state['fail']:return await route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Fixture PM service unavailable. Your changes are kept.'}))
   assert body['expectedRevision']==state['revision']
   assert len(body['changes'])==2
   states={c['itemId']:{'status':'approved','reviewedBy':'Alex Morgan'} for c in body['changes']}
   state['revision']+=1
   entry={'id':'fixture-pm-record','template_id':body['templateId'],'period_start':body['periodStart'],'scope_key':'property','task_states':states,'responses':{k:True for k in states},'revision':state['revision'],'status':'pending','form_data':{},'notes':'','deficiency_notes':'','completed_on':None,'is_complete':False,'completed_by_name':None,'work_order_id':None,'updated_at':'2026-11-20T18:00:00Z','can_edit_entry':True}
   state['entries']=[entry];state['commits'].append(copy.deepcopy(body))
   return await route.fulfill(content_type='application/json',body=json.dumps({'entry':entry}))
  state['reads']+=1
  return await route.fulfill(content_type='application/json',body=json.dumps({'entries':state['entries'],'workbook':{'daily':{},'weekly':{},'monthly':{},'rooms':[],'fetchedAt':'2026-11-20T18:00:00Z'},'can_edit':True,'can_review':True,'actor_id':fixture.UID,'actor_name':'Alex Morgan','locations':[],'review_queue':[],'access_roles':['chief_engineer'],'spreadsheet_sync_enabled':False}))
 await context.route('**/api/preventive-maintenance*',pm_route)
 page=await context.new_page();page.on('pageerror',lambda error:state['errors'].append(str(error)))
 return context,page

async def pm_frame(page):
 await expect(page.locator(WINDOW)).to_be_visible(timeout=90000)
 return page.frame_locator(WINDOW+' iframe')

async def main():
 results=[]
 async with async_playwright() as p:
  for width in [1440,390]:
   with tempfile.TemporaryDirectory(prefix='cmpri-pm-queue-') as profile:
    state={'entries':[],'revision':0,'attempts':[],'commits':[],'reads':0,'fail':False,'errors':[]}
    context,page=await launch(p,profile,width,state)
    await page.goto(BASE+'/engineering')
    await page.get_by_role('button',name='Preventative Maintenance',exact=True).click(timeout=90000)
    frame=await pm_frame(page)
    # Wait for authorized client hydration before editing the SSR date control.
    await expect(frame.get_by_role('checkbox').first).to_be_enabled(timeout=90000)
    await frame.get_by_label('Week beginning',exact=True).fill(WEEK)
    await expect(frame.get_by_label('Week beginning',exact=True)).to_have_value(WEEK)
    for task in TASKS:
     button=frame.locator('[id="pm-task-workbook:daily-'+WEEK+'-'+task+'"]')
     await expect(button).to_be_enabled(timeout=90000);await button.click()
     await expect(button).to_have_attribute('aria-checked','true')
    await expect(frame.get_by_text('2 PM changes queued.',exact=False)).to_be_visible()
    assert state['attempts']==[],state['attempts']
    await page.locator(WINDOW).screenshot(path=str(OUT/f'pm-queued-{width}.png'))
    await context.close()  # Actual browser shutdown, not a simulated React unmount.
    context,page=await launch(p,profile,width,state)
    await page.goto(BASE+'/engineering')
    frame=await pm_frame(page)
    await expect(frame.get_by_label('Week beginning',exact=True)).to_have_value(WEEK,timeout=90000)
    await expect(frame.get_by_text('2 PM changes queued.',exact=False)).to_be_visible()
    for task in TASKS:await expect(frame.locator('[id="pm-task-workbook:daily-'+WEEK+'-'+task+'"]')).to_have_attribute('aria-checked','true')
    assert not state['attempts']
    state['fail']=True
    await page.locator(WINDOW+' [data-cmpri-window-close]').click()
    await expect(frame.get_by_text('Fixture PM service unavailable. Your changes are kept.',exact=True)).to_be_visible(timeout=30000)
    await expect(page.locator(WINDOW)).to_be_visible();assert len(state['attempts'])==1;assert not state['commits']
    state['fail']=False
    await page.locator(WINDOW+' [data-cmpri-window-close]').click()
    await expect(page.locator(WINDOW)).to_have_count(0,timeout=30000)
    assert len(state['attempts'])==2 and len(state['commits'])==1
    assert state['attempts'][0]==state['attempts'][1]
    assert {c['itemId'] for c in state['commits'][0]['changes']}==set(TASKS)
    key=f'cmpri:pm-task-queue:v1:{fixture.HOTEL}:{fixture.UID}'
    saved=await page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',key)
    assert saved['periods']==[] and saved['context']['weekStart']==WEEK
    assert not state['errors'],state['errors']
    results.append({'width':width,'editing_patch_requests':0,'browser_restart_retains_checks_and_week':True,'failed_close_keeps_window_and_queue':True,'successful_close_period_mutations':1,'unchanged_retry_payload':True,'page_errors':state['errors'],'real_database_writes':0})
    await context.close()
 (OUT/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
if __name__=='__main__':asyncio.run(main())
