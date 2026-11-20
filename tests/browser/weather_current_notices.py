"""Current-observation priority and native weather-notice acceptance.

Run against a local VERCEL_ENV=preview build. Synthetic CMPRI accounts and every
API response are intercepted; external requests and WebSockets are blocked.
Weather values, ground pixels and alerts are explicit fixtures, never evidence
of current weather, actual NWS alerts, database persistence or push delivery.
"""
import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

sys.dont_write_bytecode = True
from weather_dashboard_preview import (
    API, PREVIEW, PROBE, OfficialFeedFixtures, block_websocket, install,
    iso, require, wait_for, weather_frame,
)
from weather_map_basemaps import menu, settled
from playwright.async_api import async_playwright


class CurrentFixtures(OfficialFeedFixtures):
    def __init__(self):
        super().__init__()
        local = self.now.astimezone(ZoneInfo("America/Chicago"))
        self.now = local.replace(hour=15, minute=40, second=0, microsecond=0)
        if self.now > local:
            self.now -= timedelta(days=1)
        self.now = self.now.astimezone(timezone.utc)
        self.scan_times = [int((self.now - timedelta(minutes=minutes)).timestamp() * 1000) for minutes in [10, 5]]
        self.hold_observation = False
        self.hold_alerts = False
        self.observation_gate.set()
        self.alert_gate.set()
        self.hold_map = True
        self.wind_chill = -5
        self.gust = 28
        self.alert_features = []
        self.alert_failure = False
        self.observation_failure = False
        self.history_failure = False
        self.history_extra = []

    def alert(self, identity, event, *, action="Alert", expired=False):
        bulletin = API + "/alerts/urn:oid:TEST-FIXTURE-" + identity
        return {"type": "Feature", "id": bulletin, "geometry": None, "properties": {
            "id": bulletin, "status": "Actual", "messageType": action, "event": event,
            "headline": "TEST FIXTURE " + event + " applies to property",
            "areaDesc": "TEST FIXTURE Champaign County",
            "effective": iso(self.now - timedelta(minutes=5)),
            "expires": iso(self.now + timedelta(hours=-1 if expired else 2)),
            "description": "Explicit local fixture. No actual alert or push has been issued.",
            "instruction": "TEST FIXTURE official instructions."}}

    def nws(self):
        result = super().nws()
        observation = result["resources"]["observation"]
        observation["station"] = {"id": "KCMI", "name": "TEST FIXTURE Willard Airport",
                                  "distanceMeters": 11265}
        p = observation["data"]["properties"]
        p.update({"temperature": {"value": 10, "unitCode": "wmoUnit:degF"},
            "windChill": {"value": self.wind_chill, "unitCode": "wmoUnit:degF"},
            "heatIndex": {"value": None, "unitCode": "wmoUnit:degF"},
            "windSpeed": {"value": 18, "unitCode": "wmoUnit:mi_h-1"},
            "windGust": {"value": self.gust, "unitCode": "wmoUnit:mi_h-1"},
            "windDirection": {"value": 315, "unitCode": "wmoUnit:degree_(angle)"},
            "visibility": {"value": 9656.064, "unitCode": "wmoUnit:m"},
            "textDescription": "Mostly Cloudy"})
        day_start = self.now.astimezone(ZoneInfo("America/Chicago")).replace(hour=0, minute=0)
        self.history_samples = [(day_start - timedelta(minutes=30), 99),
            (day_start + timedelta(minutes=30), -12),
            (day_start + timedelta(minutes=60), 5),
            (day_start + timedelta(hours=4), 45),
            (day_start + timedelta(hours=4, minutes=30), 45),
            (day_start + timedelta(hours=5), -12),
            (self.now - timedelta(minutes=36), 20), (self.now - timedelta(minutes=6), 10)] + self.history_extra
        history = result["resources"]["history"]
        history["data"] = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": API + "/stations/KCMI/observations/TEST-HISTORY-" + str(index),
             "properties": {"timestamp": iso(stamp), "temperature": {"value": value, "unitCode": "wmoUnit:degF"}}}
            for index, (stamp, value) in enumerate(self.history_samples)]}
        result["history"]["returnedCount"] = len(self.history_samples)
        if self.history_failure:
            history.update(status="unavailable", data=None, error="TEST FIXTURE observation history unavailable")
        if self.observation_failure:
            observation.update(status="unavailable", data=None, error="TEST FIXTURE current station unavailable")
        temperatures = [-15, 0, 15, 32, 50, 70, 90, 110, 10, 10, 42, 75]
        descriptions = ["Sunny", "Mostly Cloudy", "Rain", "Snow", "Thunderstorms", "Fog", "Windy", "Clear"]
        for kind in ["hourly", "forecast"]:
            for index, period in enumerate(result["resources"][kind]["data"]["properties"]["periods"]):
                period["temperature"] = temperatures[index % len(temperatures)]
                period["temperatureUnit"] = "F"
                period["shortForecast"] = descriptions[index % len(descriptions)]
        result["resources"]["grid"]["data"]["properties"]["windGust"] = {
            "uom": "wmoUnit:mi_h-1", "values": [{"validTime": iso(self.now) + "/PT12H", "value": 30}]}
        alerts = result["resources"]["alerts"]
        alerts["data"]["features"] = self.alert_features
        if self.alert_failure:
            alerts.update(status="unavailable", data=None, error="TEST FIXTURE alert source unavailable")
        return result


async def context_for(browser, width, height, feed, role="chief_engineer"):
    context = await browser.new_context(viewport={"width": width, "height": height},
        is_mobile=width < 640, has_touch=width < 640, service_workers="block", reduced_motion="reduce")
    await context.route_web_socket("**/*", block_websocket)
    errors, external, mutations = [], [], []
    await install(context, role)
    await context.route("**/api/weather-preview**", feed.route)
    context.on("requestfailed", feed.request_failed)
    async def protect(route):
        parsed = urlparse(route.request.url)
        if parsed.hostname not in ["127.0.0.1", "localhost"]:
            external.append(route.request.url)
            await route.abort("blockedbyclient")
            return
        if parsed.path.startswith("/api/") and route.request.method not in ["GET", "HEAD"]:
            mutations.append({"path": parsed.path, "method": route.request.method})
        await route.fallback()
    await context.route("**/*", protect)
    await context.add_init_script(PROBE)
    page = await context.new_page()
    await page.clock.install(time=feed.now)
    page.on("pageerror", lambda error: errors.append(str(error)))
    return context, page, errors, external, mutations


async def refresh(frame):
    await wait_for(frame, "!window.nwsLiveView.getState().loading")
    await frame.evaluate("() => { void nwsLiveView.refresh(); }")
    await wait_for(frame, "!window.nwsLiveView.getState().loading")


async def observed_extremes(frame):
    return await frame.locator('#liveTemperature .wv-dial-marker[data-kind="observed"]').evaluate_all("""elements=>Object.fromEntries(elements.map(el=>[el.dataset.extreme,{time:el.dataset.sampleTime,value:Number(el.dataset.airTemperature)}]))""")


async def observation_and_visuals(browser, base, output, width, height, role="chief_engineer"):
    feed = CurrentFixtures()
    context, page, errors, external, mutations = await context_for(browser, width, height, feed, role)
    evidence = {"viewport": [width, height], "fixtureOnly": True, "role": role}
    suffix = role + "-" + str(width)
    chief = role == "chief_engineer"
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.wait_for(state="visible", timeout=60000)
        require(feed.observation_calls == 0 and feed.history_calls == 0 and feed.forecast_calls == 0,
                "NWS requested before Weather opened")
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "document.querySelector('#liveTemperature .wv-temperature-value')?.textContent === '10°'")
        require(feed.observation_calls == 1, "KCMI latest observation duplicated on first open")
        require(feed.hold_forecast and feed.hold_history and not feed.forecast_gate.is_set() and not feed.history_gate.is_set(),
                "Independent history/forecast gates unexpectedly released")
        require(await frame.locator('#hourlyForecast .forecast-card').count() == 0,
                "Forecast fixtures leaked into the fast latest-observation response")
        require((await frame.evaluate('cmpriWeatherMap.getState().status.radar')) != 'Observed image loaded',
                "Radar unexpectedly completed while deliberately held")
        clock = await frame.evaluate('cmpriWeatherClock.getState()')
        require(clock['hour12'] is (not chief), "Chief/non-Chief clock preference was not propagated by the authenticated host")
        as_of = await frame.locator('#liveObservationTime').inner_text()
        expected_clock = '15:34' if chief else '3:34'
        require('As of' in as_of and 'KCMI' in as_of and expected_clock in as_of
                and (bool(re.search(r'\bPM\b', as_of)) is (not chief)),
                'Observation As of does not use actual role-appropriate Central time: ' + as_of)
        for identity in ['liveConditionIcon', 'liveWind', 'liveVisibility', 'liveConditionText', 'liveFeelsLike', 'liveGusts']:
            require(await frame.locator('#' + identity).count() == 1, 'Missing or duplicate current wheel metric: ' + identity)
            require(await frame.locator('#' + identity).evaluate("el=>Boolean(el.closest('.wv-dial-face'))"),
                    'Current metric is outside the wheel: ' + identity)
        require('-5°' in await frame.locator('#liveFeelsLike').inner_text(), 'Observed wind chill missing')
        require('28' in await frame.locator('#liveGusts').inner_text(), 'Observed gust omitted')
        require('18' in await frame.locator('#liveWind').inner_text() and 'NW' in await frame.locator('#liveWind').inner_text(),
                'Observed wind value or FROM direction missing')
        require('6 mi' in await frame.locator('#liveVisibility').inner_text(), 'Observed visibility missing from wheel')
        require(await frame.locator('#liveTemperature .wv-dial-observed-segment').count() == 0,
                'Current wheel invented history while the actual history request was held')
        await page.screenshot(path=str(output / ('current-latest-before-history-' + suffix + '.png')), full_page=True)
        evidence['independentLatestObservation'] = {'asOf': as_of, 'roleClock': clock, 'forecastAndHistoryHeld': True}
        feed.hold_history = False
        feed.history_gate.set()
        await wait_for(frame, "document.querySelectorAll('#liveTemperature .wv-dial-observed-segment').length > 0")
        require(await frame.locator('#hourlyForecast .forecast-card').count() == 0,
                'Observed history incorrectly waited for or released the forecast')
        extrema = await observed_extremes(frame)
        expected_high = feed.now.astimezone(ZoneInfo('America/Chicago')).replace(hour=4, minute=0)
        expected_low = expected_high.replace(hour=0, minute=30)
        require(extrema['H']['value'] == 45 and extrema['L']['value'] == -12,
                'Observed extrema used the 99-degree pre-midnight anchor or missed actual same-day extremes')
        require(datetime.fromisoformat(extrema['H']['time'].replace('Z','+00:00')) == expected_high
                and datetime.fromisoformat(extrema['L']['time'].replace('Z','+00:00')) == expected_low,
                'Observed extrema do not carry their actual report timestamps')
        spans = await frame.locator('#liveTemperature .wv-dial-observed-segment').evaluate_all("""elements=>elements.map(el=>({a:el.dataset.sampleStart,b:el.dataset.sampleEnd,start:el.dataset.startTime}))""")
        for span in spans:
            a,b = [datetime.fromisoformat(span[key].replace('Z','+00:00')) for key in ['a','b']]
            require(timedelta(0) < b-a <= timedelta(minutes=90), 'Observed timeline bridged an unsupported reporting gap')
            require(any(a == stamp for stamp,_ in feed.history_samples) and any(b == stamp for stamp,_ in feed.history_samples),
                    'Observed ring invented report endpoints')
        require(not any(datetime.fromisoformat(span['a'].replace('Z','+00:00')) == expected_high.replace(hour=1,minute=0)
                        and datetime.fromisoformat(span['b'].replace('Z','+00:00')) == expected_high for span in spans),
                'The 01:00–04:00 observation gap was filled')
        evidence['observedHistory'] = {'extrema': extrema, 'preMidnightAnchorExcludedFromExtrema': True,
            'unknownReportingGapsPreserved': True, 'independentOfForecast': True}
        feed.release()
        await wait_for(frame, "document.querySelectorAll('#hourlyForecast .forecast-card').length === 12 && !nwsLiveView.getState().loading")
        require(await frame.locator('#liveTemperature .wv-dial-marker[data-kind="forecast"]').count() == 2,
                'Current wheel does not distinguish forecast markers from observed markers')
        require(await frame.locator('#hourlyForecast .forecast-validity').count() == 0,
                'Hourly cards retain a repeated bottom date/time')
        gusts = await frame.locator('#hourlyForecast .wv-wind-gust').all_inner_texts()
        require(len(gusts) == 12 and all(re.fullmatch(r'Gusts\s+30\s+mph', gust, re.I) for gust in gusts),
                'Hourly gust labels retain Forecast or omit their actual forecast speed: ' + str(gusts))
        daily = frame.locator('#extendedForecast .daily-forecast-card')
        require(await daily.count() > 0 and await daily.locator('.wv-temperature-dial').count() == await daily.count(),
                'Every daily card needs its own dial')
        daily_markers = await daily.locator('.wv-dial-marker text').evaluate_all("els=>els.map(el=>el.textContent)")
        require(daily_markers and set(daily_markers).issubset({'H', 'L'}),
                'Extended Forecast marker labels still show FH/FL: '+str(daily_markers))
        daily_values = await daily.locator('.wv-dial-extreme-value').all_inner_texts()
        require(all(re.match(r'^[HL]\s', value) for value in daily_values),
                'Extended Forecast inside H/L badges retain forecast prefixes')
        require(set(await frame.locator('#liveTemperature .wv-dial-marker text').evaluate_all("els=>els.map(el=>el.textContent)")) == {'FH','FL','OH','OL'},
                'The scoped Extended Forecast label change also changed Current Conditions markers')
        same_ring = await frame.evaluate("""() => {
          const current=document.querySelector('#liveTemperature .wv-temperature-dial');
          const daily=document.querySelector('#extendedForecast [data-day="'+current.dataset.day+'"] .wv-temperature-dial');
          const values=host=>Array.from(host.querySelectorAll('.wv-dial-segment')).map(el=>[el.dataset.startTime,el.dataset.airTemperature,el.dataset.temperatureColor,el.getAttribute('d')]);
          return JSON.stringify(values(current))===JSON.stringify(values(daily));
        }""")
        require(same_ring, 'Today’s Extended Forecast ring changed its actual forecast fill or colors')
        faces = await frame.locator('.wv-temperature-dial').evaluate_all("""elements=>elements.map(el=>({
          summariesInside:Array.from(el.querySelectorAll('.wv-dial-extreme')).every(item=>Boolean(item.closest('.wv-dial-face'))),
          labels:Array.from(el.querySelectorAll('.wv-dial-clock')).map(item=>item.textContent),
          belowFace:Array.from(el.children).filter(item=>!item.matches('.wv-dial-face')).length,
          title:el.title,coverage:el.dataset.coverage
        }))""")
        expected_axis = ['00','06','12','18','24'] if chief else ['12 AM','6 AM','12 PM','6 PM','12 AM']
        require(all(face['summariesInside'] and face['belowFace'] == 0 and face['labels'] == expected_axis for face in faces),
                'A dial has misplaced H/L, below-wheel notes, or an incorrect role clock')
        require(any(face['coverage'] == 'unavailable' for face in faces), 'Missing daily hourly guidance became a colored full day')
        hourly = await frame.locator('#hourlyForecast .forecast-card').evaluate_all("""elements=>elements.map(el=>{
          const icon=el.querySelector('.hourly-condition-main .wv-condition'),v=el.querySelector('.wv-temperature-value');
          const box=el.getBoundingClientRect(),image=icon?.getBoundingClientRect(),temperature=el.querySelector('.wv-temperature');
          return {value:temperature?.dataset.airTemperature,color:temperature?.dataset.temperatureColor,
            numeric:v?.textContent,actualColor:v?getComputedStyle(v).color:null,
            centered:Boolean(image)&&Math.abs((image.left+image.width/2)-(box.left+box.width/2))<3,
            oldKey:el.querySelectorAll('.wv-temperature-scale,.wv-temperature-track,.wv-temperature-limits').length};
        })""")
        require(len(hourly) == 12 and all(row['centered'] and row['oldKey'] == 0 and '°' in row['numeric'] and 'F' not in row['numeric'] for row in hourly),
                'Hourly icons are not centered or old temperature keys/F labels remain')
        require(await frame.locator('.wv-temperature-scale,.wv-temperature-limits,.wv-dial-coverage,.wv-dial-caption,.wv-dial-limit').count() == 0,
                'Removed temperature keys or below-wheel labels remain')
        for row in hourly:
            color = row['color']
            rgb = 'rgb(' + ', '.join(str(int(color[offset:offset+2],16)) for offset in [1,3,5]) + ')'
            require(row['actualColor'] == rgb, 'Hourly temperature color was replaced by the site theme')
        stops = dict(await frame.evaluate('cmpriWeatherVisuals.stops.map(stop=>[stop.fahrenheit,stop.color])'))
        require(stops[0] == '#00e7e5' and stops[32] == '#e000ee' and stops[45] == '#0065fb'
                and stops[63] == '#9bff54' and stops[85] == '#ff8900' and stops[106] == '#e92b95',
                'The fixed reference palette changed')
        await frame.locator('#extendedForecast').scroll_into_view_if_needed()
        await page.screenshot(path=str(output / ('daily-inside-wheel-' + suffix + '.png')), full_page=True)
        await frame.locator('#hourlyForecast').scroll_into_view_if_needed()
        await page.screenshot(path=str(output / ('hourly-centered-color-' + suffix + '.png')), full_page=True)
        await frame.evaluate("document.getElementById('windowBody').scrollTo(0,0)")
        await page.screenshot(path=str(output / ('current-observed-and-forecast-' + suffix + '.png')), full_page=True)
        initial = await observed_extremes(frame)
        feed.history_extra.append((feed.now-timedelta(minutes=5),45))
        await refresh(frame)
        require(await observed_extremes(frame) == initial, 'Equal high report changed an already established observed extreme timestamp')
        feed.history_extra.append((feed.now-timedelta(minutes=4),46))
        await refresh(frame)
        higher = await observed_extremes(frame)
        require(higher['H']['value'] == 46 and datetime.fromisoformat(higher['H']['time'].replace('Z','+00:00')) == feed.now-timedelta(minutes=4)
                and higher['L'] == initial['L'], 'New observed high did not update only the appropriate extreme')
        feed.history_extra.append((feed.now-timedelta(minutes=3),-12))
        await refresh(frame)
        require((await observed_extremes(frame))['L'] == initial['L'], 'Equal low report moved the observed low timestamp')
        feed.history_extra.append((feed.now-timedelta(minutes=2),-13))
        await refresh(frame)
        require((await observed_extremes(frame))['L']['value'] == -13, 'A newly lower observed report did not update the low')
        evidence['observedExtremaStableUntilNewExtreme'] = True
        feed.wind_chill = 0; feed.gust = None
        await refresh(frame)
        require('0°' in await frame.locator('#liveFeelsLike').inner_text(), 'Valid zero wind chill became unavailable')
        require(await frame.locator('#liveGusts').count() == 0, 'Missing observed gust became zero or retained an old gust')
        feed.observation_failure = True
        await refresh(frame)
        require('STALE' in await frame.locator('#liveConditionsBadge').inner_text()
                and await frame.locator('#liveTemperature .wv-temperature-value').inner_text() == '10°',
                'Unavailable read discarded cached observation or silently treated it as fresh')
        feed.alert_failure = True
        await refresh(frame)
        require(await frame.locator('#officialAlertsSection').is_hidden(), 'Failed empty alert request created an alert section')
        availability = await frame.locator('#liveAlertAvailability').inner_text()
        require(re.search(r'unknown|unavailable|failed',availability,re.I) and not re.search(r'^\s*(?:all.clear|no active)',availability,re.I),
                'Unavailable alert data became an all-clear')
        evidence['cachedFailureLabeledStaleAndMissingNotZero'] = True
        require(not errors and not external and not mutations, 'Unexpected script error, external request or application mutation')
        require(await frame.evaluate('window.__weatherReviewForbidden.length===0'), 'GPS/push/permission API invoked')
        evidence.update(passed=True,errors=errors,externalRequests=external,applicationMutations=mutations)
        return evidence
    finally:
        feed.release(); await context.close()


async def real_siren_decode(page):
    result = await page.evaluate("""async()=>{
      const Constructor=window.__weatherOriginalAudioContext;
      if(!Constructor)throw new Error('Browser has no original AudioContext for local-file decoding');
      const context=new Constructor({sampleRate:48000});await context.suspend();
      const response=await fetch('/previews/weather/warning-siren.mp3');
      if(!response.ok)throw new Error('Local siren MP3 returned '+response.status);
      const bytes=await response.arrayBuffer(),byteLength=bytes.byteLength,buffer=await context.decodeAudioData(bytes);
      const samples=buffer.getChannelData(0),windowSize=Math.round(buffer.sampleRate*.1);
      let peak=0,total=0,first=0,last=0;
      for(let i=0;i<samples.length;i++){const square=samples[i]*samples[i];total+=square;peak=Math.max(peak,Math.abs(samples[i]));if(i<windowSize)first+=square;if(i>=samples.length-windowSize)last+=square;}
      const result={bytes:byteLength,duration:buffer.duration,channels:buffer.numberOfChannels,sampleRate:buffer.sampleRate,
        peak,rms:Math.sqrt(total/samples.length),first100msRms:Math.sqrt(first/windowSize),last100msRms:Math.sqrt(last/windowSize),
        suspendedDuringDecode:context.state==='suspended',outputConnected:false,sourcesStarted:0};
      await context.close();return result;
    }""")
    require(11.5 < result['duration'] < 11.9 and result['channels']==1 and result['sampleRate']==48000,
            'Browser cannot decode the actual local mono11.72-second siren MP3: '+str(result))
    require(result['peak'] < 1 and result['first100msRms'] < result['rms']*.25 and result['last100msRms'] < result['rms']*.25
            and result['suspendedDuringDecode'], 'The actual siren does not have a quiet unclipped rise/tail: '+str(result))
    return result


async def severity_clear_sound_sequence(page, frame, feed):
    dialog=page.locator('[data-weather-guest-safety-dialog]');ticker=page.locator('[data-weather-alert-ticker]')
    before=await page.evaluate('window.__weatherAudioAudit.starts.length')
    feed.alert_features=[feed.alert('SEVERITY-REVISION','Winter Storm Watch')]
    await refresh(frame);await ticker.wait_for(state='visible')
    require(await ticker.get_attribute('data-level')=='watch' and await dialog.is_hidden(), 'Clear→Watch did not stay yellow/standard')
    watch_color=await ticker.evaluate("el=>getComputedStyle(el).backgroundColor")
    require(watch_color=='rgb(48, 38, 0)', 'Current Watch ticker does not use its yellow background: '+watch_color)
    require(await page.evaluate('window.__weatherAudioAudit.starts.length')==before,'Watch played warning sound')
    feed.alert_features=[feed.alert('SEVERITY-REVISION','Tornado Warning')]
    await refresh(frame);await dialog.wait_for(state='visible')
    await wait_for(page,'before=>window.__weatherAudioAudit.starts.length===before+1',before)
    require(await ticker.get_attribute('data-level')=='warning' and await dialog.get_attribute('data-level')=='warning',
            'Watch→Warning did not show current red severity')
    await wait_for(page,"getComputedStyle(document.querySelector('[data-weather-alert-ticker]')).backgroundColor==='rgb(69, 13, 19)'")
    warning_color=await ticker.evaluate("el=>getComputedStyle(el).backgroundColor")
    require(warning_color=='rgb(69, 13, 19)' and warning_color!=watch_color,
            'Current Warning ticker does not use its red background: '+warning_color)
    await dialog.locator('[data-weather-guest-safety-close]').click()
    await frame.locator('#tab-notifications').click();await frame.locator('#npClearNotifications').click()
    require(not (await frame.evaluate('notificationPreview.snapshot()'))['inbox'], 'Clear notifications left old history')
    require(await ticker.get_attribute('data-level')=='warning'
            and await frame.locator('#npLiveInbox [data-level="warning"]').count()==1,
            'Clearing notifications hid or downgraded the active official warning')
    require('cleared' in (await frame.locator('#npClearStatus').inner_text()).lower(), 'Clear notifications gave no visible feedback')
    await refresh(frame)
    require(await dialog.is_hidden() and await page.evaluate('window.__weatherAudioAudit.starts.length')==before+1,
            'An unchanged cleared warning reopened or sounded again')
    await ticker.click();await dialog.wait_for(state='visible')
    feed.alert_features=[feed.alert('SEVERITY-REVISION','Winter Storm Watch')]
    await refresh(frame)
    await wait_for(page,"document.querySelector('[data-weather-guest-safety-dialog]')?.dataset.level==='watch'")
    require(await ticker.get_attribute('data-level')=='watch' and await dialog.get_attribute('data-fullscreen')=='false',
            'Same-ID warning→watch revision retained a historical red/full-screen warning')
    await wait_for(page,"getComputedStyle(document.querySelector('[data-weather-alert-ticker]')).backgroundColor==='rgb(48, 38, 0)'")
    require(await ticker.evaluate("el=>getComputedStyle(el).backgroundColor")==watch_color,
            'Downgraded Watch retains the old Warning color')
    require('Winter Storm Watch' in await dialog.inner_text(), 'Downgrade details still show the previous warning')
    feed.alert_features=[];await refresh(frame)
    await wait_for(page,"!document.querySelector('[data-weather-alert-ticker]') && !document.querySelector('[data-weather-guest-safety-dialog][open]')")
    require(not (await frame.evaluate('notificationPreview.snapshot()'))['alerts'], 'Official Clear left active hazards')
    require(await page.evaluate('window.__weatherAudioAudit.starts.length')==before+1
            and await page.evaluate('window.__weatherAudioAudit.stops.length')>0, 'Clear/downgrade did not stop warning sound or played another one')
    if not await frame.locator('#npClearNotifications').is_disabled(): await frame.locator('#npClearNotifications').click()
    await frame.locator('#tab-weather').click()
    return {'sequence':'Clear→Watch→Warning→Watch→Clear','watchYellowWarningRed':True,
            'clearHistoryPreservesCurrentHazards':True,'sameIdDowngradeReconcilesCurrentDetails':True,
            'oneSoundForNewWarningNoSoundForWatchUnchangedOrClear':True}


async def pending_and_blocked_sound(browser,base,width,height):
    outcomes=[]
    for mode in ['pending-cancel','blocked-retry']:
        feed=CurrentFixtures();feed.release()
        context,page,errors,external,mutations=await context_for(browser,width,height,feed)
        try:
            await page.goto(base+'/engineering',wait_until='domcontentloaded')
            await page.evaluate("mode=>{window.__weatherAudioAudit.holdDecode=mode==='pending-cancel';window.__weatherAudioAudit.blockResume=mode==='blocked-retry';}",mode)
            await page.get_by_role('button',name='Weather',exact=True).click();frame=await weather_frame(page)
            await wait_for(frame,'!nwsLiveView.getState().loading')
            feed.alert_features=[feed.alert('AUDIO-'+mode,'Tornado Warning')];await refresh(frame)
            dialog=page.locator('[data-weather-guest-safety-dialog]');await dialog.wait_for(state='visible')
            if mode=='pending-cancel':
                await wait_for(page,'window.__weatherAudioAudit.pendingDecodes.length===1')
                feed.alert_features=[];await refresh(frame);await dialog.wait_for(state='hidden')
                await page.evaluate('window.__weatherAudioAudit.releaseDecodes()');await asyncio.sleep(.2)
                require(await page.evaluate('window.__weatherAudioAudit.starts.length')==0,'Canceled warning played after its delayed audio decode completed')
            else:
                status=dialog.locator('[data-weather-warning-sound="blocked"]');await status.wait_for(state='visible')
                require(await page.evaluate('window.__weatherAudioAudit.starts.length')==0,'Blocked audio context played')
                await dialog.locator('[data-weather-guest-safety-close]').click()
                await page.locator('[data-weather-alert-ticker]').click()
                await dialog.wait_for(state='visible')
                await status.wait_for(state='visible')
                require(await page.evaluate('window.__weatherAudioAudit.starts.length')==0,
                        'Reopening a blocked warning automatically replayed audio')
                await page.evaluate('window.__weatherAudioAudit.blockResume=false')
                await status.get_by_role('button',name='Enable warning sound',exact=True).click()
                await wait_for(page,'window.__weatherAudioAudit.starts.length===1')
                feed.alert_features=[];await refresh(frame);await dialog.wait_for(state='hidden')
                require(await page.evaluate('window.__weatherAudioAudit.stops.length')>=1,'Clearing retried warning did not stop audio')
            require(not errors and not external and not mutations,'Audio guard scenario caused script/network/application side effects')
            outcomes.append({'mode':mode,'passed':True,'audioMockOnly':True})
        finally:
            feed.release();await context.close()
    return outcomes


async def native_notices(browser, base, output, width, height):
    feed = CurrentFixtures()
    feed.release()
    context, page, errors, external, mutations = await context_for(browser, width, height, feed)
    evidence = {"viewport": [width, height], "fixtureOnly": True}
    native_selector = '[data-cmpri-desktop-window="' + PREVIEW + '"]'
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "!nwsLiveView.getState().loading")
        native = page.locator(native_selector)
        dialog = page.locator("[data-weather-guest-safety-dialog]")
        require(await dialog.is_hidden(), "An empty feed opened Guest Safety")
        if width == 1440:
            evidence["actualLocalSirenDecodeWithoutOutput"] = await real_siren_decode(page)
        evidence["clearSeverityAndSound"] = await severity_clear_sound_sequence(page,frame,feed)
        feed.alert_features = [feed.alert("TORNADO", "Tornado Warning"),
            feed.alert("WATCH", "Severe Thunderstorm Watch"),
            feed.alert("WINTER", "Winter Weather Advisory"), feed.alert("HEAT", "Heat Advisory")]
        await refresh(frame)
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "true", "Official warning is not a full-screen native dialog")
        box = await dialog.bounding_box()
        require(box["width"] >= width * .95 and box["height"] >= height * .95, "Warning dialog does not cover the parent viewport")
        for quick_access in await dialog.get_by_role("button", name="Work orders", exact=True).all():
            require(not await quick_access.is_visible(), "An unrelated Work orders shortcut overlays Guest Safety")
        instruction = await dialog.locator("[data-weather-hotel-instruction]").inner_text()
        require("immediately" in instruction and "first-floor interior hallways" in instruction,
                "Tornado warning lost the immediate interior-hallway hotel action")
        require("TEST FIXTURE" in await dialog.locator("[data-weather-official-summary]").inner_text(),
                "Official summary was replaced by generic hotel instructions")
        require("SIMULATED GUEST SAFETY" not in await dialog.inner_text(), "An actual-shaped official alert was mislabeled as a simulated scenario")
        snapshot = await frame.evaluate("notificationPreview.snapshot()")
        official_history = [row for row in snapshot["inbox"] if not row["simulated"]]
        require(len(official_history) == 4, "Not all official watches, warnings and advisories entered in-app history")
        require(all(row["hotelInstruction"] and row["summary"] for row in official_history),
                "An official in-app message lacks its summary or hotel action")
        require(len(snapshot["alerts"]) == 4, "An applicable polygonless official alert was dropped")
        await page.screenshot(path=str(output / f"native-warning-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await dialog.wait_for(state="hidden")
        ticker = page.locator("[data-weather-alert-ticker]")
        await ticker.wait_for(state="visible")
        require(await ticker.get_attribute("data-level") == "warning", "Ticker did not use the most urgent active level")
        advisory = next(row for row in official_history if row["event"] == "Winter Weather Advisory")
        await frame.evaluate("key => notificationPreview.openDetails(key)", advisory["key"])
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "false",
                "An advisory used the full-screen warning presentation")
        await page.screenshot(path=str(output / f"native-advisory-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await frame.evaluate("document.getElementById('windowBody').scrollTo(0,0)")
        await page.screenshot(path=str(output / f"native-ticker-{width}.png"), full_page=True)

        async def ticker_geometry():
            result = await page.evaluate("""() => {
              const title=document.querySelector('.cmpri-desktop-topbar:not([hidden])');
              const host=document.querySelector('[data-weather-desktop-bulletin-host]');
              const ticker=host?.querySelector('[data-weather-alert-ticker]');
              const a=title.getBoundingClientRect(),b=ticker.getBoundingClientRect();
              return {direct:title.nextElementSibling===host,gap:b.top-a.bottom,left:b.left-a.left,
                right:a.right-b.right,width:b.width,outsideModal:!ticker.closest('.cmpri-desktop-window')};
            }""")
            require(result["direct"] and abs(result["gap"]) <= 1.5,
                    "Ticker is not directly beneath the desktop application title bar")
            require(result["outsideModal"] and abs(result["left"]) <= 2 and abs(result["right"]) <= 2,
                    "Ticker is inside a modal or no longer spans the desktop application title bar")
            return result

        first_ticker = await ticker_geometry()
        await page.emulate_media(reduced_motion="no-preference")
        await asyncio.sleep(.08)
        track = ticker.locator(":scope > span")
        x_before = (await track.bounding_box())["x"]
        await asyncio.sleep(.3)
        x_after = (await track.bounding_box())["x"]
        duration = await track.evaluate("el=>parseFloat(getComputedStyle(el).animationDuration)")
        old_duration = max(20, len((await track.text_content()).strip()) * .09)
        require(duration < old_duration, "Ticker did not become faster than its prior pacing")
        await page.emulate_media(reduced_motion="reduce")
        require(x_after < x_before - 1, "The actual alert ticker does not move right to left")
        evidence["tickerRightToLeft"] = {"beforeX": x_before, "afterX": x_after}
        if width >= 640:
            edge = native.locator(".cmpri-desktop-resize-se")
            point = await edge.bounding_box()
            before = await native.bounding_box()
            await page.mouse.move(point["x"] + point["width"] / 2, point["y"] + point["height"] / 2)
            await page.mouse.down()
            await page.mouse.move(point["x"] - 110, point["y"] - 70, steps=8)
            await page.mouse.up()
            after = await native.bounding_box()
            require(after["width"] < before["width"] - 50, "Native window resize did not occur")
            await ticker_geometry()
        await ticker.click()
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "true", "Ticker did not reopen current warning details")
        await dialog.locator("[data-weather-guest-safety-close]").click()
        count_before = len((await frame.evaluate("notificationPreview.snapshot()"))["inbox"])
        await refresh(frame)
        require(await dialog.is_hidden(), "Unchanged official response reopened dismissed warning details")
        require(len((await frame.evaluate("notificationPreview.snapshot()"))["inbox"]) == count_before,
                "Unchanged official response duplicated in-app messages")
        feed.alert_failure = True
        await refresh(frame)
        require(await ticker.is_visible(), "An unavailable alert response cleared the last known active warning")
        require(await dialog.is_hidden(), "An unavailable response reopened warning details")
        feed.alert_failure = False
        await refresh(frame)
        require(await dialog.is_hidden(), "Restoring unchanged official data reopened a dismissed warning")
        evidence["officialInAppAndTicker"] = {"messages": count_before, "unknownDoesNotClear": True,
            "noDuplicateOrReopen": True, "flushGeometry": first_ticker}
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="hidden")
        require(await ticker.is_visible(), "Closing Weather hid an active desktop alert ticker")
        await ticker_geometry()
        calls_while_closed = [feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls]
        await ticker.click()
        await dialog.wait_for(state="visible")
        require(await native.is_hidden(), "Opening ticker details unexpectedly reopened the Weather map")
        await dialog.locator("[data-weather-guest-safety-close]").click()
        require([feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls] == calls_while_closed,
                "Opening ticker details while Weather was closed fetched NWS data")
        await page.screenshot(path=str(output / f"desktop-ticker-weather-closed-{width}.png"), full_page=True)
        await launcher.click()
        frame = await weather_frame(page)
        await wait_for(frame, "!nwsLiveView.getState().loading")
        native = page.locator(native_selector)
        dialog = page.locator("[data-weather-guest-safety-dialog]")
        ticker = page.locator("[data-weather-alert-ticker]")
        await ticker.wait_for(state="visible")
        require(await dialog.is_hidden(), "Closing/reopening Weather forgot warning dismissal")
        await ticker_geometry()
        evidence["dismissalSurvivesNativeReopen"] = True
        canceled = feed.alert("CANCEL-TORNADO", "Tornado Warning", action="Cancel")
        canceled["properties"]["references"] = (
            "w-nws.webmaster@noaa.gov,urn:oid:TEST-FIXTURE-TORNADO," + iso(feed.now - timedelta(minutes=5)))
        feed.alert_features = [canceled, feed.alert("TORNADO", "Tornado Warning"),
                               feed.alert("WATCH", "Severe Thunderstorm Watch")]
        await refresh(frame)
        await wait_for(page, "document.querySelector('[data-weather-alert-ticker]')?.dataset.level === 'watch'")
        require(await ticker.get_attribute("data-level") == "watch", "Canceling warning did not leave a watch ticker")
        old_warning=next(row for row in official_history if row['event']=='Tornado Warning')
        sounds_before_history=await page.evaluate('window.__weatherAudioAudit.starts.length')
        await frame.evaluate('key=>notificationPreview.openDetails(key)',old_warning['key'])
        await dialog.wait_for(state='visible')
        require(await dialog.get_attribute('data-level')=='history' and await dialog.get_attribute('data-fullscreen')=='false'
                and await ticker.get_attribute('data-level')=='watch',
                'Opening an archived Warning masks a current Watch or uses active Warning presentation')
        require(await page.evaluate('window.__weatherAudioAudit.starts.length')==sounds_before_history,
                'Opening a past Warning replayed warning sound')
        await page.screenshot(path=str(output/f'archived-warning-current-watch-{width}.png'),full_page=True)
        await dialog.locator('[data-weather-guest-safety-close]').click()
        await ticker.click()
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "false", "A watch used full-screen warning presentation")
        if width >= 640:
            require((await dialog.bounding_box())["width"] < width * .8, "Watch details are not a standard compact native dialog")
        await page.screenshot(path=str(output / f"native-watch-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        ending_watch = feed.alert("WATCH", "Severe Thunderstorm Watch")
        ending_watch["properties"]["ends"] = iso(feed.now - timedelta(minutes=1))
        feed.alert_features = [ending_watch]
        await refresh(frame)
        await wait_for(page,"!document.querySelector('[data-weather-alert-ticker]')")
        require(await page.locator("[data-weather-alert-ticker]").count() == 0,
                "Official early end time did not remove a watch before bulletin expiration")
        ended = [row for row in (await frame.evaluate("notificationPreview.snapshot()"))["inbox"]
                 if row["status"] == "ended"]
        require(ended and any(row["expires"] > int(feed.now.timestamp() * 1000) for row in ended),
                "Early end cleanup overwrote the official future expiration time")
        feed.alert_features = [feed.alert("WATCH", "Severe Thunderstorm Watch", expired=True)]
        await refresh(frame)
        require(await page.locator("[data-weather-alert-ticker]").count() == 0, "Expired watch remained in the ticker")
        require(await dialog.is_hidden(), "Expired official alert left details open")
        require(len((await frame.evaluate("notificationPreview.snapshot()"))["alerts"]) == 0, "Canceled/expired alerts remained active")
        evidence["cancelAndExpire"] = {"warningToWatch": True, "watchUsesStandardDialog": True,
            "earlyEndsPreservesOfficialExpires": True, "expiredRemoved": True}
        soon = feed.alert("CLOSED-EXPIRY", "Winter Storm Watch")
        soon["properties"]["expires"] = iso(feed.now + timedelta(seconds=60))
        feed.alert_features = [soon]
        await refresh(frame)
        await page.locator("[data-weather-alert-ticker]").wait_for(state="visible")
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="hidden")
        closed_calls = [feed.observation_calls,feed.history_calls,feed.forecast_calls,feed.alert_calls]
        await page.clock.fast_forward(61000)
        await wait_for(page,"!document.querySelector('[data-weather-alert-ticker]')")
        require(closed_calls == [feed.observation_calls,feed.history_calls,feed.forecast_calls,feed.alert_calls],
                "Closed ticker expiration checked an NWS feed")
        evidence["tickerExpiresWhileWeatherClosedWithoutRequests"] = True
        await launcher.click()
        frame = await weather_frame(page)
        await frame.locator("#tab-notifications").click()
        require(await frame.locator("#npDelivery").count() == 0, "Phone/email delivery control returned to the in-app-only preview")
        await frame.locator("#npWinterPrep").check()
        await frame.locator("#npScenario").select_option("freeze-risk")
        await frame.locator("#npReceive").click()
        await dialog.wait_for(state="visible")
        require(await dialog.get_attribute("data-fullscreen") == "true", "Agreed forecast-freeze example is not full-screen")
        freeze = (await dialog.locator("[data-weather-hotel-instruction]").inner_text()).lower()
        require("boiler room" in freeze and "ice melt" in freeze and "available staff" in freeze and "treat sidewalks" in freeze,
                "Freeze preparation lost the agreed supplies/staff hotel instruction")
        require("SIMULATED" in await dialog.inner_text(), "Forecast-freeze example is not clearly simulated")
        await page.screenshot(path=str(output / f"native-freeze-{width}.png"), full_page=True)
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await frame.locator("#npRepeat").click()
        require(await dialog.is_hidden(), "Unchanged freeze example reopened dismissed details")
        await frame.locator("#npCancel").click()
        require(len((await frame.evaluate("notificationPreview.snapshot()"))["alerts"]) == 0, "Canceled freeze sample remained active")
        await frame.locator("#npScenario").select_option("tornado-warning")
        await frame.locator("#npReceive").click()
        await dialog.wait_for(state="visible")
        await frame.evaluate("notificationPreview.advanceSimulation(61)")
        await dialog.wait_for(state="hidden")
        require(await page.locator("[data-weather-alert-ticker]").count() == 0, "Expired warning sample retained its ticker")
        evidence["freezeAndSampleExpiry"] = {"fullScreenClearlySimulated": True, "correctSuppliesAndStaff": True,
                                             "repeatDismissed": True, "cancelAndExpiryClose": True}
        await frame.locator("#npReset").click()
        await frame.locator("#tab-weather").click()
        feed.alert_features = [feed.alert("MULTI-TORNADO", "Tornado Warning"),
                               feed.alert("MULTI-SEVERE", "Severe Thunderstorm Warning")]
        await refresh(frame)
        await dialog.wait_for(state="visible")
        await dialog.locator("[data-weather-guest-safety-close]").click()
        await refresh(frame)
        require(await dialog.is_hidden(), "A second unchanged warning in the batch reopened dismissed details")
        evidence["multipleWarningBatchDedup"] = True
        feed.alert_features=[]
        await refresh(frame)
        await wait_for(page,"!document.querySelector('[data-weather-alert-ticker]')")
        await frame.locator('#tab-notifications').click()
        await frame.locator('#npReset').click()
        sound_before=await page.evaluate('window.__weatherAudioAudit.starts.length')
        await frame.locator('#npScenario').select_option('tornado-warning')
        await frame.locator('#npReceive').click()
        await dialog.wait_for(state='visible')
        await wait_for(page,'count=>window.__weatherAudioAudit.starts.length===count+1',sound_before)
        await dialog.locator('[data-weather-guest-safety-close]').click()
        await frame.locator('#npRepeat').click()
        require(await page.evaluate('window.__weatherAudioAudit.starts.length')==sound_before+1,'Unchanged simulation repeated warning sound')
        # Age the warning out of the bounded inbox without expiring its hazard.
        await frame.evaluate("""() => {const sample=notificationPreview.sample('winter-advisory');for(let n=0;n<105;n++)notificationPreview.receive({...sample,id:'SIM-NP-AGE-'+n});}""")
        require(any(row['event']=='Tornado Warning' for row in (await frame.evaluate('notificationPreview.snapshot()'))['alerts']),
                'Fixture warning did not remain active after its history row aged out')
        await frame.locator('#tab-checks').click()
        await frame.locator('#simReset').click()
        await wait_for(page,"!document.querySelector('[data-weather-alert-ticker]')")
        require(not any(row['simulated'] for row in (await frame.evaluate('notificationPreview.snapshot()'))['alerts']),
                'Shared Reset missed a simulated hazard whose old history row aged out')
        await frame.locator('#tab-notifications').click()
        await frame.locator('#npScenario').select_option('winter-watch')
        await frame.locator('#npReceive').click()
        await wait_for(page,"document.querySelector('[data-weather-alert-ticker]')?.dataset.level==='watch'")
        require(await dialog.is_hidden() and 'SIMULATION' in await page.locator('[data-weather-alert-ticker]').inner_text(),
                'New simulated Watch was masked by an old Warning or lost its simulation label')
        await frame.locator('#npReset').click()
        await frame.locator('#npScenario').select_option('tornado-warning')
        await frame.locator('#npReceive').click()
        await dialog.wait_for(state='visible')
        await wait_for(page,'count=>window.__weatherAudioAudit.starts.length===count+2',sound_before)
        require(await dialog.get_attribute('data-level')=='warning','Fresh warning after Reset did not use current red severity')
        await dialog.locator('[data-weather-guest-safety-close]').click()
        await frame.locator('#npReset').click()
        await wait_for(page,"!document.querySelector('[data-weather-alert-ticker]')")
        evidence['simulationResetAndSoundEpoch']={'agedOutHazardCleared':True,'warningClearWatchClearWarningClear':True,'freshWarningSoundsAfterReset':True,'unchangedSilent':True}
        evidence["audioGuardCases"] = await pending_and_blocked_sound(browser,base,width,height)
        require(not errors and not external and not mutations, "Unexpected native script error, external request or mutation")
        require(await page.evaluate("window.__weatherReviewForbidden.length===0")
                and await frame.evaluate("window.__weatherReviewForbidden.length===0"), "Native notices invoked GPS / push permissions")
        evidence.update(passed=True, errors=errors, externalRequests=external, applicationMutations=mutations)
        return evidence
    finally:
        feed.release()
        await context.close()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--output", default="/tmp/cmpri-weather-current-notices")
    parser.add_argument("--suite", choices=["current", "notices", "all"], default="all")
    args = parser.parse_args()
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"),
                                          headless=True, args=["--no-sandbox"])
        suites = [("current", observation_and_visuals), ("notices", native_notices)]
        for width, height in [(1440, 1000), (390, 844)]:
            for name, action in suites:
                if args.suite not in ["all", name]:
                    continue
                roles = ["chief_engineer", "system_admin"] if name == "current" else ["chief_engineer"]
                for role in roles:
                    try:
                        result = await action(browser, args.base, output, width, height, role) if name == "current" else await action(browser, args.base, output, width, height)
                        print(f"PASS {name} {role} {width}×{height}", flush=True)
                    except Exception as error:
                        result = {"viewport": [width, height], "role": role, "passed": False, "error": str(error)}
                        print(f"FAIL {name} {role} {width}×{height}: {error}", flush=True)
                    result["suite"] = name
                    results.append(result)
        await browser.close()
    (output / "report.json").write_text(json.dumps(results, indent=2))
    if any(not result.get("passed") for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
