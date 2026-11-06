from cmpri_fixture import *
class Pointer:
 def __init__(self,page,session,touch):self.p=page;self.s=session;self.touch=touch
 async def down(self,x,y):
  if self.touch:await self.s.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1}]})
  else:await self.p.mouse.move(x,y);await self.p.mouse.down()
 async def move(self,x,y):
  if self.touch:await self.s.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y,'id':1}]})
  else:await self.p.mouse.move(x,y)
  await self.p.wait_for_timeout(40)
 async def up(self):
  if self.touch:await self.s.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
  else:await self.p.mouse.up()
def group(page,name):return page.locator('.cmpri-header-v23 fieldset.group').filter(has=page.locator('legend',has_text=name))
async def order(page):return await page.locator('.cmpri-header-v23 fieldset legend').all_text_contents()
async def keys(g):return await g.locator('.buttons .action').evaluate_all('bs=>bs.map(b=>b.dataset.layoutKey||b.dataset.key)')
async def settle(page):await page.wait_for_timeout(450)
async def main():
 results=[];layouts={}
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for touch,width in [(False,1440),(True,390)]:
   layouts.clear();posts=[]
   context=await browser.new_context(viewport={'width':width,'height':850},is_mobile=touch,has_touch=touch)
   await install(context,'chief_engineer',layouts=layouts,posts=posts);page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering');ops=group(page,'Operations');title=ops.locator('legend');await title.wait_for(timeout=60000);await settle(page)
   before_access=await page.locator('.cmpri-header-v23 .action').evaluate_all('bs=>bs.map(b=>b.dataset.key).sort()')
   session=await context.new_cdp_session(page);pointer=Pointer(page,session,touch)
   # Single tap/click collapses/expands with a tight visible, colored title.
   await title.click();assert 'collapsed' in (await ops.get_attribute('class'));assert await title.get_attribute('aria-expanded')=='false'
   await expect(title).to_be_visible();await expect(ops.locator('.buttons')).to_be_hidden();await title.click();assert 'collapsed' not in (await ops.get_attribute('class'))
   # A normal action opens its own modal. Closing it leaves the header intact.
   await ops.get_by_role('button',name='Work Order List',exact=True).click();await page.get_by_role('dialog').last.wait_for();await page.locator('.cmpri-desktop-close').last.click();await settle(page)
   first=ops.locator('.buttons .action').first;box=await first.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']/2
   await pointer.down(x,y);await page.wait_for_timeout(370);ghost=page.locator('body > .moving-copy');await expect(ghost).to_be_visible()
   copied=await ghost.bounding_box();assert abs(copied['width']-box['width'])<.1 and abs(copied['height']-box['height'])<.1,(box,copied)
   style="e=>{const s=getComputedStyle(e);return [s.font,s.color,s.backgroundColor,s.borderRadius]}";actual=await first.evaluate(style);copy_style=await ghost.evaluate(style);assert actual==copy_style,(actual,copy_style)
   assert await page.evaluate('getSelection().toString()')=='';assert await page.locator('body').evaluate("e=>getComputedStyle(e).userSelect")=='none'
   # Long press and release without movement must not launch the button.
   await pointer.up();await settle(page);assert await page.get_by_role('dialog').count()==0
   # Move a real button, and observe actual peer movement before releasing.
   original=await keys(ops);first=ops.locator('.buttons .action').first;peer=ops.locator('.buttons .action').nth(1);a=await first.bounding_box();b=await peer.bounding_box()
   await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await page.wait_for_timeout(370);await pointer.move(b['x']+b['width']*.8,b['y']+b['height']/2)
   await page.wait_for_timeout(20);assert await keys(ops)!=original
   animated=await ops.evaluate("g=>[...g.querySelectorAll('.action')].some(b=>getComputedStyle(b).transform!=='none'&&b.getAnimations().some(a=>a.effect.getKeyframes().some(k=>String(k.transform).includes('translate'))))");assert animated
   await pointer.up();await settle(page);assert await page.get_by_role('dialog').count()==0;assert layouts['chief_engineer']['buttons']['Operations']==await keys(ops)
   # Narrow Operations so a short swipe can scroll and an invalid drag can restore scroll.
   edge=ops.locator('.resize-edge');e=await edge.bounding_box();height=(await ops.bounding_box())['height']
   await pointer.down(e['x']+e['width']/2,e['y']+e['height']/2);await pointer.move((await ops.bounding_box())['x']+245,e['y']+e['height']/2+35);await pointer.up();await settle(page)
   assert abs((await ops.bounding_box())['height']-height)<.1
   row=ops.locator('.buttons');await row.evaluate('r=>r.scrollLeft=0');r=await row.bounding_box();rangebox=await ops.locator('.group-scroll').bounding_box();field=await ops.bounding_box();assert rangebox['y']>=field['y']+field['height']-1,(rangebox,field)
   # Swipe without holding: scrolling, no ghost and no normal action.
   second=ops.locator('.buttons .action').nth(1);b=await second.bounding_box();sx=min(r['x']+r['width']-10,b['x']+b['width']/2);sy=r['y']+r['height']/2
   await pointer.down(sx,sy);await pointer.move(sx-80,sy);await pointer.up();await settle(page);assert await row.evaluate('r=>r.scrollLeft')>0;assert await page.get_by_role('dialog').count()==0
   # Exit/re-enter hides/reveals only the drag visual; invalid release restores exact order/scroll/position.
   await row.evaluate('r=>r.scrollLeft=0');original=await keys(ops);first=ops.locator('.buttons .action').first;a=await first.bounding_box();scroll=await row.evaluate('r=>r.scrollLeft')
   await pointer.down(max(r['x']+5,a['x']+a['width']/2),a['y']+a['height']/2);await page.wait_for_timeout(370)
   await pointer.move(r['x']+r['width']-5,sy);await page.wait_for_timeout(300)
   field=await ops.bounding_box();outside=(field['x']+field['width']/2,field['y']+field['height']+20)
   await pointer.move(*outside);assert await ghost.evaluate('g=>getComputedStyle(g).visibility')=='hidden'
   if not touch:assert await page.locator('body').evaluate('b=>getComputedStyle(b).cursor')=='not-allowed'
   await pointer.move(r['x']+10,sy);assert await ghost.evaluate('g=>getComputedStyle(g).visibility')=='visible',{'row':r,'sy':sy,'current':await ops.bounding_box(),'styles':await ghost.evaluate('g=>g.style.visibility'),'errors':errors,'body':await page.locator('body').get_attribute('class')}
   await pointer.move(*outside);await pointer.up();await settle(page)
   assert await keys(ops)==original;assert abs(await row.evaluate('r=>r.scrollLeft')-scroll)<.1
   restored=await first.bounding_box();assert abs(restored['x']-a['x'])<.1 and abs(restored['y']-a['y'])<.1
   # Expanded Operations reaches the last position, with no forced collapse or release-click.
   await row.evaluate('r=>r.scrollLeft=40');row_scroll=await row.evaluate('r=>r.scrollLeft')
   groups_before=await order(page);a=await title.bounding_box();bar=await page.locator('.cmpri-header-v23 .groups').bounding_box()
   await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await page.wait_for_timeout(370)
   source_rect=await ops.bounding_box();ghost_rect=await ghost.bounding_box();assert abs(source_rect['width']-ghost_rect['width'])<.1 and abs(source_rect['height']-ghost_rect['height'])<.1
   assert await ops.locator('svg path').get_attribute('d')==await ghost.locator('svg path').get_attribute('d')
   assert abs(await ghost.locator('.buttons').evaluate('r=>r.scrollLeft')-row_scroll)<.1
   await pointer.move(bar['x']+bar['width']-6,bar['y']+bar['height']-4);await pointer.up();await settle(page)
   assert (await order(page))[-1]=='Operations',(groups_before,await order(page));assert 'collapsed' not in (await ops.get_attribute('class'))
   # Collapsed group is also draggable, and remains collapsed on release.
   await title.click();assert 'collapsed' in (await ops.get_attribute('class'));a=await title.bounding_box();target=await page.locator('.cmpri-header-v23 fieldset').first.bounding_box()
   await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await page.wait_for_timeout(370);await pointer.move(target['x']+4,target['y']+5);await pointer.up();await settle(page)
   assert (await order(page))[0]=='Operations';assert 'collapsed' in (await ops.get_attribute('class'))
   # Account width caps at content fitting width and persists after collapse/reopen.
   account=group(page,'Account');edge=account.locator('.resize-edge');a=await edge.bounding_box();field=await account.bounding_box();height=field['height']
   await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await pointer.move(min(width-4,a['x']+250),a['y']+20);await pointer.up();await settle(page)
   cap=await account.evaluate("g=>Math.max(g.querySelector('legend').offsetWidth+26,[...g.querySelectorAll('.buttons>.action')].reduce((n,b)=>n+b.getBoundingClientRect().width,0)+Math.max(0,g.querySelectorAll('.buttons>.action').length-1)*parseFloat(getComputedStyle(g.querySelector('.buttons')).columnGap)+14)")
   rect=await account.bounding_box();assert rect['width']<=cap+1;assert rect['height']==height;assert await account.locator('.group-scroll').is_hidden(),await account.evaluate("g=>({width:g.offsetWidth,style:g.style.width,row:g.querySelector('.buttons').clientWidth,scroll:g.querySelector('.buttons').scrollWidth,padding:getComputedStyle(g).padding,border:getComputedStyle(g).borderWidth,natural:[...g.querySelectorAll('.action')].map(b=>b.offsetWidth)})")
   saved_width=layouts['chief_engineer']['widths']['Account'];await account.locator('legend').click();await account.locator('legend').click();await settle(page);assert abs(layouts['chief_engineer']['widths']['Account']-saved_width)<1
   assert await page.locator('.cmpri-header-v23 .action').evaluate_all('bs=>bs.map(b=>b.dataset.key).sort()')==before_access
   assert not [p for p in posts if p['path']!='/api/profile/header-layout'];assert not errors,errors
   assert await page.locator('.cmpri-header-v23').evaluate("r=>[...r.querySelectorAll('*')].every(e=>!['dotted','dashed'].includes(getComputedStyle(e).outlineStyle)&&!['dotted','dashed'].includes(getComputedStyle(e).borderStyle))")
   saved=json.loads(json.dumps(layouts['chief_engineer']));await context.close()
   # New browser context: no local cache; the same authenticated account loads its server arrangement.
   fresh=await browser.new_context(viewport={'width':390 if not touch else 1440,'height':850},is_mobile=not touch,has_touch=not touch);await install(fresh,'chief_engineer',layouts=layouts);q=await fresh.new_page();await q.goto(BASE+'/engineering');await q.locator('.cmpri-header-v23 legend').first.wait_for();await q.wait_for_timeout(500)
   assert await order(q)==saved['groups'];assert await keys(group(q,'Operations'))==saved['buttons']['Operations'];assert 'collapsed' in (await group(q,'Operations').get_attribute('class'));await fresh.close()
   results.append({'input':'touch' if touch else 'pointer','width':width,'passed':True});print(json.dumps(results[-1]),flush=True)
  # A short mobile viewport forces header edge scrolling; expanded Operations still reaches last.
  layouts.clear();context=await browser.new_context(viewport={'width':390,'height':240},is_mobile=True,has_touch=True);await install(context,'chief_engineer',layouts=layouts);page=await context.new_page();await page.goto(BASE+'/engineering');ops=group(page,'Operations');await ops.locator('legend').wait_for();await settle(page)
  header=page.locator('.cmpri-desktop-topbar');assert await header.evaluate('h=>h.scrollHeight>h.clientHeight')
  session=await context.new_cdp_session(page);pointer=Pointer(page,session,True);title=ops.locator('legend');a=await title.bounding_box();h=await header.bounding_box()
  await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await page.wait_for_timeout(370);await pointer.move(h['x']+h['width']-10,h['y']+h['height']-5);await page.wait_for_timeout(1200);await pointer.up();await settle(page)
  assert (await order(page))[-1]=='Operations';assert 'collapsed' not in (await ops.get_attribute('class'));assert await header.evaluate('h=>h.scrollTop')>0
  results.append({'input':'touch','width':390,'height':240,'edgeScroll':True,'passed':True});print(json.dumps(results[-1]),flush=True);await context.close()
  # An invalid whole-group drop restores the header's pre-drag scroll and exact source position.
  layouts.clear();context=await browser.new_context(viewport={'width':390,'height':220},is_mobile=True,has_touch=True);await install(context,'chief_engineer',layouts=layouts);page=await context.new_page();await page.goto(BASE+'/engineering');ops=group(page,'Operations');await ops.locator('legend').wait_for();await settle(page)
  header=page.locator('.cmpri-desktop-topbar');session=await context.new_cdp_session(page);pointer=Pointer(page,session,True)
  # Holding a title near the edge must not scroll the header before dragging begins.
  a=await group(page,'Admin').locator('legend').bounding_box();await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await page.wait_for_timeout(650);assert await header.evaluate('h=>h.scrollTop')==0;await pointer.up();await settle(page)
  initial_order=await order(page);initial_box=await ops.bounding_box();initial_scroll=await header.evaluate('h=>h.scrollTop');h=await header.bounding_box();a=await ops.locator('legend').bounding_box()
  await pointer.down(a['x']+a['width']/2,a['y']+a['height']/2);await page.wait_for_timeout(370);await pointer.move(h['x']+h['width']-10,h['y']+h['height']-5);await page.wait_for_timeout(1000)
  assert await header.evaluate('h=>h.scrollTop')>initial_scroll;await pointer.move(h['x']+h['width']/2,h['y']+h['height']+15);await pointer.up();await settle(page)
  assert await order(page)==initial_order;assert await header.evaluate('h=>h.scrollTop')==initial_scroll;restored=await ops.bounding_box();assert abs(restored['x']-initial_box['x'])<.1 and abs(restored['y']-initial_box['y'])<.1
  results.append({'input':'touch','invalidGroupDropRestoresScrollAndPosition':True,'passed':True});print(json.dumps(results[-1]),flush=True);await context.close()
  await browser.close()
 OUT.joinpath('gestures.json').write_text(json.dumps(results,indent=2))
asyncio.run(main())
