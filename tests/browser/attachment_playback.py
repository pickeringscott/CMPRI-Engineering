from cmpri_fixture import *

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,1440]:
   context=await browser.new_context(viewport={'width':width,'height':950},is_mobile=width<640,has_touch=width<640);await install(context,'chief_engineer')
   await context.add_init_script("window.fixturePlays=[];HTMLMediaElement.prototype.play=function(){window.fixturePlays.push({active:navigator.userActivation.isActive,dialog:!!this.closest('dialog'),src:this.getAttribute('src')});return Promise.resolve()}")
   async def attachments(route):
    await route.fulfill(content_type='application/json',body=json.dumps({'images':[{'id':'video-fixture','name':'Original video.webm','type':'video/webm','uploaded_at':'2026-11-06T12:00:00Z','uploader_name':'Alex','url':'data:video/webm;base64,'}]}))
   await context.route('**/api/work-orders/*/attachments',attachments);page=await context.new_page();await page.goto(BASE+'/work-orders/'+WID)
   link=page.get_by_role('link',name='Original video.webm',exact=True);await link.wait_for(timeout=60000)
   if width>640:
    await link.hover();tip=page.get_by_role('tooltip');await expect(tip).to_be_visible();assert await tip.locator('video').evaluate('v=>v.paused && v.currentTime===0')
    await tip.hover();await page.wait_for_timeout(250);await expect(tip).to_be_visible();await tip.get_by_role('button').click()
   else:await link.click()
   await expect(page.get_by_role('dialog',name='Original video.webm')).to_be_visible();calls=await page.evaluate('fixturePlays');assert any(c['active'] and c['dialog'] for c in calls),calls
   print(json.dumps({'width':width,'pausedHoverAndClickPlayback':True}),flush=True);await context.close()
  await browser.close()
asyncio.run(main())
