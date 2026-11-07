"""Verify approved modal palettes and cleanup against a local build; all data uses fixtures."""
from cmpri_fixture import *

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,1440]:
   context=await browser.new_context(viewport={'width':width,'height':1000},is_mobile=width<640,has_touch=width<640)
   await install(context,'chief_engineer')
   async def extras(route):
    path=urlparse(route.request.url).path
    if path=='/api/hours-tracker':return await route.fulfill(json={'saved':None})
    if path=='/api/ticket-room-ranker':return await route.fulfill(json={'rooms':[{'id':'room-'+str(f),'number':str(f)+'01','floor':str(f),'rank':'B','issues':[]} for f in range(1,5)]})
    await route.fallback()
   await context.route('**/api/**',extras)
   page=await context.new_page();errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering')
   await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
   for path,title,accent in [('/work-orders','Create Work Order','148,180,206'),('/work-orders/'+WID,'Work Order Detail','162,171,209'),('/engineering/hours-tracker','Hours Tracker','142,189,170'),('/engineering/room-ranking','Room Ranker',None),('/staff-notes','Staff Notes',None),('/feedback','Feedback',None)]:
    print(json.dumps({'width':width,'path':path,'stage':'opening'}),flush=True)
    await page.evaluate("d=>window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:d.path,title:d.title}}))",{'path':path,'title':title})
    shell=page.locator('.cmpri-modal-shell').last
    await expect(shell).to_be_visible()
    frame=await (await shell.locator('iframe').element_handle()).content_frame()
    await frame.wait_for_selector('html[data-cmpri-framed=true]',timeout=60000)
    if accent:
     await frame.wait_for_function('(a)=>document.documentElement.style.getPropertyValue("--cmpri-action-rgb")===a',arg=accent)
     actual=await shell.evaluate('e=>getComputedStyle(e).getPropertyValue("--cmpri-action-rgb").trim()')
     assert actual==accent,(width,path,actual)
    if path=='/work-orders':
     for name in ['Room / Location','Category','Priority']:
      control=frame.get_by_role('combobox',name=name,exact=True)
      await control.click()
      menu=frame.locator('.cmpri-searchable-select-listbox')
      await expect(menu).to_be_visible()
      await expect(menu.get_by_role('option').first).to_be_visible()
      await control.press('Escape')
    elif path.startswith('/work-orders/'):
     await expect(frame.locator('[data-preview-detail-title]')).to_be_visible()
    elif path=='/engineering/hours-tracker':
     tracker=frame.locator('main[aria-label="Personal Hours Tracker"]');await tracker.wait_for()
     assert await tracker.locator('h1').count()==0
     assert await tracker.locator('header').count()==0
     await tracker.locator('button[aria-label$="schedule: Unentered"]').first.click()
     await expect(tracker.locator('svg:visible').first).to_be_visible()
     # Closing the host still invokes the existing unsaved-hours guard.
     await shell.get_by_role('button',name='Close '+title,exact=True).click()
     confirmation=frame.get_by_role('dialog',name='Unsaved Hours Tracker changes')
     await expect(confirmation).to_be_visible()
     await confirmation.get_by_role('button',name='Discard',exact=True).click()
     await expect(shell).to_have_count(0)
     results.append({'width':width,'path':path,'passed':True,'unsavedGuard':True})
     continue
    elif path=='/engineering/room-ranking':
     filters=frame.get_by_role('group',name='Filter rooms by rank');await filters.wait_for()
     assert await filters.get_by_role('button').count()==4
     assert await frame.locator('h1:visible').count()==0
     await frame.get_by_role('button',name='1st Floor',exact=False).click()
     row=frame.locator('[data-room="101"]');await expect(row).to_be_visible()
     color=await row.evaluate('e=>getComputedStyle(e).backgroundColor')
     assert color in ['rgb(20, 20, 15)','rgb(25, 25, 18)'],color
    else:
     await frame.wait_for_selector('[data-cmpri-page-heading]',state='attached')
     for heading in await frame.locator('[data-cmpri-page-heading]').all():await expect(heading).to_be_hidden()
    await shell.get_by_role('button',name='Close '+title,exact=True).click()
    await expect(shell).to_have_count(0)
    results.append({'width':width,'path':path,'passed':True})
   assert not errors,errors
   await context.close()
  await browser.close()
 OUT.joinpath('modal-palette-cleanup.json').write_text(json.dumps(results,indent=2))
 print(json.dumps({'checks':len(results),'passed':True,'productionDataAccessed':False}))

asyncio.run(main())
