from cmpri_fixture import *

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for role in ROLES:
   variants=[]
   for width in [390,1440]:
    layouts={};posts=[]
    context=await browser.new_context(viewport={'width':width,'height':950},is_mobile=width<640,has_touch=width<640)
    await install(context,role,layouts=layouts,posts=posts,connected=False);page=await context.new_page()
    await page.goto(BASE+'/engineering');await page.locator('.cmpri-header-v23 legend').first.wait_for(timeout=60000);await page.wait_for_timeout(500)
    groups=await page.locator('.cmpri-header-v23 fieldset').evaluate_all("gs=>gs.map(g=>({name:g.querySelector('legend').textContent,actions:[...g.querySelectorAll('.action')].map(b=>b.textContent)}))")
    actions=[a for g in groups for a in g['actions']]
    create=page.locator('.cmpri-header-create');assert await create.count()==int('submit' in CAPS[role])
    pool=page.locator('.cmpri-header-utilities').get_by_role('button').first
    if await create.count():
     pr=await pool.bounding_box();cr=await create.bounding_box();assert pr['y']+pr['height']<=cr['y'] and abs(pr['x']+pr['width']/2-cr['x']-cr['width']/2)<1,(role,width,pr,cr)
    if role=='manager':
     rect=await create.bounding_box();assert rect['x']+rect['width']/2>width/2
    assert ('Manage Profile' in actions)==(role!='front_desk' and 'view_profiles' in CAPS[role]),(role,actions)
    assert 'Staff Notes' in actions and 'Work Order List' in actions
    if role=='system_admin':
     assert 'Assets and Inventory' in [g['name'] for g in groups]
     assert 'Hours Tracker' not in actions
     assert groups[0]['name']=='Operations'
    # Every role can collapse/expand and long-press its first button; no unauthorized action appears.
    title=page.locator('.cmpri-header-v23 legend').first;field=page.locator('.cmpri-header-v23 fieldset').first
    await title.click();assert 'collapsed' in await field.get_attribute('class');await title.click()
    b=field.locator('.action').first;box=await b.bounding_box();session=await context.new_cdp_session(page)
    if width<640:await session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':box['x']+box['width']/2,'y':box['y']+box['height']/2,'id':1}]})
    else:await page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);await page.mouse.down()
    await page.wait_for_timeout(370)
    if width>=640:await page.mouse.move(box['x']+box['width']/2+10,box['y']+box['height']/2)
    await expect(page.locator('body > .moving-copy')).to_be_visible()
    if width<640:await session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    else:await page.mouse.up()
    await page.wait_for_timeout(450);assert await page.get_by_role('dialog').count()==0
    assert sorted(await page.locator('.cmpri-header-v23 .action').all_text_contents())==sorted(actions)
    if role=='front_desk':
     first=field.locator('.action').first;last=field.locator('.action').last;a=await first.bounding_box();z=await last.bounding_box()
     if width<640:await session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':a['x']+a['width']/2,'y':a['y']+a['height']/2,'id':1}]})
     else:await page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);await page.mouse.down()
     await page.wait_for_timeout(370)
     if width<640:await session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':z['x']+z['width']-3,'y':z['y']+z['height']/2,'id':1}]})
     else:await page.mouse.move(z['x']+z['width']-3,z['y']+z['height']/2)
     await page.wait_for_timeout(300)
     if width<640:await session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
     else:await page.mouse.up()
     await page.wait_for_timeout(500);assert await field.locator('.action').last.text_content()==actions[0];assert await page.get_by_role('dialog').count()==0
    # Distinct actions sharing /profile retain separate identities in the account layout.
    if 'Manage Profile' in actions:
     account=page.locator('fieldset').filter(has=page.locator('legend',has_text='Account'))
     connect=account.get_by_role('button',name='Connect ChatGPT',exact=True);await connect.press('Alt+ArrowLeft');await connect.press('Alt+ArrowLeft');await page.wait_for_timeout(500)
     saved=layouts[role]['buttons']['Account'];assert saved.index('/profile::Connect ChatGPT')<saved.index('/profile::Manage Profile')
     await page.reload();await page.locator('.cmpri-header-v23 legend').first.wait_for();await page.wait_for_timeout(500)
     names=await page.locator('fieldset').filter(has=page.locator('legend',has_text='Account')).locator('.action').all_text_contents();assert names.index('Connect ChatGPT')<names.index('Manage Profile')
    assert not [post for post in posts if post['path']!='/api/profile/header-layout']
    variants.append(groups);await context.close()
   assert variants[0]==variants[1],role
   results.append({'role':role,'groups':variants[0],'desktopAndTouchPassed':True});print(json.dumps(results[-1]),flush=True)
  await browser.close()
 OUT.joinpath('role-access.json').write_text(json.dumps(results,indent=2))

asyncio.run(main())
