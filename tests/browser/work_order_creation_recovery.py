"""Fixture-only full browser restarts; never contacts the property's database."""
import asyncio,json,os,tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
from cmpri_fixture import install,UID,HOTEL,BASE,OUT

KEY=f'cmpri:work-order-creation:v1:{HOTEL}:{UID}'
OTHER='00000000-0000-4000-8000-000000000099'
ISSUE='Sink leak needs a second inspection'
NOTES='First reading: 48 PSI\nCheck the supply valve next.'
DRAFT='00000000-0000-4000-8000-000000000088'
async def run():
 report=[]
 async with async_playwright() as p:
  for width,height in [(1440,1000),(390,844)]:
   profile=tempfile.mkdtemp(prefix=f'cmpri-create-recovery-{width}-')
   requests=[];server=[]
   async def drafts(route):
    if route.request.method=='GET':return await route.fulfill(json={'drafts':server})
    if route.request.method=='PUT':return await route.fulfill(json={'inactivity_receipt':'fixture-bound-receipt'})
    raise AssertionError('A restart must not write a server draft')
   async def launch(user=UID):
    context=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':width,'height':height},service_workers='block',args=['--no-sandbox'])
    await install(context,'chief_engineer',user_id=user)
    context.on('request',lambda request:requests.append((request.method,urlparse(request.url).path)))
    await context.route('**/api/work-orders/drafts*',drafts)
    page=context.pages[0] if context.pages else await context.new_page()
    await page.goto(BASE+'/work-orders',wait_until='domcontentloaded',timeout=90000)
    await expect(page.get_by_placeholder('Example: 316 not cooling')).to_be_visible(timeout=60000)
    return context,page
   context,page=await launch()
   await expect(page.get_by_role('button',name='Create Work Order',exact=True)).to_be_enabled(timeout=60000)
   await page.get_by_placeholder('Example: 316 not cooling').fill(ISSUE)
   await page.get_by_placeholder('Optional: findings, diagnostic codes, readings, tests, or work already performed').fill(NOTES)
   await page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)||"null")?.fields.notes.includes("48 PSI")',arg=KEY)
   snapshot=await page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
   assert snapshot['fields']['issue']==ISSUE and snapshot['fields']['notes']==NOTES
   await context.close()
   context,page=await launch()
   await expect(page.get_by_placeholder('Example: 316 not cooling')).to_have_value(ISSUE,timeout=60000)
   await expect(page.get_by_placeholder('Optional: findings, diagnostic codes, readings, tests, or work already performed')).to_have_value(NOTES)
   await expect(page.get_by_text("Recovered this account's in-progress work from this device.",exact=False)).to_be_visible()
   assert not any(method in ['POST','PATCH','DELETE'] and path.startswith('/api/work-orders') for method,path in requests),requests
   await page.screenshot(path=str(OUT/f'creation-restarted-{width}.png'),full_page=True)
   # Seed a confirmed server draft with newer unsaved local notes. The verified
   # server baseline must be unchanged before those local edits are restored.
   fields={**snapshot['fields'],'location_id':'loc-1','notes':'Server baseline'}
   server[:]=[{**fields,'id':DRAFT,'revision':4,'created_by':UID,'can_edit':True,'can_delete':True}]
   baseline=json.dumps([str(fields.get(k) or '').strip() for k in ['staff_first_name','location_id','issue','notes','asset_id','asset_name','category','priority']],separators=(',',':'))
   snapshot.update(active={'id':DRAFT,'revision':4},baseline=baseline,attachmentCount=1)
   snapshot['fields']['location_id']='loc-1'
   await page.evaluate('([key,value])=>localStorage.setItem(key,JSON.stringify(value))',[KEY,snapshot])
   # Closing normally would persist the form currently visible, so close first,
   # then seed via init script on the next context, once only.
   await context.close()
   context=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',headless=True,viewport={'width':width,'height':height},service_workers='block',args=['--no-sandbox'])
   await install(context,'chief_engineer')
   await context.add_init_script('if(!sessionStorage.getItem("fixture-seeded-active")){localStorage.setItem('+json.dumps(KEY)+','+json.dumps(json.dumps(snapshot))+');sessionStorage.setItem("fixture-seeded-active","1")}')
   context.on('request',lambda request:requests.append((request.method,urlparse(request.url).path)))
   await context.route('**/api/work-orders/drafts*',drafts)
   page=context.pages[0];await page.goto(BASE+'/work-orders',wait_until='domcontentloaded',timeout=90000)
   await expect(page.get_by_placeholder('Example: 316 not cooling')).to_have_value(ISSUE,timeout=60000)
   await expect(page.get_by_placeholder('Optional: findings, diagnostic codes, readings, tests, or work already performed')).to_have_value(NOTES)
   await expect(page.get_by_text('Selected photos must be added again',exact=False).first).to_be_visible()
   persisted=await page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',KEY)
   assert persisted['active']=={'id':DRAFT,'revision':4}
   assert persisted['baseline']==baseline
   assert persisted['attachmentCount']==0,'Only the reminder survives; file selections cannot be reconstructed'
   await context.close()
   # A later server revision does not silently replace/rebase the preserved text.
   server[0]['revision']=5
   context,page=await launch()
   await expect(page.get_by_text('Recovered Work Needs Review',exact=True)).to_be_visible(timeout=60000)
   await expect(page.get_by_placeholder('Example: 316 not cooling')).to_have_value('')
   await page.get_by_text('Recovered Text',exact=True).click()
   await expect(page.get_by_text(NOTES,exact=True)).to_be_visible()
   await page.screenshot(path=str(OUT/f'creation-conflict-{width}.png'),full_page=True)
   old=await page.evaluate('(key)=>localStorage.getItem(key)',KEY)
   await context.close()
   context,page=await launch(OTHER)
   await expect(page.get_by_role('button',name='Create Work Order',exact=True)).to_be_enabled(timeout=60000)
   await expect(page.get_by_placeholder('Example: 316 not cooling')).to_have_value('')
   assert await page.evaluate('(key)=>localStorage.getItem(key)',KEY)==old
   await context.close()
   assert not any(method in ['POST','PATCH','DELETE'] and path.startswith('/api/work-orders') for method,path in requests),requests
   report.append({'width':width,'partial_text_restart':True,'active_draft_and_revision':True,'changed_server_draft_requires_comparison':True,'different_owner_hidden':True,'no_server_draft_writes':True})
 (OUT/'creation-recovery-report.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report,indent=2))
asyncio.run(run())
