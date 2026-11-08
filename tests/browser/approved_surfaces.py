from cmpri_fixture import *
import threading,functools
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*a):pass
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  for role in ROLES:
   for width in [390,1440]:
    notes=[{'id':'00000000-0000-4000-8000-000000000010','author_name':'Alex','body':'Existing #handoff for @Chief Engineer','parent_id':None,'created_at':'2026-11-06T11:00:00Z','gif_ids':[],'attachments':[]}];posts=[];layouts={};errors=[]
    context=await browser.new_context(viewport={'width':width,'height':950},is_mobile=width<640,has_touch=width<640)
    await install(context,role,notes=notes,posts=posts,layouts=layouts);page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    await page.goto(BASE+'/staff-notes');await page.locator('.cmpri-staff-notes').wait_for(timeout=60000);await page.get_by_text('Existing #handoff',exact=False).wait_for()
    if role=='front_desk':
     name=page.get_by_role('textbox',name='Your actual name',exact=True);await name.fill('Jamie Front Desk');await page.get_by_role('button',name='Confirm',exact=True).click();await expect(page.get_by_role('textbox',name='Write a comment',exact=True)).to_be_enabled();assert not [p for p in posts if p['path']=='/api/staff-notes']
    assert not await page.get_by_role('textbox',name='Your initials',exact=True).count()
    composer=page.locator('.cmpri-staff-notes form');feed=page.locator('.cmpri-staff-notes > div.overflow-y-auto');a=await composer.bounding_box();f=await feed.bounding_box();assert a['y']>=f['y']+f['height']-1,(role,width,a,f)
    split=page.locator('.staff-notes-split');bounds=await split.bounding_box();assert abs(bounds['width']-76)<1 and abs(bounds['height']-24)<1,(role,width,bounds)
    await page.get_by_role('button',name='Media',exact=True).click();pop=page.get_by_role('group',name='GIF or Media');await expect(pop).to_be_visible();bs=await pop.get_by_role('button').all();bb=[await b.bounding_box() for b in bs];assert abs(bb[0]['width']-bb[1]['width'])<1
    await pop.get_by_role('button',name='GIF',exact=True).click();picker=page.get_by_role('dialog',name='GIPHY picker');await expect(picker).to_be_visible();await picker.get_by_role('button',name='Select Fixture GIF gif-fixture-1',exact=True).wait_for();await picker.get_by_role('searchbox',name='Search GIPHY').fill('handoff');await expect(picker.get_by_role('status')).to_have_text('Search results');await picker.get_by_role('button',name='Select Fixture GIF gif-fixture-1',exact=True).click();await expect(picker).to_have_count(0)
    await page.get_by_role('button',name='Media',exact=True).click()
    async with page.expect_file_chooser() as selected:await page.get_by_role('group',name='GIF or Media').get_by_role('button',name='Media',exact=True).click()
    await (await selected.value).set_files({'name':'Original.gif','mimeType':'image/gif','buffer':GIF})
    draft=page.get_by_role('textbox',name='Write a comment',exact=True);await draft.fill('Fixture handoff #handoff @Chief Engineer')
    await page.get_by_role('button',name='Post',exact=True).click();await expect(draft).to_have_value('',timeout=20000);await expect(page.locator('[data-staff-note]')).to_have_count(2)
    saved=[p['body'] for p in posts if p['path']=='/api/staff-notes'];assert len(saved)==1;assert saved[0]['gifIds']==['gif-fixture-1'];assert len(saved[0]['uploadIds'])==1
    if role=='front_desk':assert saved[0]['staffName']=='Jamie Front Desk'
    assert await page.locator('[data-staff-note] .staff-note-tag').count()==2
    await page.locator('[data-staff-note]').last.get_by_role('button',name='Open Photo.png',exact=True).click();await expect(page.get_by_role('dialog',name='Photo.png')).to_be_visible();await page.get_by_role('button',name='Close media').click()
    await page.reload();await expect(page.locator('[data-staff-note]')).to_have_count(2);await expect(page.get_by_role('textbox',name='Write a comment',exact=True)).to_be_visible();await expect(page.locator('[data-staff-note] .staff-note-attachments img')).to_have_count(2)
    # Detail guest name occupies a dedicated muted line above the issue on mobile.
    await page.goto(BASE+'/work-orders/'+WID);await page.get_by_role('heading',name='Notes & Ticket History',exact=True).wait_for(timeout=60000)
    name=page.locator('[data-preview-mobile-guest-name]');issue=page.get_by_text('Fixture drain needs repair',exact=True).first
    if width<640:
     await expect(name).to_be_visible();n=await name.bounding_box();i=await issue.bounding_box();assert n['y']+n['height']<=i['y']+1,(n,i);assert await name.evaluate('e=>{const probe=document.createElement("span");probe.style.color="var(--cmpri-modal-muted)";e.append(probe);const same=getComputedStyle(e).color===getComputedStyle(probe).color;probe.remove();return same}'),await name.evaluate('e=>({color:getComputedStyle(e).color,theme:document.documentElement.dataset.theme})')
     assert not await page.locator('.cmpri-detail-standalone-guest .cmpri-window-guest-name').is_visible()
     async with page.expect_file_chooser() as camera:await page.get_by_role('button',name='Open camera',exact=True).click()
     assert await page.locator('input[capture]').get_attribute('capture')=='environment';await (await camera.value).set_files({'name':'Camera.gif','mimeType':'image/gif','buffer':GIF});assert await page.locator('.preview-note-thumbnail').count()==1
    else:
     await expect(name).to_be_hidden()
     if role=='chief_engineer':
      await context.grant_permissions(['camera'],origin=BASE);await page.get_by_role('button',name='Open camera',exact=True).click();await expect(page.get_by_role('button',name='Take photo',exact=True)).to_be_enabled(timeout=20000);await page.get_by_role('button',name='Take photo',exact=True).click();await expect(page.locator('.preview-camera')).to_have_count(0);assert await page.locator('.preview-note-thumbnail').count()==1
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(role,width,'horizontal overflow')
    assert not errors,(role,width,errors)
    if role in ['chief_engineer','front_desk']:await page.screenshot(path=str(OUT/f'detail-final-{role}-{width}.png'),full_page=True)
    results.append({'role':role,'width':width,'passed':True});print(json.dumps(results[-1]),flush=True);await context.close()
  await browser.close()
 OUT.joinpath('surface-results.json').write_text(json.dumps(results,indent=2))
asyncio.run(main())
