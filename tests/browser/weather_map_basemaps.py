"""Actual-dashboard map acceptance using explicit local NWS/USGS fixtures.

Run against a local preview build:
  python tests/browser/weather_map_basemaps.py --base http://127.0.0.1:3116

This uses synthetic CMPRI accounts and intercepts every application API request.
Solid-color ground tiles and radar rasters are test fixtures, not weather or
geographic evidence. Passing does not establish live USGS/NOAA availability.
"""

import argparse
import asyncio
import json
import math
import os
import re
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, frame_forbidden, install, install_weather_audit,
    dashboard_weather_launcher, require, unexpected_application_mutation, wait_for, weather_frame,
)
from playwright.async_api import async_playwright


async def settled(frame, timeout=15000):
    await wait_for(frame, """() => {
      const ground = window.cmpriWeatherMap.getState().ground;
      return ground && ground.pending === 0 && ground.visibleTotal > 0 &&
        ground.visibleLoaded + ground.visibleFailed >= ground.visibleTotal;
    }""", timeout=timeout)
    await asyncio.sleep(.05)


async def menu(frame, element, opened):
    details = frame.locator("#" + element)
    if await details.evaluate("el => el.open") != opened:
        await details.locator(":scope > summary").click()


async def style(frame, value="aerial"):
    require(value == "aerial", "Only the aerial geographic background is permitted")
    require(await frame.evaluate("cmpriWeatherMap.getState().backgroundStyle") == "aerial", "Map changed from aerial imagery")
    await settled(frame)


async def radar(frame, enabled):
    control = frame.locator("#mapLayerRadar")
    if (await control.get_attribute("aria-pressed") == "true") != enabled:
        await control.click()
    await wait_for(frame, "enabled=>cmpriWeatherMap.getState().layers.radar===enabled",enabled)


async def pixel(frame):
    return await frame.locator("#radarCanvas").evaluate("""canvas => {
      const x = Math.round(canvas.width * .11), y = Math.round(canvas.height * .18);
      return Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
    }""")


async def set_range(frame, identity, value):
    """Exercise the input event used by pointer, keyboard and touch sliders."""
    control = frame.locator("#" + identity)
    require(await control.get_attribute("type") == "range", identity + " is not a slider")
    await control.evaluate("""(element, value) => {
      element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true}));
      element.dispatchEvent(new Event('change',{bubbles:true}));
    }""", value)


async def compact_map_actions(page, frame):
    canvas=frame.locator('#radarCanvas')
    await canvas.scroll_into_view_if_needed()
    geometry=await frame.locator('#mapShell').evaluate("""shell=>{
      const r=shell.getBoundingClientRect(),host=shell.querySelector('.map-actions'),h=host.getBoundingClientRect();
      return {top:h.top-r.top,right:r.right-h.right,width:h.width,
        buttons:Array.from(host.querySelectorAll('button')).map(el=>{const b=el.getBoundingClientRect();
          return {id:el.id,width:b.width,height:b.height,top:b.top-h.top,right:h.right-b.right};})};
    }""")
    require(abs(geometry['top'])<=1.5 and abs(geometry['right'])<=1.5
            and abs(geometry['width']-24)<.2 and len(geometry['buttons'])==4,
            'Map actions are not flush at the top-right edge: '+str(geometry))
    require(all(abs(row['width']-24)<.2 and abs(row['height']-24)<.2
                and abs(row['top']-index*24)<.2 and abs(row['right'])<.2
                for index,row in enumerate(geometry['buttons'])),
            'Map actions are not a gapless stack of24px buttons: '+str(geometry))
    before=await frame.evaluate('cmpriWeatherMap.getState()')
    await frame.locator('#zoomIn').click()
    await wait_for(frame,'value=>cmpriWeatherMap.getState().zoom>value',before['zoom'])
    zoomed=await frame.evaluate('cmpriWeatherMap.getState().zoom')
    await frame.locator('#zoomOut').click()
    await wait_for(frame,'value=>cmpriWeatherMap.getState().zoom<value',zoomed)
    await canvas.focus();await page.keyboard.press('ArrowRight')
    await wait_for(frame,'value=>cmpriWeatherMap.getState().center.lon!==value',before['center']['lon'])
    await frame.locator('#recenter').click()
    await wait_for(frame,"() => {const s=cmpriWeatherMap.getState();return Math.abs(s.center.lat-40.138080)<.000001&&Math.abs(s.center.lon+88.251416)<.000001;}")
    await frame.locator('#fullscreen').click()
    await wait_for(frame,"Boolean(document.fullscreenElement)||document.getElementById('mapShell').classList.contains('expanded')")
    expanded=await frame.locator('#mapShell').bounding_box()
    require(expanded['width']>250 and expanded['height']>300,'Fullscreen map did not expand')
    native_fullscreen=await frame.evaluate('Boolean(document.fullscreenElement)')
    await page.keyboard.press('Escape')
    await asyncio.sleep(.1)
    native_escape=await frame.evaluate("!document.fullscreenElement&&!document.getElementById('mapShell').classList.contains('expanded')")
    # Headless Chromium does not consistently perform the browser-chrome
    # Escape action. The actual fullscreen button must still exit, and the
    # component's own CSS fallback must handle Escape without closing Weather.
    if not native_escape:
        await frame.locator('#fullscreen').click()
    await wait_for(frame,"!document.fullscreenElement&&!document.getElementById('mapShell').classList.contains('expanded')")
    require(await canvas.is_visible(),'Exiting fullscreen closed the Weather view')
    await frame.evaluate("Object.defineProperty(document.getElementById('mapShell'),'requestFullscreen',{configurable:true,value:()=>Promise.reject(new Error('TEST FIXTURE: native fullscreen unavailable'))})")
    await frame.locator('#fullscreen').click()
    await wait_for(frame,"document.getElementById('mapShell').classList.contains('expanded')")
    await page.keyboard.press('Escape')
    await wait_for(frame,"!document.getElementById('mapShell').classList.contains('expanded')")
    require(await canvas.is_visible(),'Fallback Escape closed the Weather view')
    await frame.evaluate("delete document.getElementById('mapShell').requestFullscreen")
    return {**geometry,'zoomButtons':True,'recenter':True,'fullscreenButtonToggles':True,
        'nativeFullscreenAccepted':native_fullscreen,'nativeEscapeObserved':native_escape,'fallbackEscape':True}


async def legend_layout(frame, row_selector, content_selector):
    await menu(frame, "mapLegendAccordion", True)
    result = await frame.evaluate("""selectors=>{
      const row=document.querySelector(selectors[0]),content=row.querySelector(selectors[1]);
      const title=row.querySelector('strong,summary,h3'),host=document.getElementById('mapLegend');
      const a=row.getBoundingClientRect(),b=content.getBoundingClientRect(),c=title.getBoundingClientRect();
      const styles=[host,row].map(el=>({background:getComputedStyle(el).backgroundColor,border:parseFloat(getComputedStyle(el).borderTopWidth)}));
      return {rowWidth:a.width,contentWidth:b.width,titleAbove:c.bottom<=b.top+1,styles};
    }""", [row_selector,content_selector])
    require(0 < result["rowWidth"] <= 180.5 and 0 < result["contentWidth"] <= 180.5 and result["titleAbove"],
            "Legend is not180px with its title above the content: "+str(result))
    require(all(style["border"] == 0 and style["background"] in ["transparent","rgba(0, 0, 0, 0)"] for style in result["styles"]),
            "Legend retains a frame or backdrop: "+str(result))
    return result


async def set_visibility(frame, visible):
    """Dispatch the real foreground lifecycle event without removed tabs."""
    await frame.evaluate("""visible => {
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>!visible});
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    }""", visible)


async def wheel_activation(page, frame):
    canvas = frame.locator("#radarCanvas")
    await canvas.scroll_into_view_if_needed()
    box = await canvas.bounding_box()
    x, y = box["x"] + box["width"] * .55, box["y"] + box["height"] * .45
    await page.mouse.move(2, 2)
    await page.mouse.move(x, y)
    before = await frame.evaluate("({map:cmpriWeatherMap.getState(),scroll:document.getElementById('windowBody').scrollTop})")
    require(not before["map"]["wheelZoomActive"], "Map wheel zoom starts active before a map click")
    await page.mouse.wheel(0, 150)
    await asyncio.sleep(.2)
    unclicked = await frame.evaluate("({map:cmpriWeatherMap.getState(),scroll:document.getElementById('windowBody').scrollTop})")
    require(unclicked["map"]["zoom"] == before["map"]["zoom"], "Wheel zoomed the map before a click")
    require(unclicked["scroll"] > before["scroll"], "Wheel over an inactive map did not scroll the modal")
    await canvas.scroll_into_view_if_needed()
    box = await canvas.bounding_box()
    x, y = box["x"] + box["width"] * .55, box["y"] + box["height"] * .45
    await page.mouse.click(x, y)
    require(await frame.evaluate("cmpriWeatherMap.getState().wheelZoomActive"), "Click inside the map did not enable wheel zoom")
    await page.mouse.wheel(0, -180)
    await wait_for(frame, "before => cmpriWeatherMap.getState().zoom > before", before["map"]["zoom"])
    clicked = await frame.evaluate("cmpriWeatherMap.getState().zoom")
    await page.mouse.move(2, 2)
    await wait_for(frame, "!cmpriWeatherMap.getState().wheelZoomActive")
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, 100)
    await asyncio.sleep(.15)
    require(await frame.evaluate("cmpriWeatherMap.getState().zoom") == clicked,
            "Pointer leave did not reset wheel zoom activation")
    return {"unclickedWheelScrollsModal": True, "clickActivatesZoom": True,
            "pointerLeaveResetsActivation": True, "scrollBefore": before["scroll"],
            "scrollAfterInactiveWheel": unclicked["scroll"]}


def world_at(state, width, height, anchor):
    radius = 6378137
    center = state["center"]
    x = radius * center["lon"] * math.pi / 180
    y = radius * math.log(math.tan(math.pi / 4 + center["lat"] * math.pi / 360))
    resolution = 620 / state["zoom"]
    return (x + (anchor[0] - width / 2) * resolution,
            y - (anchor[1] - height / 2) * resolution)


async def anchored_zoom(page, frame, gesture, mobile=False):
    canvas = frame.locator("#radarCanvas")
    await canvas.scroll_into_view_if_needed()
    box = await canvas.bounding_box()
    anchor = (box["width"] * .62, box["height"] * .67)
    x, y = box["x"] + anchor[0], box["y"] + anchor[1]
    before = await frame.evaluate("window.cmpriWeatherMap.getState()")
    if gesture == "wheel":
        await page.mouse.click(x, y)
        await page.mouse.wheel(0, -240)
    elif gesture == "double-click":
        await page.mouse.dblclick(x, y, delay=70)
    elif gesture == "pinch":
        require(mobile, "Trusted pinch requires a mobile touch context")
        session = await page.context.new_cdp_session(page)
        try:
            def fingers(distance):
                return [{"x": x - distance, "y": y, "id": 1},
                        {"x": x + distance, "y": y, "id": 2}]
            await session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": fingers(25)})
            for step in range(1, 9):
                await session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": fingers(25 + step * 4)})
                await asyncio.sleep(.015)
            await session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        finally:
            await session.detach()
    await wait_for(frame, "before => window.cmpriWeatherMap.getState().zoom > before * 1.1", before["zoom"])
    after = await frame.evaluate("window.cmpriWeatherMap.getState()")
    old_point = world_at(before, box["width"], box["height"], anchor)
    new_point = world_at(after, box["width"], box["height"], anchor)
    error = math.hypot(new_point[0] - old_point[0], new_point[1] - old_point[1])
    require(error <= 620 / after["zoom"] * 4, f"{gesture} moved its geographic anchor by {error:.1f}m")
    return {"gesture": gesture, "beforeZoom": before["zoom"], "afterZoom": after["zoom"], "anchorErrorMeters": error}


async def run_viewport(browser, base, output, width, height):
    context = await browser.new_context(viewport={"width": width, "height": height},
        is_mobile=width < 640, has_touch=width < 640, service_workers="block", reduced_motion="reduce")
    await context.route_web_socket("**/*", block_websocket)
    fixture = OfficialFeedFixtures()
    context.on("requestfailed", fixture.request_failed)
    fixture.scan_times = [int((fixture.now - timedelta(minutes=minutes)).timestamp() * 1000)
                          for minutes in range(120, 0, -2)]
    fixture.release()
    errors, externals, mutations = [], [], []
    await install(context, "chief_engineer")
    await context.route("**/api/weather-preview**", fixture.route)

    async def protect(route):
        parsed = urlparse(route.request.url)
        if parsed.hostname not in ["127.0.0.1", "localhost"]:
            externals.append(route.request.url)
            await route.abort("blockedbyclient")
            return
        if unexpected_application_mutation(parsed.path, route.request.method):
            mutations.append({"path": parsed.path, "method": route.request.method})
        await route.fallback()

    await context.route("**/*", protect)
    await context.add_init_script(PROBE)
    await context.add_init_script("""(() => {
      window.__weatherShieldDraws=[];
      const original=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(image,...args){
        if(/\\/weather\\/signs\\/(interstate|illinois)-route\\.svg$/.test(image?.src||'') && args.length===4){
          window.__weatherShieldDraws.push({source:image.src,width:args[2],height:args[3]});
          if(window.__weatherShieldDraws.length>100)window.__weatherShieldDraws.shift();
        }
        return original.call(this,image,...args);
      };
    })();""")
    page = await context.new_page()
    await page.clock.install()
    page.on("pageerror", lambda error: errors.append(str(error)))
    evidence = {"viewport": [width, height], "fixtureOnly": True}
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = await dashboard_weather_launcher(page)
        require(not fixture.basemap_requests and not fixture.map_urls and fixture.forecast_calls == 0,
                "Ground or weather data loaded before Weather opened")
        mutation_start = len(mutations)
        await launcher.click()
        frame = await weather_frame(page)
        await install_weather_audit(frame)
        await wait_for(frame, "window.cmpriWeatherMap.getState().ground?.visibleLoaded > 0")
        await settled(frame)
        await wait_for(frame, "window.cmpriWeatherMap.getState().status.radar === 'Observed image loaded'")
        initial = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(initial["zoom"] == 4 and initial["grid"] is False and initial["backgroundStyle"] == "aerial",
                "Default aerial map extent or optional grid is incorrect")
        require(initial["ground"]["visibleLoaded"] > 0, "No actual ground fixture tile decoded")
        await wait_for(frame, """() => {
          const refs = window.cmpriWeatherMap.getState().ground.reference;
          return refs && refs.enabled && refs.roads.loaded && refs.places.loaded &&
            refs.places.renderedCount > 0 && refs.pending === 0;
        }""")
        await wait_for(frame,"Object.values(cmpriWeatherMap.getState().ground.shields).every(art=>art.status==='Official design loaded')")
        await wait_for(frame,"cmpriWeatherMap.getState().ground.reference.routes.renderedCount>0")
        ground = await frame.evaluate("window.cmpriWeatherMap.getState().ground")
        require(ground['shields']['interstate']['source'].endswith('/signs/interstate-route.svg')
                and ground['shields']['illinois']['source'].endswith('/signs/illinois-route.svg'),
                'Highway labels do not use the approved official sign artwork')
        require(ground["dataset"] == "imagery" and ground.get("imageryAcquisitionYear") is None,
                "Aerial did not use real imagery or invented a hotel-specific capture year")
        require({row["dataset"] for row in fixture.reference_requests} == {"roads", "places", "routes"},
                "Aerial is missing an actual road or populated-place reference response")
        require(any(row.get("op") == "place-labels" for row in fixture.reference_requests),
                "Town labels did not use the official GNIS feature response")
        require(all("carto.nationalmap.gov" in ground["reference"][key]["source"] for key in ["roads", "places"]),
                "Ground labels do not identify their official USGS reference source")
        require(ground["reference"]["places"]["count"] == 2
                and 1 <= ground["reference"]["places"]["renderedCount"] <= 2,
                "Official place names were not normalized/deduplicated or collision-decluttered")
        places = ground["reference"]["places"]
        require(places["sourceCount"] == 3 and places["uniqueCount"] == 2,
                "Source GNIS features were replaced by a hand-written town list")
        labels = places["renderedLabels"]
        require(len({row["name"] for row in labels}) == len(labels)
                and all(row["name"] in ["Champaign", "Urbana"] for row in labels),
                "Duplicate or invented town labels were drawn")
        annotation = await frame.locator("#radarCanvas").evaluate("""canvas => {
          const context=canvas.getContext('2d');
          const read=(x,y)=>Array.from(context.getImageData(Math.round(canvas.width*x),Math.round(canvas.height*y),1,1).data);
          return {road:read(.4,.55),beside:read(.43,.55)};
        }""")
        require(annotation["road"][0] > 205 and annotation["road"][1] > 205
                and max(abs(annotation["road"][n] - annotation["beside"][n]) for n in range(3)) > 45,
                "Road reference PNG did not compose visibly over the aerial/weather raster")
        evidence["aerialRoadsAndPlaceLabels"] = {"source": ground["reference"], "fixturePixels": annotation,
                                                 "captureYearNotInvented": True}
        require(await frame.locator("#mapBackgroundMenu,#mapBackgroundStyle").count() == 0
                and await frame.locator('.cmpri-map-layer-buttons[aria-label="Independent weather map layers"]').count() == 1,
                "Aerial-only map still exposes geographic background choices or lost its layer buttons")
        require(await frame.locator('#previousFrame,#nextFrame').count() == 0,
                "Removed previous/next scan arrow buttons remain")
        routes = ground["reference"]["routes"]
        # Nearby views reserve room for I57 north/south, I74 east/west and one
        # source-backed state route. Broad views keep their smaller budget.
        route_limit = 5 if ground["tileZoom"] <= 9 else 7 if ground["tileZoom"] <= 11 else 10
        require(routes["sourceCount"] >= routes["count"] >= 1 and 0 < routes["renderedCount"] <= routes["budget"] <= route_limit,
                "Source-backed route shields are missing or exceed the decluttering budget: " + str(routes))
        shield_keys=[(row["key"],row.get("side","single")) for row in routes["rendered"]]
        require(len(set(shield_keys)) == routes["renderedCount"], "The same highway route/side has duplicate shields")
        require(all(sum(row["key"]==key for row in routes["rendered"])<=1
                    or any(row["key"]==key and row["type"]=="interstate" and row["number"] in ["57","74"] for row in routes["rendered"])
                    for key,_ in shield_keys), "An unrelated route was labeled repeatedly")
        i57=[row for row in routes['rendered'] if row['type']=='interstate' and row['number']=='57']
        i74=[row for row in routes['rendered'] if row['type']=='interstate' and row['number']=='74']
        require({row['side'] for row in i57}=={'north','south'}
                and all((row['latitude']>40.138080) is (row['side']=='north') for row in i57)
                and {row['side'] for row in i74}=={'east','west'}
                and all((row['longitude']>-88.251416) is (row['side']=='east') for row in i74),
                'Fixture-returned I57 north/south or I74 east/west geometry lost its contextual shield: '+str(routes))
        shield_draws = await frame.evaluate('window.__weatherShieldDraws')
        expected_shield_size = 20 if (await frame.locator('#radarCanvas').bounding_box())['width'] < 420 else 24
        require(shield_draws and all(row['height']==expected_shield_size for row in shield_draws),
                'Official route artwork did not use the smaller responsive shield size: '+str(shield_draws))
        evidence['smallerOfficialShieldSize'] = expected_shield_size
        evidence["declutteredOfficialRoutes"] = routes
        evidence["officialShieldArtworkLoaded"] = ground['shields']
        evidence['compactMapActions']=await compact_map_actions(page,frame)
        await frame.locator('.map-panel').scroll_into_view_if_needed()
        await page.screenshot(path=str(output / f'weather-contextual-shields-{width}.png'),full_page=True)
        for removed in ["tryLiveFeeds", "mapLayerTimes", "mapGrid", "mapStatus", "observedRadarNote", "mapHelp"]:
            require(await frame.locator("#" + removed).count() == 0,
                    "Removed map control or descriptive copy remains: " + removed)
        require(await frame.locator('#mapAttribution a[href*="nationalmap.gov"]').count() == 0,
                "The generic USGS National Map link remains")
        await wait_for(frame, "() => {const image=document.getElementById('mapReflectivityLegend'); return image?.complete && image.naturalWidth===500 && image.naturalHeight===30;}")
        accordion = frame.locator('#mapLegendAccordion')
        require(not await accordion.evaluate('el=>el.open')
                and not (await frame.evaluate('cmpriWeatherMap.getState().legend.expanded')),
                'Map legends must initially be collapsed')
        feed_counts = [len(fixture.map_urls),len(fixture.wms_requests),len(fixture.reference_requests),len(fixture.basemap_requests)]
        await menu(frame, 'mapLegendAccordion', True)
        await frame.evaluate("() => {const input=document.getElementById('mapOpacity');input.dispatchEvent(new Event('input',{bubbles:true}));}")
        require(await accordion.evaluate('el=>el.open')
                and (await frame.evaluate('cmpriWeatherMap.getState().legend.expanded')),
                'Map UI refresh discarded the expanded legend')
        require(feed_counts == [len(fixture.map_urls),len(fixture.wms_requests),len(fixture.reference_requests),len(fixture.basemap_requests)],
                'Opening or rendering the legend triggered a source request')
        legend = await frame.evaluate("""() => {
          const host=document.getElementById('mapLegend'),accordion=document.getElementById('mapLegendAccordion'),shell=document.getElementById('mapShell');
          const a=accordion.getBoundingClientRect(),b=shell.getBoundingClientRect(),style=getComputedStyle(accordion);
          return {inside:accordion.parentElement===shell&&host.parentElement.id==='mapLegendContents',left:a.left-b.left,bottom:b.bottom-a.bottom,
            width:a.width,mapWidth:b.width,height:a.height,mapHeight:b.height,text:host.textContent,links:host.querySelectorAll('a').length,
            background:style.backgroundColor,keyWidth:host.getBoundingClientRect().width};
        }""")
        legend["reflectivityRowWidth"] = await frame.locator('.cmpri-reflectivity-legend').evaluate("el=>el.getBoundingClientRect().width")
        require(legend["inside"] and 0 <= legend["left"] <= 16 and 0 <= legend["bottom"] <= 45
                and legend["width"] < legend["mapWidth"] and legend["height"] <= legend["mapHeight"] * .46 + 1,
                "Official radar legend is not compact in the map's lower-left corner: " + str(legend))
        require(legend["reflectivityRowWidth"] <= 180.5 and legend["keyWidth"] <= 180.5 and 195 <= legend["width"] <= 197
                and legend["background"] == 'rgba(8, 12, 14, 0.76)',
                "Reflectivity key backdrop expands beyond its compact 180px source ramp: " + str(legend))
        require(not re.search(r"legend unavailable", legend["text"], re.I) and legend["links"] == 0,
                "Removed unavailable message or standalone legend link remains")
        ticks = await frame.locator(".cmpri-reflectivity-ticks > span").evaluate_all("""elements=>elements.map(element=>({
          text:element.textContent.replaceAll('−','-'),font:parseFloat(getComputedStyle(element).fontSize)
        }))""")
        require([tick["text"] for tick in ticks] == ["-20", "-10", "0", "10", "20", "30", "40", "50", "60", "70"]
                and all(tick["font"] >= 9 for tick in ticks),
                "Source-verified radar legend ticks are missing or too small to read: " + str(ticks))
        legend["readableVerifiedTicks"] = ticks
        legend["framelessPresentation"] = await legend_layout(frame,'.cmpri-reflectivity-legend','.cmpri-reflectivity-ramp')
        legend["collapsedByDefault"] = True
        legend["toggleDoesNotFetch"] = True
        legend["openStateSurvivesRender"] = True
        evidence["officialRadarLegendInMap"] = legend
        await menu(frame, 'mapLegendAccordion', False)
        sliders = await frame.evaluate("""() => ['mapOpacity','playbackSpeed','loopLength'].map(id => {
          const element=document.getElementById(id),row=element.closest('.cmpri-map-playback-options');
          return {id,type:element.type,row:row?.className,output:element.closest('label')?.querySelector('output')?.textContent};
        })""")
        require(all(row["type"] == "range" and row["row"] and row["output"] for row in sliders),
                "Opacity, speed and observed-loop sliders are not together with readable outputs: " + str(sliders))
        evidence["compactControls"] = sliders
        await wait_for(frame, "cmpriWeatherMap.getState().refresh.scheduled")
        cadence = await frame.evaluate("cmpriWeatherMap.getState().refresh")
        require(cadence["intervalMs"] == 300000 and cadence["nextAt"],
                "Visible Weather has no automatic five-minute map refresh")
        def catalog_reads():
            return len([call for call in fixture.wms_requests if call["product"] == "reflectivity" and call["op"] == "capabilities"])
        catalogs_before = catalog_reads()
        nws_before = [fixture.observation_calls, fixture.history_calls, fixture.forecast_calls, fixture.alert_calls]
        await page.clock.fast_forward(cadence["intervalMs"] + 10)
        deadline = asyncio.get_running_loop().time() + 10
        while catalog_reads() <= catalogs_before:
            require(asyncio.get_running_loop().time() < deadline, "Visible automatic map refresh did not read the actual scan catalog")
            await asyncio.sleep(.05)
        await wait_for(frame, "cmpriWeatherMap.getState().refresh.scheduled && cmpriWeatherMap.getState().pendingRequests === 0")
        await wait_for(frame,"!nwsLiveView.getState().loading")
        require([fixture.observation_calls,fixture.history_calls,fixture.forecast_calls,fixture.alert_calls] ==
                [nws_before[0]+1,nws_before[1]+1,nws_before[2],nws_before[3]],
                "Visible map cadence did not recheck only latest+history exactly once")
        await set_visibility(frame, False)
        require(not await frame.evaluate("cmpriWeatherMap.getState().refresh.scheduled"),
                "Map refresh stayed scheduled after its view was hidden")
        hidden_count = len(fixture.map_urls)
        hidden_nws = [fixture.observation_calls,fixture.history_calls,fixture.forecast_calls,fixture.alert_calls]
        await page.clock.fast_forward(cadence["intervalMs"] + 10)
        await asyncio.sleep(.1)
        require(len(fixture.map_urls) == hidden_count and hidden_nws == [fixture.observation_calls,fixture.history_calls,fixture.forecast_calls,fixture.alert_calls],
                "A hidden Weather view continued map or observation refresh")
        await set_visibility(frame, True)
        await wait_for(frame, "cmpriWeatherMap.getState().refresh.scheduled && cmpriWeatherMap.getState().pendingRequests === 0")
        evidence["foregroundAutomaticRefresh"] = {"intervalMs": cadence["intervalMs"],
            "visibleRefreshReadsScanCatalog": True, "hiddenViewStopsRequests": True,
            "resumesAfterReturning": True, "onlyLatestAndHistoryForegroundRechecked": True}
        evidence["wheelActivation"] = await wheel_activation(page, frame)
        await frame.locator("#recenter").click()
        await settled(frame)
        await frame.locator(".map-panel").scroll_into_view_if_needed()
        await page.screenshot(path=str(output / f"weather-compact-regional-{width}.png"), full_page=True)
        await radar(frame, False)
        color = await pixel(frame)
        require(max(abs(color[n]-[173,80,42][n]) for n in range(3))<=3,
                "Aerial source imagery was not rendered under weather")
        require({row['dataset'] for row in fixture.basemap_requests} == {'imagery'},
                "Aerial-only Weather requested an alternate ground dataset")
        require('capture year unavailable' in (await frame.locator('#mapGroundStatus').inner_text()).lower(),
                "Aerial capture year was invented")
        require('USGS' in await frame.locator('#mapAttribution').inner_text(), 'Required imagery attribution is missing')
        evidence['aerialOnlyGround']={'fixturePixel':color,'noAlternateBackgroundUiOrRequests':True}
        base_pixel = await pixel(frame)
        await radar(frame, True)
        await wait_for(frame, "window.cmpriWeatherMap.getState().status.radar === 'Observed image loaded'")
        await asyncio.sleep(.08)
        overlay_pixel = await pixel(frame)
        alpha = 180 / 255 * (await frame.evaluate("window.cmpriWeatherMap.getState().opacity"))
        expected = [round(base_pixel[n] * (1 - alpha) + [30, 170, 75][n] * alpha) for n in range(3)]
        require(max(abs(overlay_pixel[n] - expected[n]) for n in range(3)) <= 4,
                f"Radar/background composition mismatch: base={base_pixel}, overlay={overlay_pixel}, expected={expected}")
        evidence["radarCompositedOverGround"] = {"ground": base_pixel, "radarOverGround": overlay_pixel}
        # All loop windows must contain only exact catalog times; shorter
        # windows must not fabricate missing scans to fill a requested duration.
        loop_counts = {}
        for minutes in ["120", "60", "90"]:
            await set_range(frame, "loopLength", minutes)
            state = await frame.evaluate("window.cmpriWeatherMap.getState()")
            require(state["loopMinutes"] == int(minutes), "Loop-window selection did not update")
            require(state["scanTimes"] and set(state["scanTimes"]).issubset(fixture.scan_times), "Loop invented scan times")
            require(state["scanTimes"][-1] == fixture.scan_times[-1], "Loop dropped the latest actual scan")
            require(state["scanTimes"][-1] - state["scanTimes"][0] <= int(minutes) * 60000, "Loop exceeds selected history")
            loop_counts[minutes] = state["frameCount"]
        require(loop_counts["120"] > loop_counts["60"], "Loop-window control did not filter actual history")
        for slider_value, value in enumerate(["slow", "normal", "fast"]):
            await set_range(frame, "playbackSpeed", slider_value)
            require((await frame.evaluate("window.cmpriWeatherMap.getState()"))["playbackSpeed"] == value, "Playback speed selection did not update")
            require(value in (await frame.locator("#playbackSpeedValue").inner_text()).lower(), "Playback speed output is unreadable")
        displayed = await frame.evaluate("window.cmpriWeatherMap.getState().displayedScanTime")
        await frame.locator("#playLoop").click()
        await wait_for(frame, "before => { const s=window.cmpriWeatherMap.getState(); return s.playing && s.displayedScanTime !== before; }", displayed, timeout=7000)
        playing = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(playing["displayedScanTime"] in fixture.scan_times, "Playback displayed an invented scan time")
        await frame.locator("#playLoop").click()
        evidence["actualScanWindows"] = loop_counts
        evidence["loadedScanPlayback"] = True
        # Warm sixty actual scan fixtures, then hold the selected replacement
        # while other scans exert pressure beyond the64-image cache bound.
        await set_range(frame,"loopLength",120)
        await wait_for(frame,"cmpriWeatherMap.getState().readyFrameCount===cmpriWeatherMap.getState().frameCount",timeout=30000)
        warmed=await frame.evaluate("cmpriWeatherMap.getState()")
        require(warmed["readyFrameCount"]>=60,"Eviction regression did not warm enough actual scan fixtures")
        latest=warmed["scanTimes"][-1]
        await set_range(frame,"frameRange",warmed["frameCount"]-1)
        await wait_for(frame,"latest=>cmpriWeatherMap.getState().displayedScanTime===latest",latest)
        fixture.radar_held_times={latest};fixture.radar_held_gate.clear()
        exports_before=len(fixture.exports)
        await frame.locator('#zoomOut').click()
        await wait_for(frame,"cmpriWeatherMap.getState().readyFrameCount>=cmpriWeatherMap.getState().frameCount-1 && cmpriWeatherMap.getState().rasterLoads>0",timeout=30000)
        retained=await frame.evaluate("cmpriWeatherMap.getState()")
        require(len(fixture.exports)>64 and retained["displayedRasterLoaded"] and retained["displayedScanTime"]==latest,
                "Displayed radar disappeared during cache pressure and a held replacement: "+str(retained))
        retained_pixel=await frame.locator('#radarCanvas').evaluate("""canvas=>Array.from(canvas.getContext('2d').getImageData(Math.round(canvas.width*.61),Math.round(canvas.height*.34),1,1).data)""")
        require(retained_pixel[1]>100 and retained_pixel[0]<130,"Held cached radar pixels disappeared from covered map ground: "+str(retained_pixel))
        require(retained["imageCacheSize"]<=64,"Radar cache exceeded64 images")
        fixture.radar_held_gate.set()
        await wait_for(frame,"cmpriWeatherMap.getState().readyFrameCount===cmpriWeatherMap.getState().frameCount",timeout=30000)
        # A larger cached raster must cover a smaller viewport without refetches.
        reuse_before=len(fixture.exports)
        await frame.locator('#zoomIn').click();await asyncio.sleep(.4)
        require(len(fixture.exports)==reuse_before,"Zooming into cached geographic coverage re-requested radar PNGs")
        require(await frame.evaluate('cmpriWeatherMap.getState().readyFrameCount===cmpriWeatherMap.getState().frameCount'),
                "Ready cached loop coverage disappeared after coverage reuse")
        # Advance the official capabilities by one real scan and hold its PNG.
        new_scan=fixture.scan_times[-1]+120000;fixture.scan_times.append(new_scan)
        fixture.radar_held_times={new_scan};fixture.radar_held_gate.clear()
        prior_ready=set(await frame.evaluate('cmpriWeatherMap.getState().scanTimes'))
        refresh_exports=len(fixture.exports)
        await frame.locator('#playLoop').click()
        await page.clock.fast_forward(300010)
        await wait_for(frame,'scan=>cmpriWeatherMap.getState().scanTimes.includes(scan) && cmpriWeatherMap.getState().rasterLoads>0',new_scan,timeout=20000)
        progress=await frame.evaluate('cmpriWeatherMap.getState()')
        ready_times={item['time'] for item in progress['frameProgress'] if item['status']=='ready'}
        require(prior_ready.issubset(ready_times) and progress['displayedRasterLoaded'],
                'A delayed new scan refresh discarded previously ready loop coverage')
        require(all(item['time']==new_scan for item in fixture.exports[refresh_exports:]),
                'Refreshing one new scan re-requested PNGs for cached loop scans')
        before_play=progress['displayedScanTime']
        await wait_for(frame,'before=>cmpriWeatherMap.getState().displayedScanTime!==before',before_play,timeout=4000)
        playing=await frame.evaluate('cmpriWeatherMap.getState()')
        require(playing['displayedScanTime'] in ready_times and playing['rasterLoads']>0,
                'Playback waited for the held newest scan instead of cycling ready scans')
        await frame.locator('#playLoop').click();paused=await frame.evaluate('cmpriWeatherMap.getState()')
        await asyncio.sleep(.15)
        require(await frame.locator('.loop').evaluate('el=>parseFloat(getComputedStyle(el).opacity)')==1,
                'Pending new scan dims the entire playback bar')
        bar=frame.locator('#frameRange')
        require('scans ready' in await bar.get_attribute('aria-valuetext') and 'linear-gradient' in await bar.evaluate('el=>el.style.backgroundImage'),
                'Playback bar lacks per-scan loading progress')
        fixture.radar_held_gate.set()
        await wait_for(frame,'cmpriWeatherMap.getState().readyFrameCount===cmpriWeatherMap.getState().frameCount',timeout=15000)
        loaded=await frame.evaluate('cmpriWeatherMap.getState()')
        require(not loaded['playing'] and loaded['frame']==paused['frame'] and loaded['displayedScanTime']==paused['displayedScanTime'],
                'Completing a background scan advanced a paused frame')
        calls=len(fixture.exports)
        await frame.locator('#playLoop').click();await asyncio.sleep(.8);await frame.locator('#playLoop').click()
        require(len(fixture.exports)==calls,'Playing ready loop frames re-requested cached PNGs')
        wanted=loaded['frameCount']//2;await set_range(frame,'frameRange',wanted)
        await wait_for(frame,'wanted=>{const s=cmpriWeatherMap.getState();return s.frame===wanted && s.displayedScanTime===s.scanTimes[wanted];}',wanted)
        evidence['cachePressureAndDelayedNewScan']={'warmedScans':warmed['readyFrameCount'],'requestsBeyondCacheLimit':len(fixture.exports)>64,
            'displayedRasterRetained':retained['displayedRasterRetained'],'coveredPixel':retained_pixel,'cachedReadyCoverageReused':True,
            'delayedNewScanKeepsOldReadyFrames':True,'readyPlaybackNoRefetch':True,'pauseStableAfterBackgroundLoad':True}
        evidence['seekSliderUsesRequestedFrame']=True
        # Verify all four inputs resolve to the vertical-bar thumb rule.
        thumbs = await frame.evaluate("""() => ['frameRange','mapOpacity','playbackSpeed','loopLength'].map(id=>{
          const el=document.getElementById(id),matching=[];
          function scan(rules){for(const rule of rules){if(rule.cssRules?.length)scan(rule.cssRules);if(rule.selectorText?.includes('::-webkit-slider-thumb')){
            for(const selector of rule.selectorText.split(',')){try{if(el.matches(selector.replace('::-webkit-slider-thumb','')))matching.push({width:rule.style.width,height:rule.style.height,radius:rule.style.borderRadius});}catch{}}
          }}}for(const sheet of document.styleSheets){try{scan(sheet.cssRules);}catch{}}
          return {id,rule:matching.at(-1)};
        })""")
        require(all(row.get("rule") and float(row["rule"]["height"].replace("px",""))>float(row["rule"]["width"].replace("px","")) for row in thumbs),
                "Not every slider has a vertical-bar thumb style: "+str(thumbs))
        evidence["fourVerticalBarThumbs"] = thumbs
        evidence["gestures"] = [await anchored_zoom(page, frame, "pinch", True)] if width < 640 else [
            await anchored_zoom(page, frame, "wheel"), await anchored_zoom(page, frame, "double-click")]
        # Batch local zoom actions into one frame, avoiding a test-created
        # request storm, then verify native tile limits and explicit overzoom.
        await frame.locator("#recenter").click()
        await frame.evaluate("() => { for (let n=0;n<30;n++) document.getElementById('zoomIn').click(); }")
        await wait_for(frame, "window.cmpriWeatherMap.getState().zoom === 1024")
        await settled(frame)
        high = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(abs(high["center"]["lat"] - 40.138080) < 1e-8
                and abs(high["center"]["lon"] + 88.251416) < 1e-8,
                "Hotel-scale zoom lost the fixed property center")
        pin=high['pinAnchor']
        require(pin['anchor']=='tip' and abs(pin['lat']-40.138080)<1e-8 and abs(pin['lon']+88.251416)<1e-8,
                'Hotel pin tip lost the verified property coordinate at high zoom')
        require(high["ground"]["tileZoom"] <= 16, "Ground map requested unsupported native detail")
        require(all(tile["z"] <= 16 for tile in fixture.basemap_requests), "Ground tile requests exceeded z16")
        evidence["hotelScaleOverzoom"] = {"zoom": high["zoom"], "nativeTileZoom": high["ground"]["tileZoom"],
                                         "requestedZoom": high["ground"]["requestedZoom"]}
        await page.screenshot(path=str(output / f"weather-ground-hotel-{width}.png"), full_page=True)
        # Move to uncached aerial tiles, then prove failures do not retry on
        # every redraw. Synthetic route/imagery data remain explicit fixtures.
        fixture.basemap_fail_datasets.add("imagery")
        await frame.locator('#radarCanvas').focus()
        await frame.evaluate("() => {for(let n=0;n<40;n++)document.getElementById('radarCanvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));}")
        await settled(frame)
        failed = await frame.evaluate("window.cmpriWeatherMap.getState().ground")
        require(failed["visibleFailed"] > 0 and any(word in (failed["status"] + failed["error"]).lower() for word in ["unavailable", "failed"]),
                "Failed ground tiles were not labeled unavailable")
        before_retry = len(fixture.basemap_requests)
        await frame.evaluate("() => { for (let n=0;n<8;n++) { const opacity=document.getElementById('mapOpacity'); opacity.value=String(40+n); opacity.dispatchEvent(new Event('input')); } }")
        await asyncio.sleep(.5)
        require(len(fixture.basemap_requests) == before_retry, "Failed tiles retried on each redraw")
        require(fixture.basemap_max_inflight <= 4, "Ground map exceeded four concurrent source requests")
        require(failed["cacheSize"] <= 150, "Ground LRU cache exceeded its bound")
        evidence["failureAndCache"] = {"visibleFailed": failed["visibleFailed"], "retryBurst": False,
            "maximumConcurrentRequests": fixture.basemap_max_inflight, "cacheSize": failed["cacheSize"]}
        # Keep new imagery tile requests pending while closing the native host.
        fixture.basemap_fail_datasets.clear()
        fixture.hold_basemap = True
        fixture.basemap_gate.clear()
        fixture.basemap_pending.clear()
        fixture.hold_map = True
        fixture.map_gate.clear()
        fixture.scan_times.append(fixture.scan_times[-1]+120000)
        await page.clock.fast_forward(300010)
        await wait_for(frame,"cmpriWeatherMap.getState().rasterLoads>0")
        await frame.locator('#radarCanvas').focus()
        await frame.evaluate("() => {for(let n=0;n<40;n++)document.getElementById('radarCanvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));}")
        await asyncio.wait_for(fixture.basemap_pending.wait(), timeout=5)
        await frame.evaluate("""() => {
          const close = window.nwsLiveView.close;
          window.nwsLiveView.close = (...args) => { const result=close(...args);
            parent.__groundClosedState=window.cmpriWeatherMap.getState(); return result; };
        }""")
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="hidden")
        closed = await page.evaluate("window.__groundClosedState")
        require(closed and closed["ground"]["pending"] == 0 and not closed["ground"]["opened"],
                "Ground tile requests survived native close")
        require(closed["rasterLoads"] == 0 and closed["rasterQueue"] == 0 and closed["pendingRequests"] == 0,
                "NOAA raster requests or queued scans survived native close")
        require(not closed["refresh"]["scheduled"] and not closed["wheelZoomActive"],
                "Automatic map refresh or wheel activation survived native close")
        fixture.release()
        count_closed = len(fixture.basemap_requests)
        await asyncio.sleep(.25)
        require(len(fixture.basemap_requests) == count_closed, "Ground requested tiles after Weather closed")
        require(not errors and not externals and not await frame_forbidden(page), "Unexpected browser errors or external/permission activity")
        require(len(mutations) == mutation_start, "Map interaction caused an application mutation")
        evidence.update({"passed": True, "closeAbortsGroundRequests": True, "noBackgroundRequests": True,
                         "groundRequests": count_closed, "noRealDatabaseOrPush": True, "errors": errors})
        print(f"PASS actual dashboard ground map/gestures {width}×{height} (local fixtures)", flush=True)
        return evidence
    finally:
        fixture.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3116"))
    parser.add_argument("--output", default="/tmp/cmpri-weather-ground-review")
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
    (output / "weather-ground-report.json").write_text(json.dumps({"fixtureOnly": True,
        "liveFeedAvailabilityVerified": False, "results": results}, indent=2))
    require(all(row["passed"] for row in results), "Ground-map fixture acceptance failed; see " + str(output / "weather-ground-report.json"))


if __name__ == "__main__":
    asyncio.run(main())
