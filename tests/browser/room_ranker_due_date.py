from cmpri_fixture import *
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for auto in [True,False]:
   ctx=await browser.new_context(viewport={'width':1440,'height':900})
   await install(ctx,'chief_engineer')
   async def extras(route):
    if urlparse(route.request.url).path=='/api/work-orders/'+WID:
     return await route.fulfill(json={'workOrder':{**orders[0], 'priority':'Urgent' if auto else 'High', 'ranker_base_priority':'Low' if auto else 'High', 'due_by':'2026-11-09', 'ranker_auto_urgent':auto}})
    await route.fallback()
   await ctx.route('**/api/**',extras)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(e.stack))
   await page.goto(BASE+'/work-orders/'+WID)
   due=page.get_by_role('button',name='Edit due by');await expect(due).to_be_visible(timeout=60000)
   if auto:
    await expect(due).to_be_disabled()
    await expect(page.get_by_text('Room Ranker made this ticket urgent',exact=False)).to_be_visible()
    await expect(page.get_by_text('Room Ranker temporarily raised this priority from Low.',exact=False)).to_be_visible()
    assert await page.get_by_role('button',name='Edit priority').get_attribute('aria-describedby')=='ranker-priority-hint'
    assert await due.get_attribute('aria-describedby')=='ranker-due-date-hint'
   else:
    await expect(due).to_be_enabled();await due.click();await expect(page.get_by_label('Due By',exact=True)).to_be_visible()
    assert await page.get_by_text('Room Ranker made this ticket urgent',exact=False).count()==0
    assert await page.get_by_text('Room Ranker temporarily raised this priority',exact=False).count()==0
   assert not errors,errors
   print('auto urgency '+str(auto)+' passed',flush=True)
   await ctx.close()
  await browser.close()
asyncio.run(main())
