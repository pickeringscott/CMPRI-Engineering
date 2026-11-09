"""Mocked browser check of multiple mounted work orders and the window switcher."""
import asyncio, os
os.environ.setdefault('CMPRI_UI_BASE', 'http://localhost:3116')
from cmpri_fixture import *
async def main():
 second={**orders[0], 'id':'00000000-0000-4000-8000-000000000004','display_id':'4219','room':'205','issue':'Second fixture'}
 extras=[{**orders[0], 'id':f'00000000-0000-4000-8000-{number:012d}', 'display_id':str(4216+number), 'room':str(201+number), 'issue':f'Fixture number {number}'} for number in range(5,9)]
 orders.extend([second,*extras])
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [int(value) for value in os.environ.get('CMPRI_TEST_WIDTHS','390,1360').split(',')]:
   ctx=await browser.new_context(viewport={'width':width,'height':915},is_mobile=width<640,has_touch=width<640)
   await install(ctx,'chief_engineer')
   await ctx.route('**/api/work-orders/*/parts',lambda route:route.fulfill(json={'items':[],'parts':[],'poLines':[]}))
   await ctx.route('**/api/work-orders/'+second['id'],lambda route:route.fulfill(json={'workOrder':second}))
   for ticket in extras:
    async def ticket_route(route, request, ticket=ticket): await route.fulfill(json={'workOrder':ticket})
    await ctx.route('**/api/work-orders/'+ticket['id'],ticket_route)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering'); await page.locator('[data-dashboard-title]').wait_for(timeout=30000)
   bar=page.get_by_role('navigation',name='Work order windows')
   assert await bar.count() == 0
   list_menu=page.locator('[data-key="work-order-list"]:visible').first
   await list_menu.click()
   await page.locator('[data-cmpri-desktop-window="work-order-list"]').wait_for()
   lst=page.locator('[data-cmpri-desktop-window="work-order-list"]')
   await lst.get_by_text('Fixture drain needs repair',exact=False).first.click()
   first=page.locator('[data-cmpri-desktop-window="/work-orders/'+WID+'"]');await expect(first).to_be_visible()
   frm=first.locator('iframe').content_frame
   editor=frm.locator('#technician-note-editor');await editor.wait_for(timeout=30000);await editor.fill('Keep this unsaved note')
   await page.get_by_role('button',name='Pool Status:',exact=False).click()
   pool=page.locator('[data-cmpri-desktop-window="pool-status"]');await expect(pool).to_be_visible()
   await page.locator('[data-key="/staff-notes"]:visible').first.click()
   notes_window=page.locator('[data-cmpri-desktop-window="/staff-notes"]');await expect(notes_window).to_have_count(1)
   await page.locator('[data-key="/management/rooms"]:visible').first.click()
   locations_window=page.locator('[data-cmpri-desktop-window="/management/rooms"]');await expect(locations_window).to_have_count(1)
   await list_menu.click()
   await expect(pool).to_have_count(1)
   await lst.get_by_text('Second fixture',exact=False).first.click()
   other=page.locator('[data-cmpri-desktop-window="/work-orders/'+second['id']+'"]');await expect(other).to_be_visible()
   switch=bar.get_by_label('Switch open work order');await expect(switch.locator('option')).to_have_count(3)
   await switch.select_option('/work-orders/'+WID)
   await expect(editor).to_have_value('Keep this unsaved note')
   assert await first.get_attribute('data-active') == 'true'
   assert await other.count() == 1
   for ticket in extras[:3]:
    await list_menu.click()
    await lst.get_by_text(ticket['issue'],exact=False).first.click()
    await expect(page.locator('[data-cmpri-desktop-window="/work-orders/'+ticket['id']+'"]')).to_have_count(1)
   await expect(switch.locator('option')).to_have_count(6)
   await expect(notes_window).to_have_count(1)
   await expect(locations_window).to_have_count(1)
   await expect(lst).to_have_count(1)
   await list_menu.click()
   await lst.get_by_text(extras[3]['issue'],exact=False).first.click()
   await expect(page.get_by_role('alert').filter(has_text='up to five work orders')).to_be_visible()
   await expect(page.locator('[data-cmpri-desktop-window="/work-orders/'+extras[3]['id']+'"]')).to_have_count(0)
   # A ticket that is already open still raises at the cap and closing it frees a slot.
   await switch.select_option('/work-orders/'+second['id'])
   assert await other.get_attribute('data-active') == 'true'
   await other.locator('[data-cmpri-window-close]').click(no_wait_after=True)
   await expect(other).to_have_count(0)
   if await lst.get_attribute('data-active') != 'true': await list_menu.click()
   await lst.get_by_text(extras[3]['issue'],exact=False).first.click()
   await expect(page.locator('[data-cmpri-desktop-window="/work-orders/'+extras[3]['id']+'"]')).to_have_count(1)
   await switch.select_option('/work-orders/'+WID)
   await expect(editor).to_have_value('Keep this unsaved note')
   assert not errors, errors
   print('PASS',width,'five-ticket cap, sixth blocked, existing raised, slot reused, preserved note',flush=True)
   await ctx.close()
  await browser.close()
asyncio.run(main())
