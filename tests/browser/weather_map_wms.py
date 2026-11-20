"""Verify activated WMS products in the native Weather window with local fixtures.

All application APIs and WebSockets are intercepted; external HTTP is blocked.
Metadata, map PNGs, and legend PNGs are explicit local fixtures in official
response shapes. This does not verify live NOAA/NCEP availability.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from datetime import timedelta
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, frame_forbidden,
    dashboard_weather_launcher, install, install_weather_audit, require, unexpected_application_mutation, wait_for, weather_frame,
)
from weather_map_basemaps import legend_layout, pixel, settled, style
from playwright.async_api import async_playwright


async def select_product(frame, value, enabled=True):
    identity = {'reflectivity':'mapLayerRadar','velocity':'mapLayerVelocity','ptype':'mapLayerPtype',
                'roads':'mapLayerRoads','impacts':'mapLayerImpacts','alerts':'mapLayerAlerts',
                'cloudCover':'mapLayerCloudCover'}[value]
    control = frame.locator('#'+identity)
    for details in await control.locator('xpath=ancestor::details').all():
        if not await details.evaluate('el=>el.open'): await details.locator(':scope > summary').click()
    if (await control.get_attribute('aria-pressed') == 'true') != enabled:
        await control.click()
    await wait_for(frame, "args=>cmpriWeatherMap.getState().layers[args[0]]===args[1]",[value,enabled])


async def wms_ready(frame, product):
    name = 'ptype' if product == 'precipitation' else product
    await wait_for(frame,"""name=>{const w=cmpriWeatherMap.getState().wmsLayers[name];
      return w && w.time && w.displayedTime===w.time && w.pending===0 && w.imageLoaded;}""",name)
    if product == 'cloudCover':
        await wait_for(frame,"""()=>{const w=cmpriWeatherMap.getState().wmsLayers.cloudCover;
          return w.kind==='forecast' && w.units==='%' && w.sourceTime+'Z'===w.displayedTime && !w.legendLoaded;}""")
    else:
        await wait_for(frame,"""name=>{const image=document.getElementById('mapWmsLegend-'+name);
          return image?.complete && image.naturalWidth>0;}""",name)
    await asyncio.sleep(.06)


async def cloud_lifecycle(page, frame, fixture, failed):
    for name in ['velocity','ptype']: await select_product(frame,name,False)
    await wms_ready(frame,'cloudCover')
    initial=await frame.evaluate('cmpriWeatherMap.getState()')
    before_pixel=await pixel(frame)
    radar=(initial['displayedScanTime'],initial['displayedFrame'])
    require(not initial['playing'],'Cloud lifecycle requires paused reflectivity')
    counts=lambda:{name:sum(call['product']==name and call['op']=='capabilities' for call in fixture.wms_requests) for name in fixture.wms_modes}
    before_counts=counts()
    fixture.wms_now=fixture.now+timedelta(hours=1)
    fixture.wms_held_products.add('cloudCover')
    fixture.wms_product_gates['cloudCover'].clear();fixture.wms_product_pending['cloudCover'].clear()
    await page.clock.fast_forward(300010)
    await asyncio.wait_for(fixture.wms_product_pending['cloudCover'].wait(),timeout=5)
    held=await frame.evaluate('cmpriWeatherMap.getState()')
    require(held['wmsLayers']['cloudCover']['imageLoaded']
            and held['wmsLayers']['cloudCover']['displayedTime']==initial['wmsLayers']['cloudCover']['displayedTime']
            and held['wmsLayers']['cloudCover']['time']!=held['wmsLayers']['cloudCover']['displayedTime'],
            'Cloud replacement discarded prior pixels or advanced the displayed forecast valid time early')
    require(max(abs(a-b) for a,b in zip(before_pixel,await pixel(frame)))<=3,
            'Held cloud replacement changed the retained composite')
    after_counts=counts()
    require(all(after_counts[name]==before_counts[name]+1 for name in ['reflectivity','cloudCover'])
            and all(after_counts[name]==before_counts[name] for name in ['velocity','precipitation']),
            'Visible refresh did not request only selected weather products: '+str([before_counts,after_counts]))
    fixture.wms_held_products.discard('cloudCover');fixture.wms_product_gates['cloudCover'].set()
    await wms_ready(frame,'cloudCover');await wait_for(frame,'cmpriWeatherMap.getState().refresh.scheduled')
    refreshed=await frame.evaluate('cmpriWeatherMap.getState()')
    require((refreshed['displayedScanTime'],refreshed['displayedFrame'])==radar and not refreshed['playing'],
            'Cloud forecast refresh advanced or started the paused radar loop')
    fixture.wms_held_products.add('cloudCover')
    fixture.wms_product_gates['cloudCover'].clear();fixture.wms_product_pending['cloudCover'].clear()
    await frame.locator('#radarCanvas').focus();await page.keyboard.press('ArrowRight')
    await asyncio.wait_for(fixture.wms_product_pending['cloudCover'].wait(),timeout=5)
    await select_product(frame,'cloudCover',False)
    await wait_for(frame,'cmpriWeatherMap.getState().wmsLayers.cloudCover.pending===0')
    await asyncio.sleep(.1)
    require(any('product=cloudCover' in row['url'] and row['error']=='net::ERR_ABORTED' for row in failed),
            'Disabling cloud cover did not abort its pending image read')
    fixture.wms_held_products.discard('cloudCover');fixture.wms_product_gates['cloudCover'].set()
    await select_product(frame,'cloudCover',True);await wms_ready(frame,'cloudCover')
    for name in ['velocity','ptype']: await select_product(frame,name,True)
    return {'selectedOnlyFiveMinuteRefresh':True,'priorPixelsAndForecastTimeRetained':True,
            'toggleAbortsPendingRead':True,'pausedRadarUnchanged':True}


async def forecast_cloud(frame, fixture):
    before=await frame.evaluate('cmpriWeatherMap.getState()')
    require(await frame.locator('#mapLayerSatellite').count()==0 and await frame.locator('#mapLayerLightning').count()==0,
            'Removed satellite/lightning controls remain exposed')
    await select_product(frame,'cloudCover',True);await wms_ready(frame,'cloudCover');await settled(frame)
    after=await frame.evaluate('cmpriWeatherMap.getState()');cloud=after['wmsLayers']['cloudCover']
    require(all(after['layers'][name]==enabled for name,enabled in before['layers'].items() if name!='cloudCover'),
            'Cloud control changed another independent layer')
    require(cloud['layer']=='ndfd.conus.sky' and cloud['style']=='' and cloud['kind']=='forecast' and cloud['units']=='%',
            'Cloud state does not reflect the verified NDFD forecast contract')
    require(cloud['sourceTime'] in fixture.wms_metadata['cloudCover']['layers'][0]['dimensions']['vtit']['values'].split(',')
            and cloud['sourceTime']+'Z'==cloud['time']==cloud['displayedTime'],
            'Cloud source VTIT and UTC display valid time differ')
    require('digital.weather.gov' in cloud['mapSource'] and 'VTIT=' in cloud['mapSource']
            and 'SRS=' in cloud['mapSource'] and 'CRS=' not in cloud['mapSource'],
            'Cloud source provenance lost its exact WMS 1.1.1 VTIT/SRS request')
    row=frame.locator('[data-legend=cloudCover]')
    require(await row.locator('strong').inner_text()=='Forecast cloud cover · %', 'Cloud key caption lost forecast units')
    stamp=await frame.evaluate('value=>cmpriWeatherClock.stamp(value)',cloud['displayedTime'])
    require(stamp in await row.inner_text() and stamp in await frame.locator('#scanTime').inner_text(),
            'Cloud UTC valid time is not displayed in Central time')
    require('official png color key is not advertised' in (await row.get_attribute('title')).lower()
            and await row.locator('img,.cmpri-map-swatch').count()==0,
            'Missing official cloud key is not truthful or an invented palette was inserted')
    require(not any(call['product']=='cloudCover' and call['op']=='legend' for call in fixture.wms_requests),
            'Cloud forecast requested an unadvertised legend')
    require('unavailable' not in (await row.inner_text()).lower(), 'Missing cloud key leaked diagnostic copy into the compact caption')
    return {'verifiedForecastContract':True,'exactVtitWithUtcDisplay':True,'validTimeCentral':stamp,
            'missingKeyTooltipOnly':True,'noUnadvertisedLegendRequest':True,'otherLayersRetained':True}


async def run_viewport(browser, base, output, width, height):
    context = await browser.new_context(viewport={'width':width,'height':height},is_mobile=width<640,
        has_touch=width<640,service_workers='block',reduced_motion='reduce')
    await context.route_web_socket('**/*',block_websocket)
    fixture=OfficialFeedFixtures();fixture.release()
    context.on('requestfailed',fixture.request_failed)
    await install(context,'chief_engineer')
    await context.route('**/api/weather-preview**',fixture.route)
    errors,externals,mutations=[],[],[]
    async def protect(route):
        parsed=urlparse(route.request.url)
        if parsed.hostname not in ['127.0.0.1','localhost']:
            externals.append(route.request.url);await route.abort('blockedbyclient');return
        if unexpected_application_mutation(parsed.path, route.request.method):
            mutations.append({'path':parsed.path,'method':route.request.method})
        await route.fallback()
    await context.route('**/*',protect);await context.add_init_script(PROBE)
    page=await context.new_page();await page.clock.install(time=fixture.now)
    page.on('pageerror',lambda error:errors.append(str(error)))
    failed=[]
    page.on('requestfailed',lambda request:failed.append({'url':request.url,'error':request.failure}) if '/api/weather-preview/wms' in request.url else None)
    evidence={'viewport':[width,height],'fixtureOnly':True,'products':[]}
    try:
        await page.goto(base+'/engineering',wait_until='domcontentloaded')
        launcher = await dashboard_weather_launcher(page)
        mutation_start = len(mutations)
        await launcher.click();frame=await weather_frame(page);await install_weather_audit(frame)
        await settled(frame);await style(frame,'aerial');await select_product(frame,'reflectivity',False)
        require(not await frame.locator('#mapLegendAccordion').evaluate('el=>el.open'),
                'Map legend accordion did not start collapsed')
        require(not any(row['product']=='cloudCover' for row in fixture.wms_requests),
                'Unselected cloud-cover forecast loaded automatically')
        for selected,product,name,advertised_style,color,alpha_value in [
            ('velocity','velocity','kilx_sr_bvel','radar_velocity',[180,65,205],150),
            ('ptype','precipitation','conus_pcpn_typ','radar_precip_type',[85,205,225],170)]:
            for other in ['velocity','ptype']:
                await select_product(frame,other,False)
            before=await frame.evaluate('cmpriWeatherMap.getState()')
            fixture.wms_legend_delay=.8
            legends_before=len([call for call in fixture.wms_requests if call['product']==product and call['op']=='legend'])
            await select_product(frame,selected)
            await wait_for(frame,"name=>/Loading/.test(cmpriWeatherMap.getState().wmsLayers[name].legendStatus)",selected)
            await frame.locator('#radarCanvas').focus()
            for _ in range(6): await page.keyboard.press('ArrowRight')
            await wms_ready(frame,product);await settled(frame)
            fixture.wms_legend_delay=0
            require(len([call for call in fixture.wms_requests if call['product']==product and call['op']=='legend'])-legends_before==1,
                    'Rapid pan duplicated a legend request')
            state=await frame.evaluate('cmpriWeatherMap.getState()');wms=state['wmsLayers'][selected]
            require(wms['layer']==name and wms['style']==advertised_style,'WMS did not use its advertised layer/style')
            require(datetime_from_iso(wms['time'])==datetime_from_iso(fixture.wms_metadata[product]['layers'][0]['time']['values'].split(',')[-1]),
                    'WMS time was not the latest concrete advertised scan')
            for identity in ['playLoop','frameRange','playbackSpeed','loopLength']:
                require(await frame.locator('#'+identity).is_disabled(),'Reflectivity playback stayed enabled when reflectivity was off')
            stamp=await frame.evaluate('value=>cmpriWeatherClock.stamp(value)',wms['time'])
            require(stamp in await frame.locator('#scanTime').inner_text(),'WMS scan time ignored the Chief Central clock')
            origin='opengeo.ncep.noaa.gov'
            require(origin in wms['mapSource'] and origin in wms['legendSource'],
                    'WMS map/legend lost official source provenance')
            legend = frame.locator('#mapWmsLegend-'+selected).locator('..')
            if await legend.evaluate("el=>el.tagName==='DETAILS' && !el.open"):
                await legend.locator(':scope > summary').click()
            presentation = await legend_layout(frame,'.cmpri-wms-legend:has(#mapWmsLegend-'+selected+')', '.cmpri-source-scale')
            dimensions=await frame.locator('#mapWmsLegend-'+selected).evaluate('el=>({width:el.naturalWidth,height:el.naturalHeight,renderedWidth:el.getBoundingClientRect().width})')
            require([dimensions['width'],dimensions['height']]==[500,30] and dimensions['renderedWidth']<=180.5,
                    'Official source legend is not compact')
            require(await frame.locator('.cmpri-map-source-legend').count()==0, 'A native-size scrollable source legend remains')
            if selected == 'velocity':
                bounds = await frame.locator('.cmpri-velocity-ticks').evaluate('''host => {
                  const box=host.getBoundingClientRect();
                  return [...host.children].map(tick=>{const key=tick.getBoundingClientRect();
                    return {text:tick.textContent,left:key.left-box.left,right:key.right-box.left,width:box.width};});
                }''')
                require(all(tick['left']>=-.5 and tick['right']<=tick['width']+.5 for tick in bounds),
                        'Velocity source labels clip outside the compact key: '+str(bounds))
                presentation['labelsWithinKey'] = bounds
            presentation.update(sourceDimensions=dimensions)
            actual=await pixel(frame);alpha=alpha_value/255*state['opacity']
            expected=[round([173,80,42][n]*(1-alpha)+color[n]*alpha) for n in range(3)]
            require(max(abs(actual[n]-expected[n]) for n in range(3))<=4,'Independent WMS raster did not compose over USGS: '+str(actual))
            await style(frame,'aerial');changed=await frame.evaluate('cmpriWeatherMap.getState()')
            require(changed['layers'][selected] and changed['wmsLayers'][selected]['time']==wms['time'] and changed['center']==state['center'],
                    'Changing geographic background changed an independent observed layer')
            await style(frame,'aerial')
            evidence['products'].append({'product':product,'layer':name,'style':advertised_style,'timeCentral':stamp,
                'officialShapedPngAndLegendDecoded':True,'separateProductStateAndSource':True,'legendPresentation':presentation})
        evidence['cloudCover']=await forecast_cloud(frame,fixture)
        for name in ['reflectivity','velocity','ptype','cloudCover','alerts','impacts']: await select_product(frame,name,True)
        for product in ['velocity','precipitation','cloudCover']: await wms_ready(frame,product)
        await wait_for(frame,'cmpriWeatherMap.getState().readyFrameCount>0')
        stack=await frame.evaluate('cmpriWeatherMap.getState()')
        require(all(stack['layers'][name] for name in ['reflectivity','velocity','ptype','cloudCover','alerts','impacts']),
                'Supported weather layers cannot remain selected together')
        require(not await frame.locator('#playLoop').is_disabled(),'Selecting independent WMS layers disabled active reflectivity playback')
        expected=[173.,80.,42.]
        for color,alpha_byte in [([40,85,130],200),([30,170,75],180),([85,205,225],170),([180,65,205],150)]:
            alpha=alpha_byte/255*stack['opacity'];expected=[expected[n]*(1-alpha)+color[n]*alpha for n in range(3)]
        actual=await pixel(frame)
        require(max(abs(actual[n]-round(expected[n])) for n in range(3))<=5,'Selected reflectivity/ptype/velocity did not visibly stack: '+str(actual))
        await select_product(frame,'roads',True);roads=await frame.evaluate('cmpriWeatherMap.getState()')
        require(roads['layers']['roads'] and roads['layers']['impacts']
                and all(roads['layers'][name] for name in ['reflectivity','velocity','ptype','alerts']),
                'Reported roads selection disabled forecast impacts or an unrelated layer')
        require('unavailable' in (await frame.locator('#mapFeedStatus').inner_text()).lower(),
                'Unavailable reported roads look like a live route layer')
        await select_product(frame,'impacts',False)
        require(await frame.evaluate('cmpriWeatherMap.getState().layers.roads'),
                'Disabling forecast impacts disabled reported roads')
        await select_product(frame,'impacts',True);winter=await frame.evaluate('cmpriWeatherMap.getState()')
        require(winter['layers']['impacts'] and winter['layers']['roads']
                and all(winter['layers'][name] for name in ['reflectivity','velocity','ptype','alerts']),
                'Forecast impacts selection disabled reported roads or an unrelated layer')
        await select_product(frame,'roads',False)
        require(await frame.evaluate('cmpriWeatherMap.getState().layers.impacts'),
                'Disabling reported roads disabled forecast impacts')
        await select_product(frame,'roads',True)
        full_stack=await frame.evaluate('cmpriWeatherMap.getState()')
        require(all(full_stack['layers'][name]
                    for name in ['reflectivity','velocity','ptype','alerts','roads','impacts']),
                'The original six independent weather selections cannot remain enabled together')
        evidence['independentLayerStack']={'compositedPixel':actual,'supportedLayersStack':True,
            'winterLayersRemainSelectedBothOrders':True,'allSixSelectionsIndependent':True,
            'unavailableReportedRoadsNotFabricated':True,
            'drawOrder':'aerial→forecast cloud cover→WSSI→reflectivity→ptype→velocity→reference labels/alerts/hotel'}
        await frame.locator('.map-panel').scroll_into_view_if_needed()
        await page.screenshot(path=str(output/f'independent-weather-layer-stack-{width}.png'),full_page=True)
        evidence['cloudCoverLifecycle']=await cloud_lifecycle(page,frame,fixture,failed)
        fixture.wms_modes['precipitation']='unavailable'
        await frame.locator('#radarCanvas').focus();await page.keyboard.press('ArrowRight')
        await wait_for(frame,"/unavailable/i.test(cmpriWeatherMap.getState().wmsLayers.ptype.status)")
        require('unavailable' in (await frame.locator('#mapFeedStatus').inner_text()).lower()
                and (await frame.evaluate('cmpriWeatherMap.getState()'))['layers']['velocity'],
                'One WMS failure hid other selected layers or was not labeled unavailable')
        fixture.wms_modes['precipitation']='fresh';fixture.hold_wms=True;fixture.wms_gate.clear();fixture.wms_pending.clear()
        await page.keyboard.press('ArrowRight');await asyncio.wait_for(fixture.wms_pending.wait(),timeout=5)
        await wait_for(frame,'cmpriWeatherMap.getState().wmsLayers.velocity.pending>0 && cmpriWeatherMap.getState().wmsLayers.ptype.pending>0 && cmpriWeatherMap.getState().wmsLayers.cloudCover.pending>0')
        native=page.locator('[data-cmpri-desktop-window="'+PREVIEW+'"]')
        await native.get_by_role('button',name='Close Weather',exact=True).click()
        await page.locator('iframe[src*="'+PREVIEW+'"]').wait_for(state='hidden')
        closed=await frame.evaluate('cmpriWeatherMap.getState()')
        require(closed['pendingRequests']==0 and all(value['pending']==0 for value in closed['wmsLayers'].values())
                and not closed['playing'] and not closed['refresh']['scheduled'],'WMS requests/playback/refresh survived close')
        fixture.release();calls=len(fixture.wms_requests);await asyncio.sleep(.2)
        require(len(fixture.wms_requests)==calls,'Hidden cached Weather continued WMS requests')
        require(not errors and not externals and not await frame_forbidden(page),'Unexpected error/external/permission activity')
        require(len(mutations)==mutation_start,'Layer controls caused application mutations')
        evidence.update(passed=True,nativeCloseAbortsWms=True,noBackgroundRequests=True,noRealDatabaseOrPush=True,errors=errors)
        print(f'PASS independent WMS layers {width}×{height} (local fixtures)',flush=True);return evidence
    finally:
        fixture.release();await context.close()


def datetime_from_iso(value):
    from datetime import datetime
    return datetime.fromisoformat(value.replace('Z','+00:00'))


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3116"))
    parser.add_argument("--output", default="/tmp/cmpri-weather-wms-review")
    args = parser.parse_args()
    require(urlparse(args.base).hostname in ["127.0.0.1", "localhost"], "Only a local fixture server is permitted")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True,
            executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"), args=["--no-sandbox"])
        try:
            for width, height in [(1440, 1000), (390, 844)]:
                try:
                    results.append(await run_viewport(browser, args.base.rstrip("/"), output, width, height))
                except Exception as error:
                    results.append({"viewport": [width, height], "passed": False, "error": str(error), "fixtureOnly": True})
                    print(f"FAIL {width}×{height}: {error}", flush=True)
        finally:
            await browser.close()
    (output / "weather-wms-report.json").write_text(json.dumps({"fixtureOnly": True,
        "liveFeedAvailabilityVerified": False, "results": results}, indent=2))
    require(all(row["passed"] for row in results), "WMS fixture acceptance failed; see " + str(output / "weather-wms-report.json"))


if __name__ == "__main__":
    asyncio.run(main())
