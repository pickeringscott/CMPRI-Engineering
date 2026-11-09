from cmpri_fixture import *
ROOT=Path(__file__).resolve().parents[2]
OUT=Path('/workspace/work/thanksgiving-production')
manifest=json.loads((ROOT/'src/lib/ui/thanksgiving-assets.json').read_text())
layouts=json.loads((ROOT/'src/lib/ui/thanksgiving-layouts.json').read_text())
scan=(ROOT/'tests/browser/modal_element_scan.js').read_text()
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width,height,mode in [(1440,900,'desktop'),(390,844,'mobile')]:
   context=await browser.new_context(viewport={'width':width,'height':height},service_workers='block')
   # Advance the real leaf script deterministically; header interactions use the normal browser clock.
   await context.add_init_script('''if(location.pathname.startsWith('/backgrounds/thanksgiving-animated/')){
    let time=1,frames=[];window.requestAnimationFrame=fn=>(frames.push(fn),frames.length);
    window.advanceThemeLeaves=n=>{for(let i=0;i<n;i++){time+=100;const batch=frames;frames=[];for(const fn of batch)fn(time)}};
   }''')
   await install(context,'chief_engineer');page=await context.new_page();errors=[];art_requests=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def request(r):
    if r.frame.url==BASE+manifest['entry'] or r.url==BASE+manifest['entry']:art_requests.append(r.url)
   page.on('request',request)
   await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000)
   frame=page.frame(url=BASE+manifest['entry']);assert frame
   await frame.wait_for_function('document.getElementById("scene")?.dataset.layout==='+json.dumps(mode))
   await frame.wait_for_function('Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)')
   async def geometry():return await frame.locator('.decor').evaluate_all('es=>Object.fromEntries(es.map(e=>[e.id,{x:parseFloat(e.style.left),y:parseFloat(e.style.top),width:parseFloat(e.style.width),height:parseFloat(e.style.height),layer:+e.style.zIndex-10}]))')
   before=await geometry()
   async def safe_greeting():
    if mode=='mobile':assert (await geometry())['greeting']==layouts[mode]['objects']['greeting'];return
    header=await page.locator('.cmpri-desktop-topbar').bounding_box();g=await frame.locator('#greeting').bounding_box()
    assert g['y']>=header['y']+header['height']+19,(header,g)
    assert abs(width-g['x']-g['width']-24)<1,g
    assert g['y']+g['height']<=height,g
   await safe_greeting()
   for key in ['turkey','orange','pale']:assert before[key]==layouts[mode]['objects'][key]
   iframe=page.locator('iframe[title^="Thanksgiving"]');viewport=await iframe.bounding_box();assert viewport=={'x':0,'y':0,'width':width,'height':height},viewport
   # Collapsing/reopening groups and closing desktop windows must preserve the viewport composition.
   ops=page.locator('fieldset.group').filter(has=page.locator('legend',has_text='Operations'))
   await ops.locator('legend').click();await page.wait_for_timeout(60);await safe_greeting()
   await ops.locator('legend').click();await page.wait_for_timeout(60);await safe_greeting()
   for key in ['turkey','orange','pale']:assert (await geometry())[key]==before[key]
   if mode=='desktop':
    groups=page.locator('fieldset.group')
    for i in range(await groups.count()):
     group=groups.nth(i)
     if 'collapsed' not in (await group.get_attribute('class')):await group.locator('legend').click()
    await page.wait_for_timeout(60);await safe_greeting()
    for i in range(await groups.count()):
     group=groups.nth(i)
     if 'collapsed' in (await group.get_attribute('class')):await group.locator('legend').click()
     await page.wait_for_timeout(60);await safe_greeting()
    for key in ['turkey','orange','pale']:assert (await geometry())[key]==before[key]
   before=await geometry()
   await ops.get_by_role('button',name='Manage Locations',exact=True).click();dialog=page.get_by_role('dialog').last;await dialog.wait_for(timeout=30000)
   await page.locator('.cmpri-desktop-close').last.click();assert await geometry()==before and await iframe.bounding_box()==viewport
   audit=await frame.evaluate(scan);assert not audit['findings'],audit['findings'][:10]
   header=await page.evaluate(scan,'.cmpri-desktop-topbar,.cmpri-desktop-topbar *');assert not header['findings'],header['findings'][:12]
   assert await frame.locator('.leaf:not(.settled)').count()==96
   await frame.evaluate('advanceThemeLeaves(80)')
   first=await frame.locator('.settled').first.element_handle();pose=await first.get_attribute('style')
   await frame.evaluate('advanceThemeLeaves(50)')
   assert await first.evaluate('e=>e.isConnected') and await first.get_attribute('style')==pose
   await frame.evaluate('advanceThemeLeaves(1400)')
   assert await frame.locator('.leaf.settled').count()==480
   for name,layer in [('leavesA',1),('leavesB',6)]:
    assert await frame.locator('#'+name+' .settled').count()==240
    assert await frame.locator('#'+name).evaluate('e=>+e.style.zIndex')==layer+10
   assert await frame.locator('#scene').get_attribute('data-pile-height')=='100'
   assert not any('/api/' in url or 'supabase' in url for url in art_requests),art_requests
   assert not errors,errors
   await page.screenshot(path=str(OUT/f'cmpri-{mode}-fixed.png'))
   results.append({'mode':mode,'approvedArtworkPositions':True,'greetingClearsExpandedTabs':True,'windowCloseStable':True,'fallingLeaves':96,'persistentGroundLeaves':480,'pileHeight':100,'originalLeafLayers':[1,6],'unexpectedNavy':len(audit['findings'])+len(header['findings']),'artworkDatabaseRequests':0})
   await context.close()
  await browser.close()
 (OUT/'desktop-integration.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
asyncio.run(main())
