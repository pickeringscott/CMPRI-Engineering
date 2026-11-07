"""Location editing and desktop scrollbar/background regression checks; fixture writes only."""
from cmpri_fixture import *

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'],ignore_default_args=['--hide-scrollbars'])
  for width in [390,1440]:
   ctx=await browser.new_context(viewport={'width':width,'height':1000},is_mobile=width<640,has_touch=width<640)
   await install(ctx,'chief_engineer')
   locations=[{'id':str(i),'name':f'Room {i}','room_number':str(i),'area':'Guest Rooms','location_type':'Guest Room','active':True} for i in range(101,141)]
   locations.extend([{'id':'lobby','name':'Lobby','room_number':None,'area':'Public Spaces','location_type':'Public Area','active':True},{'id':'store','name':'Storage','room_number':None,'area':'Back of House','location_type':'Storage','active':True}])
   writes=[]
   async def rooms(route):
    if route.request.method=='PATCH':
     body=route.request.post_data_json;writes.append(body)
     location=next(x for x in locations if x['id']==body['id']);location.update(body)
     return await route.fulfill(json={'location':location})
    return await route.fulfill(json={'locations':locations,'work_orders':[{'id':WID,'location_id':'101','room':'101','issue':'Inspect fan','status':'Open'}],'pm_plans':[],'pm_completions':[],'can_edit':True,'can_manage_corporate_pm':True})
   await ctx.route('**/api/rooms',rooms)
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000)
   await page.wait_for_timeout(600)
   background=page.locator('iframe[title^="Thanksgiving"]')
   if width>=768:
    await background.wait_for();bg=await (await background.element_handle()).content_frame()
    await bg.locator('#scene').wait_for()
    origin=await bg.evaluate('performance.timeOrigin')
    initial=await background.bounding_box()
    greeting=await bg.locator('#greeting').bounding_box()
    async def stable():
     assert await background.bounding_box()==initial,(initial,await background.bounding_box())
     assert await bg.locator('#greeting').bounding_box()==greeting
     assert await bg.evaluate('performance.timeOrigin')==origin
    # Header resizing and group reordering must not rescale the artwork.
    ops=page.locator('fieldset').filter(has=page.locator('legend',has_text='Operations'))
    await ops.locator('legend').click();await stable();await ops.locator('legend').click();await stable()
    title=page.locator('fieldset').filter(has=page.locator('legend',has_text='Admin')).locator('legend')
    target=page.locator('fieldset').filter(has=page.locator('legend',has_text='Account'))
    a=await title.bounding_box();b=await target.bounding_box()
    await page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);await page.mouse.down()
    await page.mouse.move(b['x']+b['width']-3,b['y']+b['height']/2,steps=8);await page.mouse.up();await page.wait_for_timeout(500);await stable()
    await page.get_by_role('button',name='Manage Locations',exact=True).click()
    shell=page.locator('[data-cmpri-desktop-window="/management/rooms"]');await shell.wait_for()
   else:
    assert await background.count()==1
    await page.evaluate("window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:'/management/rooms',title:'Manage Locations'}}))")
    shell=page.locator('.cmpri-modal-shell').last;await shell.wait_for()
   frame=await (await shell.locator('iframe').element_handle()).content_frame()
   toggle=frame.locator('.location-toggle').first;await toggle.wait_for(timeout=60000);await toggle.click()
   region=frame.get_by_role('region',name='Room 101 details');await expect(region).to_be_visible()
   for panel in await region.locator('.location-panel:not(button)').all():
    assert await panel.evaluate('e=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
   assert await region.evaluate('e=>{const probe=document.createElement("canvas").getContext("2d");probe.fillStyle=getComputedStyle(e).backgroundColor;probe.fillRect(0,0,1,1);const [r,g,b]=probe.getImageData(0,0,1,1).data;return r>g&&g>b}')
   edit=region.get_by_role('button',name='Edit Location',exact=True)
   tracker=region.get_by_role('button',name='Open PM Tracker →',exact=True)
   assert await region.locator('.location-ticket').evaluate('e=>getComputedStyle(e).backgroundColor')==await edit.evaluate('e=>getComputedStyle(e).backgroundColor')
   assert await edit.evaluate('e=>e.parentElement===e.nextElementSibling?.parentElement && e.nextElementSibling.textContent.includes("Open PM Tracker")')
   assert await edit.evaluate('e=>parseFloat(getComputedStyle(e).borderRadius)>=e.getBoundingClientRect().height/2')
   await page.screenshot(path=str(OUT/f'locations-expanded-{width}.png'))
   if width>=768:
    # The east resize handle must leave every scrollbar pixel inside the frame clickable.
    box=await shell.locator('iframe').bounding_box()
    for offset in [1,3,5,7]:
     assert await page.evaluate('([x,y])=>document.elementFromPoint(x,y)?.tagName', [box['x']+box['width']-offset,box['y']+80])=='IFRAME'
    scrollbar=frame.locator('html')
    await page.mouse.move(box['x']+box['width']-4,box['y']+60);await page.mouse.down();await page.mouse.move(box['x']+box['width']-4,box['y']+150,steps=8);await page.mouse.up()
    assert await scrollbar.evaluate('e=>e.scrollTop')>0
    await scrollbar.evaluate('e=>e.scrollTop=0')
   await edit.click();dialog=frame.get_by_role('dialog',name='Edit Location',exact=True)
   area=dialog.get_by_role('combobox',name='Area',exact=True);kind=dialog.get_by_role('combobox',name='Location Type',exact=True)
   assert await area.locator('option:not([disabled])').all_text_contents()==['Back of House','Guest Rooms','Public Spaces']
   assert await kind.locator('option:not([disabled])').all_text_contents()==['Guest Room','Public Area','Storage']
   await expect(area).to_have_value('Guest Rooms');await expect(kind).to_have_value('Guest Room')
   await page.screenshot(path=str(OUT/f'location-editor-{width}.png'))
   await area.select_option('Public Spaces');await kind.select_option('Public Area')
   await dialog.get_by_role('button',name='Save Location',exact=True).click();await expect(dialog).to_have_count(0)
   assert writes[0]['area']=='Public Spaces' and writes[0]['location_type']=='Public Area'
   await region.get_by_role('button',name='Edit Location',exact=True).click()
   dialog=frame.get_by_role('dialog',name='Edit Location',exact=True)
   await expect(dialog.get_by_role('combobox',name='Area',exact=True)).to_have_value('Public Spaces')
   await expect(dialog.get_by_role('combobox',name='Location Type',exact=True)).to_have_value('Public Area')
   await dialog.get_by_role('button',name='Cancel',exact=True).click()
   if width>=768:
    # Moving, resizing and closing a real desktop window preserves the same background document.
    bar=shell.locator('.cmpri-desktop-titlebar');box=await bar.bounding_box()
    await page.mouse.move(box['x']+120,box['y']+14);await page.mouse.down();await page.mouse.move(box['x']+160,box['y']+34,steps=8);await page.mouse.up();await stable()
    edge=shell.locator('.cmpri-desktop-resize-e');box=await edge.bounding_box();before=await shell.bounding_box()
    await page.mouse.move(box['x']+3,box['y']+30);await page.mouse.down();await page.mouse.move(box['x']+43,box['y']+30,steps=8);await page.mouse.up()
    assert (await shell.bounding_box())['width']>before['width'];await stable()
   await shell.get_by_role('button',name='Close Manage Locations',exact=True).click();await expect(shell).to_have_count(0)
   if width>=768:await stable()
   assert not errors,errors
   results.append({'width':width,'dropdownSaveAndReopen':True,'themedPanels':True,'adjacentPillActions':True,'scrollbarAndBackgroundStable':width>=768})
   print(json.dumps(results[-1]),flush=True);await ctx.close()
  await browser.close()
 OUT.joinpath('location-desktop-polish.json').write_text(json.dumps(results,indent=2))

asyncio.run(main())
