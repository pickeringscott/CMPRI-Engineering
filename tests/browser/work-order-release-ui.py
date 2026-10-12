# Isolated local UI regression: Python Playwright + Chromium and a running Next dev server.
# APIs are synthetic fixtures; server authorization is tested in work-order-draft-access.test.mjs.
import asyncio,json,time,os
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.async_api import async_playwright,expect
BASE=os.environ.get('CMPRI_TEST_BASE_URL','http://127.0.0.1:3116').rstrip('/')
assert urlparse(BASE).hostname=='127.0.0.1', 'Use an isolated local Next server only'
OUT=Path(os.environ.get('CMPRI_TEST_OUTPUT','/tmp/cmpri-release-ui'))
OUT.mkdir(parents=True,exist_ok=True)
ROLES=['engineer','chief_engineer','system_admin','manager','assistant_manager','front_desk_manager','technician','housekeeping','front_desk']
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  for role in ROLES:
   for width in [384,1360]:
    ctx=await browser.new_context(viewport={'width':width,'height':915},is_mobile=width<640,has_touch=width<640)
    sess={'access_token':'fixture-token','refresh_token':'fixture-refresh','expires_at':int(time.time())+7200,'expires_in':7200,'token_type':'bearer','user':{'id':'fixture-user','email':'fixture@example.invalid'}}
    await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(sess))+');window.__guideUrls=[];window.open=(u)=>{window.__guideUrls.push(u);return null;};')
    own={'id':'own','created_by':'fixture-user','issue':'Own draft','location_id':'room-219','room':'Room 219','revision':1,'can_edit':True,'can_delete':True}
    other={'id':'other','created_by':'other-user','issue':'Other account draft','location_id':'room-219','room':'Room 219','revision':1,'can_edit':True,'can_delete':True}
    requests=[]
    async def route(r):
     u=urlparse(r.request.url);q=parse_qs(u.query)
     if u.hostname!='127.0.0.1':return await r.abort()
     if not u.path.startswith('/api/'):return await r.continue_()
     body={};requests.append((u.path,q))
     if u.path=='/api/session':body={'user':{'id':'fixture-user','name':'Fixture','email':'fixture@example.invalid','role':role},'landing':'/engineering','capabilities':['submit','view_dashboard','view_work_orders','add_work_order_notes']+(['review_tickets','edit_tickets'] if role in ['engineer','chief_engineer','system_admin'] else [])}
     elif u.path=='/api/profile':body={'preferences':{'appearance':'dark','language':'en'}}
     elif u.path=='/api/rooms':body={'locations':[{'id':'room-219','name':'Room 219','location_type':'Guest Room'}]}
     elif u.path=='/api/assets':body={'assets':[]}
     elif u.path=='/api/work-orders/drafts':body={'drafts':[own,other],**({'review_draft':other} if q.get('review_draft_id')==['other'] else {})} # Deliberately hostile mixed payload verifies form's defense in depth.
     elif u.path=='/api/work-orders':body={'work_orders':[{'id':'fixture-order','room':'Room 219','issue':'Fixture lamp issue','status':'Open','priority':'Medium'}]}
     await r.fulfill(content_type='application/json',body=json.dumps(body))
    await ctx.route('**/*',route);page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/work-orders?draftId=other')
    await page.get_by_text('Room 219 · Own draft',exact=True).wait_for(timeout=60000)
    assert not await page.get_by_text('Room 219 · Other account draft',exact=True).count()
    await expect(page.locator('textarea').first).to_have_value('')
    box=await page.locator('[data-work-order-form-layout]').bounding_box()
    if width>=1024:assert abs(box['width']/width-.66)<.005 and abs(box['x']/width-.17)<.005,box
    else:assert abs(box['width']-(width-8))<2,box
    assert any(path=='/api/work-orders/drafts' and q.get('scope')==['own'] for path,q in requests)
    if role=='chief_engineer':
     await page.goto(BASE+'/work-orders?draftId=other&reviewDraft=1')
     await expect(page.locator('textarea').first).to_have_value('Other account draft')
     assert await page.get_by_text('Room 219 · Other account draft',exact=True).count()==0
     await expect(page.get_by_role('button',name='Approve & Submit Draft')).to_be_visible()
    await page.screenshot(path=str(OUT/f'release-form-{role}-{width}.png'),full_page=True)
    await page.goto(BASE+'/engineering')
    await page.locator('[data-dashboard-title]').wait_for()
    guides=page.get_by_role('combobox',name='Front Desk Quick Guides')
    if await guides.count() and await guides.is_visible():
     assert await guides.locator('option').count()==4
     for slug in ['enseo','dormakaba','guest-room']:await guides.select_option(slug)
     assert await page.evaluate('window.__guideUrls')==['/guides/enseo.pdf','/guides/dormakaba.pdf','/guides/guest-room.pdf']
    if role=='chief_engineer' and width<640:assert not await guides.is_visible()
    if role=='chief_engineer' and width<640:await page.locator('[data-chief-mobile-menus]').get_by_role('button',name='Work Orders',exact=False).click()
    launch=page.get_by_role('menuitem' if role=='chief_engineer' and width<640 else 'button',name='Work Order List',exact=True)
    if await launch.count():
     await launch.click();await page.locator('[data-work-order-list-heading]').wait_for()
     kpi=page.locator('#work-order-kpi-filters');await expect(kpi.get_by_role('button')).to_have_count(8)
     for button in await kpi.get_by_role('button').all():
      sizes=await button.evaluate('e=>({base:parseFloat(getComputedStyle(e).fontSize),label:parseFloat(getComputedStyle(e.children[0]).fontSize),count:parseFloat(getComputedStyle(e.children[1]).fontSize),width:e.clientWidth,scroll:e.scrollWidth})')
      assert abs(sizes['label']-(sizes['base']*.78+5))<.1,sizes
      assert abs(sizes['count']-(sizes['base']*.9+5))<.1,sizes
      assert sizes['scroll']<=sizes['width']+1,sizes
     await page.screenshot(path=str(OUT/f'release-kpis-{role}-{width}.png'),full_page=True)
    assert await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    assert not errors,errors
    results.append({'role':role,'width':width,'passed':True,'form_width':box['width'],'own_drafts_only':True})
    await ctx.close()
  await browser.close()
 OUT.joinpath('release-ui-browser-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
asyncio.run(main())
