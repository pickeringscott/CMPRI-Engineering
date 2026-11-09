# Local browser regression with synthetic API data. No external traffic or writes.
# Start Next on 127.0.0.1:3116 with fixture Supabase public configuration first.
import asyncio
import importlib.util
import json
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('layout', Path(__file__).with_name('ticket-detail-layout.py'))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)
layout.BASE = layout.BASE.replace('127.0.0.1', 'localhost')


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for width in (384, 1360):
            ctx = await browser.new_context(viewport={'width': width, 'height': 915}, is_mobile=width < 640, has_touch=width < 640)
            # The synthetic Supabase endpoint has no realtime service; prevent
            # WebSocket traffic from reaching the network during this test.
            async def close_fixture_websocket(socket):
                await socket.close()
            await ctx.route_web_socket('wss://ci-placeholder.supabase.co/**', close_fixture_websocket)
            session = {'access_token': 'fixture', 'refresh_token': 'fixture', 'expires_at': int(time.time()) + 7200,
                       'user': {'id': 'fixture-user', 'email': 'fixture@example.invalid'}}
            await ctx.add_init_script('sessionStorage.setItem("cmpri:auth:v1",' + json.dumps(json.dumps(session)) + ');')
            row = {'id': layout.ID, 'revision': 7, 'display_id': '261015001', 'room': 'Room 219',
                   'issue': 'Light is flickering', 'status': 'Open', 'priority': 'Medium',
                   'category': 'General', 'technician_name': 'Fixture Technician', 'created_by': 'other-user',
                   'notes': 'Saved note', 'created_at': '2026-10-12T12:00:00Z'}
            patches = []
            requests = []
            errors = []

            async def route(request):
                url = urlparse(request.request.url)
                method = request.request.method
                requests.append((method, url.path))
                if url.hostname not in ('127.0.0.1', 'localhost'):
                    return await request.abort()
                if url.path == '/__ticket_host':
                    # Match the real embedded host's close-on-saved behavior.
                    html = f'''<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><iframe id="ticket" style="border:0;width:100%;height:100vh" src="/work-orders/{layout.ID}?embedded=1&modalToken=fixture"></iframe><script>window.ticketEvents=[];addEventListener('message',e=>{{ticketEvents.push(e.data);if(e.data.type==='cmpri-work-order-saved')document.querySelector('#ticket')?.remove()}})</script></body></html>'''
                    return await request.fulfill(content_type='text/html', body=html)
                if not url.path.startswith('/api/'):
                    return await request.continue_()
                body, code = {}, 200
                if url.path == '/api/session':
                    body = {'user': {'id': 'fixture-user', 'name': 'Fixture Technician', 'role': 'chief_engineer'},
                            'landing': '/engineering', 'capabilities': layout.POLICY['chief_engineer']}
                elif url.path == '/api/profile':
                    body = {'preferences': {'language': 'en', 'appearance': 'dark'}}
                elif url.path == f'/api/work-orders/{layout.ID}':
                    if method == 'PATCH':
                        payload = request.request.post_data_json
                        patches.append(payload)
                        if payload.get('expected_revision') != row['revision']:
                            body, code = {'error': 'Fixture revision conflict'}, 409
                        else:
                            row.update({key: value for key, value in payload.items() if key != 'expected_revision'})
                            row['revision'] += 1
                            body = {'workOrder': dict(row)}
                    else:
                        body = {'workOrder': dict(row), 'mentionTickets': []}
                elif url.path.endswith('/attachments'):
                    body = {'images': []}
                elif url.path.endswith('/parts'):
                    body = {'items': [], 'parts': [], 'poLines': []}
                elif url.path == '/api/maintenance-reference':
                    body = {'assets': [], 'technicians': [{'id': 'tech-1', 'full_name': 'Fixture Technician', 'role': 'technician', 'active': True}, {'id': 'tech-2', 'full_name': 'Jordan', 'role': 'technician', 'active': True}]}
                elif url.path == '/api/room-operations':
                    body = {'rows': []}
                elif url.path == '/api/room-ranker':
                    body = {'rooms': []}
                await request.fulfill(status=code, content_type='application/json', body=json.dumps(body))

            await ctx.route('**/*', route)
            page = await ctx.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            # The synthetic Supabase endpoint has no realtime service.
            page.on('console', lambda message: errors.append('console: ' + message.text) if message.type == 'error' and 'example.supabase.co/realtime' not in message.text else None)
            page.on('requestfailed', lambda request: errors.append('request failed: ' + request.url + ' ' + str(request.failure)) if urlparse(request.url).hostname in ('localhost', '127.0.0.1') else None)
            await page.goto(f'{layout.BASE}/__ticket_host')
            frame = page.frame_locator('#ticket')
            heading = frame.get_by_role('heading', name='Reported Issue', exact=True)
            try:
                await heading.wait_for(timeout=15000)
            except Exception:
                print('Frame body:', await frame.locator('body').inner_text())
                print('Page errors:', errors)
                print('Requests:', requests)
                raise
            await heading.click()
            status = frame.get_by_label('Status', exact=True)
            await expect(status).to_be_visible()
            field = frame.locator('.cmpri-ticket-metadata-field').filter(has=status)
            await expect(field).to_have_attribute('data-changed', 'false')
            original_border = await status.evaluate('(el) => getComputedStyle(el).borderColor')
            note = frame.locator('#technician-note-editor')
            await note.fill('This unsaved note must stay here')

            async with page.expect_response(lambda response: response.url.endswith('/api/work-orders/' + layout.ID) and response.request.method == 'PATCH'):
                await status.select_option('Closed')
            await expect(status).to_have_value('Closed')
            await expect(field).to_have_attribute('data-changed', 'true')
            await expect(status).to_have_css('border-color', 'rgb(34, 197, 94)')
            await expect(page.locator('#ticket')).to_have_count(1)
            await expect(frame.locator('details[data-reported-issue]')).to_have_attribute('open', '')
            await expect(note).to_have_value('This unsaved note must stay here')
            assert patches == [{'expected_revision': 7, 'status': 'Closed'}], patches
            await page.screenshot(path=f'/tmp/cmpri-metadata-autosave-{width}.png')

            async with page.expect_response(lambda response: response.url.endswith('/api/work-orders/' + layout.ID) and response.request.method == 'PATCH'):
                await status.select_option('Open')
            await expect(field).to_have_attribute('data-changed', 'false')
            await expect(status).to_have_css('border-color', original_border)
            await expect(page.locator('#ticket')).to_have_count(1)
            await expect(note).to_have_value('This unsaved note must stay here')
            assert patches[-1] == {'expected_revision': 8, 'status': 'Open'}, patches
            technician = frame.get_by_role('combobox', name='Technician', exact=True)
            tech_field = frame.locator('.cmpri-ticket-metadata-field').filter(has=technician)
            original_tech_border = await technician.evaluate('(el) => getComputedStyle(el).borderColor')
            await technician.click()
            async with page.expect_response(lambda response: response.url.endswith('/api/work-orders/' + layout.ID) and response.request.method == 'PATCH'):
                await frame.get_by_role('option', name='Jordan', exact=True).click()
            await expect(tech_field).to_have_attribute('data-changed', 'true')
            await expect(technician).to_have_css('border-color', 'rgb(34, 197, 94)')
            assert patches[-1] == {'expected_revision': 9, 'technician_name': 'Jordan'}, patches
            await technician.click()
            async with page.expect_response(lambda response: response.url.endswith('/api/work-orders/' + layout.ID) and response.request.method == 'PATCH'):
                await frame.get_by_role('option', name='Fixture Technician', exact=True).click()
            await expect(tech_field).to_have_attribute('data-changed', 'false')
            await technician.evaluate('(el) => el.blur()')
            await expect(technician).to_have_css('border-color', original_tech_border)
            await expect(note).to_have_value('This unsaved note must stay here')
            assert patches[-1] == {'expected_revision': 10, 'technician_name': 'Fixture Technician'}, patches
            assert not errors, errors
            assert not any(event.get('type') == 'cmpri-work-order-saved' for event in await page.evaluate('ticketEvents'))
            await ctx.close()
        await browser.close()
    print('Passed desktop and mobile metadata autosave browser cases')


asyncio.run(main())
