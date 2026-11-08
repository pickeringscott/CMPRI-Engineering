"""Local synthetic Drive acquisition -> existing preview -> explicit confirmation."""
from cmpri_fixture import *

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390]:
   context=await browser.new_context(viewport={'width':width,'height':960})
   await install(context,'chief_engineer')
   state={'mode':'success','preview':0,'commits':0,'fetches':0}
   files=[{'name':name+'_CMPRI_2026-11-08_10-52-59.csv','text':'fixture'} for name in ['In House Guest List Details','Housekeeping Departures','Housekeeping Arrivals']]
   row={'room':'101','guest_name':'Sample Guest','room_status':'Occupied','checkout_date':'2026-11-09','checkout_time':'11:00:00','company':'Sample Group','pets':0}
   async def route(r):
    path=urlparse(r.request.url).path
    if path=='/api/room-operations/guest-reports/drive':
     state['fetches']+=1
     return await r.fulfill(json={'files':[] if state['mode']=='empty' else files})
    if path=='/api/room-operations/guest-reports':
     body=r.request.post_data_json
     assert body['files']==files
     if body['validateOnly']:
      state['preview']+=1
      if state['mode']=='invalid':return await r.fulfill(status=422,json={'error':'Optional reports may be at most five minutes earlier than the guest list.'})
     else:
      assert body['previousId']=='previous-import'
      state['commits']+=1
     return await r.fulfill(json={'ok':True,'date':'2026-11-08','rows':[row],'previousId':'previous-import','import_id':'new-import'})
    if path=='/api/room-operations':return await r.fulfill(json={'rows':[],'date':'2026-11-08'})
    return await r.fallback()
   await context.route('**/api/room-operations**',route)
   await context.route_web_socket('**/realtime/v1/websocket*',lambda socket:socket.close())
   page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering/room-operations')
   fetch=page.get_by_role('button',name='Drive',exact=True)
   await fetch.wait_for(timeout=60000)
   date=page.get_by_label('Report Date',exact=True)
   initial_date=await date.input_value()
   await page.wait_for_timeout(500)
   assert state['fetches']==0
   await expect(page.get_by_label('Report format',exact=True)).to_have_count(0)
   await fetch.click()
   await expect(page.get_by_role('button',name='Confirm Import',exact=True)).to_be_visible()
   await expect(page.locator('#room-ops-upload-form ul')).to_have_count(0)
   assert await date.input_value()==initial_date
   await page.screenshot(path=str(OUT/f'room-ops-upload-{width}.png'))
   assert state['preview']==1 and state['commits']==0,state
   await page.get_by_role('button',name='Confirm Import',exact=True).click()
   await expect(page.get_by_text('Room Reports Imported.',exact=True)).to_be_visible()
   assert state['commits']==1,state
   state['mode']='empty';await fetch.click()
   await expect(page.get_by_text('No newer reports for today were found in the attachment folder.',exact=True)).to_be_visible()
   state['mode']='invalid';await fetch.click()
   await expect(page.locator('#room-ops-upload-form [role=alert]')).to_contain_text('five minutes earlier')
   await expect(page.get_by_role('button',name='Confirm Import',exact=True)).to_have_count(0)
   assert state['commits']==1 and not errors,(state,errors)
   state['mode']='success'
   async with page.expect_file_chooser() as chooser:
    await page.get_by_role('button',name='File',exact=True).click()
   await (await chooser.value).set_files([{'name':f['name'],'mimeType':'text/csv','buffer':f['text'].encode()} for f in files])
   await expect(page.get_by_text('3 reports selected',exact=True)).to_be_visible()
   before=state['fetches']
   await page.get_by_role('button',name='Submit',exact=True).click()
   await expect(page.get_by_role('button',name='Confirm Import',exact=True)).to_be_visible()
   assert state['fetches']==before
   await expect(page.get_by_text('Report format',exact=True)).to_have_count(0)
   await context.close()
  await browser.close()
 print('PASS desktop/mobile: Drive fetch, existing validation preview, explicit confirmation, no newer files, validation rejection; no production writes.')

asyncio.run(main())
