"""Exercise the deployable work-order modal with synthetic local API responses."""
from cmpri_fixture import *
from datetime import datetime, timezone
import re

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390,320]:
   ctx=await browser.new_context(viewport={'width':width,'height':960},is_mobile=width<640,has_touch=width<640,timezone_id='America/Chicago')
   revisions={'orders':1}
   await install(ctx,'chief_engineer',revisions=revisions)
   today='2026-11-06'
   examples=[]
   counts={'pending':1,'open':3,'progress':1,'priority':2,'overdue':0,'completed':1,'closed':0,'all':6}
   for index,(room,status,priority,room_status,checkout,time,tier,badge,cn) in enumerate([
    ('204','Open','High','Occupied',today,None,'Titanium','railway-cn',True),
    ('218','In Progress','Medium','Vacant Dirty',today,'14:30:00','Platinum',None,False),
    ('307','Pending Verification','Normal','Vacant Ready','2026-11-07','10:00:00','Gold','big-ten',False),
    ('412','Completed','Normal','Out of Order',None,None,'Ambassador',None,False),
    ('Lobby','Open','High',None,None,None,None,None,False),
    ('106','Open','Normal','Occupied',today,'10:30 AM','Silver',None,True),
   ]):
    examples.append({**orders[0],'id':f'sample-{index}','display_id':str(4218+index),'room':room,'status':status,'priority':priority,'room_status':room_status,'checkout_date':checkout,'checkout_time':time,'loyalty_tier':tier,'guest_group_badge':badge,'cn_room':cn,'incoming_reserved':False,'issue':['Bathroom sink drains slowly','Inspect air conditioner noise','Replace desk lamp','Shower repair verified','Inspect lobby ceiling light','Adjust door closer'][index]})
   async def extra(route):
    path=urlparse(route.request.url).path
    if path=='/api/work-orders/sample-0':return await route.fulfill(json={'workOrder':examples[0],'mentionTickets':[]})
    if path!='/api/work-orders':return await route.fallback()
    q=parse_qs(urlparse(route.request.url).query);rows=examples[:]
    query=q.get('q',[''])[0].lower();f=q.get('filter',['all'])[0];sort=q.get('sort',['default'])[0]
    if query:rows=[x for x in rows if query in str(x).lower()]
    if f=='open':rows=[x for x in rows if x['status']=='Open']
    if sort=='tier-high':rows.sort(key=lambda x:['Ambassador','Titanium','Platinum','Gold','Silver','Base',None].index(x['loyalty_tier']))
    return await route.fulfill(json={'work_orders':rows,'total':len(rows),'counts':counts})
   await ctx.route('**/api/work-orders**',extra)
   # All network activity outside the local app is disabled, including Realtime.
   await ctx.route_web_socket(re.compile(r'^wss://[^/]*\.supabase\.co/'),lambda socket:socket.close())
   page=await ctx.new_page();errors=[];writes=[]
   page.on('pageerror',lambda e:(errors.append(str(e)),print('PAGE ERROR',e.stack,flush=True)))
   page.on('request',lambda request:writes.append(request.url) if request.method not in ['GET','HEAD'] and '/api/work-orders' in request.url else None)
   await page.clock.set_fixed_time(datetime(2026,11,6,14,0,tzinfo=timezone.utc))
   await page.goto(BASE+'/engineering',timeout=60000)
   await page.get_by_role('button',name='Work Order List',exact=True).wait_for(timeout=60000)
   await page.get_by_role('button',name='Work Order List',exact=True).focus()
   await page.get_by_role('button',name='Work Order List',exact=True).press('Enter')
   modal=page.locator('[data-cmpri-desktop-window="work-order-list"]')
   await expect(modal).to_be_visible(timeout=15000)
   await expect(modal.locator('.work-order-ticket-line')).to_have_count(6)

   async def check_layout(expected_columns=None):
    kpi=modal.locator('#work-order-kpi-filters')
    await expect(kpi).to_have_attribute('data-columns',re.compile('[48]'))
    dimensions=await kpi.evaluate('''e=>({columns:Number(e.dataset.columns),width:e.clientWidth,scroll:e.scrollWidth,font:getComputedStyle(e).getPropertyValue('--filter-font-size'),tracks:getComputedStyle(e).gridTemplateColumns,buttons:[...e.children].map(b=>{
     const label=b.children[0].getBoundingClientRect(),count=b.children[1].getBoundingClientRect();
     return {text:b.innerText,collision:label.right+3>count.left,wrapped:Math.abs(label.y-count.y)>3,overflow:b.scrollWidth>b.clientWidth+1,whiteSpace:getComputedStyle(b.children[0]).whiteSpace};
    })})''')
    assert dimensions['columns'] in [4,8],dimensions
    if expected_columns:assert dimensions['columns']==expected_columns,(width,dimensions)
    assert dimensions['scroll']<=dimensions['width']+1,dimensions
    for button in dimensions['buttons']:
     assert not button['collision'] and not button['wrapped'] and not button['overflow'],(width,button)
     assert button['whiteSpace']=='nowrap'
    for row in await modal.locator('[data-preview-status]').all():
     lines=row.locator('.work-order-ticket-line,.work-order-room-line')
     first,second=await lines.nth(0).bounding_box(),await lines.nth(1).bounding_box()
     assert first['y']+first['height']<=second['y']+1
     assert await row.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    return dimensions['columns']

   await check_layout(8 if width==1440 else 4)
   first=modal.locator('[data-preview-status]').first
   for index in [0,5]:
    cn=modal.locator('[data-preview-status]').nth(index).locator('img[alt="CN"]')
    await expect(cn).to_have_count(1);await expect(cn).to_be_visible()
   assert await first.locator('.work-order-ticket-line > span').all_text_contents()==['WO#4218','Open','High Priority']
   sizes=await first.evaluate('e=>({number:parseFloat(getComputedStyle(e.querySelector(".preview-wo-number")).fontSize),room:parseFloat(getComputedStyle(e.querySelector(".preview-room")).fontSize),badge:e.querySelector("img[alt=CN]").getBoundingClientRect().height})')
   assert sizes['number']<sizes['room'] and abs(sizes['badge']-sizes['room'])<1,sizes
   await expect(first.locator('[data-work-order-checkout]')).to_have_text('C/O Nov 6 · 11:00 a.m.')
   await expect(modal.locator('[data-work-order-checkout]').nth(1)).to_have_text('C/O Nov 6 · 2:30 p.m.')
   await expect(modal.locator('[data-work-order-checkout]').nth(2)).to_have_text('C/O Nov 7')
   colors=await first.evaluate('e=>[...e.querySelectorAll("[data-work-order-checkout],[data-preview-room-status]")].map(x=>getComputedStyle(x).backgroundColor)')
   assert colors[0]==colors[1],colors

   sort=modal.get_by_role('combobox',name='Sort work orders')
   sort_box,search_box=await sort.bounding_box(),await modal.get_by_role('searchbox').bounding_box()
   assert sort_box['x']<=search_box['x']+1 and (sort_box['x']<search_box['x'] or search_box['y']>=sort_box['y']+sort_box['height']-1)
   await sort.select_option('tier-high');await expect(modal.locator('.work-order-ticket-line').first).to_contain_text('WO#4221')
   assert await sort.evaluate('e=>getComputedStyle(e).borderWidth')=='0px'
   await sort.select_option('default');await expect(modal.locator('.work-order-ticket-line').first).to_contain_text('WO#4218')
   search=modal.get_by_role('searchbox')
   await search.fill('Lobby');await expect(modal.locator('.work-order-ticket-line')).to_have_count(1)
   await search.fill('');await expect(modal.locator('.work-order-ticket-line')).to_have_count(6)
   await modal.locator('[data-preview-kpi="open"]').click();await expect(modal.locator('.work-order-ticket-line')).to_have_count(3)
   await modal.locator('[data-preview-kpi="all"]').click();await expect(modal.locator('.work-order-ticket-line')).to_have_count(6)

   title=modal.locator('.cmpri-desktop-titlebar')
   help=title.get_by_role('button',name='Marriott Bonvoy membership tier key')
   close=title.get_by_role('button',name='Close Work Order List',exact=True)
   assert await modal.locator('.work-order-tier-key').count()==1
   await expect(help.locator('.tier-ambassador')).to_be_visible()
   badge=help.locator('.work-order-tier-question')
   assert await badge.evaluate('e=>getComputedStyle(e).backgroundColor')=='rgb(220, 38, 38)'
   markbox,qbox,closebox=await help.locator('.tier-m').bounding_box(),await badge.bounding_box(),await close.bounding_box()
   assert qbox['x']>=markbox['x']+markbox['width']/2 and qbox['y']<markbox['y']+markbox['height']/2
   assert qbox['x']+qbox['width']<closebox['x']
   before=await modal.bounding_box()
   if width<640:await help.tap()
   else:await help.click()
   key=modal.locator('.work-order-tier-popover');await expect(key).to_be_visible()
   assert await modal.bounding_box()==before,'Opening help must not drag the host window'
   assert await key.locator('li').all_text_contents()==['Titanium Elite','Platinum Elite','Gold Elite','Silver Elite','Member']
   menu=await key.evaluate('e=>({title:getComputedStyle(e.querySelector("h2")).fontSize,item:getComputedStyle(e.querySelector("li")).fontSize,foot:getComputedStyle(e.querySelector("p")).fontSize,background:getComputedStyle(e).backgroundColor,modal:getComputedStyle(e.closest(".cmpri-desktop-window").querySelector(".cmpri-desktop-window-body")).backgroundColor})')
   assert menu['title']=='11px' and menu['item']=='10px' and menu['foot']=='9px',menu
   assert menu['background']==menu['modal'],menu
   menu_box=await key.bounding_box()
   assert menu_box['x']>=before['x'] and menu_box['x']+menu_box['width']<=before['x']+before['width']
   await modal.screenshot(path=str(OUT/f'work-order-key-{width}.png'))
   await help.press('Escape');await expect(key).to_have_count(0);await expect(help).to_be_focused();await expect(modal).to_be_visible()
   await help.press('Enter');await expect(key).to_be_visible()
   await modal.locator('.cmpri-work-order-list > [role=status]').click();await expect(key).to_have_count(0)
   await modal.screenshot(path=str(OUT/f'work-order-list-{width}.png'))

   if width==1440:
    resize_results=[]
    for target in [1000,950,850,750,640,500,390,320]:
     rect=await modal.bounding_box();edge=await modal.locator('.cmpri-desktop-resize-e').bounding_box()
     x,y=edge['x']+edge['width']/2,edge['y']+edge['height']/2
     await page.mouse.move(x,y);await page.mouse.down()
     await page.mouse.move(x+target-rect['width'],y,steps=8);await page.mouse.up()
     await page.wait_for_timeout(80)
     resize_results.append({'width':target,'columns':await check_layout()})
    assert any(x['columns']==8 for x in resize_results) and any(x['columns']==4 for x in resize_results),resize_results
    await modal.screenshot(path=str(OUT/'work-order-list-narrow-desktop.png'))
    results.append({'desktopResize':resize_results})

   # Six-digit counts must recalculate intrinsic track widths after a data refresh.
   counts.update({key:123456 for key in counts})
   revisions['orders']+=1
   await page.evaluate('window.dispatchEvent(new Event("online"))')
   await search.fill('Lobby');await expect(modal.locator('.work-order-ticket-line')).to_have_count(1)
   await search.fill('');await expect(modal.locator('.work-order-ticket-line')).to_have_count(6)
   await expect(modal.locator('[data-preview-kpi=open] .work-order-filter-count')).to_have_text('123456')
   await check_layout(4 if width<640 else None)
   await modal.locator('[data-preview-status]').first.click()
   detail=page.locator('[data-cmpri-desktop-window="/work-orders/sample-0"]')
   await expect(detail).to_be_visible()
   await detail.get_by_role('button',name='Close Work Order',exact=False).first.click()
   await expect(modal).to_be_visible()
   assert not writes,writes
   assert not errors,errors
   results.append({'width':width,'passed':True,'largeCounts':True,'keyboardAndTouch':True,'selection':True})
   await ctx.close()
  for role,role_width in [('front_desk',390),('technician',1440)]:
   context=await browser.new_context(viewport={'width':role_width,'height':960},is_mobile=role_width<640,has_touch=role_width<640)
   await install(context,role)
   await context.route_web_socket(re.compile(r'^wss://[^/]*\.supabase\.co/'),lambda socket:socket.close())
   page=await context.new_page()
   await page.goto(BASE+('/front-desk' if role=='front_desk' else '/engineering'))
   launch=page.get_by_role('button',name='Work Order List',exact=True)
   await launch.wait_for(timeout=60000);await launch.focus();await launch.press('Enter')
   dialog=page.locator('[data-cmpri-desktop-window="work-order-list"]')
   await expect(dialog).to_be_visible()
   await expect(dialog.locator('[data-preview-status]')).to_have_count(1)
   help=dialog.get_by_role('button',name='Marriott Bonvoy membership tier key')
   if role_width<640:await help.tap()
   else:await help.click()
   await expect(dialog.locator('.work-order-tier-popover')).to_be_visible()
   await help.press('Escape');await expect(help).to_be_focused()
   results.append({'role':role,'width':role_width,'passed':True})
   await context.close()
  await browser.close()
 OUT.joinpath('work-order-list-layout.json').write_text(json.dumps(results,indent=2))
 print(json.dumps({'passed':True,'checks':results,'productionDataAccessed':False}))

asyncio.run(main())
