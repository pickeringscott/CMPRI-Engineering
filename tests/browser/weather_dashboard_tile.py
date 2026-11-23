import asyncio
from cmpri_fixture import BASE, UID, install, async_playwright, expect

async def run(browser, width, height):
    context = await browser.new_context(viewport={'width':width,'height':height}, has_touch=width<701, is_mobile=width<701, service_workers='block')
    await install(context,'chief_engineer')
    await context.add_init_script(f'localStorage.setItem("cmpri:beginners-guide:opened:{UID}","1"); localStorage.setItem("cmpri:ask-files-consent:v1","1");')
    reads=[]
    async def mock(route):
        reads.append(route.request.url)
        await route.fulfill(json={'dashboard':{'current':46,'high':59,'low':38,'precipitation':10,'wind':13,'bearing':300,'condition':'Cloudy','icon':None,'isDaytime':False,'moonAngle':42}})
    await context.route('**/api/weather-preview?part=dashboard',mock)
    page=await context.new_page()
    response=await page.goto(BASE+'/engineering',wait_until='domcontentloaded')
    await page.get_by_role('button',name='Safety & Logs',exact=True).wait_for(timeout=14000)
    dial=page.locator('[data-cmpri-weather-dial]')
    if width < 701:
        assert await dial.count()==0 and len(reads)==0
        print('390px touch: dial hidden; no weather feed request',flush=True)
    else:
        await expect(dial).to_have_attribute('aria-label','Open Weather. 46° · Cloudy. Forecast low 38° · Forecast high 59°. Precipitation chance 10% · Wind 13 mph')
        assert await dial.bounding_box()=={'x':1198,'y':653,'width':225,'height':225}
        assert await dial.evaluate('(e)=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
        await expect(dial.locator('svg[data-condition=cloud]')).to_be_visible()
        tab=page.get_by_role('button',name='Safety & Logs',exact=True)
        if await tab.get_attribute('aria-expanded')!='true': await tab.click()
        await dial.click()
        await expect(page.locator('iframe[src*="/previews/cmpri-weather-preview.html"]')).to_be_visible(timeout=10000)
        assert await tab.get_attribute('aria-expanded')=='true'
        print('1440px desktop: exact geometry/transparent background, all live fields with fixtures, Weather opens and same tab stays selected',flush=True)
    await context.close()

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
        await run(browser,1440,900)
        await run(browser,390,844)
        await browser.close()

asyncio.run(main())
