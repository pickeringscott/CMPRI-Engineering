import asyncio, base64, json, os
from playwright.async_api import async_playwright

BASE = os.environ.get('PREVIEW_URL', 'http://127.0.0.1:3217')
PIXEL = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for width, height in [(390,844),(320,568),(1280,900),(844,390)]:
            page = await browser.new_page(viewport={'width':width,'height':height})
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            await page.goto(BASE)
            await page.get_by_role('button', name='Add GIF or media').click()
            menu = page.get_by_role('group',name='Attachment options')
            mb = await menu.bounding_box()
            modal = await page.get_by_role('dialog').bounding_box()
            assert mb['x'] >= modal['x'] and mb['x']+mb['width'] <= modal['x']+modal['width']
            halves=await menu.locator('button').evaluate_all('(els)=>els.map(e=>e.getBoundingClientRect().width)')
            assert abs(halves[0]-halves[1])<1
            if width==390:await page.screenshot(path='/tmp/cmpri-gif-mobile-menu.png')
            await page.get_by_role('button',name='GIF',exact=True).click()
            await page.get_by_role('textbox',name='Search GIFs').fill('hello')
            await page.get_by_role('button',name='Search',exact=True).click()
            await page.get_by_text('GIPHY unavailable',exact=True).wait_for()
            await page.get_by_text('Tenor unavailable',exact=True).wait_for()
            assert await page.locator('.masonry button').count()==0
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if width==390:await page.screenshot(path='/tmp/cmpri-gif-mobile-unavailable.png')
            await page.get_by_role('button',name='Close GIF search').click()
            await page.get_by_role('button',name='Add GIF or media').click()
            async with page.expect_file_chooser() as chooser:
                await page.get_by_role('button',name='Media',exact=True).click()
            await (await chooser.value).set_files({'name':'test-local.gif','mimeType':'image/gif','buffer':PIXEL})
            await page.locator('.draft-attachments .local-card').filter(has_text='test-local.gif').wait_for()
            await page.get_by_role('textbox',name='Write a comment').fill('Local-only test note')
            await page.get_by_role('button',name='Post',exact=True).click()
            await page.get_by_text('Local-only test note',exact=True).wait_for()
            await page.reload()
            assert await page.get_by_text('Local-only test note',exact=True).count()==0
            assert not errors, errors
            await page.close()
            print(f'PASS real endpoints, popover, local picker, memory-only post, no overflow at {width}x{height}')
        page=await browser.new_page(viewport={'width':390,'height':844})
        async def fixture(route):
            provider='tenor' if '/tenor?' in route.request.url else 'giphy'
            items=[{'provider':provider,'id':f'fixture-{i}','title':f'Synthetic {provider} {i}','canonicalUrl':f'https://{provider}.com/gifs/fixture-{i}','previewUrl':f'https://media.{provider}.com/fixture-{i}.gif','width':200,'height':100+i*15} for i in range(12)]
            await route.fulfill(json={'provider':provider,'items':items})
        await page.route('**/api/gifs/*?*',fixture)
        await page.route('https://media.giphy.com/**',lambda route:route.fulfill(body=PIXEL,content_type='image/gif'))
        await page.route('https://media.tenor.com/**',lambda route:route.fulfill(body=PIXEL,content_type='image/gif'))
        await page.goto(BASE)
        await page.get_by_role('button',name='Add GIF or media').click()
        await page.get_by_role('button',name='GIF',exact=True).click()
        await page.get_by_role('textbox',name='Search GIFs').fill('synthetic')
        await page.get_by_role('button',name='Search',exact=True).click()
        await page.locator('.masonry button').last.wait_for()
        assert await page.locator('.masonry button').count()==24
        assert await page.locator('.results-scroll').evaluate('(e)=>e.scrollHeight>e.clientHeight')
        await page.get_by_role('button',name='Attach Synthetic giphy 0 from GIPHY').click()
        card=page.locator('.draft-attachments [data-kind="external-link"]')
        assert await card.get_attribute('href')=='https://giphy.com/gifs/fixture-0'
        assert await card.locator('img').get_attribute('src')=='https://media.giphy.com/fixture-0.gif'
        assert 'GIPHY' in await card.inner_text()
        await page.get_by_role('button',name='Post',exact=True).click()
        assert await page.locator('.notes [data-kind="external-link"]').count()==1
        print('PASS test-only provider fixtures: masonry scroll, merging, canonical attributed external link, posting')
        await browser.close()

asyncio.run(main())
