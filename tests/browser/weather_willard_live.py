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
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from playwright.async_api import async_playwright
from weather_current_notices import CurrentFixtures, context_for
from weather_dashboard_preview import PREVIEW, require, wait_for, weather_frame
from weather_map_basemaps import set_visibility

TRACKER = '/api/willard-tracker'


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
      return a.expanded===opened && a.trackerActive===opened && a.clockRunning===opened;}""", opened)


async def finished(frame):
    await wait_for(frame, "() => {const a=weatherPreview.getState().airport;return !a.flightPending && !['loading'].includes(a.boardStatus);}")


async def advance(page, feed, milliseconds):
    feed.now+=timedelta(milliseconds=milliseconds)
    await page.clock.fast_forward(milliseconds)


async def tracker_state(frame):
    return await frame.evaluate('weatherPreview.getState().airport.trackerState')


async def tracker_ready(frame):
    await wait_for(frame,"() => {const t=weatherPreview.getState().airport.trackerState;return t&&t.active&&t.pending===0&&t.pendingTiles===0&&t.queuedTiles===0&&t.tileCacheSize>0;}")


async def layout_pixel(frame,lat=40.065,lon=-88.22):
    return await frame.evaluate("""([lat,lon])=>{
      const t=weatherPreview.getState().airport.trackerState,c=document.querySelector('.wt-canvas');
      const point=cmpriWillardTracker.project(lat,lon,t.zoom),center=cmpriWillardTracker.project(t.center.lat,t.center.lon,t.zoom);
      const x=t.width/2+point.x-center.x,y=t.height/2+point.y-center.y,ratio=c.width/t.width;
      return {x,y,pixel:Array.from(c.getContext('2d').getImageData(Math.round(x*ratio),Math.round(y*ratio),1,1).data)};
    }""",[lat,lon])


async def layout_checks(page,frame,feed):
    host=frame.locator('[data-willard-tracker]')
    aerial=host.locator('[data-layer="aerial"]');layout=host.locator('[data-layer="layout"]')
    await wait_for(frame,"() => {const l=weatherPreview.getState().airport.trackerState.airportLayout;return l&&l.status==='available'&&!l.pending&&l.rendered===3;}")
    initial=await tracker_state(frame)
    require(initial['aerialImagery'] and initial['basemap']=='imagery' and initial['airportLayout']['enabled']
            and await aerial.get_attribute('aria-pressed')=='true' and await layout.get_attribute('aria-pressed')=='true',
            'Aerial Imagery and verified Airport Layout are not both selected by default')
    require(initial['imageryCaptureYear'] is None and 'Capture Year Unavailable' in await host.locator('.wt-imagery-year').inner_text(),
            'Historical aerial imagery invented a capture year')
    on=await layout_pixel(frame)
    await layout.click();off_state=await tracker_state(frame);off=await layout_pixel(frame)
    require(not off_state['airportLayout']['enabled'] and off_state['airportLayout']['rendered']==0
            and off_state['aerialImagery'] and off_state['markers']==initial['markers'] and off_state['airport']==initial['airport'],
            'Airport Layout toggle changed imagery, reported aircraft or the fixed CMI pin')
    require(max(abs(off['pixel'][i]-[173,80,42][i]) for i in range(3))<=2
            and max(abs(on['pixel'][i]-off['pixel'][i]) for i in range(3))>3,
            'Verified FAA footprint did not paint over the imagery or did not clear when disabled: '+str([on,off]))
    calls=feed.layout_calls
    await layout.click()
    await wait_for(frame,'weatherPreview.getState().airport.trackerState.airportLayout.rendered===3')
    require(feed.layout_calls==calls,'Re-enabling cached airport geometry caused another FAA read')
    await aerial.click();await tracker_ready(frame)
    topo=await tracker_state(frame);topo_pixel=await layout_pixel(frame,40.08,-88.1)
    require(topo['basemap']=='topo' and not topo['aerialImagery'] and topo['airportLayout']['enabled']
            and topo['airportLayout']['rendered']==3 and topo['markers']==initial['markers'],
            'Aerial toggle did not fall back to Topo independently of FAA layout/aircraft')
    require(max(abs(topo_pixel['pixel'][i]-[52,101,173][i]) for i in range(3))<=2,
            'Aerial-off reused the wrong tile dataset')
    await aerial.click();await tracker_ready(frame)
    restored=await tracker_state(frame)
    require(restored['basemap']=='imagery' and restored['airportLayout']['enabled']
            and restored['airportLayout']['rendered']==3,'Aerial-on lost Airport Layout selection')
    require(await host.locator('.wt-layout-source').inner_text()=='Airport Layout · Reference · FAA AIS',
            'FAA fixture lacks the generic, source-aware Airport Layout credit')
    for status in ['stale','unavailable']:
        feed.layout_status=status;await refresh_tracker(frame)
        await wait_for(frame,'status=>{const l=weatherPreview.getState().airport.trackerState.airportLayout;return l.status===status&&!l.pending;}',status)
        state=await tracker_state(frame);sample=await layout_pixel(frame)
        require(state['airportLayout']['rendered']==0 and state['aerialImagery'] and state['aircraftCount']==3
                and max(abs(sample['pixel'][i]-[173,80,42][i]) for i in range(3))<=2,
                'Stale/unavailable layout retained invented pixels or removed aircraft/imagery: '+str([state['airportLayout'],sample]))
        require(await host.locator('.wt-layout-status').is_visible()
                and status in (await host.locator('.wt-layout-status').inner_text()).lower(),
                'Missing/stale Airport Layout has no visible availability status')
    feed.layout_status='available';await refresh_tracker(frame)
    await wait_for(frame,'weatherPreview.getState().airport.trackerState.airportLayout.rendered===3')
    return {'bothDefaultOn':True,'independentSelectionAndCorrectTiles':True,'faaPixelsClearWhenDisabledOrUnknown':True,
        'sixHourLayoutCacheReused':True,'historicalImageryYearNotInvented':True,'on':on,'off':off}


async def refresh_tracker(frame):
    host=frame.locator('[data-willard-tracker]')
    prior=(await tracker_state(frame))['requests']
    await host.locator('[data-action="refresh"]').click()
    await wait_for(frame,'prior=>{const t=weatherPreview.getState().airport.trackerState;return t.requests>prior&&t.pending===0;}',prior)


async def native_map_checks(page,frame,feed,width,chief):
    host=frame.locator('[data-willard-tracker]');canvas=host.locator('.wt-canvas')
    await tracker_ready(frame)
    initial=await tracker_state(frame)
    require(initial['active'] and initial['status']=='live' and initial['aircraftCount']==3
            and initial['clockMode']==('24' if chief else '12'),'Native tracker lost fresh source positions or role clock')
    require(initial['tileParallelLimit']==4 and initial['tileCacheSize']>0
            and initial['basemap']=='imagery' and any(row['dataset']=='imagery' for row in feed.basemap_requests),
            'Tracker ground map did not decode official USGS aerial fixtures')
    layer_evidence=await layout_checks(page,frame,feed)
    supplied={row['hex']:row for row in feed.tracker()['aircraft']}
    require(len(initial['markers'])==3 and {row['kind'] for row in initial['markers']}=={'arrow','dot'}
            and all(row['lat']==supplied[row['hex']]['lat'] and row['lon']==supplied[row['hex']]['lon']
                    and row['track']==supplied[row['hex']]['track'] and not row['stale'] for row in initial['markers']),
            'Native tracker invented/predicted positions, omitted unknown-track dots or lost supplied heading')
    source=host.locator('.wt-source')
    require(await source.locator('.wt-provider').get_attribute('href')=='https://adsb.lol/?lat=40.0398&lon=-88.2762&zoom=9&hideSideBar='
            and 'opendatacommons.org/licenses/odbl' in await source.locator('.wt-license').get_attribute('href')
            and 'USGSImageryOnly' in await source.locator('.wt-usgs').get_attribute('href'), 'Tracker source/license/ground provenance missing')
    updated=await host.locator('.wt-updated').inner_text()
    require('CST' in updated and (bool(re.search(r'\b(?:AM|PM)\b',updated)) is (not chief)), 'Tracker timestamp ignores role clock')
    await canvas.scroll_into_view_if_needed()
    async def tap_plane(hexcode):
        state=await tracker_state(frame);marker=next(row for row in state['markers'] if row['hex']==hexcode)
        box=await canvas.bounding_box();x,y=box['x']+marker['x'],box['y']+marker['y']
        if width<640:await page.touchscreen.tap(x,y)
        else:await page.mouse.click(x,y)
        await host.locator('.wt-details').wait_for(state='visible')
    await tap_plane('a1a1a1')
    details=host.locator('.wt-details')
    detail_text=await details.inner_text()
    require(all(text in detail_text for text in ['TEST123','NTEST1','3,500 Ft','110 Kt','90°']),
            'Aircraft click/tap details lost supplied callsign, altitude, speed or heading')
    await details.locator('.wt-details-close').click();await tap_plane('c3c3c3')
    require('Ground' in await details.inner_text() and '0 Kt' in await details.inner_text()
            and 'Unknown' in await details.inner_text(),'Ground speed zero or missing heading became fabricated values')
    await details.locator('.wt-details-close').click()
    await host.locator('[data-action="zoom-in"]').click()
    require((await tracker_state(frame))['zoom']==initial['zoom']+1,'Native tracker zoom-in does not work')
    await host.locator('[data-action="zoom-out"]').click()
    require((await tracker_state(frame))['zoom']==initial['zoom'],'Native tracker zoom-out does not work')
    box=await canvas.bounding_box();x,y=box['x']+box['width']*.55,box['y']+box['height']*.35
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+45,y+25,steps=5);await page.mouse.up()
    require((await tracker_state(frame))['center']!=initial['center'],'Native tracker drag does not pan')
    painted=await layout_pixel(frame)
    require(max(abs(painted['pixel'][i]-[173,80,42][i]) for i in range(3))>3,
            'FAA polygons lost their geographic anchor while panning')
    await host.locator('[data-action="recenter"]').click()
    centered=await tracker_state(frame)
    require(abs(centered['center']['lat']-centered['airport']['lat'])<.000001
            and abs(centered['center']['lon']-centered['airport']['lon'])<.000001 and centered['zoom']==9,
            'Native tracker recenter does not restore fixed CMI')
    await host.locator('[data-action="fullscreen"]').click()
    await wait_for(frame,"Boolean(document.fullscreenElement)||Boolean(document.querySelector('.wt-expanded'))")
    await host.locator('[data-action="fullscreen"]').click()
    await wait_for(frame,"!document.fullscreenElement&&!document.querySelector('.wt-expanded')")
    require(await canvas.is_visible(),'Exiting native aircraft fullscreen closed Weather')
    await host.locator('.wt-map').evaluate("el=>Object.defineProperty(el,'requestFullscreen',{configurable:true,value:()=>Promise.reject(new Error('TEST FIXTURE native fullscreen unavailable'))})")
    await host.locator('[data-action="fullscreen"]').click()
    await wait_for(frame,"Boolean(document.querySelector('.wt-expanded'))")
    await page.keyboard.press('Escape')
    await wait_for(frame,"!document.querySelector('.wt-expanded')")
    require(await canvas.is_visible(),'Fallback aircraft fullscreen Escape closed Weather')
    await host.locator('.wt-map').evaluate("el=>delete el.requestFullscreen")
    for mode in ['stale','unavailable']:
        feed.tracker_status=mode;await refresh_tracker(frame)
        state=await tracker_state(frame)
        require(state['status']==mode and state['aircraftCount'] is None and state['retainedAircraftCount']==3
                and all(row['stale'] for row in state['markers']), 'Old/failed aircraft source remained live, disappeared or became zero')
        require(('Stale' if mode=='stale' else 'Unavailable') in await host.locator('.wt-status').inner_text(),
                'Tracker lacks visible stale/unavailable labeling')
    feed.tracker_status='live';feed.tracker_empty=True;await refresh_tracker(frame)
    empty=await tracker_state(frame)
    require(empty['aircraftCount']==0 and not empty['markers'] and 'No Aircraft Reported' in await host.locator('.wt-status').inner_text(),
            'A successful empty source is not distinguished from unavailable data')
    feed.tracker_status='unavailable';await refresh_tracker(frame)
    require((await tracker_state(frame))['aircraftCount'] is None and 'No Aircraft Reported' not in await host.locator('.wt-status').inner_text(),
            'Unavailable source was presented as zero aircraft')
    feed.tracker_status='live';feed.tracker_empty=False;await refresh_tracker(frame)
    return {'nativeCanvas':True,'sourcePositionsAndHeadingPreserved':True,'clickAndTouchDetails':True,
        'groundZeroAndMissingHeading':True,'zoomPanRecenterFullscreen':True,'staleUnavailableAndEmptyDistinct':True,'roleClock':updated,
        'stackedMapLayers':layer_evidence,'faaGeometryAnchoredDuringPan':True}


async def run_case(browser, base, output, width, height, role):
    feed = Flights(); feed.release(); feed.willard_modes['arrivals'] = 'unavailable'
    context, page, errors, external, mutations = await context_for(browser, width, height, feed, role)
    await context.route('**/api/willard-flights**', feed.route)
    await context.route('**/api/willard-tracker**',feed.route)
    await context.route('**/api/willard-airport-layout**',feed.route)
    evidence = {'viewport':[width,height],'role':role,'fixtureOnly':True}
    chief = role == 'chief_engineer'
    suffix = role + '-' + str(width)
    try:
        await page.goto(base+'/engineering',wait_until='domcontentloaded')
        launcher=page.get_by_role('button',name='Weather',exact=True)
        await launcher.wait_for(state='visible',timeout=60000)
        require(feed.willard_calls==0 and feed.tracker_calls==0 and feed.layout_calls==0,'Airport requested before Weather opened')
        await launcher.click(); frame=await weather_frame(page)
        await frame.evaluate("""() => {
          window.__willardFetchAudit=[];const original=window.fetch;
          window.fetch=function(input,options){
            const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
            if(['/api/willard-flights','/api/willard-tracker','/api/willard-airport-layout'].includes(path)){
              const row={path,method:options?.method||'GET',aborted:false};window.__willardFetchAudit.push(row);
              options?.signal?.addEventListener('abort',()=>{row.aborted=true;});
            }return original.call(this,input,options);
          };
        }""")
        airport=frame.locator('#willardAirport'); board=airport.locator('[data-willard-board]')
        state=await frame.evaluate('weatherPreview.getState().airport')
        require(not state['expanded'] and not state['trackerMounted'] and not state['clockRunning']
                and feed.willard_calls==0 and feed.tracker_calls==0 and feed.layout_calls==0,'Collapsed airport performs work')
        require(await board.get_attribute('data-style')=='london'
                and await board.get_attribute('data-time-format')==('24h' if chief else '12h'), 'Wrong board style/role clock')
        feed.hold_willard=True;feed.willard_gate.clear();feed.willard_pending.clear()
        feed.hold_layout=True;feed.layout_gate.clear();feed.layout_pending.clear()
        await expand(frame,True);await asyncio.wait_for(feed.willard_pending.wait(),5)
        await asyncio.wait_for(feed.layout_pending.wait(),5)
        await wait_for(frame,"weatherPreview.getState().airport.trackerStatus==='live'")
        require(await airport.locator('tbody [data-flight]').count()==0,'Held source exposed invented flight rows')
        require((await tracker_state(frame))['airportLayout']['rendered']==0,'Held FAA source exposed fabricated airport polygons')
        await expand(frame,False)
        require(await frame.evaluate("window.__willardFetchAudit.filter(row=>row.path==='/api/willard-airport-layout').at(-1)?.aborted"),
                'Collapsing airport did not abort held FAA layout read')
        feed.hold_layout=False;feed.layout_gate.set()
        feed.hold_willard=False;feed.willard_gate.set()
        await expand(frame,True);await finished(frame)
        arrivals=airport.locator('[data-willard-arrivals]');departures=airport.locator('[data-willard-departures]')
        require(await arrivals.get_attribute('data-availability')=='unavailable'
                and 'Flight data unavailable' in await arrivals.inner_text()
                and 'No flights listed' not in await arrivals.inner_text(), 'Unavailable arrivals became empty/all-clear')
        require(await departures.locator('tr[data-flight]').count()==2,'Working departures lost to partial source failure')
        evidence['partialAvailabilityHonest']=True
        evidence['nativeAircraftMap']=await native_map_checks(page,frame,feed,width,chief)
        first=feed.willard_calls
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(feed.willard_calls==first,'Immediate re-expansion ignored60-second memory cache')
        await advance(page,feed,61010)
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
        require(await airport.locator('iframe').count()==0 and await airport.locator('.wt-canvas').count()==1,
                'Airport created an external provider frame or lost its native map')
        require(await board.evaluate('el=>el.scrollWidth<=el.clientWidth+1'),'London board overflows viewport')
        await board.scroll_into_view_if_needed();await page.screenshot(path=str(output/('willard-live-board-'+suffix+'.png')),full_page=True)
        await airport.locator('[data-willard-tracker]').scroll_into_view_if_needed();await page.screenshot(path=str(output/('willard-compact-tracker-'+suffix+'.png')),full_page=True)
        evidence['publishedRows']={'codesharesPreserved':True,'noInventedEta':True,'nextDayRetained':True,'roleClock':('24h' if chief else '12h'),'nativeTracker':True}
        calls=feed.willard_calls
        await advance(page,feed,61010)
        require(feed.willard_calls==calls,'Expanded airport started interval polling')
        feed.willard_modes['arrivals']='unavailable'
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(await arrivals.get_attribute('data-availability')=='stale'
                and 'Last known' in await arrivals.locator('.wa-board-status').inner_text()
                and await arrivals.locator('tr[data-flight]').count()==3,'Failed refresh dropped prior rows or treated stale data as live')
        feed.willard_empty.add('departures');await advance(page,feed,61010)
        await expand(frame,False);await expand(frame,True);await finished(frame)
        require(await departures.get_attribute('data-availability')=='live'
                and await departures.locator('tr[data-flight]').count()==0
                and 'No flights listed by source' in await departures.inner_text(),'Explicit source empty state became unavailable or fabricated rows')
        evidence['failedRefreshAndExplicitEmpty']={'priorRowsStale':True,'workingBoardIndependent':True,'sourceEmptyDistinctFromUnknown':True}
        # Expired-cache reads are stopped by each foreground lifecycle boundary.
        for boundary in ['collapse','hidden','close']:
            await expand(frame,False)
            tracker_calls=feed.tracker_calls
            await advance(page,feed,181010)
            require(feed.tracker_calls==tracker_calls,'Inactive tracker continued source polling')
            feed.hold_willard=True;feed.willard_gate.clear();feed.willard_pending.clear()
            feed.hold_tracker=True;feed.tracker_gate.clear();feed.tracker_pending.clear()
            feed.hold_basemap=True;feed.basemap_gate.clear();feed.basemap_pending.clear()
            await expand(frame,True);await asyncio.wait_for(feed.willard_pending.wait(),5)
            await asyncio.wait_for(feed.tracker_pending.wait(),5)
            await asyncio.wait_for(feed.basemap_pending.wait(),5)
            require(await frame.evaluate('weatherPreview.getState().airport.flightPending'),'Held flight read notpending')
            if boundary=='collapse':await expand(frame,False)
            elif boundary=='hidden':await set_visibility(frame,False)
            else:
                native=page.locator('[data-cmpri-desktop-window="'+PREVIEW+'"]')
                await native.get_by_role('button',name='Close Weather',exact=True).click()
                await page.locator('iframe[src*="'+PREVIEW+'"]').wait_for(state='hidden')
            await wait_for(frame,'!weatherPreview.getState().airport.flightPending && !weatherPreview.getState().airport.trackerActive && !weatherPreview.getState().airport.clockRunning')
            require(await frame.evaluate("['/api/willard-flights','/api/willard-tracker'].every(path=>window.__willardFetchAudit.filter(row=>row.path===path).at(-1)?.aborted)"),
                    'Lifecycle boundary did not abort underlying board and aircraft reads: '+boundary)
            stopped=await tracker_state(frame)
            require(stopped['pending']==0 and stopped['pendingTiles']==0 and stopped['queuedTiles']==0
                    and not stopped['refreshTimerActive'] and stopped['tileCacheSize']==0
                    and not stopped['airportLayout']['pending'],
                    'Inactive tracker retained requests, source timers or tile bitmaps: '+str(stopped))
            calls=[feed.willard_calls,feed.tracker_calls];feed.hold_willard=False;feed.willard_gate.set()
            feed.hold_tracker=False;feed.tracker_gate.set();feed.hold_basemap=False;feed.basemap_gate.set();await asyncio.sleep(.05)
            require([feed.willard_calls,feed.tracker_calls]==calls,'Inactive airport made another source request')
            if boundary=='hidden':
                await set_visibility(frame,True);await finished(frame);await tracker_ready(frame)
                await expand(frame,False)
        calls=[feed.willard_calls,feed.tracker_calls];await advance(page,feed,240010)
        require([feed.willard_calls,feed.tracker_calls]==calls,'Closed Weather continued airport requests')
        state=await frame.evaluate('weatherPreview.getState().airport')
        require(not state['backgroundPolling'] and state['notifications']==0 and not state['trackerActive'],
                'Closed airport retains polling, notifications or tracker activity')
        require(not errors and not external and not mutations,'Unexpected script/external/application activity: '+str([errors,external,mutations]))
        require(await page.evaluate('window.__weatherReviewForbidden.length===0') and await frame.evaluate('window.__weatherReviewForbidden.length===0'),'Airport requested permissions/GPS/push')
        evidence.update(passed=True,flightReads=feed.willard_calls,trackerSourceReads=feed.tracker_calls,airportLayoutReads=feed.layout_calls,cache60Seconds=True,
            noFlightBoardIntervalPolling=True,noInactiveTrackerPolling=True,abortOnCollapseHiddenClose=True,
            errors=errors,externalRequests=external,applicationMutations=mutations)
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
