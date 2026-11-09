"""List/detail must show the same colored status immediately after priority."""
from cmpri_fixture import *
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390,320]:
   for status in ['In-House','Need to Order','On Order','Received']:
    ctx=await browser.new_context(viewport={'width':width,'height':1000})
    await install(ctx,'chief_engineer')
    orders[0]['parts_status']=status
    await ctx.route('**/api/work-orders/'+WID+'/parts',lambda route:route.fulfill(json={'items':[],'parts':[],'poLines':[]}))
    page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/engineering')
    await page.get_by_role('button',name='Work Order List',exact=True).click()
    modal=page.locator('[data-cmpri-desktop-window="work-order-list"]')
    pill=modal.locator('[data-parts-status]')
    await expect(pill).to_have_text(status,timeout=30000)
    before=await pill.evaluate('e=>({previous:e.previousElementSibling.textContent,height:e.getBoundingClientRect().height,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})')
    assert before['previous']=='High Priority',before
    assert before['height']==18,before
    await page.goto(BASE+'/work-orders/'+WID)
    pill=page.locator('[data-parts-status]')
    await expect(pill).to_have_text(status,timeout=30000)
    await expect(pill).to_be_visible()
    await expect(pill).to_have_css('height','18px')
    await page.wait_for_timeout(150)
    after=await pill.evaluate('e=>({previous:e.previousElementSibling.textContent,height:e.getBoundingClientRect().height,color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor})')
    assert before==after,(width,status,before,after)
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
    assert not errors,errors
    await ctx.close()
   print(json.dumps({'width':width,'four_statuses':True,'same_color_and_18px_height':True,'immediately_after_priority':True}))
  await browser.close()
asyncio.run(main())
