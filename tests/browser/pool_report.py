"""Printable annual report, including the desktop iframe's parent-owned fetch.
All API/auth responses are fixtures; no production data is read or changed.
Run against a built app with CMPRI_UI_BASE set (defaults to localhost:3116).
"""
from cmpri_fixture import *
import subprocess

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  results=[]
  for embedded,width in [(True,1440),(False,1440),(True,390),(False,390)]:
   ctx=await browser.new_context(viewport={'width':width,'height':950})
   await install(ctx,'chief_engineer')
   facility={'id':'00000000-0000-4000-8000-000000000020','pool_name':'Pool','facility_name':'Residence Inn','city':'Champaign','sanitizer':'Bromine'}
   row={'id':'00000000-0000-4000-8000-000000000021','revision':1,'log_date':'2026-11-16','pool_facility_id':facility['id'],'ph_am':7.4,'sanitizer_band_am':'3-6','ph_pm':7.6,'sanitizer_band_pm':'5-10','temperature_f':84,'flow_rate_gpm':55,'main_drain_visible':True,'filter_backwashed':False,'closure_condition':False,'closure_reason':'','remarks':'Routine check','completed_by_initials':'TEST','updated_at':'2026-11-16T15:00:00Z','manual_closure':False}
   history_requests=[]
   async def pool_route(route):
    assert route.request.method=='GET','Report preparation must not write readings'
    if parse_qs(urlparse(route.request.url).query).get('history')==['1']:
     history_requests.append(route.request.url)
     return await route.fulfill(json={'facility':facility,'facilities':[facility],'history':[row]})
    await route.fulfill(json={'facility':facility,'facilities':[facility],'log':row,'can_edit':True,'can_edit_saved':True,'daily_entries':[]})
   await ctx.route('**/api/pool-log?*',pool_route)
   await ctx.route('**/pool-report-test-host',lambda r:r.fulfill(content_type='text/html',body='<html><body style="margin:0"><iframe title="Pool Log" src="/engineering/pool-log" style="width:100%;height:940px;border:0"></iframe></body></html>'))
   page=await ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(BASE+('/pool-report-test-host' if embedded else '/engineering/pool-log'))
   view=page.frame_locator('iframe') if embedded else page
   report=view.get_by_role('region',name='Swimming facility report')
   await expect(report).to_be_visible(timeout=30000)
   await view.get_by_label('Report start month (MM/YY)').fill('01/26')
   await view.get_by_label('Report end month (MM/YY)').fill('12/26')
   if embedded:
    # The app's shared cache fetches in the parent realm even for static assets.
    frame=page.frames[1]
    local=await frame.evaluate('''async () => {
     const bytes=await (await fetch('/forms/swimming-facility-daily-operational-report.pdf')).arrayBuffer();
     return bytes instanceof ArrayBuffer;
    }''')
    assert local is False,'Fixture must exercise a buffer from the parent window'
   await report.get_by_role('button',name='Prepare printable report').click()
   if os.environ.get('POOL_REPORT_REPRODUCE')=='1':
    await expect(report.get_by_role('alert')).to_contain_text('NaN')
    print('Reproduced iframe PDF error:',await report.get_by_role('alert').inner_text())
    await browser.close();return
   await expect(report.get_by_role('link',name='Download PDF')).to_be_visible(timeout=30000)
   assert await report.get_by_role('alert').count()==0
   async with page.expect_download() as download_event:
    await report.get_by_role('link',name='Download PDF').click()
   download=await download_event.value
   path=OUT/f'pool-report-{width}-{"embedded" if embedded else "standalone"}.pdf'
   await download.save_as(path)
   assert path.read_bytes().startswith(b'%PDF-')
   info=subprocess.check_output(['pdfinfo',str(path)],text=True)
   assert 'Pages:           12' in info,info
   assert await report.evaluate('(el) => el === el.parentElement.lastElementChild'),'Report must be at the bottom'
   await view.get_by_role('button',name='View entire pool log').click()
   await expect(view.get_by_role('button',name='Hide entire pool log')).to_be_visible()
   assert await report.evaluate('(el) => el === el.parentElement.lastElementChild'),'Expanded history must stay above report'
   assert not errors,errors
   results.append({'embedded':embedded,'width':width,'pages':12,'report_at_bottom':True})
   await ctx.close()
  await browser.close();print(json.dumps(results))

asyncio.run(main())
