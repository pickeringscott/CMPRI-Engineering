# API/RLS authorization has separate tests. This verifies discoverable list/detail UI.
import asyncio,json,time,importlib.util,os,sys
sys.dont_write_bytecode=True
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('ticket-detail-layout.py'))
layout=importlib.util.module_from_spec(spec);spec.loader.exec_module(layout)
BASE=layout.BASE;OUT=Path('/tmp/cmpri-ticket-read-ui');OUT.mkdir(exist_ok=True)
ID='00000000-0000-4000-8000-000000000042'
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for role,caps in layout.POLICY.items():
   for width in [384,1360]:
    ctx=await browser.new_context(viewport={'width':width,'height':915},is_mobile=width<640,has_touch=width<640)
    session={'access_token':'fixture-token','refresh_token':'fixture-refresh','expires_at':int(time.time())+7200,'expires_in':7200,'token_type':'bearer','user':{'id':'fixture-user','email':'fixture@example.invalid'}}
    await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(session))+');')
    row={'id':ID,'display_id':'WO-OWN-CLOSED','room':'Room 219','issue':'Own closed ticket','status':'Closed','created_by':'fixture-user','technician_name':'Other Technician','notes':'Engineering verified the repair.','created_at':'2026-10-12T12:00:00Z'}
    writes=[]
    async def route(r):
     u=urlparse(r.request.url)
     if u.hostname!='127.0.0.1':return await r.abort()
     if not u.path.startswith('/api/'):return await r.continue_()
     if r.request.method not in ['GET','HEAD']:writes.append(u.path)
     body={}
     if u.path=='/api/session':body={'user':{'id':'fixture-user','name':'Fixture User','email':'fixture@example.invalid','role':role},'landing':'/engineering','capabilities':caps}
     elif u.path=='/api/profile':body={'preferences':{'language':'en','appearance':'dark'}}
     elif u.path=='/api/work-orders':body={'work_orders':[row,{**row,'id':'00000000-0000-4000-8000-000000000043','display_id':'WO-OTHER-OPEN','issue':'Other creator active ticket','created_by':'other-user','status':'Open'}]}
     elif u.path==f'/api/work-orders/{ID}':body={'workOrder':row,'mentionTickets':[]}
     elif u.path=='/api/work-orders/drafts':body={'drafts':[]}
     elif u.path=='/api/maintenance-reference':body={'assets':[],'technicians':[]}
     elif u.path=='/api/room-operations':body={'rows':[]}
     elif u.path=='/api/room-ranker':body={'rooms':[]}
     elif u.path.endswith('/attachments'):body={'images':[]}
     await r.fulfill(content_type='application/json',body=json.dumps(body))
    await ctx.route('**/*',route);page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/engineering');await page.locator('[data-dashboard-title]').wait_for(timeout=60000)
    if role=='chief_engineer' and width<640:
     await page.locator('[data-chief-mobile-menus]').get_by_role('button',name='Work Orders',exact=False).click()
     await page.get_by_role('menuitem',name='Work Order List',exact=True).click()
    else:await page.get_by_role('button',name='Work Order List',exact=True).click()
    await page.locator('[data-work-order-list-heading]').wait_for()
    await expect(page.get_by_role('button',name='Open work order for Room 219: Other creator active ticket',exact=True)).to_be_visible()
    await page.get_by_role('button',name='Open work order for Room 219: Own closed ticket',exact=True).click()
    frame=page.frame_locator('iframe[src*="/work-orders/"]')
    await frame.get_by_role('heading',name='Reported Issue',exact=True).wait_for(timeout=60000)
    await expect(frame.get_by_text('Engineering verified the repair.',exact=True)).to_be_visible()
    if role not in ['engineer','chief_engineer','system_admin']:
     await expect(frame.locator('#technician-note-editor')).to_be_disabled()
     await expect(frame.get_by_role('button',name='Upload photo',exact=True)).to_have_count(0)
     await expect(frame.get_by_role('button',name='Save Notes',exact=True)).to_have_count(0)
    assert not writes,writes
    assert not errors,errors
    await page.screenshot(path=str(OUT/f'{role}-{width}.png'))
    results.append({'role':role,'width':width,'passed':True})
    await ctx.close()
  await browser.close()
 OUT.joinpath('results.json').write_text(json.dumps(results,indent=2));print(f'Passed {len(results)} list/detail cases')
if __name__=='__main__':asyncio.run(main())
