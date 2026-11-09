"""Synthetic work order title, checkout transition and accordion browser checks."""
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from cmpri_fixture import *

async def run():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in (1440,390):
   for ticket_status in ('Open','Completed'):
    ctx=await browser.new_context(viewport={'width':width,'height':900},is_mobile=width<640,has_touch=width<640,timezone_id='UTC')
    await install(ctx,'chief_engineer')
    state={'checked_out':False}
    today=datetime.now(ZoneInfo('America/Chicago')).date()
    checkout_case='future' if width==390 and ticket_status=='Completed' else 'default' if ticket_status=='Completed' else 'imported'
    checkout_date=today+timedelta(days=1) if checkout_case=='future' else today
    current={**orders[0], 'status':ticket_status,'guest_name':'Alexandra Robinson','guest_group_badge':'railway-cn','loyalty_tier':'Titanium','incoming_reserved':True,'incoming_name':'Jordan Williams','incoming_loyalty_tier':'Gold','incoming_group_badge':'big-ten','room_status':'Occupied','checkout_date':checkout_date.isoformat(),'checkout_time':None if checkout_case=='default' else '14:30:00'}
    async def workorders(route):
     path=urlparse(route.request.url).path
     row=dict(current)
     if state['checked_out']:
      row.update(guest_name=None, guest_group_badge=None, loyalty_tier=None, room_status='Vacant Dirty')
     if path==f'/api/work-orders/{WID}/parts':return await route.fulfill(json={'items':[],'parts':[],'poLines':[]})
     if path==f'/api/work-orders/{WID}':return await route.fulfill(json={'workOrder':row,'mentionTickets':[]})
     if path=='/api/work-orders':return await route.fulfill(json={'work_orders':[row],'total':1,'counts':{'pending':0,'open':1,'progress':0,'priority':1,'overdue':0,'completed':1,'closed':0,'all':1}})
     return await route.fallback()
    await ctx.route('**/api/work-orders**',workorders)
    await ctx.route_web_socket(re.compile(r'^wss://[^/]*\.supabase\.co/'),lambda socket:socket.close())
    page=await ctx.new_page(); errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/engineering',timeout=60000)
    launch=page.get_by_role('button',name='Work Order List',exact=True)
    await launch.wait_for(timeout=60000)
    await launch.focus()
    await launch.press('Enter')
    listing=page.locator('[data-cmpri-desktop-window="work-order-list"]')
    await listing.locator('[data-preview-status]').first.click(timeout=30000)
    detail=page.locator(f'[data-cmpri-desktop-window="/work-orders/{WID}"]')
    await expect(detail).to_be_visible(timeout=30000)
    title=detail.locator('.cmpri-desktop-titlebar')
    guest=title.locator('.cmpri-title-guest')
    await expect(guest).to_contain_text('Alexandra Robinson',timeout=30000)
    await expect(guest.get_by_text('Occupied',exact=True)).to_be_visible()
    await expect(guest.locator('img[alt="CN"]')).to_be_visible()
    await expect(guest.get_by_text('Reserved',exact=True)).to_have_count(0)
    help=title.get_by_role('button',name='Marriott Bonvoy membership tier key')
    close=title.locator('[data-cmpri-window-close]')
    hb,cb=await help.bounding_box(),await close.bounding_box()
    assert hb and cb and 0<=cb['x']-(hb['x']+hb['width'])<16, (width,hb,cb)
    assert await guest.is_visible()
    namebox=await guest.locator('.cmpri-title-guest-name').bounding_box()
    assert namebox and namebox['x'] + namebox['width'] <= hb['x'] + 0.5, (width,namebox,hb)
    frame=detail.frame_locator('iframe')
    issue=frame.locator('[data-reported-issue]')
    await expect(issue).to_be_visible(timeout=60000)
    await expect(issue).not_to_have_attribute('open','',timeout=30000)
    await expect(frame.locator('[data-work-order-guest]')).to_have_count(0)
    locked=frame.locator('[data-preview-locked-pane]')
    await expect(locked).not_to_contain_text('Assigned to')
    await expect(locked).to_contain_text(f'C/O {checkout_date.strftime("%b")} {checkout_date.day}')
    if checkout_case=='imported': await expect(locked).to_contain_text('2:30 p.m.')
    elif checkout_case=='default': await expect(locked).to_contain_text('11:00 a.m.')
    else:
     await expect(locked).not_to_contain_text('11:00 a.m.')
     await expect(locked).not_to_contain_text('2:30 p.m.')
    await issue.locator('summary').click()
    await expect(issue).to_have_attribute('open','')
    await expect(issue.get_by_text('Technician',exact=True)).to_be_visible()
    pm=frame.locator('details').filter(has=frame.get_by_role('heading',name='Preventative Maintenance',exact=True))
    await expect(pm).not_to_have_attribute('open','')
    await pm.locator('summary').click()
    await expect(pm.get_by_text('PM checks and quarterly room forms',exact=True)).to_be_visible()
    pm_link=pm.get_by_role('link',name=re.compile('Open Prevent'))
    await expect(pm_link).to_have_attribute('href',f'/engineering/preventive-maintenance?workOrder={WID}')
    await page.screenshot(path=str(OUT / f'work-order-title-{width}-{ticket_status}.png'))
    state['checked_out']=True
    await page.evaluate('window.dispatchEvent(new CustomEvent("cmpri-data-cache-invalidated", {detail:{topics:["rooms"]}}))')
    await expect(guest).to_contain_text('Jordan Williams',timeout=15000)
    await expect(guest.get_by_text('Reserved',exact=True)).to_be_visible()
    await expect(guest).not_to_contain_text('Alexandra Robinson')
    assert not errors,errors
    results.append({'width':width,'status':ticket_status,'transition':'passed'})
    await ctx.close()
  await browser.close()
 print(json.dumps(results))
asyncio.run(run())
