from cmpri_fixture import *

DAY='2026-11-06'
GUEST=f'In House Guest List Details_CMPRI_{DAY}_10-00-00.csv'
ARRIVAL=f'Housekeeping Arrivals_CMPRI_{DAY}_10-00-00.csv'
SCAN=ARRIVAL.replace('.csv','.png')
CSV=f'ROOM NUMBER,GUEST NAME,ARRIVAL,DEPARTURE,NIGHTS\n101,Current Guest,{DAY},2026-11-08,2'
ARRIVALS='ROOM NUMBER,GUEST NAME,PREFERENCES\n,Unassigned Guest,High floor\n101,Next Guest,High floor\n101,Next Guest,Extra pillows'

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
   async def extract(route):
    calls.append({'kind':'extract'});await route.fulfill(content_type='application/json',body=json.dumps({'name':SCAN,'text':ARRIVALS,'reviewRequired':True}))
   await context.route('**/api/room-operations/guest-reports',guest_reports);await context.route('**/api/room-operations/guest-reports/extract',extract)
   page=await context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));await page.goto(BASE+'/engineering/room-operations');await page.get_by_role('button',name='Upload Room Ops',exact=True).click(timeout=60000)
   panel=page.get_by_role('region',name='Upload Room Operations',exact=True);picker=page.get_by_role('group',name='Report files');add=picker.get_by_role('button',name='Drag/add files here',exact=True);submit=picker.get_by_role('button',name='Submit',exact=True);await expect(submit).to_be_disabled()
   async def choose(name,text,mime='text/csv'):
    async with page.expect_file_chooser() as chooser:await add.click()
    await (await chooser.value).set_files({'name':name,'mimeType':mime,'buffer':text.encode() if isinstance(text,str) else text})
   await choose(GUEST,CSV);await expect(picker.get_by_role('listitem')).to_have_count(1);assert calls==[]
   data=await page.evaluate_handle("args=>{const d=new DataTransfer();d.items.add(new File([args.text],args.name,{type:'text/csv'}));return d}",{'text':ARRIVALS,'name':ARRIVAL})
   await picker.dispatch_event('drop',{'dataTransfer':data});await expect(picker.get_by_role('listitem')).to_have_count(2);assert calls==[]
   remove=picker.get_by_role('button',name='Remove '+GUEST,exact=True);assert await remove.evaluate('e=>getComputedStyle(e).color')=='rgb(248, 113, 113)';await remove.click();await expect(picker.get_by_role('listitem')).to_have_count(1)
   await choose(GUEST,CSV);await expect(picker.get_by_role('listitem')).to_have_count(2);await choose(ARRIVAL,ARRIVALS);await expect(panel.get_by_role('alert')).to_contain_text('one file for each report type');await expect(picker.get_by_role('listitem')).to_have_count(2);assert calls==[]
   await picker.get_by_role('button',name='Remove '+ARRIVAL,exact=True).click();await choose(SCAN,GIF,'image/png');assert calls==[]
   assert (await submit.bounding_box())['height']<=24
   await submit.click();await page.get_by_role('heading',name=f'Review {DAY} — 1 Rooms',exact=True).wait_for();assert [c['kind'] for c in calls]==['extract','reports'];assert calls[-1]['body']['validateOnly'] is True
   # Removing a staged file invalidates its preview; the next submission cannot include it.
   await picker.get_by_role('button',name='Remove '+SCAN,exact=True).click();await expect(page.get_by_role('button',name='Confirm Import',exact=True)).to_have_count(0);await submit.click();confirm=page.get_by_role('button',name='Confirm Import',exact=True);await confirm.wait_for();assert [f['name'] for f in calls[-1]['body']['files']]==[GUEST]
   await confirm.click();await expect(panel.get_by_role('alert')).to_have_text('Fixture save unavailable');await expect(picker.get_by_role('listitem')).to_have_count(1);await confirm.click();await expect(page.get_by_text('Room Reports Imported.',exact=True)).to_be_visible();await expect(picker.get_by_role('listitem')).to_have_count(0);await expect(submit).to_be_disabled()
   commits=[c for c in calls if c['kind']=='reports' and not c['body']['validateOnly']];assert len(commits)==2 and all(c['body']['previousId']=='previous-fixture' for c in commits)
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');assert not errors,errors
   results.append({'width':width,'clickDropRemoveStageSubmitReviewRetryPassed':True});print(json.dumps(results[-1]),flush=True);await context.close()
  # General Manager keeps the existing read-only Daily Ops access.
  context=await browser.new_context();await install(context,'manager');page=await context.new_page();await page.goto(BASE+'/engineering/room-operations');await page.get_by_role('heading',name='Daily Room Operations',exact=True).wait_for();await page.wait_for_timeout(500);assert await page.get_by_role('button',name='Upload Room Ops',exact=True).count()==0;await context.close();await browser.close()
 OUT.joinpath('daily-ops-files.json').write_text(json.dumps(results,indent=2))

asyncio.run(main())
