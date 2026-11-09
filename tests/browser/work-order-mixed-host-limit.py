"""Mixed desktop/global limit and focus regression with synthetic data."""
import asyncio, os
os.environ.setdefault('CMPRI_UI_BASE','http://localhost:3116')
from cmpri_fixture import *

async def main():
 fixtures=[{**orders[0], 'id':f'00000000-0000-4000-8000-{number:012d}', 'display_id':str(4200+number), 'room':str(200+number), 'issue':f'Mixed fixture {number}'} for number in range(3,9)]
 orders[:]=fixtures
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  ctx=await browser.new_context(viewport={'width':390,'height':950},is_mobile=True,has_touch=True)
  await install(ctx,'chief_engineer')
  for item in fixtures:
   async def detail(route,request,item=item):
    if urlparse(request.url).path != '/api/work-orders/'+item['id']: return await route.fallback()
    await route.fulfill(json={'workOrder':item,'mentionTickets':[]})
   await ctx.route('**/api/work-orders/'+item['id']+'*',detail)
  await ctx.route('**/api/work-orders/*/parts',lambda route:route.fulfill(json={'items':[],'parts':[],'poLines':[]}))
  async def staff_notes(route):
   if urlparse(route.request.url).path != '/api/staff-notes': return await route.fallback()
   await route.fulfill(json={'notes':[{'id':'note1','body':'WO#4203 and WO#4204', 'author_name':'Alex','created_at':'2026-11-06T12:00:00Z','parent_id':None}], 'parents':[],'mentions':[], 'tickets':{'4203':{'href':'/work-orders/'+fixtures[0]['id'],'preview':'First'},'4204':{'href':'/work-orders/'+fixtures[1]['id'],'preview':'Second'}}, 'next':None, 'management':True,'frontDesk':False,'hotelId':HOTEL,'userId':UID,'unread':0})
  await ctx.route('**/api/staff-notes*',staff_notes)
  page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(e.stack or str(e)))
  await page.goto(BASE+'/engineering');await page.locator('[data-dashboard-title]').wait_for(timeout=60000)
  bar=page.get_by_role('navigation',name='Work order windows')
  list_menu=page.locator('[data-key="work-order-list"]:visible').first
  lst=page.locator('[data-cmpri-desktop-window="work-order-list"]')
  for item in fixtures[:1]:
   await list_menu.click()
   await lst.get_by_text(item['issue'],exact=False).first.click()
   await expect(page.locator('[data-cmpri-desktop-window="/work-orders/'+item['id']+'"]')).to_have_count(1)
  await page.locator('[data-key="/staff-notes"]:visible').first.click()
  notes_window=page.locator('[data-cmpri-desktop-window="/staff-notes"]')
  notes=notes_window.locator('iframe').content_frame
  await notes.locator('a[href="/work-orders/'+fixtures[1]['id']+'"]').click(timeout=60000)
  await expect(page.locator('[data-cmpri-desktop-window="/work-orders/'+fixtures[1]['id']+'"]')).to_have_count(1)
  await expect(notes_window).to_have_count(1)
  for item in fixtures[2:4]:
   await list_menu.click()
   await lst.get_by_text(item['issue'],exact=False).first.click()
   await expect(page.locator('[data-cmpri-desktop-window="/work-orders/'+item['id']+'"]')).to_have_count(1)
  first=page.locator('[data-cmpri-desktop-window="/work-orders/'+fixtures[0]['id']+'"]')
  await bar.get_by_label('Switch open work order').select_option('/work-orders/'+fixtures[0]['id'])
  editor=first.locator('iframe').content_frame.locator('#technician-note-editor')
  await editor.fill('Desktop draft must remain',timeout=60000)
  await page.evaluate('''() => {const d=document.createElement('dialog');d.id='mixed-source';d.innerHTML='<h2>Other modal</h2><input aria-label="Other draft" value="Keep me"/>';document.body.appendChild(d);d.showModal()}''')
  source=page.locator('#mixed-source')
  await source.get_by_role('button',name='Work orders',exact=True).click(timeout=15000)
  picker=page.locator('[data-cmpri-global-modal-shell] [data-modal-entry][aria-label="Work Order List"]')
  await picker.get_by_role('button',name=f'Open work order for {fixtures[4]["room"]}: {fixtures[4]["issue"]}').click()
  fifth=page.frame_locator('iframe[src*="'+fixtures[4]['id']+'"]')
  try: await fifth.locator('#technician-note-editor').fill('Global draft must remain',timeout=15000)
  except Exception:
   print('DEBUG',[(frame.url,(await frame.locator('body').inner_text())[:500]) for frame in page.frames],errors,flush=True)
   raise
  nav=page.get_by_role('navigation',name='Open screens')
  await nav.get_by_role('button',name='Work orders',exact=True).click()
  await picker.get_by_role('button',name=f'Open work order for {fixtures[5]["room"]}: {fixtures[5]["issue"]}').click()
  await expect(page.get_by_role('alert').filter(has_text='up to five work orders')).to_be_visible()
  await expect(page.locator('iframe[src*="'+fixtures[5]['id']+'"]')).to_have_count(0)
  # Existing desktop ticket is raised at the limit; the originating modal is
  # suspended rather than discarded and global work-order state stays mounted.
  await picker.get_by_role('button',name=f'Open work order for {fixtures[0]["room"]}: {fixtures[0]["issue"]}').click()
  await expect(editor).to_be_visible()
  await expect(editor).to_have_value('Desktop draft must remain')
  await page.get_by_role('button',name='Open screens',exact=True).click()
  await expect(fifth.locator('#technician-note-editor')).to_have_value('Global draft must remain')
  assert await source.get_by_label('Other draft').input_value()=='Keep me'
  assert not errors,errors
  print('PASS mixed hosts: Staff Notes link, shared cap, blocked sixth, existing raise, preserved drafts')
  await ctx.close();await browser.close()

asyncio.run(main())
