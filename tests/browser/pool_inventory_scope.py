"""Pool chemicals are lazy, location-scoped and retain Remarks/save behavior."""
from cmpri_fixture import *
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  for width in [1440,390,320]:
   ctx=await browser.new_context(viewport={'width':width,'height':1000},reduced_motion='reduce');await install(ctx,'chief_engineer')
   room='00000000-0000-4000-8000-000000000021';item='00000000-0000-4000-8000-000000000022';facility={'id':'00000000-0000-4000-8000-000000000023','pool_name':'Pool','facility_name':'Pool','sanitizer':'Bromine'}
   row={'id':'00000000-0000-4000-8000-000000000024','revision':1,'log_date':'2026-11-09','pool_facility_id':facility['id'],'ph_am':7.4,'sanitizer_band_am':'3-6','temperature_f':84,'flow_rate_gpm':55,'main_drain_visible':True,'filter_backwashed':False,'closure_condition':False,'closure_reason':'','remarks':'Routine check','completed_by_initials':'SP','updated_at':'2026-11-09T16:00:00Z','manual_closure':False}
   supply={'id':item,'item_name':'Bromine','quantity_on_hand':25,'quantity_reserved':2,'unit_of_measure':'LB'}
   reads=[];writes=[];all_requests=[]
   async def pool(route):
    nonlocal row
    if route.request.method=='GET':return await route.fulfill(json={'facility':facility,'facilities':[facility],'log':row,'can_edit':True,'can_edit_saved':True})
    b=route.request.post_data_json;writes.append(b);supply['quantity_on_hand']-=1;row={**row,**b,'revision':2};await route.fulfill(json={'log':row,'closure_required':False})
   async def supplies(route):reads.append(1);await route.fulfill(json={'location':{'id':room,'name':'Pool Pump Room'},'items':[supply]})
   await ctx.route('**/api/pool-log?*',pool);await ctx.route('**/api/pool-log',pool);await ctx.route('**/api/pool-log/supplies',supplies)
   page=await ctx.new_page();page.on('request',lambda r:all_requests.append(r.url));errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+'/engineering/pool-log');summary=page.locator('details.pool-chemical-usage summary');await expect(summary).to_be_visible(timeout=30000);await page.wait_for_timeout(200);assert not reads,'Chemical inventory must not load before expansion'
   await summary.click();await expect(page.get_by_text('Pool Pump Room',exact=True)).to_be_visible();await expect(page.get_by_label('Pool chemical supply',exact=True).locator('option')).to_have_count(2)
   await page.get_by_label('Pool chemical supply',exact=True).select_option(item);units=page.get_by_label('Pool chemical usage unit',exact=True);assert await units.locator('option').all_text_contents()==['LB','LB','OZ','G','KG']
   await units.select_option('OZ');await page.get_by_label('Pool chemical quantity used',exact=True).fill('16');await page.get_by_role('button',name='Add chemical use',exact=True).click()
   remarks=page.locator('label').filter(has_text='Remarks / actions taken').locator('textarea');await expect(remarks).to_have_value('Routine check\nChemical used: 16 OZ Bromine.')
   await page.get_by_role('button',name="Add to today's pool log",exact=True).click();await expect(page.get_by_text('Pool log saved to the database.',exact=False)).to_be_visible()
   assert len(writes)==1 and writes[0]['chemical_uses'][0]['item']==item and writes[0]['chemical_uses'][0]['unit']=='OZ'
   await expect(page.get_by_label('Pool chemical supply',exact=True).locator('option').last).to_contain_text('22 LB available')
   assert not any('/api/ai/' in url or '/api/assistant' in url or '/api/chat' in url for url in all_requests),all_requests
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
   await page.screenshot(path=str(OUT/f'pool-scoped-chemicals-{width}.png'),full_page=True);await ctx.close();print(json.dumps({'width':width,'no_inventory_fetch_before_open':True,'pool_pump_room_label':True,'contextual_units':True,'remarks_and_usage_saved':True,'no_ai_calls':True,'no_overflow':True}))
  await browser.close()
asyncio.run(main())
