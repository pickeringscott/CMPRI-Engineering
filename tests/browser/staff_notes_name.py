"""Front Desk identity controls against the real handlers and isolated PostgreSQL."""
from cmpri_fixture import *
import re
BACKEND='http://127.0.0.1:3127'
def sid(n):return f'00000000-0000-4000-8000-{n:012d}'
async def setup(browser,width,role='front_desk',user=6):
 context=await browser.new_context(viewport={'width':width,'height':844 if width<640 else 900},is_mobile=width<640,has_touch=width<640)
 await install(context,role,user_id=sid(user),hotel_id=sid(1))
 calls=[]
 async def forward(route):
  path=urlparse(route.request.url).path
  calls.append({'path':path,'method':route.request.method})
  args={'method':route.request.method,'headers':{'Authorization':'Bearer fixture:'+sid(user)}}
  if route.request.method in ['POST','PATCH']:args['data']=route.request.post_data_json
  response=await context.request.fetch(BACKEND+path,**args)
  await route.fulfill(status=response.status,content_type='application/json',body=await response.body())
 await context.route(re.compile(r'.*/api/staff-notes(?:[/?].*)?$'),forward)
 page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 return context,page,calls,errors
async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390]:
   c,q,calls,errors=await setup(browser,width);await q.goto(BASE+'/staff-notes')
   name=q.get_by_role('textbox',name='Your actual name',exact=True);await name.wait_for()
   comment=q.get_by_role('textbox',name='Write a comment',exact=True)
   await expect(comment).to_be_disabled();await expect(q.get_by_role('button',name='Post',exact=True)).to_be_disabled()
   shell=q.locator('.staff-compose-shell');assert await shell.locator('input').count()==1
   sizing=await name.evaluate("e=>{const c=document.createElement('canvas').getContext('2d');c.font=getComputedStyle(e).font;return {width:parseFloat(getComputedStyle(e).width),ch:c.measureText('0').width}}")
   assert abs(sizing['width']/sizing['ch']-10)<.2,sizing
   a=await name.bounding_box();b=await q.get_by_role('button',name='Confirm',exact=True).bounding_box();assert b['x']>=a['x']+a['width'] and b['x']-a['x']-a['width']<=6
   await q.screenshot(path=str(OUT/f'name-entry-live-{width}.png'))
   await name.fill('Front Desk');await q.get_by_role('button',name='Confirm',exact=True).click();await expect(q.get_by_role('alert')).to_be_visible();await expect(comment).to_be_disabled()
   await name.fill('Taylor Reed');await q.get_by_role('button',name='Confirm',exact=True).click();await expect(comment).to_be_enabled()
   assert not [x for x in calls if x['path']=='/api/staff-notes' and x['method']=='POST']
   identity=q.locator('.staff-confirmed-identity');await expect(identity).to_have_text('Taylor Reed·Front DeskChange')
   assert await shell.locator('.staff-confirmed-identity').count()==1
   style=await identity.evaluate('e=>({size:getComputedStyle(e).fontSize,color:getComputedStyle(e).color})');assert style['size']=='11px',style
   await expect(q.get_by_text('Front Desk User',exact=True)).to_have_count(0)
   await q.reload();await expect(comment).to_be_enabled();await expect(identity).to_contain_text('Taylor Reed')
   # A surname offers a complete, stable Front Desk identity, and never malformed ghost text.
   await comment.fill('@Reed');option=q.get_by_role('option',name='Mention Taylor Reed (Front Desk name)',exact=True);await expect(option).to_be_visible()
   assert not await q.get_by_role('button',name='Complete @Taylor Reed',exact=True).count()
   await option.click();await expect(comment).to_have_value('@Taylor Reed ')
   await comment.fill(f'Front Desk handoff {width}');await q.get_by_role('button',name='Post',exact=True).click();await expect(comment).to_have_value('')
   note=q.locator('[data-staff-note]').filter(has_text=f'Front Desk handoff {width}').last
   await expect(note.locator('.staff-front-desk-badge')).to_have_text('Front Desk')
   assert await note.locator('.staff-front-desk-badge').evaluate("e=>getComputedStyle(e).fontSize")=='9px'
   author=await note.locator('.staff-author-name').bounding_box();badge=await note.locator('.staff-front-desk-badge').bounding_box()
   assert badge['x']>=author['x']+author['width'] and badge['y']<author['y']+author['height'],(author,badge)
   await note.get_by_role('button',name='Reply to Taylor Reed',exact=True).click();await comment.fill(f'Taylor reply {width}');await q.get_by_role('button',name='Post',exact=True).click();await expect(comment).to_have_value('');await expect(q.locator('[data-staff-note]').filter(has_text=f'Taylor reply {width}')).to_contain_text('↪ Taylor Reed')
   # Existing live GIPHY controls remain usable after confirmation.
   await q.get_by_role('button',name='Media',exact=True).click();await q.get_by_role('group',name='GIF or Media').get_by_role('button',name='GIF',exact=True).click()
   picker=q.get_by_role('dialog',name='GIPHY picker');await expect(picker).to_be_visible();await picker.get_by_role('button',name='Select Fixture GIF gif-fixture-1',exact=True).click();await expect(picker).to_have_count(0)
   await q.get_by_role('button',name='Post',exact=True).click();await expect(q.locator('form .staff-note-attachments')).to_have_count(0)
   await q.screenshot(path=str(OUT/f'confirmed-live-{width}.png'))
   await q.get_by_role('button',name='Change name',exact=True).click();await expect(name).to_be_visible();await expect(comment).to_be_disabled()
   assert not errors,errors
   await c.unroute_all(behavior='ignoreErrors');await c.close()
   fresh,fq,_,fe=await setup(browser,width);await fq.goto(BASE+'/staff-notes');await expect(fq.get_by_role('textbox',name='Your actual name',exact=True)).to_be_visible();assert not fe,fe;await fresh.unroute_all(behavior='ignoreErrors');await fresh.close()
   # Another account sees the registered name, without a name gate of its own.
   tc,tq,_,te=await setup(browser,width,'technician',9);await tq.goto(BASE+'/staff-notes');text=tq.get_by_role('textbox',name='Write a comment',exact=True);await expect(text).to_be_enabled();await expect(tq.get_by_role('button',name='Confirm',exact=True)).to_have_count(0)
   await text.fill('@Tay');await expect(tq.get_by_role('option',name='Mention Taylor Reed (Front Desk name)',exact=True)).to_be_visible()
   await text.fill('@Chen');await expect(tq.get_by_role('option',name='Mention Alex Chen (Person)',exact=True)).to_be_visible()
   assert not te,te;await tc.unroute_all(behavior='ignoreErrors');await tc.close()
   results.append({'width':width,'nameConfirmationInsideBorder':True,'nameWidth10ch':True,'nameThenFrontDesk':True,'labelStylingPreserved':True,'sessionOnly':True,'registeredNameAndSurnameMentions':True,'replyAndGiphyPost':True,'browserErrors':0});print(json.dumps(results[-1]),flush=True)
  await browser.close()
 OUT.joinpath('staff-notes-name-results.json').write_text(json.dumps(results,indent=2))
asyncio.run(main())
