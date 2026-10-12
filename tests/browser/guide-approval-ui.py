# Requires Python Playwright, local Chromium and an isolated Next dev server.
# API calls are intercepted; any API mutation or external request is blocked.
import asyncio,json,time,re,os
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
BASE=os.environ.get('CMPRI_TEST_BASE_URL','http://127.0.0.1:3116').rstrip('/')
assert urlparse(BASE).hostname=='127.0.0.1', 'Use an isolated local Next server only'
OUT=Path(os.environ.get('CMPRI_TEST_OUTPUT','/tmp/cmpri-guide-approval-ui'))
OUT.mkdir(parents=True,exist_ok=True)
CASES=[('manager',False,True),('assistant_manager',False,True),('front_desk_manager',False,True),('engineer',True,False),('technician',False,False),('system_admin',True,False)]
async def main():
 results=[]
 async with async_playwright() as p:
  b=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for role,review,guidesAllowed in CASES:
   for width in [384,1360]:
    for pending in ([0,1] if review else [0]):
     ctx=await b.new_context(viewport={'width':width,'height':915},is_mobile=width<640,has_touch=width<640)
     sess={'access_token':'synthetic-token','refresh_token':'synthetic-refresh','expires_at':int(time.time())+7200,'token_type':'bearer','user':{'id':'fixture','email':'fixture@example.invalid'}}
     await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(sess))+');window.__opened=[];window.open=u=>window.__opened.push(u);')
     async def route(r):
      u=urlparse(r.request.url)
      if u.hostname!='127.0.0.1':return await r.abort()
      if not u.path.startswith('/api/'):return await r.continue_()
      assert r.request.method=='GET','Unexpected API mutation'
      body={}
      if u.path=='/api/session':body={'user':{'id':'fixture','name':'Fixture Name','email':'maint.cmpri@hawkeyehotels.com' if role=='system_admin' else 'fixture@example.invalid','role':role,'secondary_roles':['engineer'] if role=='system_admin' else []},'landing':'/engineering','capabilities':['submit','view_dashboard','view_work_orders','add_work_order_notes']+(['review_tickets','edit_tickets'] if review else [])}
      elif u.path=='/api/profile':body={'preferences':{'appearance':'dark','language':'en'}}
      elif u.path=='/api/work-orders':body={'work_orders':[{'id':'fixture-order','room':'Room 219','issue':'Synthetic pending issue','status':'Pending Verification' if pending else 'Open','priority':'Medium'}]}
      elif u.path=='/api/work-orders/drafts':body={'drafts':[]}
      elif u.path=='/api/dashboard/notifications':body={'notifications':[],'orders_version':'fixture-v1','checked_at':'2026-10-12T05:00:00Z'}
      await r.fulfill(content_type='application/json',body=json.dumps(body))
     await ctx.route('**/*',route);page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
     await page.goto(BASE+'/engineering');await page.locator('[data-dashboard-title]').wait_for(timeout=60000)
     guides=page.get_by_role('combobox',name='Front Desk Quick Guides')
     assert await guides.count()==int(guidesAllowed)
     if guidesAllowed:
      for i,slug in enumerate(['enseo','dormakaba','guest-room']):
       await guides.select_option(slug);dialog=page.get_by_role('dialog');await expect(dialog).to_be_visible()
       assert await dialog.locator('[data-guide-pdf]').get_attribute('data-guide-pdf')==f'/guides/{slug}.pdf'
       await dialog.locator('canvas').first.wait_for(timeout=30000)
       await expect(dialog.get_by_role('status')).to_have_count(0,timeout=30000)
       await expect(dialog.locator('canvas')).to_have_count({'enseo':2,'dormakaba':8,'guest-room':4}[slug])
       await expect(dialog.get_by_role('alert')).to_have_count(0)
       box=await dialog.bounding_box();assert box['width']<=width and box['x']>=0
       if i==0:await page.screenshot(path=str(OUT/f'ui-next-guide-{role}-{width}.png'))
       if i==0:await dialog.get_by_role('button',name='Back to guides').click()
       elif i==1:await dialog.get_by_role('button',name='Close guide').click()
       else:await page.keyboard.press('Escape')
       await expect(page.get_by_role('dialog')).to_have_count(0);await expect(guides).to_be_focused()
      assert await page.evaluate('window.__opened')==[]
     if review:
      await page.get_by_role('button',name=re.compile('Work order approvals for')).click()
      panel=page.locator('[data-work-order-approvals]');await panel.wait_for()
      assert await panel.get_by_role('group',name='Signed-in account').count()==0
      assert await panel.get_by_role('button',name=re.compile('Sound')).count()==0
      label=panel.get_by_text('Awaiting approval',exact=True);count=label.locator('..').locator('span').last
      assert await count.inner_text()==str(pending)
      assert await label.evaluate('e=>getComputedStyle(e).fontSize')==await count.evaluate('e=>getComputedStyle(e).fontSize')
      assert await panel.get_by_role('list',name='Work orders awaiting approval').count()==pending
      if not pending:
       assert (await label.locator('..').locator('..').bounding_box())['height']<65
       if width<640:
        notification=await panel.get_by_text('Notifications',exact=False).first.bounding_box();heading=await label.bounding_box()
        assert notification['y']-heading['y']<65
      assert await page.locator('[data-dashboard-role]').is_visible()
      await page.screenshot(path=str(OUT/f'ui-next-approvals-{role}-{width}-{pending}.png'))
     assert not errors,errors
     results.append({'role':role,'width':width,'pending':pending,'guides':guidesAllowed,'passed':True});await ctx.close()
  await b.close()
 OUT.joinpath('ui-next-browser-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
asyncio.run(main())
