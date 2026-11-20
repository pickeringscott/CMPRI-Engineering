"""Fixture-only persistent-browser restart checks for profile and selected Files."""
import asyncio, base64, hashlib, json, os, re, tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright, expect
from cmpri_fixture import install, UID, HOTEL, WID, CAPS, orders, BASE, OUT

PROFILE_KEY=f'cmpri:profile-draft:v1:{HOTEL}:{UID}'
SCHEDULE_KEY=PROFILE_KEY+':schedule'
OTHER='00000000-0000-4000-8000-000000000099'
BYTES=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNVsAAAAASUVORK5CYII=')
NAME='retained-fixture.png'
PREFERENCES={'language':'en','appearance':'dark','notification_mode':'in_app','notifications':{'new_work_orders':True,'status_changes':True,'mentions':True}}
DAYS=['monday','tuesday','wednesday','thursday','friday','saturday','sunday']

async def retained(page, editor='create', user=UID, hotel=HOTEL):
 return await page.evaluate('''async key => {
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('cmpri-work-order-attachments-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
   if(!db.objectStoreNames.contains('drafts')){db.close();return null}
   const row=await new Promise((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').get(JSON.stringify(key));r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});db.close();
   if(!row)return null;
   return {identity:row.draftIdentity,uploads:row.uploads,files:await Promise.all(row.files.map(async item=>({name:item.name,type:item.type,lastModified:item.lastModified,id:item.uploadId,bytes:Array.from(new Uint8Array(await item.blob.arrayBuffer()))})))};
 }''', [hotel,user,editor])

async def wait_retained(page, editor='create'):
 for _ in range(80):
  value=await retained(page,editor)
  if value and value['files']:return value
  await page.wait_for_timeout(100)
 raise AssertionError('Attachment bytes were not committed to IndexedDB')

async def run():
 report=[]
 async with async_playwright() as p:
  for width,height in [(1440,1000),(390,844)]:
   directory=tempfile.mkdtemp(prefix=f'cmpri-profile-files-{width}-')
   state={'name':'Alex Morgan','prefs':dict(PREFERENCES),'schedule':{'timezone':'America/Chicago','schedule':{day:{'enabled':False,'start':'09:00','end':'17:00'} for day in DAYS}},'writes':[],'revision':1,'uploadFailure':False}
   async def launch(path,user=UID,hotel=HOTEL,fail_storage=False):
    context=await p.chromium.launch_persistent_context(directory,executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'],viewport={'width':width,'height':height},service_workers='block')
    await install(context,'chief_engineer',user_id=user,hotel_id=hotel)
    if fail_storage:
     await context.add_init_script("Storage.prototype.setItem=new Proxy(Storage.prototype.setItem,{apply(fn,self,args){if(String(args[0]).startsWith('cmpri:profile-draft:'))throw new DOMException('fixture quota','QuotaExceededError');return Reflect.apply(fn,self,args)}});IDBFactory.prototype.open=function(){throw new DOMException('fixture disabled','SecurityError')}")
    async def api(route):
     request=route.request;url=urlparse(request.url)
     if url.hostname not in ['localhost','127.0.0.1']:return await route.abort()
     if url.path=='/api/profile':
      if request.method=='PATCH':
       body=request.post_data_json;state['writes'].append({'path':url.path,'body':body});state['name']=body['full_name'];state['prefs']=body['preferences']
      return await route.fulfill(json={'profile':{'id':user,'full_name':state['name'],'email':'fixture@example.invalid','role':'chief_engineer'},'preferences':state['prefs'],'profile_settings_available':True,'can_manage_users':True,'chatgpt_connection':None})
     if url.path=='/api/profile/phone-notifications':
      if request.method=='POST':
       body=request.post_data_json;state['writes'].append({'path':url.path,'body':body});state['schedule']={k:body[k] for k in ['timezone','schedule']}
      return await route.fulfill(json={'configured':True,'public_key':'','subscribed_on_this_device':False,'settings':state['schedule']})
     if url.path=='/api/work-orders/'+WID:return await route.fulfill(json={'workOrder':{**orders[0],'revision':state['revision']}})
     if url.path=='/api/work-orders' and request.method=='POST':
      state['writes'].append({'path':url.path,'body':request.post_data_json});return await route.fulfill(json={'ok':True,'work_orders':[{'id':WID,'display_id':'4218','status':'Open'}]})
     if url.path.endswith('/attachments') and request.method=='PUT':
      body=request.post_data_json;state['writes'].append({'path':url.path,'body':body})
      if state['uploadFailure']:return await route.fulfill(status=503,json={'error':'Fixture offline upload'})
      return await route.fulfill(json={'ok':True,'complete':True})
     if url.path.startswith('/api/') and request.method not in ['GET','HEAD'] and not (url.path=='/api/work-orders/drafts' and request.method=='PUT'):
      raise AssertionError('Unexpected local fixture write '+url.path)
     return await route.fallback()
    await context.route('**/*',api)
    await context.route_web_socket(re.compile(r'^wss?://(?!(?:localhost|127\.0\.0\.1)(?::\d+)?(?:/|$))'),lambda socket:socket.close())
    page=context.pages[0] if context.pages else await context.new_page()
    await page.goto(BASE+path,wait_until='domcontentloaded',timeout=90000)
    return context,page

   # Profile and schedule keep unfinished changes through browser process exits.
   context,page=await launch('/profile')
   await page.get_by_label('Display name',exact=True).fill('Unsaved local name')
   await page.get_by_label('Appearance',exact=True).select_option('light')
   await page.get_by_label('Time zone',exact=True).fill('America/New_York')
   await page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)||"null")?.fields.name==="Unsaved local name"',arg=PROFILE_KEY)
   await page.wait_for_function('(key)=>JSON.parse(localStorage.getItem(key)||"null")?.fields.timezone==="America/New_York"',arg=SCHEDULE_KEY)
   await context.close()
   context,page=await launch('/profile')
   await expect(page.get_by_label('Display name',exact=True)).to_have_value('Unsaved local name',timeout=60000)
   await expect(page.get_by_label('Appearance',exact=True)).to_have_value('light')
   await expect(page.get_by_label('Time zone',exact=True)).to_have_value('America/New_York')
   assert not state['writes'],'Restart must never submit changes'
   await context.close()
   state['name']='Newer server name'
   context,page=await launch('/profile')
   await expect(page.get_by_text('Recovered Profile Needs Review',exact=True)).to_be_visible(timeout=60000)
   await expect(page.get_by_label('Display name',exact=True)).to_have_value('Newer server name')
   await page.get_by_role('button',name='Use Recovered Changes',exact=True).click()
   await page.get_by_role('button',name='Save Profile',exact=True).click()
   await page.wait_for_function('(key)=>localStorage.getItem(key)===null',arg=PROFILE_KEY)
   assert state['writes'][-1]['body']['baseline']['name']=='Newer server name'
   await page.get_by_role('button',name='Save Schedule',exact=True).click()
   await page.wait_for_function('(key)=>localStorage.getItem(key)===null',arg=SCHEDULE_KEY)
   await context.close()

   # Create selected actual Files; restart restores names, bytes, and upload IDs.
   context,page=await launch('/work-orders')
   await expect(page.get_by_role('button',name='Create Work Order',exact=True)).to_be_enabled(timeout=60000)
   await page.get_by_placeholder('Example: 316 not cooling').fill('Unsaved file fixture')
   await page.locator('input[type=file][multiple]').set_input_files({'name':NAME,'mimeType':'image/png','buffer':BYTES})
   saved=await wait_retained(page)
   assert saved['files'][0]['bytes']==list(BYTES)
   await context.close()
   context,page=await launch('/work-orders')
   await expect(page.get_by_title(NAME,exact=True)).to_be_visible(timeout=60000)
   reopened=await wait_retained(page)
   assert reopened==saved,(reopened,saved)
   blob_bytes=await page.locator('[aria-label="Selected photo previews"] img').evaluate('async img=>Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer()))')
   assert blob_bytes==list(BYTES)
   # Signout hides selected files but keeps owner-scoped recovery.
   await page.evaluate("window.dispatchEvent(new Event('cmpri-workspace-sign-out'))")
   await expect(page.get_by_title(NAME,exact=True)).to_have_count(0)
   assert (await retained(page))['files']==saved['files']
   await context.close()
   context,page=await launch('/work-orders',user=OTHER)
   await expect(page.get_by_role('button',name='Create Work Order',exact=True)).to_be_enabled(timeout=60000)
   await expect(page.get_by_title(NAME,exact=True)).to_have_count(0)
   assert (await retained(page))['files']==saved['files']
   await context.close()
   context,page=await launch('/work-orders')
   await expect(page.get_by_title(NAME,exact=True)).to_be_visible(timeout=60000)
   await page.get_by_role('button',name='Remove selected photo: '+NAME,exact=True).click()
   for _ in range(60):
    if await retained(page) is None:break
    await page.wait_for_timeout(100)
   assert await retained(page) is None
   await context.close()

   # Detail selections retain original retry ID; changed revision requires review.
   context,page=await launch('/work-orders/'+WID)
   await expect(page.locator('input[type=file][multiple]')).to_be_enabled(timeout=60000)
   await page.locator('input[type=file][multiple]').set_input_files({'name':NAME,'mimeType':'image/png','buffer':BYTES})
   detail=await wait_retained(page,WID);await context.close()
   state['revision']=2
   context,page=await launch('/work-orders/'+WID)
   await expect(page.get_by_text('This ticket changed since',exact=False)).to_be_visible(timeout=60000)
   await page.get_by_role('button',name='Use Recovered Attachments',exact=True).click()
   await expect(page.get_by_alt_text(NAME,exact=True)).to_be_visible()
   await page.get_by_role('button',name='Submit Note',exact=True).click()
   for _ in range(60):
    if await retained(page,WID) is None:break
    await page.wait_for_timeout(100)
   assert await retained(page,WID) is None
   uploads=[r['body'] for r in state['writes'] if r['path'].endswith('/attachments')]
   assert uploads[-1]['uploadId']==detail['files'][0]['id']
   assert uploads[-1]['sha256']==hashlib.sha256(BYTES).hexdigest()
   await context.close()
   # Failed browser storage is visible while unfinished values remain editable.
   context,page=await launch('/profile',fail_storage=True)
   await page.get_by_label('Display name',exact=True).fill('Keep open on quota failure')
   await expect(page.get_by_text('This device could not preserve profile changes.',exact=False)).to_be_visible(timeout=60000)
   await context.close()
   report.append({'width':width,'profileRestartAndCASReview':True,'scheduleRestartAndAckCleanup':True,'createFileRestartBytesScopeAndRemoval':True,'detailRevisionReviewIdempotentAckCleanup':True,'storageFailureVisible':True})
 OUT.mkdir(parents=True,exist_ok=True)
 (OUT/'profile-attachment-recovery.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report),flush=True)

if __name__=='__main__':asyncio.run(run())
