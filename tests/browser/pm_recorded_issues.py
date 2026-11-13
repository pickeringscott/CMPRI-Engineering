import asyncio,json,time,os
from pathlib import Path
from urllib.parse import urlparse,quote
from playwright.async_api import async_playwright,expect
# Authorized real-record exports only; keep the inputs and output screenshots outside git.
BASE=os.environ.get('CMPRI_PM_BROWSER_URL','http://127.0.0.1:3118');OUT=Path(os.environ['CMPRI_PM_BROWSER_OUTPUT']);OUT.mkdir(parents=True,exist_ok=True)
SESSION=json.loads(Path(os.environ['CMPRI_PM_SESSION_PATH']).read_text());DATA=json.loads(Path(os.environ['CMPRI_PM_BROWSER_REPLAY_PATH']).read_text())
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox']);results=[]
  for width in [390,1440]:
   context=await browser.new_context(viewport={'width':width,'height':1000},service_workers='block')
   auth={'access_token':'offline-read-only-replay','refresh_token':'offline-read-only-replay','expires_at':int(time.time())+3600,'expires_in':3600,'token_type':'bearer','user':{'id':SESSION['user']['id'],'email':SESSION['user']['email']}}
   await context.add_init_script('if(location.origin==='+json.dumps(BASE)+'){sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(auth))+');}')
   errors=[];external=[];mutations=[]
   async def route(r):
    u=urlparse(r.request.url)
    if u.hostname not in ['127.0.0.1','localhost']:external.append(u.hostname);return await r.abort()
    if not u.path.startswith('/api/'):return await r.continue_()
    async def reply(v):await r.fulfill(status=200,content_type='application/json',body=json.dumps(v))
    if r.request.method not in ['GET','HEAD','OPTIONS']:mutations.append(u.path);return await r.abort()
    if u.path=='/api/session':return await reply(SESSION)
    if u.path=='/api/winter-preparedness':return await reply(DATA['winter'])
    if u.path=='/api/preventive-maintenance':return await reply(DATA['pm'])
    if u.path=='/api/preventive-maintenance/recorded-issues':return await reply(DATA['issues'])
    if u.path=='/api/resource-revisions':return await reply({'userId':SESSION['user']['id'],'hotelId':SESSION['hotelId'],'versions':{}})
    if u.path=='/api/profile/header-layout':return await reply({'layout':{}})
    if u.path=='/api/profile':return await reply({'preferences':{'appearance':'dark','language':'en'}})
    return await reply({'notifications':[],'notes':[],'names':[],'mentions':[],'directory':[],'drafts':[],'assignments':[],'assets':[],'events':[],'versions':{}})
   await context.route('**/*',route);page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering/preventive-maintenance')
   await page.get_by_role('button',name='Maintenance History',exact=True).click(timeout=60000)
   trigger=page.get_by_role('button',name='Review issues from previous inspections',exact=True);await expect(trigger).to_be_enabled();await trigger.click()
   dialog=page.get_by_role('dialog',name='Previous inspection issues',exact=True)
   await expect(dialog).to_be_visible();await expect(dialog.get_by_text('Creating work orders is blocked in this preview.',exact=False)).to_be_visible()
   await expect(dialog.get_by_role('button').filter(has_text='recorded issues')).to_have_count(len(DATA['issues']['records']))
   links={x['import_external_id']:x for x in DATA['issues']['links']}
   def ident(s,i):return 'pm:'+quote(json.dumps([s['templateId'],s['period'],s['scope']],separators=(',',':')),safe="~()*!.'-")+':'+quote(i['key'],safe="~()*!.'-")
   linkedSource=next(s for s in DATA['issues']['records'] if any(x['import_external_id']==ident(s,i) for i in s['issues'] for x in links.values()))
   def recordButton(s):return dialog.get_by_role('button').filter(has_text=s['title']).filter(has_text=s['period']+' · '+s['scope']).first
   await recordButton(linkedSource).click();await expect(dialog.get_by_role('button').filter(has_text='Linked — open work order').first).to_be_visible()
   await dialog.get_by_role('button',name='Back to records',exact=True).click()
   source=next(s for s in DATA['issues']['records'] if not s['hold'] and any(not any(x['import_external_id']==ident(s,i) for x in links.values()) for i in s['issues']))
   await recordButton(source).click()
   check=dialog.locator('input[type=checkbox]:enabled').first
   await check.check();row=check.locator('xpath=../..');description=row.locator('textarea');await description.fill(await description.input_value() or await row.locator('strong').inner_text())
   location=row.locator('select');options=await location.locator('option').evaluate_all('(els)=>els.map(e=>e.value).filter(Boolean)');assert options;await location.select_option(options[0])
   await dialog.get_by_role('button',name='Review selected work orders',exact=True).click()
   await expect(dialog.get_by_role('button',name='Confirm selected work orders / retry unresolved',exact=True)).to_be_disabled()
   await dialog.screenshot(path=str(OUT/('pm-review-'+str(width)+'.png')))
   assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
   assert not await dialog.evaluate('(e)=>e.scrollWidth>e.clientWidth+1')
   await page.keyboard.press('Escape');await expect(dialog).to_have_count(0);await expect(trigger).to_be_focused()
   await trigger.click();await recordButton(linkedSource).click()
   expected=next(x['id'] for i in linkedSource['issues'] for x in links.values() if x['import_external_id']==ident(linkedSource,i))
   await dialog.get_by_role('button').filter(has_text='Linked — open work order').first.click()
   await page.wait_for_url(BASE+'/work-orders/'+expected);await expect(dialog).to_have_count(0)
   await page.goto(BASE+'/engineering/winter-preparedness')
   await expect(page.get_by_role('heading',name='Winter Preparedness Checklist',exact=True)).to_be_visible()
   await expect(page.get_by_role('checkbox')).to_have_count(32)
   await expect(page.locator('input[type=checkbox]:enabled')).to_have_count(0)
   await expect(page.locator('input[type=checkbox]:checked')).to_have_count(sum(1 for i in DATA['winter']['items'] if i['checked']))
   await expect(page.get_by_text('Checklist changes are blocked in this preview.',exact=False)).to_be_visible()
   assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth+1')
   await page.screenshot(path=str(OUT/('winter-'+str(width)+'.png')),full_page=True)
   assert not errors,errors;assert not external,external;assert not mutations,mutations
   results.append({'width':width,'actual_sources':len(DATA['issues']['records']),'existing_links':len(DATA['issues']['links']),'system_admin_review_control':True,'winter_source_tasks':32,'winter_actual_saved_items':len(DATA['winter']['items']),'preview_confirm_disabled':True,'focus_return':True,'existing_ticket_opens':True,'horizontal_overflow':False,'page_errors':0,'external_requests':0,'live_writes':0});await context.close()
  await browser.close();(OUT/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
asyncio.run(main())
