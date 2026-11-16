"""Exercise the canonical standalone football artwork without auth or production data.

Run after ``npm run build:football``. This serves only checked-in
public files on an ephemeral loopback port, checks the real Next/Continue UI,
and writes screenshots/results to CMPRI_FOOTBALL_OUTPUT (default work/football-ui).
"""
import asyncio
import hashlib
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('CMPRI_FOOTBALL_OUTPUT', ROOT / 'work' / 'football-ui'))
OUT.mkdir(parents=True, exist_ok=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'public'), **kwargs)

    def log_message(self, *args):
        pass


async def snapshot(page):
    return await page.evaluate('''() => ({
      game: window.cmpriTheme.game,
      events: window.cmpriTheme.events || [],
      banner: !document.getElementById('gameBreak').hidden,
      title: document.getElementById('gameBreakTitle').textContent,
      message: document.getElementById('gameBreakMessage').textContent,
      clock: document.getElementById('sbClock').textContent,
      period: document.getElementById('sbQuarter').textContent,
      down: document.getElementById('sbDown').textContent
    })''')


async def wait_ready(page):
    await page.wait_for_function('window.cmpriTheme?.game && !document.getElementById("newGame").disabled', timeout=90000)


async def main():
    manifest = json.loads((ROOT / 'src/lib/ui/football-assets.json').read_text())
    entry = ROOT / ('public' + manifest['entry'])
    assert entry.exists(), entry
    assert hashlib.sha256(entry.read_bytes()).hexdigest()[:16] == manifest['version']
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    results, errors, requests = [], [], []
    try:
        async with async_playwright() as driver:
            browser = await driver.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
            context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
            page = await context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: requests.append(request.url))
            await page.goto(base + manifest['entry'])
            await wait_ready(page)
            assert await page.locator('.section-109-label').count() == 0
            assert 'NR' not in await page.locator('#cmpriScorebug').inner_text()
            assert await page.evaluate('Array.from(document.querySelectorAll(".sb-team-logo")).every(i=>i.complete && i.naturalWidth > 0)')
            assert await page.evaluate('window.cmpriTheme.fans') == 60670
            assert await page.evaluate('window.cmpriTheme.illinoisFans') == 33369
            assert await page.evaluate('window.cmpriTheme.iowaFans') == 27301
            assert await page.locator('#pause').get_attribute('aria-pressed') == 'true'
            await page.screenshot(path=str(OUT / 'desktop.png'))
            opening_receiver = (await snapshot(page))['game']['possession']
            expected_second_half = 'iowa' if opening_receiver == 'ill' else 'ill'
            initial_tally = int(await page.locator('#tallyTotal').inner_text())
            warning_snapshots, halftime_snapshot, third_quarter_snapshot = [], None, None
            observed_events = 0
            was_halftime = False
            for click in range(450):
                before = await snapshot(page)
                if before['game']['finished']:
                    break
                was_halftime = before['banner'] and before['title'] == 'HALFTIME'
                await page.locator('#next').click()
                current = await snapshot(page)
                if was_halftime:
                    assert current['game']['quarter'] == 3, current
                    assert current['game']['possession'] == expected_second_half, current
                    assert current['game']['ballOn'] == 25, current
                    assert current['game']['down'] == 1, current
                    assert current['game']['toGo'] == 10, current
                    assert current['clock'] == '15:00', current
                    third_quarter_snapshot = current
                for event in current['events'][observed_events:]:
                    if event['type'] == 'two-minute-warning':
                        assert current['banner'], current
                        assert current['title'] == 'TWO-MINUTE WARNING', current
                        assert current['clock'] == '02:00', current
                        assert current['down'] == '2-MIN WARNING', current
                        assert event['quarter'] in (2, 4), event
                        warning_snapshots.append(current)
                        await page.screenshot(path=str(OUT / f'two-minute-q{event["quarter"]}.png'))
                    elif event['type'] == 'halftime':
                        assert current['banner'] and current['title'] == 'HALFTIME', current
                        assert current['clock'] == '00:00' and current['period'] == 'HALF', current
                        assert event['openingReceiver'] == opening_receiver, event
                        assert event['receivingTeam'] == expected_second_half, event
                        assert 'receives the second-half kickoff' in current['message'], current
                        halftime_snapshot = current
                        await page.screenshot(path=str(OUT / 'halftime.png'))
                observed_events = len(current['events'])
            else:
                raise AssertionError('Game did not finish within 450 Next/Continue clicks')
            final = await snapshot(page)
            assert final['game']['finished'] and final['period'] == 'FINAL', final
            assert final['game']['leadChanges'] >= 3, final
            assert [s['game']['quarter'] for s in warning_snapshots] == [2, 4], warning_snapshots
            assert halftime_snapshot is not None and third_quarter_snapshot is not None
            assert int(await page.locator('#tallyTotal').inner_text()) == initial_tally + 1
            assert int(await page.locator('#sbIllScore').inner_text()) == final['game']['score']['ill']
            assert int(await page.locator('#sbIowaScore').inner_text()) == final['game']['score']['iowa']
            assert await page.locator('#playLog li').count() == final['game']['totalSnaps']
            results.append({'test': 'canonical game: Q2/Q4 warning banners, stopped 2:00 clock, halftime receiving/reset, final score and tally',
                            'passed': True, 'openingReceiver': opening_receiver,
                            'secondHalfReceiver': expected_second_half, 'snaps': final['game']['totalSnaps'],
                            'score': final['game']['score'], 'leadChanges': final['game']['leadChanges']})
            # Portrait uses an actual quarter-turn, while the live scorebug stays
            # upright at the viewport bottom and labels do not reappear.
            for width, height in [(390, 844), (320, 740)]:
                await page.set_viewport_size({'width': width, 'height': height})
                await page.wait_for_timeout(100)
                geometry = await page.evaluate('''() => {
                  const field=document.querySelector('.field-surface'),r=field.getBoundingClientRect(),
                        s=document.getElementById('cmpriScorebug').getBoundingClientRect(),
                        m=new DOMMatrix(getComputedStyle(field).transform);
                  return {field:{x:r.x,y:r.y,width:r.width,height:r.height},
                    scorebug:{x:s.x,y:s.y,width:s.width,height:s.height,bottom:s.bottom},
                    rotation:Math.atan2(m.b,m.a)*180/Math.PI,
                    scrollWidth:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight};
                }''')
                assert abs(geometry['rotation'] - 90) < .1, geometry
                assert geometry['field']['height'] > geometry['field']['width'] * 1.8, geometry
                assert geometry['scrollWidth'] == width, geometry
                assert 0 <= height - geometry['scorebug']['bottom'] <= 8, geometry
                assert geometry['scorebug']['x'] >= 0 and geometry['scorebug']['x'] + geometry['scorebug']['width'] <= width, geometry
                assert await page.locator('.section-109-label').count() == 0
                await page.screenshot(path=str(OUT / f'portrait-{width}x{height}.png'))
                results.append({'test': f'portrait {width}x{height}: vertical field, upright bottom scorebug, no overflow or 109 label',
                                'passed': True, 'geometry': geometry})
            await page.reload()
            await wait_ready(page)
            assert int(await page.locator('#tallyTotal').inner_text()) == initial_tally + 1
            assert not errors, errors
            assert all(url.startswith(base + '/') for url in requests), requests
            assert not any('/api/' in url for url in requests), requests
            results.append({'test': 'reload retains completed-game tally; no external/API requests or browser errors', 'passed': True})
            await browser.close()
    finally:
        server.shutdown()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
