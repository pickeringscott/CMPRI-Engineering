"""Exercise work-order navigation through other open screens without live writes.

Run with CMPRI_UI_BASE=http://localhost:3116 against the local fixture server.
"""
from cmpri_fixture import *

SECOND = '00000000-0000-4000-8000-000000000004'


async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
  for width in (() if os.environ.get('CMPRI_NATIVE_ONLY') else (390, 1360)):
   ctx = await browser.new_context(viewport={'width':width,'height':950}, is_mobile=width < 640, has_touch=width < 640)
   first = dict(orders[0]); second = dict(first, id=SECOND, display_id='4219', room='205', issue='Second fixture problem')
   orders[:] = [first, second]
   await install(ctx,'chief_engineer')
   async def second_order(route):
    await route.fulfill(json={'workOrder':second,'mentionTickets':[]})
   await ctx.route('**/api/work-orders/'+SECOND+'*', second_order)
   async def parts(route):
    await route.fulfill(json={'items':[],'parts':[],'poLines':[]})
   await ctx.route('**/api/work-orders/*/parts', parts)
   page = await ctx.new_page(); errors=[]
   page.on('pageerror',lambda error: errors.append(error.stack or str(error)))
   await page.goto(BASE+'/technician')
   pool = page.get_by_role('button',name='Pool Status: CLOSED')
   await pool.wait_for(timeout=60000); await pool.click()
   host = page.get_by_role('dialog',name='Pool',exact=True)
   await expect(host).to_be_visible()
   await host.get_by_role('button',name='Work orders',exact=True).click()
   picker = page.get_by_role('dialog',name='Work Order List',exact=True)
   await expect(picker).to_be_visible()
   await picker.get_by_role('button',name='Open work order for 204: Fixture drain needs repair').click()
   frame1 = page.frame_locator('iframe[src*="'+WID+'"]')
   try: await frame1.get_by_role('heading',name='Reported Issue',exact=True).wait_for(timeout=15000)
   except Exception:
    print('URL',page.url,'frames',[(frame.url, (await frame.locator('body').inner_text())[:1000]) for frame in page.frames], 'errors',errors, flush=True)
    raise
   note1 = frame1.locator('#technician-note-editor')
   try: await note1.fill('Draft one remains open',timeout=10000)
   except Exception:
    print('URL',page.url,'frames',[(frame.url,(await frame.locator('body').inner_text())[:1200]) for frame in page.frames], 'errors',errors,flush=True)
    raise
   await page.get_by_role('navigation',name='Open screens').get_by_role('button',name='Work orders',exact=True).click()
   picker = page.get_by_role('dialog',name='Work Order List',exact=True)
   await picker.get_by_role('button',name='Open work order for 205: Second fixture problem').click()
   frame2 = page.frame_locator('iframe[src*="'+SECOND+'"]')
   await frame2.get_by_role('heading',name='Reported Issue',exact=True).wait_for(timeout=60000)
   await frame2.locator('#technician-note-editor').fill('Draft two remains open')
   nav = page.get_by_role('navigation',name='Open screens')
   await nav.get_by_role('button',name='Work Order 4218 · 204',exact=True).click()
   await expect(note1).to_have_value('Draft one remains open')
   await nav.get_by_role('button',name='Work Order 4219 · 205',exact=True).click()
   await expect(frame2.locator('#technician-note-editor')).to_have_value('Draft two remains open')
   assert await page.locator('iframe[src*="'+WID+'"]').count()==1
   assert await page.locator('iframe[src*="'+SECOND+'"]').count()==1
   assert not errors, errors
   await ctx.close()
   print(f'PASS {width}px: another modal, two tickets, switching, mounted drafts')
  # A standalone native modal remains independent of the work-order shell.
  for kind in ('native','custom'):
   ctx = await browser.new_context(viewport={'width':390,'height':950},is_mobile=True,has_touch=True)
   first = dict(orders[0]); second = dict(first,id=SECOND,display_id='4219',room='205',issue='Second fixture problem')
   orders[:] = [first,second]
   await install(ctx,'chief_engineer')
   async def second_order(route):
    if urlparse(route.request.url).path != '/api/work-orders/'+SECOND: return await route.fallback()
    await route.fulfill(json={'workOrder':second,'mentionTickets':[]})
   async def parts(route): await route.fulfill(json={'items':[],'parts':[],'poLines':[]})
   await ctx.route('**/api/work-orders/'+SECOND+'*',second_order)
   await ctx.route('**/api/work-orders/*/parts',parts)
   page=await ctx.new_page(); errors=[]
   page.on('pageerror',lambda error: errors.append(error.stack or str(error)))
   await page.goto(BASE+'/technician')
   await page.get_by_role('button',name='Pool Status: CLOSED').wait_for(timeout=60000)
   await page.evaluate('''kind => {
    const element=document.createElement(kind==='native'?'dialog':'div');
    element.id='fixture-dialog'; element.innerHTML='<h2>Fixture modal</h2><input aria-label="Original draft" value="Original stays" />';
    if(kind==='custom'){element.setAttribute('role','dialog');element.setAttribute('aria-modal','true');element.style.cssText='position:fixed;inset:10%;z-index:500;background:#222;color:white'}
    document.body.appendChild(element);if(kind==='native')element.showModal();
   }''',kind)
   original=page.locator('#fixture-dialog')
   await original.get_by_role('button',name='Work orders',exact=True).click(timeout=15000)
   picker=page.get_by_role('dialog',name='Work Order List',exact=True)
   await picker.get_by_role('button',name='Open work order for 204: Fixture drain needs repair').click()
   frame1=page.frame_locator('iframe[src*="'+WID+'"]')
   await frame1.locator('#technician-note-editor').fill('Native draft one',timeout=60000)
   nav=page.get_by_role('navigation',name='Open screens')
   await nav.get_by_role('button',name='Work orders',exact=True).click()
   await picker.get_by_role('button',name='Open work order for 205: Second fixture problem').click()
   frame2=page.frame_locator('iframe[src*="'+SECOND+'"]')
   try: await frame2.locator('#technician-note-editor').fill('Native draft two',timeout=15000)
   except Exception:
    print('NATIVE DEBUG',[(frame.url,(await frame.locator('body').inner_text())[:500]) for frame in page.frames],errors,flush=True)
    raise
   # A new native dialog can appear while tickets are already open.
   await page.evaluate('''() => {const d=document.createElement('dialog');d.id='later-dialog';d.innerHTML='<h2>Later modal</h2>';document.body.appendChild(d);d.showModal()}''')
   later=page.locator('#later-dialog')
   await later.get_by_role('button',name='Work orders',exact=True).click(timeout=15000)
   await nav.get_by_role('button',name='Work Order 4219 · 205',exact=True).click()
   await expect(frame2.locator('#technician-note-editor')).to_have_value('Native draft two')
   await later.evaluate('element=>element.remove()')
   await nav.get_by_role('button',name='Work Order 4218 · 204',exact=True).click()
   await expect(frame1.locator('#technician-note-editor')).to_have_value('Native draft one')
   if kind == 'native':
    # Explicit close must honor the dirty draft and return to the original modal.
    await nav.get_by_role('button',name='Work Order 4219 · 205',exact=True).click()
    await page.locator('[data-modal-entry][aria-hidden="false"] button.cmpri-desktop-close').click()
    await frame2.get_by_role('button',name='Discard draft and close',exact=True).click()
    await nav.get_by_role('button',name='Work Order 4218 · 204',exact=True).click()
    await page.locator('[data-modal-entry][aria-hidden="false"] button.cmpri-desktop-close').click()
    await frame1.get_by_role('button',name='Discard draft and close',exact=True).click()
    await picker.get_by_role('button',name='Close Work Order List',exact=True).click()
    await expect(original).to_be_visible()
    await expect(original.get_by_label('Original draft')).to_have_value('Original stays')
   else:
    # A background form may complete and remove the original modal at any time.
    await original.evaluate('element=>element.remove()')
    await expect(frame1.locator('#technician-note-editor')).to_have_value('Native draft one')
    await nav.get_by_role('button',name='Work Order 4219 · 205',exact=True).click()
    await expect(frame2.locator('#technician-note-editor')).to_have_value('Native draft two')
   assert not errors,errors
   await ctx.close()
   print(f'PASS {kind}: open two tickets and preserve drafts across modal transitions')
  ctx=await browser.new_context(viewport={'width':390,'height':950})
  await install(ctx,'chief_engineer')
  async def unauthorized_session(route):
   await route.fulfill(json={'user':{'id':UID,'name':'Fixture','role':'unknown'},'hotelId':HOTEL,'landing':'/technician','capabilities':[]})
  await ctx.route('**/api/session',unauthorized_session)
  page=await ctx.new_page();await page.goto(BASE+'/technician')
  await page.get_by_role('button',name='Pool Status: CLOSED').wait_for(timeout=60000)
  await page.evaluate('''() => {const d=document.createElement('dialog');d.id='unauthorized-dialog';d.innerHTML='<h2>Fixture modal</h2>';document.body.appendChild(d);d.showModal()}''')
  await page.wait_for_timeout(1000)
  assert await page.locator('#unauthorized-dialog').get_by_role('button',name='Work orders',exact=True).count()==0
  await ctx.close()
  print('PASS access: launcher omitted without work-order permission')
  await browser.close()

asyncio.run(main())
