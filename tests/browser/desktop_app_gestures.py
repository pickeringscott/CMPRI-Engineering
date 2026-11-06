from cmpri_fixture import *

async def main():
 results=[];layouts={};posts=[]
 async with async_playwright() as p:
  context=await p.chromium.launch_persistent_context(str(OUT/'desktop-app-profile'),headless=False,executable_path='/usr/bin/chromium',args=['--no-sandbox'],viewport=None)
  await install(context,'chief_engineer',layouts=layouts,posts=posts);tab=context.pages[0];await tab.goto(BASE+'/engineering');await tab.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000)
  browser=await context.browser.new_browser_cdp_session();manifest=await (await context.new_cdp_session(tab)).send('Page.getAppManifest');manifest_id=manifest['manifest']['id']
  await browser.send('PWA.install',{'manifestId':manifest_id,'installUrlOrBundleUrl':BASE+'/'})
  await browser.send('PWA.changeAppUserSettings',{'manifestId':manifest_id,'displayMode':'standalone'})
  async with context.expect_page() as opened:await browser.send('PWA.launch',{'manifestId':manifest_id,'url':BASE+'/engineering'})
  app=await opened.value;await app.wait_for_load_state();await app.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000)
  for q in list(context.pages):
   if q not in [tab,app]:await q.close()
  windows={}
  for name,q in [('tab',tab),('app',app)]:
   s=await context.new_cdp_session(q);target=await s.send('Target.getTargetInfo');win=await browser.send('Browser.getWindowForTarget',{'targetId':target['targetInfo']['targetId']});windows[name]=win['windowId'];await browser.send('Browser.setWindowBounds',{'windowId':win['windowId'],'bounds':{'left':0,'top':0,'width':1280,'height':950}})
   await s.send('Emulation.setFocusEmulationEnabled',{'enabled':False})
  assert windows['tab']!=windows['app']
  assert await app.evaluate("matchMedia('(display-mode: standalone)').matches")
  assert await tab.evaluate("matchMedia('(display-mode: browser)').matches")
  print(json.dumps({'nativeWindows':windows,'installedManifest':manifest_id,'appStandaloneConfirmed':True}),flush=True)
  for variant in ['current-code']:
   for mode,q in [('tab',tab),('app',app)]:
    for item_type in ['button','group']:
     for timing in ['click','hold-without-movement','hold-then-move','immediate-mouse-drag']:
      layouts.clear();await q.evaluate('localStorage.clear()');await q.reload();await q.bring_to_front();await q.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000);await q.wait_for_timeout(500)
      errors=[];q.on('pageerror',lambda e:errors.append(str(e)))
      await q.evaluate("""()=>{window.inputTrace=[];const start=performance.now();for(const name of ['pointerdown','pointermove','pointerup','pointercancel','contextmenu','dragstart'])document.addEventListener(name,e=>{if(e.target.closest?.('.cmpri-header-v23')||e.buttons)window.inputTrace.push({type:name,ms:Math.round(performance.now()-start),x:e.clientX,y:e.clientY,pointer:e.pointerType,buttons:e.buttons,trusted:e.isTrusted})},true)}""")
      ops=q.locator('fieldset').filter(has=q.locator('legend',has_text='Operations'));item=ops.locator('.action').first if item_type=='button' else ops.locator('legend');peer=await (ops.locator('.action').nth(1) if item_type=='button' else q.locator('fieldset').filter(has=q.locator('legend',has_text='Account'))).element_handle()
      a=await item.bounding_box();b=await peer.bounding_box();x=a['x']+a['width']/2;y=a['y']+a['height']/2
      before=await q.locator('.cmpri-header-v23 fieldset').evaluate_all("gs=>gs.map(g=>({label:g.querySelector('legend').textContent,items:[...g.querySelectorAll('.action')].map(b=>b.dataset.key)}))")
      await q.mouse.move(x,y)
      if timing=='click':await q.mouse.click(x,y,delay=40)
      else:await q.mouse.down()
      if timing=='hold-without-movement':await q.wait_for_timeout(550)
      elif timing!='click':
       if timing=='hold-then-move':await q.wait_for_timeout(550)
       else:await q.mouse.move(x+14,y)
       await q.mouse.move(b['x']+b['width']*.85,b['y']+b['height']/2)
       await q.wait_for_timeout(35)
      ghost=q.locator('body > .moving-copy');count=await ghost.count();motion=await peer.evaluate("e=>({transform:getComputedStyle(e).transform,activeAnimations:e.getAnimations().length})")
      visual=await ghost.evaluate("e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,opacity:s.opacity,visibility:s.visibility,inViewport:r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight}}") if count else None
      if count:
       last=await q.evaluate("inputTrace.filter(e=>e.type==='pointermove'&&e.buttons).at(-1)");assert abs(visual['x']-last['x']-8)<.2 and abs(visual['y']-last['y']-8)<.2,(visual,last)
       assert await ghost.evaluate("g=>[g,...g.querySelectorAll('*')].every(e=>!['dotted','dashed'].includes(getComputedStyle(e).outlineStyle)&&!['dotted','dashed'].includes(getComputedStyle(e).borderStyle))")
      if mode=='app' and timing=='immediate-mouse-drag':await q.screenshot(path=str(OUT/('app-'+item_type+'-drag.png')))
      if timing!='click':await q.mouse.up()
      await q.wait_for_timeout(450)
      after=await q.locator('.cmpri-header-v23 fieldset').evaluate_all("gs=>gs.map(g=>({label:g.querySelector('legend').textContent,items:[...g.querySelectorAll('.action')].map(b=>b.dataset.key)}))")
      activated=await q.get_by_role('dialog').count() if item_type=='button' else ('collapsed' in await ops.get_attribute('class'))
      row={'variant':variant,'mode':mode,'item':item_type,'input':timing,'ghostCountDuring':count,'visual':visual,'neighbor':motion,'orderChanged':before!=after,'activated':bool(activated),'context':await q.evaluate("({standalone:matchMedia('(display-mode: standalone)').matches,platform:navigator.platform,focus:document.hasFocus(),width:innerWidth})"),'events':await q.evaluate('window.inputTrace'),'errors':errors}
      results.append(row);print(json.dumps({k:v for k,v in row.items() if k not in ['events']}),flush=True)
      assert not errors,errors
      events=row['events'];down=next(e for e in events if e['type']=='pointerdown');up=next(e for e in events if e['type']=='pointerup')
      if timing=='click':assert up['ms']-down['ms']<320,row
      if timing=='immediate-mouse-drag':assert next(e for e in events if e['type']=='pointermove' and e['buttons'])['ms']-down['ms']<320,row
      if timing=='click':assert count==0 and activated,(variant,mode,item_type,row)
      elif timing=='hold-without-movement':assert count==0 and before==after and not activated,row
      else:assert count==1 and visual['visibility']=='visible' and visual['inViewport'] and before!=after and not activated,row
  assert not [post for post in posts if post['path']!='/api/profile/header-layout']
  OUT.joinpath('desktop-app-gestures.json').write_text(json.dumps(results,indent=2));await context.close()
if not os.environ.get('DISPLAY'):raise SystemExit('A real display is required to verify an installed app and separate browser window.')
asyncio.run(main())
