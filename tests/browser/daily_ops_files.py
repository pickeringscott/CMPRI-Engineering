from cmpri_fixture import *

DAY='2026-11-06'
GUEST=f'In House Guest List Details_CMPRI_{DAY}_10-00-00.csv'
ARRIVAL=f'Housekeeping Arrivals_CMPRI_{DAY}_10-00-00.csv'
SCAN=ARRIVAL.replace('.csv','.png')
CSV=f'ROOM NUMBER,GUEST NAME,ARRIVAL,DEPARTURE,NIGHTS\n101,Current Guest,{DAY},2026-11-08,2'
ARRIVALS='ROOM NUMBER,GUEST NAME,PREFERENCES\n,Unassigned Guest,High floor\n101,Next Guest,High floor'

async def main():
 results=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [390,1440]:
   context=await browser.new_context(viewport={'width':width,'height':950},is_mobile=width<640,has_touch=width<640);await install(context,'chief_engineer');calls=[];fail_once=True
   async def guest_reports(route):
    nonlocal fail_once
    body=route.request.post_data_json;calls.append({'kind':'reports','body':body})
    if not body['validateOnly'] and fail_once:
     fail_once=False;await route.fulfill(status=503,content_type='application/json',body='{"error":"Fixture save unavailable"}');return
    data={'date':DAY,'previousId':'previous-fixture','rows':[{'room':'101','guest_name':'Current Guest','room_status':'Occupied','company':'','pets':0,'vip':False,'guest_arrival_date':DAY,'checkout_date':'2026-11-08','checkout_time':'11:00:00'}],'import_id':'import-fixture'}
    await route.fulfill(content_type='application/json',body=json.dumps(data))
   async def unexpected_extract(route):
    calls.append({'kind':'extract'});await route.fulfill(status=500,content_type='application/json',body='{"error":"Unexpected server image extraction"}')
   await context.route('**/api/room-operations/guest-reports',guest_reports);await context.route('**/api/room-operations/guest-reports/extract',unexpected_extract)
   page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));await page.goto(BASE+'/engineering/room-operations');await page.get_by_role('button',name='Expand upload form').click(timeout=60000)
   panel=page.get_by_role('region',name='Upload Room Operations',exact=True);picker=panel.get_by_role('group',name='Report files');add=picker.get_by_role('button',name='Drag/add files here',exact=True);submit=picker.get_by_role('button',name='Submit',exact=True);await expect(submit).to_be_disabled()
   # The CSV import picker never submits image bytes to the legacy server OCR route.
   image=await page.evaluate_handle("args=>{const d=new DataTransfer();d.items.add(new File([args.bytes],args.name,{type:'image/png'}));return d}",{'bytes':'fictional image','name':SCAN})
   await picker.dispatch_event('drop',{'dataTransfer':image});await expect(panel.get_by_role('alert')).to_contain_text('Choose CSV report files');assert calls==[]
   await panel.get_by_text('Read a report image or PDF locally',exact=True).click();await expect(panel.get_by_role('heading',name='Read text on this device')).to_be_visible()
   async def choose(name,text):
    async with page.expect_file_chooser() as chooser:await add.click()
    await (await chooser.value).set_files({'name':name,'mimeType':'text/csv','buffer':text.encode()})
   await choose(GUEST,CSV);await expect(picker.get_by_text('1 report selected')).to_be_visible();assert calls==[]
   data=await page.evaluate_handle("args=>{const d=new DataTransfer();d.items.add(new File([args.text],args.name,{type:'text/csv'}));return d}",{'text':ARRIVALS,'name':ARRIVAL})
   await picker.dispatch_event('drop',{'dataTransfer':data});await expect(picker.get_by_text('2 reports selected')).to_be_visible();assert calls==[]
   await choose(ARRIVAL,ARRIVALS);await expect(panel.get_by_role('alert')).to_contain_text('one file for each report type');assert calls==[]
   await submit.click();await page.get_by_role('heading',name=f'Review {DAY} — 1 Rooms',exact=True).wait_for();assert [c['kind'] for c in calls]==['reports'];assert calls[-1]['body']['validateOnly'] is True
   assert [f['name'] for f in calls[-1]['body']['files']]==[GUEST,ARRIVAL]
   confirm=page.get_by_role('button',name='Confirm Import',exact=True);await confirm.click();await expect(panel.get_by_role('alert')).to_have_text('Fixture save unavailable');await expect(picker.get_by_text('2 reports selected')).to_be_visible();await confirm.click();await expect(page.get_by_text('Room Reports Imported.',exact=True)).to_be_visible();await expect(submit).to_be_disabled()
   commits=[c for c in calls if c['kind']=='reports' and not c['body']['validateOnly']];assert len(commits)==2 and all(c['body']['previousId']=='previous-fixture' for c in commits)
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');assert not errors,errors
   results.append({'width':width,'csvOnlyImportAndLocalOcrSeparationPassed':True});print(json.dumps(results[-1]),flush=True);await context.close()
  context=await browser.new_context();await install(context,'manager');page=await context.new_page();await page.goto(BASE+'/engineering/room-operations');await page.get_by_role('heading',name='Daily Room Operations',exact=True).wait_for();await page.wait_for_timeout(500);assert await page.get_by_role('group',name='Upload Room Ops').count()==0;await context.close();await browser.close()
 OUT.joinpath('daily-ops-files.json').write_text(json.dumps(results,indent=2))

asyncio.run(main())
