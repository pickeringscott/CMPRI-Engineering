from cmpri_fixture import *

async def check(shell, page, label):
    trigger=shell.get_by_role('button',name='Room ranker key',exact=True)
    close=shell.get_by_role('button',name='Close Room Ranker',exact=True)
    await expect(trigger).to_be_visible()
    a=await trigger.bounding_box();b=await close.bounding_box()
    assert a['x']+a['width']<=b['x']+2,(label,a,b)
    assert await trigger.get_attribute('aria-expanded')=='false'
    await trigger.click()
    key=shell.get_by_role('region',name='Room ranker key')
    await expect(key).to_be_visible()
    assert await trigger.get_attribute('aria-expanded')=='true'
    await expect(key.get_by_text('Room ranker key',exact=True)).to_be_visible()
    rect=await key.bounding_box();container=await shell.bounding_box()
    assert rect['x']>=container['x']-1 and rect['x']+rect['width']<=container['x']+container['width']+1,(label,rect,container)
    await page.keyboard.press('Escape')
    await expect(key).to_have_count(0)
    await expect(trigger).to_be_focused()
    await expect(shell).to_be_visible()
    await trigger.click()
    await key.get_by_role('button',name='Close room ranker key').click()
    await expect(key).to_have_count(0)
    await expect(trigger).to_be_focused()
    await trigger.click()
    await trigger.click()
    await expect(key).to_have_count(0)
    print(label+' passed',flush=True)

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,1440]:
   ctx=await browser.new_context(viewport={'width':width,'height':850},is_mobile=width<640,has_touch=width<640)
   await install(ctx,'chief_engineer')
   async def extras(route):
    if urlparse(route.request.url).path=='/api/ticket-room-ranker': return await route.fulfill(json={'rooms':[]})
    await route.fallback()
   await ctx.route('**/api/**',extras)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering')
   await page.locator('.cmpri-header-v23').wait_for(timeout=60000)
   await page.evaluate("window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:'/engineering/room-ranking',title:'Room Ranker'}}))")
   shell=page.locator('.cmpri-modal-shell').last
   await check(shell,page,'modal '+str(width))
   await shell.get_by_role('button',name='Close Room Ranker',exact=True).click()
   await expect(shell).to_have_count(0)
   if width==1440:
    await page.locator('.cmpri-header-v23 .action[data-key="/engineering/room-ranking"]').click()
    window=page.locator('[data-cmpri-desktop-window="/engineering/room-ranking"]')
    await expect(window).to_be_visible()
    await check(window,page,'desktop window')
   assert not errors,errors
   await ctx.close()
  await browser.close()
asyncio.run(main())
