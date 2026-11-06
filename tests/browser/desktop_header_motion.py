from cmpri_fixture import *

async def rendered_slide(element):
 """Observe rendered interpolation, not just a registered animation object."""
 return await element.evaluate("""async e=>{
  for(let i=0;i<12;i++){
   await new Promise(requestAnimationFrame);
   const animation=e.getAnimations().find(a=>{const p=a.effect.getComputedTiming().progress;return p>0&&p<1});
   if(animation){
    const transform=getComputedStyle(e).transform,matrix=new DOMMatrixReadOnly(transform);
    return {interpolating:transform!=='none'&&(Math.abs(matrix.m41)>0.1||Math.abs(matrix.m42)>0.1),transform,progress:animation.effect.getComputedTiming().progress};
   }
  }
  return {interpolating:false,transform:getComputedStyle(e).transform};
 }""")

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for role in ['system_admin','chief_engineer']:
   context=await browser.new_context(viewport={'width':1440,'height':850});layouts={};posts=[]
   await install(context,role,layouts=layouts,posts=posts);page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000);await page.wait_for_timeout(500)
   admin=page.locator('fieldset').filter(has=page.locator('legend',has_text='Admin'));title=admin.locator('legend')
   # Picking up either form of a non-first group must not move it before pointer movement.
   for collapsed in [False,True]:
    if collapsed:await title.click();await page.wait_for_timeout(450)
    before=await page.locator('.cmpri-header-v23 legend').all_text_contents();box=await title.bounding_box()
    await page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);await page.mouse.down();await page.wait_for_timeout(650)
    await expect(page.locator('body > .moving-copy')).to_be_visible();assert await page.locator('.cmpri-header-v23 legend').all_text_contents()==before
    await page.mouse.up();await page.wait_for_timeout(450);assert ('collapsed' in await admin.get_attribute('class'))==collapsed
   await title.click();await page.wait_for_timeout(450)
   # A non-first title remains in its own slot when moved slightly along the raised tab row.
   before=await page.locator('.cmpri-header-v23 legend').all_text_contents();box=await title.bounding_box()
   await page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);await page.mouse.down();await page.wait_for_timeout(370);await page.mouse.move(box['x']+box['width']/2+10,box['y']+box['height']/2);await page.wait_for_timeout(300)
   assert await page.locator('.cmpri-header-v23 legend').all_text_contents()==before;await page.mouse.up();await page.wait_for_timeout(450)
   # Actual neighboring button pixels must interpolate during the reordering animation.
   ops=page.locator('fieldset').filter(has=page.locator('legend',has_text='Operations'));first=await ops.locator('.action').nth(0).element_handle();peer=await ops.locator('.action').nth(1).element_handle();a=await first.bounding_box();b=await peer.bounding_box()
   await page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);await page.mouse.down();await page.wait_for_timeout(370)
   ghost=await page.locator('body > .moving-copy').bounding_box();assert abs(ghost['width']-a['width'])<.1 and abs(ghost['height']-a['height'])<.1
   await page.mouse.move(b['x']+b['width']*.85,b['y']+b['height']/2);motion=await rendered_slide(peer);assert motion['interpolating'],motion
   await page.mouse.up();await page.wait_for_timeout(450);assert await page.get_by_role('dialog').count()==0
   # Whole-group neighbors also render their slide; valid release saves the shown order.
   account=await page.locator('fieldset').filter(has=page.locator('legend',has_text='Account')).element_handle();a=await title.bounding_box();b=await account.bounding_box()
   await page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);await page.mouse.down();await page.wait_for_timeout(370);await page.mouse.move(b['x']+b['width']-4,b['y']+b['height']/2)
   group_motion=await rendered_slide(account);assert group_motion['interpolating'],group_motion
   await page.mouse.up();await page.wait_for_timeout(450);assert (await page.locator('.cmpri-header-v23 legend').all_text_contents())[-1]=='Admin';assert layouts[role]['groups'][-1]=='Admin'
   # A failed account sync warns truthfully; returning online retries the pending arrangement.
   failing=True
   async def sync_failure(route):
    if failing and route.request.method=='PUT':await route.fulfill(status=503,content_type='application/json',body='{"error":"Fixture sync unavailable"}')
    else:await route.fallback()
   await context.route('**/api/profile/header-layout',sync_failure)
   account_button=page.locator('fieldset').filter(has=page.locator('legend',has_text='Account')).get_by_role('button',name='Sign Out',exact=True)
   await account_button.press('Alt+ArrowLeft');warning=page.get_by_text('Your arrangement is saved on this device. Sync will retry when you return.',exact=True);await expect(warning).to_be_visible()
   failing=False;await page.evaluate("window.dispatchEvent(new Event('online'))");await expect(warning).to_have_count(0)
   assert not errors,errors;assert not [post for post in posts if post['path']!='/api/profile/header-layout']
   results.append({'role':role,'buttonSlide':motion,'groupSlide':group_motion,'stationaryHoldStable':True,'raisedTabInsertionStable':True});print(json.dumps(results[-1]),flush=True);await context.close()
  await browser.close()
 OUT.joinpath('desktop-motion.json').write_text(json.dumps(results,indent=2))

asyncio.run(main())
