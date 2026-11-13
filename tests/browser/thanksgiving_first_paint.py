"""Run directly with Python/Playwright; serves only the real local artwork.

Delay the layout script while images are visible, then compare the first frame
with the completed layout. Repeat with cached images and a newly added header.
No app sign-in, accounts, sample operational data or external requests are used.
"""
import asyncio
import json
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / 'src/lib/ui/thanksgiving-assets.json').read_text())
LAYOUTS = json.loads((ROOT / 'src/lib/ui/thanksgiving-layouts.json').read_text())
REQUESTED, RELEASE = threading.Event(), threading.Event()
IMAGE_REQUESTS = []
MEASURE = """() => Object.fromEntries(['turkey','orange','pale','greeting','leavesA','leavesB'].map(id=>{
 const el=document.getElementById(id),r=el.getBoundingClientRect();
 return [id,{x:r.x,y:r.y,width:r.width,height:r.height,layer:getComputedStyle(el).zIndex}];
}))"""


class ArtworkServer(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def end_headers(self):
        # Keep real images warm while independently delaying the layout script.
        immutable = urlsplit(self.path).path.endswith(('.png', '.css'))
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable' if immutable else 'no-store')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.endswith('.png'):
            IMAGE_REQUESTS.append(path)
        if path.startswith('/backgrounds/thanksgiving-animated/scene.') and path.endswith('.js'):
            REQUESTED.set()
            if not RELEASE.wait(30):
                self.send_error(503, 'Test did not release the layout script')
                return
        if path == '/first-paint':
            html = ('<!doctype html><html><body style="margin:0">'
                    '<iframe title="Artwork" style="position:fixed;inset:0;width:100%;height:100%;border:0" '
                    f'src="{MANIFEST["entry"]}"></iframe></body></html>').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        super().do_GET()


def same_geometry(before, after, ids=None):
    for name in ids or before:
        assert before[name]['layer'] == after[name]['layer'], (name, before, after)
        for field in ['x', 'y', 'width', 'height']:
            assert abs(before[name][field] - after[name][field]) < 0.05, (name, field, before, after)


async def check(browser, base, width, height):
    context = await browser.new_context(viewport={'width': width, 'height': height}, service_workers='block')
    errors, external = [], []
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if urlsplit(request.url).hostname != '127.0.0.1' else None)
    layout = LAYOUTS['mobile' if width < 768 else 'desktop']
    try:
        cold_images = None
        for phase in ['cold', 'cached-images']:
            REQUESTED.clear()
            RELEASE.clear()
            await page.goto(f'{base}/first-paint?phase={phase}', wait_until='commit')
            assert await asyncio.to_thread(REQUESTED.wait, 15), 'Layout script was not requested'
            frame = page.frame(url=base + MANIFEST['entry'])
            assert frame is not None
            await frame.wait_for_selector('#turkey', state='visible')
            await frame.wait_for_function('Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)')
            before = await frame.evaluate(MEASURE)
            for name, obj in layout['objects'].items():
                assert before[name]['layer'] == str(obj['layer'] + 10), (phase, name, before[name])
            for name, obj in layout['leaves']['layers'].items():
                assert before[name]['layer'] == str(obj['layer'] + 10), (phase, name, before[name])
            if phase == 'cold':
                cold_images = len(IMAGE_REQUESTS)
            else:
                assert len(IMAGE_REQUESTS) == cold_images, 'Warm images were unexpectedly downloaded again'
            RELEASE.set()
            await frame.wait_for_function('document.getElementById("scene").dataset.layout')
            after = await frame.evaluate(MEASURE)
            same_geometry(before, after)
            assert await frame.locator('.leaf:not(.settled)').count() == 82
            # A dashboard header can move its greeting; it must not resize or
            # reorder the turkey, pumpkins, or either leaf layer.
            await page.evaluate("window.originalArtwork=document.querySelector('iframe');const h=document.createElement('header');h.className='cmpri-desktop-topbar';h.style.height='250px';document.body.append(h)")
            if width >= 768:
                await frame.wait_for_function('document.getElementById("greeting").getBoundingClientRect().y>=250')
            same_geometry(after, await frame.evaluate(MEASURE), ['turkey', 'orange', 'pale', 'leavesA', 'leavesB'])
            await page.evaluate("document.querySelector('header').remove()")
            assert await page.evaluate("window.originalArtwork===document.querySelector('iframe')")
            await frame.locator('#toggle').click()
            assert await frame.locator('#toggle').get_attribute('aria-pressed') == 'true'
            print(json.dumps({'width': width, 'height': height, 'phase': phase, 'stableSizeAndLayers': True, 'headerKeptArtwork': True}), flush=True)
        assert not errors, errors
        assert not external, external
    finally:
        RELEASE.set()
        await context.close()


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(ArtworkServer, directory=str(ROOT / 'public')))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_BIN', '/usr/bin/chromium'), args=['--no-sandbox'])
            try:
                for width, height in [(1440, 900), (1024, 768), (1920, 900), (390, 844)]:
                    await check(browser, f'http://127.0.0.1:{server.server_port}', width, height)
            finally:
                await browser.close()
    finally:
        RELEASE.set()
        server.shutdown()
        server.server_close()


asyncio.run(main())
