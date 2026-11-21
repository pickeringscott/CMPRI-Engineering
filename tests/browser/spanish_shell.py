"""Actual profile-save language propagation through the desktop and cached frames.

All accounts, reads and writes are isolated fixtures. External requests and
WebSockets are blocked. Run against a local build with CMPRI_UI_BASE and
CMPRI_UI_OUTPUT, just like the other tests/browser suites.
"""
import asyncio
import copy
import json
import re
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, HOTEL, OUT, UID, WID, install, orders
from housekeeping_preferences import DAYS, PREFS, profile


LIST = '[data-cmpri-desktop-window="work-order-list"]'
PROFILE = '[data-cmpri-desktop-window="/profile"]'
TICKET = f'[data-cmpri-desktop-window="/work-orders/{WID}"]'
ISSUE = 'Open the drain cover; keep the word Open exactly.'
EDITED_ISSUE = 'Open the drain cover carefully; Open is the original guest wording.'
NOTE = 'Open - handwritten note remains English and unsaved.'


async def activate(page, label):
    # The real launcher can sit in a horizontal, scrollable group on phones.
    button = page.get_by_role('button', name=label, exact=True)
    await button.focus()
    await button.press('Enter')


async def document_identity(frame):
    return await frame.evaluate('window.__spanishShellDocumentIdentity ||= crypto.randomUUID()')


async def frame_for(window):
    element = await window.locator('iframe').element_handle()
    assert element is not None
    frame = await element.content_frame()
    assert frame is not None
    return frame


async def save_language(frame, language):
    language_select = frame.locator('select').filter(has=frame.locator('option[value="es"]')).first
    await language_select.select_option(language)
    name = 'Guardar perfil' if language == 'es' else 'Save Profile'
    save = frame.get_by_role('button', name=name, exact=True)
    await expect(save).to_be_enabled()
    async with frame.page.expect_response(lambda response: urlparse(response.url).path == '/api/profile'
                                         and response.request.method == 'PATCH'):
        await save.click()
    await expect(save).to_be_enabled()


async def verify_language(page, frames, language):
    await expect(page.locator('html')).to_have_attribute('lang', language)
    await expect(page.locator('html')).to_have_attribute('data-cmpri-language-owner', UID)
    for frame in frames:
        await expect(frame.locator('html')).to_have_attribute('lang', language)
        await expect(frame.locator('html')).to_have_attribute('data-cmpri-language-owner', UID)
    spanish = language == 'es'
    await expect(page.locator('[data-dashboard-title]')).to_contain_text('Ingeniería' if spanish else 'Engineering')
    pool_control = page.locator('.cmpri-header-status-pill')
    await expect(pool_control).to_have_text('Piscina: CERRADA' if spanish else 'Pool Status: CLOSED')
    await expect(pool_control).to_be_visible()
    fit = await pool_control.evaluate('''element => {
      const button = element.getBoundingClientRect();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      return {client: element.clientWidth, scroll: element.scrollWidth,
              buttonLeft: button.left, buttonRight: button.right,
              textLeft: text.left, textRight: text.right, viewport: innerWidth};
    }''')
    assert fit['scroll'] <= fit['client'] + 1, ('Pool caption overflows its button', language, fit)
    assert fit['textLeft'] >= fit['buttonLeft'] - 1, ('Pool caption crosses its left edge', language, fit)
    assert fit['textRight'] <= min(fit['buttonRight'], fit['viewport']) + 1, ('Pool caption is clipped at right', language, fit)
    await expect(page.locator('[data-layout-label="Operations"] legend')).to_have_text('Operaciones' if spanish else 'Operations')
    await expect(page.locator('[data-key="work-order-list"]')).to_have_text('Lista de órdenes de trabajo' if spanish else 'Work Order List')
    await expect(page.locator('[data-layout-key="/profile::Manage Profile"]')).to_have_text('Administrar perfil' if spanish else 'Manage Profile')
    # Localized presentation must leave the authorization/layout/action IDs intact.
    await expect(page.locator('[data-key="work-order-list"]')).to_have_attribute('data-control', 'Work Order List')
    await expect(page.locator('[data-layout-key="/profile::Manage Profile"]')).to_have_attribute('data-layout-key', '/profile::Manage Profile')


async def run_case(browser, role, width):
    state = {'user': UID, 'prefs': copy.deepcopy(PREFS), 'writes': [], 'queries': [],
             'errors': [], 'blocked_external': set(), 'full_name': 'Fixture Open',
             'row': {**copy.deepcopy(orders[0]), 'issue': ISSUE, 'notes': '', 'category': 'General',
                     'reporter_notes': 'The guest wrote Open. Preserve this text.', 'revision': 7}}
    context = await browser.new_context(viewport={'width': width, 'height': 1000 if width > 640 else 844},
                                        is_mobile=width < 640, has_touch=width < 640,
                                        timezone_id='America/Chicago', service_workers='block')
    await install(context, role)

    async def api(route):
        request, parsed = route.request, urlparse(route.request.url)
        if parsed.hostname not in ('localhost', '127.0.0.1'):
            state['blocked_external'].add(parsed.hostname)
            return await route.abort()
        if parsed.path == '/api/profile':
            if request.method == 'PATCH':
                body = request.post_data_json
                assert 'role' not in body, 'Changing language must not change roles'
                state['writes'].append({'path': parsed.path, 'body': body})
                state['prefs'] = copy.deepcopy(body['preferences'])
                state['full_name'] = body.get('full_name', state['full_name'])
            payload = profile(state, role)
            payload['profile']['full_name'] = state['full_name']
            payload['can_manage_users'] = True
            return await route.fulfill(json=payload)
        if parsed.path == '/api/profile/phone-notifications':
            assert request.method == 'GET', 'This test must not alter notification delivery'
            return await route.fulfill(json={'configured': True, 'public_key': '', 'subscribed_on_this_device': False,
                                            'settings': {'timezone': 'America/Chicago', 'schedule': {
                                                day: {'enabled': False, 'start': '09:00', 'end': '17:00'} for day in DAYS}}})
        if parsed.path == '/api/work-orders':
            assert request.method == 'GET'
            query = parse_qs(parsed.query)
            state['queries'].append(query)
            assert query.get('filter', ['all'])[0] in ['pending', 'open', 'progress', 'priority', 'overdue', 'completed', 'closed', 'all']
            row = copy.deepcopy(state['row'])
            rows = [row] if not query.get('q') or query['q'][0].lower() in row['issue'].lower() else []
            return await route.fulfill(json={'work_orders': rows, 'total': len(rows), 'counts': {
                'all': 1, 'open': 1, 'progress': int(row['status'] == 'In Progress'), 'priority': 1,
                'pending': 0, 'overdue': 0, 'completed': 0, 'closed': 0}})
        if parsed.path == '/api/work-orders/' + WID + '/parts':
            assert request.method == 'GET'
            return await route.fulfill(json={'items': [], 'parts': [], 'poLines': []})
        if parsed.path == '/api/work-orders/' + WID:
            if request.method == 'PATCH':
                body = request.post_data_json
                assert body['expected_revision'] == state['row']['revision']
                assert set(body) <= {'expected_revision', 'status', 'issue'}, body
                if 'status' in body:
                    assert body['status'] in ['Open', 'In Progress'], body
                if 'issue' in body:
                    assert body['issue'] == EDITED_ISSUE, body
                state['writes'].append({'path': parsed.path, 'body': body})
                state['row'].update({key: value for key, value in body.items() if key != 'expected_revision'})
                state['row']['revision'] += 1
            return await route.fulfill(json={'workOrder': copy.deepcopy(state['row']), 'mentionTickets': []})
        if parsed.path.startswith('/api/') and request.method not in ('GET', 'HEAD'):
            raise AssertionError('Unexpected fixture write: ' + parsed.path)
        return await route.fallback()

    await context.route('**/*', api)
    await context.route_web_socket(re.compile(r'^wss?://'), lambda socket: socket.close())
    page = await context.new_page()
    page.on('pageerror', lambda error: state['errors'].append({'message': str(error), 'stack': error.stack}))
    try:
        await page.goto(BASE + '/engineering', wait_until='domcontentloaded', timeout=60000)
        await page.get_by_role('button', name='Work Order List', exact=True).wait_for(timeout=60000)
        await activate(page, 'Work Order List')
        listing = page.locator(LIST)
        await expect(listing.locator('[data-preview-status]')).to_have_count(1)
        await listing.locator('[data-preview-kpi="open"]').click()
        await listing.get_by_role('combobox', name='Sort work orders').select_option('created-oldest')
        await listing.get_by_role('searchbox').fill('Open')
        await expect(listing.locator('[data-preview-status]')).to_have_count(1)
        list_search = await listing.get_by_role('searchbox').element_handle()
        await listing.locator('[data-preview-status]').focus()
        await listing.locator('[data-preview-status]').press('Enter')
        ticket_window = page.locator(TICKET)
        await expect(ticket_window).to_be_visible(timeout=30000)
        ticket = await frame_for(ticket_window)
        await ticket.get_by_role('heading', name='Reported Issue', exact=True).wait_for(timeout=60000)
        await ticket.locator('details[data-reported-issue] > summary').click()
        await ticket.get_by_role('button', name='Edit reported issue', exact=True).click()
        issue = ticket.get_by_role('textbox', name='Reported Issue', exact=True)
        await issue.fill(EDITED_ISSUE)
        async with page.expect_response(lambda response: urlparse(response.url).path == '/api/work-orders/' + WID
                                        and response.request.method == 'PATCH'):
            await issue.blur()
        await ticket.locator('#technician-note-editor').fill(NOTE)
        ticket_identity = await document_identity(ticket)

        await activate(page, 'Manage Profile')
        profile_window = page.locator(PROFILE)
        account = await frame_for(profile_window)
        await account.get_by_role('button', name='Save Profile', exact=True).wait_for(timeout=60000)
        profile_identity = await document_identity(account)
        await verify_language(page, [ticket, account], 'en')
        await save_language(account, 'es')
        await verify_language(page, [ticket, account], 'es')
        assert state['prefs']['language'] == 'es'
        assert await document_identity(ticket) == ticket_identity
        assert await document_identity(account) == profile_identity
        assert await list_search.evaluate('element => element.isConnected'), 'Locale change remounted the work-order list'
        await expect(account.get_by_role('button', name='Guardar perfil', exact=True)).to_be_visible()
        await expect(ticket.get_by_role('heading', name=re.compile(r'^Problema (reportado|informado)$'))).to_be_visible()
        await expect(ticket.locator('#technician-note-editor')).to_have_value(NOTE)
        await expect(ticket.get_by_role('button', name=re.compile(r'^Editar problema (reportado|informado)$'))).to_have_text(EDITED_ISSUE)
        await expect(ticket.locator('#ticket-status')).to_have_value('Open')
        await expect(ticket.locator('#ticket-status option[value="Open"]')).to_have_text('Abierta')
        await expect(ticket.locator('#ticket-status option[value="Will Not Do"]')).to_have_text('No se realizará')
        # Close the clean profile while it is still the foreground window.
        await profile_window.get_by_role('button', name='Cerrar Administrar perfil', exact=True).click()
        await expect(profile_window).to_have_count(0)

        # Raising the cached list preserves the English query and canonical filters.
        await activate(page, 'Lista de órdenes de trabajo')
        await expect(listing.get_by_role('searchbox')).to_have_value('Open')
        await expect(listing.get_by_role('combobox', name='Ordenar órdenes de trabajo')).to_have_value('created-oldest')
        await expect(listing.locator('[data-preview-kpi="open"]')).to_have_attribute('aria-pressed', 'true')
        await expect(listing.locator('[data-preview-status]')).to_contain_text('Open')
        await expect(listing.locator('[data-preview-status]')).to_contain_text('Abierta')
        await page.screenshot(path=str(OUT / f'spanish-shell-{role}-{width}.png'))

        # Closing/reopening clean windows must retain the saved account language
        # and list preferences without disturbing a different, unsaved ticket.
        await listing.get_by_role('button', name='Cerrar Lista de órdenes de trabajo', exact=True).click()
        await expect(listing).to_have_count(0)
        await activate(page, 'Lista de órdenes de trabajo')
        await expect(listing.get_by_role('searchbox')).to_have_value('Open')
        await expect(listing.locator('[data-preview-kpi="open"]')).to_have_attribute('aria-pressed', 'true')
        # Exercise a localized status control while Spanish is active. The
        # selected label changes, while its API value stays canonical English.
        await listing.locator('[data-preview-status]').focus()
        await listing.locator('[data-preview-status]').press('Enter')
        async with page.expect_response(lambda response: urlparse(response.url).path == '/api/work-orders/' + WID
                                        and response.request.method == 'PATCH'):
            await ticket.locator('#ticket-status').select_option('In Progress')
        await expect(ticket.locator('#ticket-status')).to_have_value('In Progress')
        await expect(ticket.locator('#ticket-status option[value="In Progress"]')).to_have_text('En curso')
        await expect(ticket.locator('#technician-note-editor')).to_have_value(NOTE)
        await activate(page, 'Administrar perfil')
        account = await frame_for(profile_window)
        await account.get_by_role('button', name='Guardar perfil', exact=True).wait_for(timeout=60000)
        await verify_language(page, [ticket, account], 'es')
        reopened_profile_identity = await document_identity(account)
        assert await document_identity(ticket) == ticket_identity
        await expect(ticket.locator('#technician-note-editor')).to_have_value(NOTE)

        await save_language(account, 'en')
        await verify_language(page, [ticket, account], 'en')
        assert await document_identity(account) == reopened_profile_identity
        assert await document_identity(ticket) == ticket_identity
        await expect(ticket.locator('#technician-note-editor')).to_have_value(NOTE)
        await expect(ticket.get_by_role('button', name='Edit reported issue', exact=True)).to_have_text(EDITED_ISSUE)
        await expect(listing.get_by_role('searchbox')).to_have_value('Open')
        await expect(ticket.locator('#ticket-status')).to_have_value('In Progress')
        assert any(item.get('filter') == ['open'] and item.get('sort') == ['created-oldest']
                   and item.get('q') == ['Open'] for item in state['queries']), state['queries']
        assert any(write['body'].get('status') == 'In Progress' for write in state['writes'])
        assert not any('appendNotes' in write['body'] or 'notes' in write['body'] for write in state['writes'])
        assert not state['errors'], state['errors']
        return {'role': role, 'width': width, 'actualProfileSave': True, 'englishSpanishEnglish': True,
                'cachedFramesPreserved': True, 'unsavedNotePreserved': True, 'userIssuePreserved': True,
                'reopenRetainsLocale': True, 'canonicalPayloads': True, 'poolHeaderTextFits': True, 'fixtureWrites': len(state['writes']),
                'blockedExternalHosts': sorted(state['blocked_external']), 'productionDataAccessed': False}
    except Exception:
        diagnostics = {'role': role, 'width': width, 'errors': state['errors'],
                       'writes': state['writes'], 'queries': state['queries'], 'frames': []}
        try:
            diagnostics['outer'] = (await page.locator('body').inner_text())[:16000]
            for frame in page.frames:
                diagnostics['frames'].append({'url': frame.url,
                                              'language': await frame.locator('html').get_attribute('lang'),
                                              'body': (await frame.locator('body').inner_text())[:12000]})
            await page.screenshot(path=str(OUT / f'spanish-shell-failed-{role}-{width}.png'))
        except Exception as error:
            diagnostics['captureError'] = str(error)
        (OUT / f'spanish-shell-failed-{role}-{width}.json').write_text(json.dumps(diagnostics, indent=2, ensure_ascii=False))
        raise
    finally:
        await context.close()


async def main():
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        try:
            for role in ['chief_engineer', 'system_admin']:
                for width in [1440, 390]:
                    print(f'Running Spanish shell: {role} {width}', flush=True)
                    results.append(await run_case(browser, role, width))
                    print(f'Passed Spanish shell: {role} {width}', flush=True)
                    (OUT / 'spanish-shell.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        finally:
            await browser.close()
    print(json.dumps({'passed': True, 'cases': results}, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
