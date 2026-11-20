"""Native Weather astronomy acceptance with explicit local response fixtures.

Every app/Weather API and provider request is intercepted. Astronomical examples
below exercise UI behavior; they are not evidence of actual local sky events.
"""
import argparse
import asyncio
import json
import os
import re
import sys
from datetime import timedelta
from pathlib import Path

sys.dont_write_bytecode = True
from playwright.async_api import async_playwright
from weather_current_notices import CurrentFixtures, context_for, refresh, dial_reference_layout
from weather_dashboard_preview import API, PREVIEW, dashboard_weather_launcher, iso, require, wait_for, weather_frame


class AstronomyFixtures(CurrentFixtures):
    def __init__(self, mode='phase'):
        super().__init__()
        self.release()
        self.mode = mode
        self.night = True

    def nws(self):
        result = super().nws()
        observation = result['resources']['observation']['data']['properties']
        observation['textDescription'] = 'Clear' if self.night else 'Sunny'
        observation['icon'] = API+'/icons/land/'+('night' if self.night else 'day')+'/skc'
        if self.mode=='event':
            observation['textDescription']='Partly Cloudy with Variable Cloudiness Overnight'
            observation['icon']=API+'/icons/land/night/few'
            result['resources']['observation'].update(status='stale',error='TEST FIXTURE retained station observation')
        return result

    def astronomy(self):
        result = super().astronomy()
        resource = result['resources']['astronomy']
        resource.update(status='live', error=None)
        resource['data']['moonPhase'] = {'label':'First Quarter','angle':90,'illumination':.5,
            'calculatedAt':iso(self.now),'sourceUrl':'https://github.com/cosinekitty/astronomy'}
        if self.mode in ['event','expired','invalid']:
            start = self.now+timedelta(minutes=30)
            end = self.now+timedelta(hours=2)
            if self.mode == 'expired':
                start, end = self.now-timedelta(hours=3), self.now-timedelta(hours=1)
            resource['data']['events'] = [{'id':'TEST-FIXTURE-LOCAL-LUNAR','type':'lunar-eclipse',
                'title':'TEST FIXTURE local lunar eclipse over Champaign','summary':'Explicit local UI fixture; not an actual announced eclipse.',
                'start':iso(start),'end':iso(end),'peak':iso(self.now+timedelta(hours=1)),
                'sourceUrl':'https://science.nasa.gov/eclipses/',
                'details':['TEST FIXTURE locally validated event details.','TEST FIXTURE event detail time '+iso(start)],'calculated':True}]
            if self.mode == 'invalid':
                resource['data']['events'][0]['start'] = 'not-a-time'
        if self.mode == 'unavailable':
            resource.update(status='unavailable',error='TEST FIXTURE astronomy unavailable')
            resource['data']['moonPhase'] = None
        return result


async def open_fixture(browser, base, width, height, role, feed):
    context,page,errors,external,mutations = await context_for(browser,width,height,feed,role)
    await page.goto(base+'/engineering',wait_until='domcontentloaded')
    launcher = await dashboard_weather_launcher(page)
    await launcher.click()
    frame = await weather_frame(page)
    await wait_for(frame,"document.querySelector('#liveTemperature .wv-temperature-value')?.textContent==='10°'")
    return context,page,frame,errors,external,mutations


async def run_case(browser, base, output, width, height, role):
    chief = role == 'chief_engineer'
    evidence = {'viewport':[width,height],'role':role,'fixtureOnly':True}
    feed = AstronomyFixtures()
    feed.hold_astronomy=True
    feed.astronomy_gate.clear()
    context,page,frame,errors,external,mutations = await open_fixture(browser,base,width,height,role,feed)
    suffix=role+'-'+str(width)
    try:
        require(feed.astronomy_calls==1 and not feed.astronomy_gate.is_set(), 'Astronomy response was not independently held')
        require(await frame.locator('#liveTemperature .wv-temperature-value').inner_text()=='10°',
                'Observation rendering waited for astronomy')
        feed.hold_astronomy=False
        feed.astronomy_gate.set()
        caption=frame.locator('[data-weather-astronomy-caption]')
        await wait_for(frame,"document.querySelector('[data-weather-astronomy-caption]')?.textContent.includes('First Quarter')")
        require((await caption.inner_text()).strip()=='First Quarter','Moon caption contains more than its phase')
        require(await frame.locator('#liveConditionIcon .wv-moon').count()>0,'Night clear condition did not display its moon')
        geometry=await frame.locator('[data-current-condition-icon]').evaluate("""el=>{
          const icon=el.querySelector('.wv-condition').getBoundingClientRect(),face=el.closest('.wv-dial-face').getBoundingClientRect(),value=document.querySelector('#liveTemperature .wv-temperature-value').getBoundingClientRect();
          return {dx:Math.abs(icon.left+icon.width/2-face.left-face.width/2),noOverlap:icon.bottom<=value.top+1};
        }""")
        require(geometry['dx']<4 and geometry['noOverlap'],'Current condition icon is not centered above its inside-wheel values: '+str(geometry))
        require(not re.search(r'no aurora|no eclipse|all.clear',await frame.locator('#liveTemperature').inner_text(),re.I),
                'Unavailable events became an astronomy all-clear')
        await page.screenshot(path=str(output/f'weather-centered-moon-{suffix}.png'),full_page=True)
        feed.night=False
        await refresh(frame)
        require(await frame.locator('#liveConditionIcon .wv-moon').count()==0
                and (await caption.text_content() or '').strip()=='',
                'Moon-phase caption remained on a daytime sun condition')
        require(feed.astronomy_calls==1,'Unchanged foreground weather rendering refetched cached astronomy')
        require(not errors and not external and not mutations,'Unexpected astronomy phase error/network/mutation')
        evidence['phaseOnlyOnMoonAndIndependentObservation']=True
    finally:
        feed.release()
        await context.close()

    feed=AstronomyFixtures('event')
    context,page,frame,errors,external,mutations=await open_fixture(browser,base,width,height,role,feed)
    try:
        trigger=frame.locator('[data-weather-astronomy-trigger]')
        await wait_for(frame,"document.querySelector('[data-weather-astronomy-caption]')?.textContent.includes('TEST FIXTURE')")
        await wait_for(frame,"document.querySelectorAll('#liveTemperature .wv-dial-marker').length===4 && !nwsLiveView.getState().loading")
        await dial_reference_layout(frame)
        require('STALE' in await frame.locator('#liveConditionsBadge').inner_text()
                and await frame.locator('#liveGusts').count()==1,
                'Dense event layout lost stale-observation status or reported gust')
        await trigger.click()
        dialog=frame.locator('dialog[data-weather-astronomy-dialog]')
        await dialog.wait_for(state='visible')
        require(await dialog.locator('[data-weather-astronomy-event]').count()==1,
                'Local current/future event failed to open its details')
        text=await dialog.inner_text()
        require('TEST FIXTURE local lunar eclipse' in text and 'TEST FIXTURE locally validated event details.' in text,
                'Event details omitted the actual returned title or source detail')
        require(('16:10' in text if chief else bool(re.search(r'4:10\s*PM',text))) and ('CST' in text or 'Central' in text),
                'Event times do not use role-appropriate Central time: '+text)
        detail_times=' '.join(await dialog.locator('.wx-detail').all_inner_texts())
        require(('16:10' in detail_times if chief else bool(re.search(r'4:10\s*PM',detail_times)))
                and iso(feed.now+timedelta(minutes=30)) not in detail_times,
                'Event narrative details retain raw ISO/fixed24h instead of the role’s Central clock: '+detail_times)
        require(await dialog.locator('a[href="https://science.nasa.gov/eclipses/"]').count()==1,
                'Event official source link was omitted or rewritten')
        await page.screenshot(path=str(output/f'weather-astronomy-details-{suffix}.png'),full_page=True)
        await dialog.locator('[data-weather-astronomy-close]').click()
        require(await dialog.is_hidden(),'Astronomy details did not close')
        require(await trigger.evaluate('el=>el===document.activeElement'),'Closing astronomy did not restore trigger focus')
        await trigger.click()
        await dialog.wait_for(state='visible')
        await page.locator('[data-cmpri-desktop-window="'+PREVIEW+'"]').get_by_role('button',name='Close Weather',exact=True).click()
        await page.locator('iframe[src*="'+PREVIEW+'"]').wait_for(state='hidden')
        launcher = await dashboard_weather_launcher(page)
        await launcher.click()
        await weather_frame(page)
        require(await dialog.is_hidden() and feed.astronomy_calls==1,
                'Closing/reopening Weather retained an open astronomy popup or refetched its fresh cache')
        require(not errors and not external and not mutations,'Unexpected event-details error/network/mutation')
        require(await frame.evaluate('window.__weatherReviewForbidden.length===0')
                and await page.evaluate('window.__weatherReviewForbidden.length===0'),
                'Astronomy requested GPS, push, or notification permission')
        evidence['localEventDetailsSourceAndCentralTime']=True
        evidence['nativeCloseClosesEventDetailsAndRetainsCache']=True
    finally:
        feed.release()
        await context.close()

    for mode in ['expired','invalid','unavailable']:
        feed=AstronomyFixtures(mode)
        context,page,frame,errors,external,mutations=await open_fixture(browser,base,width,height,role,feed)
        try:
            await wait_for(frame,'cmpriWeatherAstronomyFeed.getState().pendingRequests===0 && nwsLiveView.getState().pendingRequests===0')
            caption=frame.locator('[data-weather-astronomy-caption]')
            text=await caption.text_content() or ''
            require('TEST FIXTURE local lunar eclipse' not in text,'Expired/invalid event remained eligible for its local caption')
            require(not re.search(r'no aurora|no eclipse|all.clear',await frame.locator('#liveTemperature').inner_text(),re.I),
                    'Missing or unavailable astronomy became an all-clear')
            if mode=='unavailable':
                require('First Quarter' not in text,'Unavailable moon data became a fabricated phase')
            require(not errors and not external and not mutations,'Unexpected invalid/unavailable astronomy side effect')
        finally:
            feed.release()
            await context.close()
    feed=AstronomyFixtures()
    feed.hold_astronomy=True
    feed.astronomy_gate.clear()
    context,page,frame,errors,external,mutations=await open_fixture(browser,base,width,height,role,feed)
    aborted=[]
    page.on('requestfailed',lambda request:aborted.append(request.failure) if '/api/weather-preview/astronomy' in request.url else None)
    try:
        await page.locator('[data-cmpri-desktop-window="'+PREVIEW+'"]').get_by_role('button',name='Close Weather',exact=True).click()
        await page.locator('iframe[src*="'+PREVIEW+'"]').wait_for(state='hidden')
        await wait_for(frame,'cmpriWeatherAstronomyFeed.getState().pendingRequests===0')
        await page.wait_for_timeout(100)
        require('net::ERR_ABORTED' in aborted,'Closing Weather did not abort its pending astronomy read')
        reads=feed.astronomy_calls
        await page.clock.fast_forward(300010)
        require(feed.astronomy_calls==reads,'Closed Weather continued astronomical checks')
        evidence['closeAbortsAstronomyAndStopsReads']=True
    finally:
        feed.release()
        await context.close()
    evidence.update(passed=True,invalidExpiredUnavailableHandled=True,noRealDatabaseOrPush=True)
    return evidence


async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--base',required=True)
    parser.add_argument('--output',default='/workspace/artifacts/weather-merge-astronomy')
    args=parser.parse_args()
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    results=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        for width,height in [(1440,1000),(390,844)]:
            for role in ['chief_engineer','system_admin']:
                try:
                    result=await run_case(browser,args.base,output,width,height,role)
                    print(f'PASS astronomy {role} {width}×{height}',flush=True)
                except Exception as error:
                    result={'viewport':[width,height],'role':role,'passed':False,'error':str(error)}
                    print(f'FAIL astronomy {role} {width}×{height}: {error}',flush=True)
                results.append(result)
        await browser.close()
    (output/'report.json').write_text(json.dumps(results,indent=2))
    if not all(result.get('passed') for result in results): raise SystemExit(1)


if __name__=='__main__': asyncio.run(main())
