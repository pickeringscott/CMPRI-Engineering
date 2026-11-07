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
   before=await geometry();assert before==layouts[mode]['objects']
   iframe=page.locator('iframe[title^="Thanksgiving"]');viewport=await iframe.bounding_box();assert viewport=={'x':0,'y':0,'width':width,'height':height},viewport
   # Collapsing/reopening groups and closing desktop windows must preserve the viewport composition.
   ops=page.locator('fieldset.group').filter(has=page.locator('legend',has_text='Operations'))
   await ops.locator('legend').click();await ops.locator('legend').click();assert await geometry()==before
   await ops.get_by_role('button',name='Manage Locations',exact=True).click();dialog=page.get_by_role('dialog').last;await dialog.wait_for(timeout=30000)
   await page.locator('.cmpri-desktop-close').last.click();assert await geometry()==before and await iframe.bounding_box()==viewport
   audit=await frame.evaluate(scan);assert not audit['findings'],audit['findings'][:10]
   header=await page.evaluate(scan,'.cmpri-desktop-topbar,.cmpri-desktop-topbar *');assert not header['findings'],header['findings'][:12]
   assert await frame.locator('.leaf').count()==96
   assert not any('/api/' in url or 'supabase' in url for url in art_requests),art_requests
   assert not errors,errors
   await page.screenshot(path=str(OUT/f'cmpri-{mode}-fixed.png'))
   results.append({'mode':mode,'exactLayout':True,'headerChangesStable':True,'windowCloseStable':True,'leafCount':96,'unexpectedNavy':len(audit['findings'])+len(header['findings']),'artworkDatabaseRequests':0})
   await context.close()
  await browser.close()
 (OUT/'desktop-integration.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
asyncio.run(main())
