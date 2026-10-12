# Local fixture UI tests. No external requests or production writes.
import asyncio,json,time,importlib.util,sys,base64,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('ticket-detail-layout.py'))
layout=importlib.util.module_from_spec(spec);spec.loader.exec_module(layout)
OUT=Path(os.environ.get('CMPRI_TEST_OUTPUT','/tmp/cmpri-collaboration'));OUT.mkdir(parents=True,exist_ok=True)
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==')
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for role,caps in layout.POLICY.items():
   for width in [384,1360]:
    ctx=await browser.new_context(viewport={'width':width,'height':915},is_mobile=width<640,has_touch=width<640)
    session={'access_token':'fixture','refresh_token':'fixture','expires_at':int(time.time())+7200,'user':{'id':'fixture-user','email':'fixture@example.invalid'}}
    await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(session))+');')
    row={'id':layout.ID,'revision':7,'display_id':'WO-FIXTURE','room':'Room 219','issue':'Original issue','status':'In Progress','priority':'Medium','technician_name':'Other Technician','created_by':'other-user','notes':'Original immutable finding'}
    posts=[];failed=[False]
    async def route(r):
     u=urlparse(r.request.url);method=r.request.method
     if u.hostname!='127.0.0.1':return await r.abort()
     if not u.path.startswith('/api/'):return await r.continue_()
     body={};status=200
     if u.path=='/api/session':body={'user':{'id':'fixture-user','name':'Actual Author','role':role},'landing':'/engineering','capabilities':caps}
     elif u.path=='/api/profile':body={'preferences':{'language':'en','appearance':'dark'}}
     elif u.path.endswith('/notes') and method=='POST':
      payload=r.request.post_data_json;posts.append((u.path,payload))
      assert payload=={'notes':['Correct finding'],'expected_revision':7},payload
      if not failed[0]:failed[0]=True;body={'error':'Fixture save failure'};status=503
      else:body={'workOrder':{**row,'revision':8,'notes':row['notes']+f'\nCMPRI2|2026-10-12T12:00:00Z|Actual Author|{role}|note|Correct finding'}}
     elif u.path.endswith('/attachments'):
      body={'images':[]} if method=='GET' else {'ok':True}
      if method=='POST':posts.append((u.path,'photo'))
     elif u.path==f'/api/work-orders/{layout.ID}':body={'workOrder':row}
     elif u.path=='/api/maintenance-reference':body={'assets':[],'technicians':[]}
     elif u.path=='/api/room-operations':body={'rows':[]}
     elif u.path=='/api/room-ranker':body={'rooms':[]}
     if method not in ['GET','HEAD'] and not (u.path.endswith('/notes') or u.path.endswith('/attachments')):raise AssertionError((method,u.path))
     await r.fulfill(status=status,content_type='application/json',body=json.dumps(body))
    await ctx.route('**/*',route);page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(f'{layout.BASE}/work-orders/{layout.ID}?embedded=1');await page.get_by_role('heading',name='Reported Issue',exact=True).wait_for(timeout=60000)
    await expect(page.locator('#technician-note-editor')).to_be_enabled()
    async with page.expect_response(lambda response: response.url.endswith('/attachments') and response.request.method=='POST'):
     await page.locator('#work-order-detail-photo').set_input_files({'name':'photo.png','mimeType':'image/png','buffer':PNG})
    await expect(page.get_by_role('button',name='Upload photo',exact=True)).to_be_enabled()
    assert any(value=='photo' for _,value in posts),posts
    if role not in ['engineer','chief_engineer','system_admin']:
     await page.locator('#technician-note-editor').fill('Correct finding');await page.get_by_role('button',name='Submit Note',exact=True).click()
     await page.get_by_role('button',name='Save Notes',exact=True).click()
     await expect(page.get_by_text('Save error: Fixture save failure',exact=True)).to_be_visible()
     await expect(page.get_by_text('Original immutable finding',exact=True)).to_be_visible()
     await page.get_by_role('button',name='Save Notes',exact=True).click()
     await page.wait_for_timeout(100)
     assert len([x for x in posts if x[0].endswith('/notes')])==2,posts
    assert not errors,errors
    await page.screenshot(path=str(OUT/f'{role}-{width}.png'));results.append({'role':role,'width':width,'passed':True});await ctx.close()
  await browser.close()
 OUT.joinpath('results.json').write_text(json.dumps(results,indent=2));print(f'Passed {len(results)} collaboration cases')
asyncio.run(main())
