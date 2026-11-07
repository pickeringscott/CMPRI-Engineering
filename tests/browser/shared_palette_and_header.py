from cmpri_fixture import *
OUT=Path('/workspace/work/app-cache-release');OUT.mkdir(exist_ok=True)
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,844]:
   for role in ROLES:
    context=await browser.new_context(viewport={'width':width,'height':1000},service_workers='block');await install(context,role);page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-utilities').wait_for(timeout=60000)
    create=page.locator('.cmpri-header-utilities .cmpri-header-create');pool=page.locator('.cmpri-header-utilities .cmpri-header-status-pill')
    if await create.count():
     a=await create.bounding_box();b=await pool.bounding_box();assert abs(a['width']-b['width'])<.1,(role,width,a,b)
     assert abs(a['x']-b['x'])<.1,(role,width,a,b)
    assert not errors,errors
    results.append({'role':role,'width':width,'sameButtonWidth':True});await context.close()
  # The separate Technician dashboard uses the same controls and rule.
  context=await browser.new_context(viewport={'width':390,'height':844},service_workers='block');await install(context,'technician');page=await context.new_page();await page.goto(BASE+'/technician');await page.locator('.cmpri-header-create').wait_for(timeout=60000)
  a=await page.locator('.cmpri-header-create').bounding_box();b=await page.locator('.cmpri-header-status-pill').bounding_box();assert abs(a['width']-b['width'])<.1
  results.append({'role':'technician','route':'/technician','width':390,'sameButtonWidth':True});await context.close()
  # Changing root tokens updates the desktop host, embedded document and nested native modal together.
  context=await browser.new_context(viewport={'width':1440,'height':1000},service_workers='block');await install(context,'chief_engineer')
  async def rooms(route):await route.fulfill(json={'locations':[{'id':'room','name':'Room 101','room_number':'101','area':'Rooms','location_type':'Guest Room','active':True}],'work_orders':[],'pm_plans':[],'pm_completions':[],'can_edit':True})
  await context.route('**/api/rooms',rooms);page=await context.new_page();await page.goto(BASE+'/engineering');await page.get_by_role('button',name='Manage Locations',exact=True).wait_for(timeout=60000);await page.get_by_role('button',name='Manage Locations',exact=True).click()
  shell=page.locator('[data-cmpri-desktop-window="/management/rooms"]');await shell.wait_for();frame=await (await shell.locator('iframe').element_handle()).content_frame();await frame.locator('.location-toggle').first.wait_for(timeout=30000)
  await frame.locator('.location-toggle').first.click();await frame.get_by_role('button',name='Edit Location',exact=True).click();dialog=frame.get_by_role('dialog',name='Edit Location',exact=True);await dialog.wait_for()
  before=await dialog.evaluate('e=>getComputedStyle(e).backgroundColor')
  await page.evaluate('document.documentElement.style.setProperty("--cmpri-palette-modal-base","#292929")')
  await frame.wait_for_function('getComputedStyle(document.documentElement).getPropertyValue("--cmpri-palette-modal-base").trim()==="#292929"')
  await page.wait_for_timeout(80);after=await dialog.evaluate('e=>getComputedStyle(e).backgroundColor');assert before!=after,(before,after)
  assert await shell.evaluate('e=>getComputedStyle(e).getPropertyValue("--cmpri-modal-base").trim()')=='#292929'
  await page.evaluate('document.documentElement.style.removeProperty("--cmpri-palette-modal-base")');await frame.wait_for_function('getComputedStyle(document.documentElement).getPropertyValue("--cmpri-palette-modal-base").trim()==="#181818"')
  assert await dialog.evaluate('e=>getComputedStyle(e).backgroundColor')==before
  results.append({'rootPaletteChangePropagatesToDesktopEmbeddedAndNativeModals':True,'approvedDefaultRestored':True});await context.close();await browser.close()
 (OUT/'shared-palette-header.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
asyncio.run(main())
