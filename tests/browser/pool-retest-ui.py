"""Local production-build UI checks; every API and external request is intercepted."""
import asyncio,json,time,os
from urllib.parse import urlparse
from playwright.async_api import async_playwright,expect
BASE=os.environ.get('POOL_TEST_BASE_URL','http://127.0.0.1:3112')
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  results=[]
  for width,hold in [(1440,False),(390,False),(390,True),(390,None)]:
   ctx=await browser.new_context(viewport={'width':width,'height':950})
   session={'access_token':'fixture-only','refresh_token':'fixture-only','expires_at':int(time.time())+7200,'expires_in':7200,'token_type':'bearer','user':{'id':'fixture'}}
   await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",'+json.dumps(json.dumps(session))+');')
   facility={'id':'00000000-0000-0000-0000-000000000001','pool_name':'Fixture','facility_name':'Fixture','sanitizer':'Bromine'}
   row={'id':'fixture','revision':1,'log_date':'2026-10-12','pool_facility_id':facility['id'],'ph_am':7.6,'sanitizer_am':0,'sample_location_am':'shallow','temperature_f':84,'flow_rate_gpm':55,'main_drain_visible':True,'filter_backwashed':False,'closure_condition':True,'closure_reason':'AM bromine zero; historical closure.','remarks':'','completed_by_initials':'TEST','updated_at':'2026-10-12T15:00:00Z','manual_closure':hold,'latest_test':{'period':'am','ph':7.6,'sanitizer':0,'sanitizer_band':None,'sample_location':'shallow'}}
   writes=[];retests=[];errors=[]
   async def route(r):
    nonlocal row
    u=urlparse(r.request.url)
    if u.hostname!='127.0.0.1':return await r.abort()
    if not u.path.startswith('/api/'):
     if r.request.method!='GET':return await r.abort()
     return await r.continue_()
    body={}
    if u.path=='/api/pool-log':
     if r.request.method=='POST':
      data=r.request.post_data_json;writes.append(data)
      sample=data.get('retest')
      latest={'period':'retest' if sample else 'pm','ph':sample['ph'] if sample else data['ph_pm'],'sanitizer':None,'sanitizer_band':sample['sanitizer_band'] if sample else data['sanitizer_band_pm'],'sample_location':'shared'}
      row={**row,**data,'revision':row['revision']+1,'sample_location_pm':'shared','latest_test':latest,'closure_condition':hold is not False}
      if sample:
       row['retest_submission']=sample;retests.append({**sample,'recorded_at':'2026-10-12T20:00:00Z','revision':row['revision']})
      body={'log':row,'closure_required':row['closure_condition'],'closure_reasons':[],'warnings':[]}
     else:body={'facility':facility,'facilities':[facility],'log':row,'retests':retests,'can_edit':True,'can_edit_saved':False}
    elif u.path=='/api/profile':body={'preferences':{'appearance':'dark','language':'en'}}
    await r.fulfill(content_type='application/json',body=json.dumps(body))
   await ctx.route('**/*',route);page=await ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering/pool-log')
   await expect(page.get_by_role('combobox',name='PM pH',exact=True)).to_be_visible()
   await expect(page.locator('select[id^="pool-sample_location_"]')).to_have_count(0)
   await page.get_by_role('combobox',name='PM pH',exact=True).select_option('7.4')
   await page.get_by_role('combobox',name='PM bromine (ppm)',exact=True).select_option('3-6')
   await page.get_by_role('button',name="Add to today's pool log",exact=True).click()
   await expect(page.get_by_text('Current status for this log: '+('Open' if hold is False else 'CLOSED'),exact=True)).to_be_visible()
   assert len(writes)==1 and writes[0]['ph_am']==7.6 and writes[0]['sanitizer_am']==0
   assert row['closure_reason']=='AM bromine zero; historical closure.'
   await page.get_by_role('button',name='Record another test',exact=True).click()
   await page.locator('#pool-retest_ph').select_option('7.4')
   await page.get_by_role('button',name="Add to today's pool log",exact=True).click()
   assert len(writes)==1,'Partial sample must not POST'
   await page.locator('#pool-retest_band').select_option('3-6')
   await page.get_by_role('button',name="Add to today's pool log",exact=True).click()
   await expect(page.get_by_role('heading',name='Recorded additional tests')).to_be_visible()
   assert len(writes)==2 and writes[-1]['retest']['ph']==7.4
   assert writes[-1]['retest']['sanitizer_band']=='3-6'
   assert row['closure_condition']==(hold is not False)
   assert not errors,errors
   results.append({'width':width,'manual_hold':hold,'passing_pm_and_retest':True,'partial_blocked':True,'history_visible':True,'real_api_requests':0})
   await ctx.close()
  await browser.close();print(json.dumps(results))
asyncio.run(main())
