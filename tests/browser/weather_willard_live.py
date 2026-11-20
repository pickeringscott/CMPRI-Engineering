"""Native Willard board acceptance with intercepted flight/provider fixtures.

No request reaches an airport service, database, notification API or tracker.
These checks prove rendering and lifecycle behavior, never live flight coverage.
"""
import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from playwright.async_api import async_playwright
from weather_current_notices import CurrentFixtures, context_for
from weather_dashboard_preview import PREVIEW, dashboard_weather_launcher, require, wait_for, weather_frame
from weather_map_basemaps import set_visibility

TRACKER = 'https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9&compact=1'


class Flights(CurrentFixtures):
    def willard(self):
        result = super().willard()
        rows = result['boards']['arrivals']['flights']
        if len(rows) > 2:
            rows[2]['status'] = 'Estimated 18:22'
        return result


async def expand(frame, opened):
    host = frame.locator('#willardAirport')
    if await host.evaluate('el=>el.open') != opened:
        await host.locator(':scope > summary').click()
    await wait_for(frame, """opened=>{const a=weatherPreview.getState().airport;
      return a.expanded===opened && a.iframeMounted===opened && a.clockRunning===opened;}""", opened)


async def finished(frame):
    await wait_for(frame, "() => {const a=weatherPreview.getState().airport;return !a.flightPending && !['loading'].includes(a.boardStatus);}")


async def run_case(browser, base, output, width, height, role):
    feed = Flights(); feed.release(); feed.willard_modes['arrivals'] = 'unavailable'
    context, page, errors, external, mutations = await context_for(browser, width, height, feed, role)
    await context.route('**/api/willard-flights**', feed.route)
    tracker_reads = []
    async def tracker(route):
        require(route.request.url == TRACKER and route.request.method == 'GET', 'Tracker template changed')
        tracker_reads.append({'url':route.request.url,'method':route.request.method})
        await route.fulfill(content_type='text/html',body='<!doctype html><p>TRACKER DOCUMENT FIXTURE · NO AIRCRAFT DATA</p>')
    await context.route('https://avioadsb.org/embed/map?**', tracker)
    evidence = {'viewport':[width,height],'role':role,'fixtureOnly':True}
    chief = role == 'chief_engineer'
    suffix = role + '-' + str(width)
    try:
        await page.goto(base+'/engineering',wait_until='domcontentloaded')
        launcher = await dashboard_weather_launcher(page)
        await launcher.wait_for(state='visible',timeout=60000)
        require(feed.willard_calls==0 and not tracker_reads,'Airport requested before Weather opened')
        await launcher.click(); frame=await weather_frame(page)
        await frame.evaluate("""() => {
          window.__willardFetchAudit=[];const original=window.fetch;
          window.fetch=function(input,options){
            if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/willard-flights'){
              const row={method:options?.method||'GET',aborted:false};window.__willardFetchAudit.push(row);
              options?.signal?.addEventListener('abort',()=>{row.aborted=true;});
            }return original.call(this,input,options);
          };
        }""")
        airport=frame.locator('#willardAirport'); board=airport.locator('[data-willard-board]')
        state=await frame.evaluate('weatherPreview.getState().airport')
        require(not state['expanded'] and not state['iframeMounted'] and not state['clockRunning']
                and feed.willard_calls==0 and not tracker_reads,'Collapsed airport performs work')
        require(await board.get_attribute('data-style')=='london'
                and await board.get_attribute('data-time-format')==('24h' if chief else '12h'), 'Wrong board style/role clock')
        feed.hold_willard=True;feed.willard_gate.clear();feed.willard_pending.clear()
        await expand(frame,True);await asyncio.wait_for(feed.willard_pending.wait(),5)
        await wait_for(frame,"weatherPreview.getState().airport.trackerStatus==='document-loaded'")
        require(await airport.locator('tbody [data-flight]').count()==0,'Held source exposed invented flight rows')
        feed.hold_willard=False;feed.willard_gate.set();await finished(frame)
        arrivals=airport.locator('[data-willard-arrivals]');departures=airport.locator('[data-willard-departures]')
        require(await arrivals.get_attribute('data-availability')=='unavailable'
                and 'Flight data unavailable' in await arrivals.inner_text()
                and 'No flights listed' not in await arrivals.inner_text(), 'Unavailable arrivals became empty/all-clear')
        require(await departures.locator('tr[data-flight]').count()==2,'Working departures lost to partial source failure')
        evidence['partialAvailabilityHonest']=True
        first=feed.willard_calls
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(feed.willard_calls==first,'Immediate re-expansion ignored60-second memory cache')
        await page.clock.fast_forward(61010)
        require(feed.willard_calls==first,'Expanded airport polls after cache expiration')
        feed.willard_modes['arrivals']='live'
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(feed.willard_calls==first+1,'Expired cache did not refresh on next expansion')
        expected=feed.willard()['boards']
        for kind in ['arrivals','departures']:
            section=airport.locator('[data-willard-'+kind+']')
            require(await section.get_attribute('data-availability')=='live','Verified fixture board is notlive')
            for source in expected[kind]['flights']:
                row=section.locator('tr[data-flight="'+source['id']+'"]')
                hours=int(source['time'][:2]);wall=source['time'] if chief else str(hours%12 or 12)+source['time'][2:]+(' AM' if hours<12 else ' PM')
                require(await row.locator('.wa-flight-time').inner_text()==wall,'Published wall time was shifted/ignored')
                require(await row.locator('.wa-flight-time').get_attribute('datetime')==source['date']+'T'+source['time'], 'Published row date/time lost')
                require(await row.locator('.wa-flight-number').inner_text()==source['flight']
                        and await row.locator('.wa-airline').inner_text()==source['airline']
                        and await row.locator('.wa-airport-iata').inner_text()==source['iata'], 'Published flight/airline/route lost')
                status=source['status'] if chief else source['status'].replace('18:22','6:22 PM')
                require(await row.locator('td').last.inner_text()==status,'Provider status changed or role clock omitted')
                require(await row.locator('time').count()==1,'Renderer invented an ETA/actual timestamp')
        shares=await arrivals.locator('tr[data-flight]').evaluate_all("els=>els.slice(0,2).map(el=>({flight:el.querySelector('.wa-flight-number').textContent,time:el.querySelector('time').textContent,iata:el.querySelector('.wa-airport-iata').textContent}))")
        require({row['flight'] for row in shares}=={'AA1234','BA5678'} and len({(row['time'],row['iata']) for row in shares})==1,'Codeshare rows were merged')
        require(await departures.locator('tr[data-flight]').last.locator('.wa-flight-date').inner_text(), 'Next-day published date is hidden')
        require(await airport.locator('select,input').count()==0,'Airport selectors/search returned')
        require(not re.search(r'SAMPLE|DEMO|API key|no.key|token',await airport.inner_text(),re.I),'Implementation/sample text in product UI')
        require(await board.evaluate("el=>getComputedStyle(el).backgroundColor")=='rgb(0, 0, 0)','London board palette changed')
        attrs=await airport.locator('[data-willard-tracker]>iframe').evaluate("el=>Object.fromEntries(['src','width','height','loading','referrerpolicy'].map(k=>[k,el.getAttribute(k)]))")
        require(attrs=={'src':TRACKER,'width':'100%','height':'450','loading':'lazy','referrerpolicy':'strict-origin-when-cross-origin'},'Provider embed parameters/attributes changed')
        require(await board.evaluate('el=>el.scrollWidth<=el.clientWidth+1'),'London board overflows viewport')
        await board.scroll_into_view_if_needed();await page.screenshot(path=str(output/('willard-live-board-'+suffix+'.png')),full_page=True)
        await airport.locator('[data-willard-tracker]').scroll_into_view_if_needed();await page.screenshot(path=str(output/('willard-compact-tracker-'+suffix+'.png')),full_page=True)
        evidence['publishedRows']={'codesharesPreserved':True,'noInventedEta':True,'nextDayRetained':True,'roleClock':('24h' if chief else '12h'),'tracker':attrs}
        calls=feed.willard_calls
        await page.clock.fast_forward(61010)
        require(feed.willard_calls==calls,'Expanded airport started interval polling')
        feed.willard_modes['arrivals']='unavailable'
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(await arrivals.get_attribute('data-availability')=='stale'
                and 'Last known' in await arrivals.locator('.wa-board-status').inner_text()
                and await arrivals.locator('tr[data-flight]').count()==3,'Failed refresh dropped prior rows or treated stale data as live')
        feed.willard_empty.add('departures');await page.clock.fast_forward(61010)
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(await departures.get_attribute('data-availability')=='live'
                and await departures.locator('tr[data-flight]').count()==0
                and 'No flights listed by source' in await departures.inner_text(),'Explicit source empty state became unavailable or fabricated rows')
        evidence['failedRefreshAndExplicitEmpty']={'priorRowsStale':True,'workingBoardIndependent':True,'sourceEmptyDistinctFromUnknown':True}
        # Expired-cache reads are stopped by each foreground lifecycle boundary.
        for boundary in ['collapse','hidden','close']:
            await expand(frame,False);await page.clock.fast_forward(61010)
            feed.hold_willard=True;feed.willard_gate.clear();feed.willard_pending.clear()
            await expand(frame,True);await asyncio.wait_for(feed.willard_pending.wait(),5)
            require(await frame.evaluate('weatherPreview.getState().airport.flightPending'),'Held flight read notpending')
            if boundary=='collapse':await expand(frame,False)
            elif boundary=='hidden':await set_visibility(frame,False)
            else:
                native=page.locator('[data-cmpri-desktop-window="'+PREVIEW+'"]')
                await native.get_by_role('button',name='Close Weather',exact=True).click()
                await page.locator('iframe[src*="'+PREVIEW+'"]').wait_for(state='hidden')
            await wait_for(frame,'!weatherPreview.getState().airport.flightPending && !weatherPreview.getState().airport.iframeMounted && !weatherPreview.getState().airport.clockRunning')
            require(await frame.evaluate('window.__willardFetchAudit.at(-1).aborted'),'Lifecycle boundary did not abort underlying flight fetch: '+boundary)
            calls=feed.willard_calls;feed.hold_willard=False;feed.willard_gate.set();await asyncio.sleep(.05)
            require(feed.willard_calls==calls,'Inactive airport made another flight request')
            if boundary=='hidden':
                await set_visibility(frame,True);await finished(frame)
                await expand(frame,False)
        calls=feed.willard_calls;await page.clock.fast_forward(120010)
        require(feed.willard_calls==calls,'Closed Weather continued flight requests')
        state=await frame.evaluate('weatherPreview.getState().airport')
        require(not state['backgroundPolling'] and state['notifications']==0 and state['aircraftCoverageVerified'] is False,'Airport claims coverage/polling/notifications')
        require(not errors and not external and not mutations,'Unexpected script/external/application activity: '+str([errors,external,mutations]))
        require(await page.evaluate('window.__weatherReviewForbidden.length===0') and await frame.evaluate('window.__weatherReviewForbidden.length===0'),'Airport requested permissions/GPS/push')
        evidence.update(passed=True,flightReads=feed.willard_calls,trackerDocumentReads=len(tracker_reads),cache60Seconds=True,
            noIntervalPolling=True,abortOnCollapseHiddenClose=True,errors=errors,externalRequests=external,applicationMutations=mutations)
        return evidence
    finally:
        feed.release();await context.close()


async def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--base',required=True)
    parser.add_argument('--output',default='/workspace/artifacts/weather-final-live-airport');args=parser.parse_args()
    require(urlparse(args.base).hostname in ['127.0.0.1','localhost'],'Only intercepted localpreview permitted')
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True);results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        for width,height in [(1440,1000),(390,844)]:
            for role in ['chief_engineer','system_admin']:
                try:
                    result=await run_case(browser,args.base.rstrip('/'),output,width,height,role)
                    print(f'PASS Willard {role} {width}×{height}',flush=True)
                except Exception as error:
                    result={'viewport':[width,height],'role':role,'passed':False,'error':str(error),'fixtureOnly':True}
                    print(f'FAIL Willard {role} {width}×{height}: {error}',flush=True)
                results.append(result)
        await browser.close()
    (output/'report.json').write_text(json.dumps({'fixtureOnly':True,'liveAircraftCoverageVerified':False,'results':results},indent=2))
    if not all(row['passed'] for row in results):raise SystemExit(1)


if __name__=='__main__':asyncio.run(main())
