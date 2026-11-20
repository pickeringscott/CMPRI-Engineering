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
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, frame_forbidden,
    install, install_weather_audit, require, wait_for, weather_frame,
)
from weather_map_basemaps import legend_layout, pixel, settled, style
from playwright.async_api import async_playwright


async def select_product(frame, value, enabled=True):
    identity = {'reflectivity':'mapLayerRadar','velocity':'mapLayerVelocity','ptype':'mapLayerPtype',
                'roads':'mapLayerRoads','impacts':'mapLayerImpacts','alerts':'mapLayerAlerts'}[value]
    control = frame.locator('#'+identity)
    if (await control.get_attribute('aria-pressed') == 'true') != enabled:
        await control.click()
    await wait_for(frame, "args=>cmpriWeatherMap.getState().layers[args[0]]===args[1]",[value,enabled])


async def wms_ready(frame, product):
    name = 'ptype' if product == 'precipitation' else product
    await wait_for(frame,"""name=>{const w=cmpriWeatherMap.getState().wmsLayers[name];
      return w && w.time && w.displayedTime===w.time && w.pending===0 && w.imageLoaded;}""",name)
    await wait_for(frame,"""name=>{const image=document.getElementById('mapWmsLegend-'+name);
      return image?.complete && image.naturalWidth>0;}""",name)
    await asyncio.sleep(.06)


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
        if parsed.path.startswith('/api/') and route.request.method not in ['GET','HEAD']:
            mutations.append({'path':parsed.path,'method':route.request.method})
        await route.fallback()
    await context.route('**/*',protect);await context.add_init_script(PROBE)
    page=await context.new_page();page.on('pageerror',lambda error:errors.append(str(error)))
    evidence={'viewport':[width,height],'fixtureOnly':True,'products':[]}
    try:
        await page.goto(base+'/engineering',wait_until='domcontentloaded')
        launcher=page.get_by_role('button',name='Weather',exact=True)
        await launcher.wait_for(state='visible',timeout=60000);mutation_start=len(mutations)
        await launcher.click();frame=await weather_frame(page);await install_weather_audit(frame)
        await settled(frame);await style(frame,'aerial');await select_product(frame,'reflectivity',False)
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
            require('opengeo.ncep.noaa.gov' in wms['mapSource'] and 'opengeo.ncep.noaa.gov' in wms['legendSource'],
                    'WMS map/legend lost official source provenance')
            legend = frame.locator('#mapWmsLegend-'+selected).locator('..')
            if await legend.evaluate("el=>el.tagName==='DETAILS' && !el.open"):
                await legend.locator(':scope > summary').click()
            presentation = await legend_layout(frame,'.cmpri-wms-legend:has(#mapWmsLegend-'+selected+')','img')
            actual=await pixel(frame);alpha=alpha_value/255*state['opacity']
            expected=[round([173,80,42][n]*(1-alpha)+color[n]*alpha) for n in range(3)]
            require(max(abs(actual[n]-expected[n]) for n in range(3))<=4,'Independent WMS raster did not compose over USGS: '+str(actual))
            await style(frame,'aerial');changed=await frame.evaluate('cmpriWeatherMap.getState()')
            require(changed['layers'][selected] and changed['wmsLayers'][selected]['time']==wms['time'] and changed['center']==state['center'],
                    'Changing geographic background changed an independent observed layer')
            await style(frame,'aerial')
            evidence['products'].append({'product':product,'layer':name,'style':advertised_style,'timeCentral':stamp,
                'officialShapedPngAndLegendDecoded':True,'separateProductStateAndSource':True,'legendPresentation':presentation})
        for name in ['reflectivity','velocity','ptype','alerts','impacts']: await select_product(frame,name,True)
        await wms_ready(frame,'velocity');await wms_ready(frame,'precipitation')
        await wait_for(frame,'cmpriWeatherMap.getState().readyFrameCount>0')
        stack=await frame.evaluate('cmpriWeatherMap.getState()')
        require(all(stack['layers'][name] for name in ['reflectivity','velocity','ptype','alerts','impacts']),
                'Supported weather layers cannot remain selected together')
        require(not await frame.locator('#playLoop').is_disabled(),'Selecting independent WMS layers disabled active reflectivity playback')
        expected=[173.,80.,42.]
        for color,alpha_byte in [([30,170,75],180),([85,205,225],170),([180,65,205],150)]:
            alpha=alpha_byte/255*stack['opacity'];expected=[expected[n]*(1-alpha)+color[n]*alpha for n in range(3)]
        actual=await pixel(frame)
        require(max(abs(actual[n]-round(expected[n])) for n in range(3))<=5,'Selected reflectivity/ptype/velocity did not visibly stack: '+str(actual))
        await select_product(frame,'roads',True);roads=await frame.evaluate('cmpriWeatherMap.getState()')
        require(roads['layers']['roads'] and not roads['layers']['impacts']
                and all(roads['layers'][name] for name in ['reflectivity','velocity','ptype','alerts']),
                'Reported roads toggled unrelated layers or failed winter exclusivity')
        require('unavailable' in (await frame.locator('#mapFeedStatus').inner_text()).lower(),
                'Unavailable reported roads look like a live route layer')
        await select_product(frame,'impacts',True);winter=await frame.evaluate('cmpriWeatherMap.getState()')
        require(winter['layers']['impacts'] and not winter['layers']['roads']
                and all(winter['layers'][name] for name in ['reflectivity','velocity','ptype','alerts']),
                'Forecast impacts toggled unrelated layers or failed winter exclusivity')
        for identity in ['mapLayerSatellite','mapLayerLightning']:
            require(await frame.locator('#'+identity).is_disabled()
                    and 'unavailable' in (await frame.locator('#'+identity).inner_text()).lower(),
                    'Unsupported product is presented as a selectable live layer')
        evidence['independentStackAndWinterExclusivity']={'compositedPixel':actual,'supportedLayersStack':True,
            'onlyWinterRoadsAndImpactsExclude':True,'unsupportedClearlyUnavailable':True}
        await frame.locator('.map-panel').scroll_into_view_if_needed()
        await page.screenshot(path=str(output/f'independent-weather-layer-stack-{width}.png'),full_page=True)
        fixture.wms_modes['precipitation']='unavailable'
        await frame.locator('#radarCanvas').focus();await page.keyboard.press('ArrowRight')
        await wait_for(frame,"/unavailable/i.test(cmpriWeatherMap.getState().wmsLayers.ptype.status)")
        require('unavailable' in (await frame.locator('#mapFeedStatus').inner_text()).lower()
                and (await frame.evaluate('cmpriWeatherMap.getState()'))['layers']['velocity'],
                'One WMS failure hid other selected layers or was not labeled unavailable')
        fixture.wms_modes['precipitation']='fresh';fixture.hold_wms=True;fixture.wms_gate.clear();fixture.wms_pending.clear()
        await page.keyboard.press('ArrowRight');await asyncio.wait_for(fixture.wms_pending.wait(),timeout=5)
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
