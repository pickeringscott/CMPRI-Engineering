"""Lead Housekeeping preferences and controls, using isolated browser/API doubles.

No real user, notification permission, push, subscription or database is changed.
CMPRI_UI_BASE=http://127.0.0.1:PORT CMPRI_UI_OUTPUT=/tmp/hk-preferences python tests/browser/housekeeping_preferences.py
"""
import asyncio
import copy
import json
import re
from urllib.parse import parse_qs, urlparse

from cmpri_fixture import BASE, CAPS, HOTEL, OUT, UID, install
from playwright.async_api import async_playwright, expect

OTHER = '00000000-0000-4000-8000-000000000099'
ENDPOINT = 'https://push.example.invalid/housekeeping-fixture-device'
DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
PREFS = {'language': 'en', 'appearance': 'dark', 'notification_mode': 'in_app',
         'notifications': {'new_work_orders': False, 'status_changes': False, 'mentions': False}}
PUSH_STUB = r'''() => {
 const key='cmpri:push-fixture:active';
 const state=window.__pushFixture={local:sessionStorage.getItem(key)==='true',permission:'granted',permissionResult:'granted',focusOnPermission:false,permissionRequests:0,subscribeCalls:0,unsubscribeCalls:0,unsubscribeResult:true};
 const subscription={endpoint:'https://push.example.invalid/housekeeping-fixture-device',
  toJSON(){return {endpoint:this.endpoint,expirationTime:null,keys:{p256dh:'fixture-public-key',auth:'fixture-secret'}}},
  async unsubscribe(){state.unsubscribeCalls++;if(!state.unsubscribeResult)return false;state.local=false;sessionStorage.setItem(key,'false');return true}};
 const registration={pushManager:{async getSubscription(){return state.local?subscription:null},async subscribe(){state.subscribeCalls++;state.local=true;sessionStorage.setItem(key,'true');return subscription}}};
 Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{async getRegistration(){return registration},async register(){return registration},ready:Promise.resolve(registration)}});
 window.PushManager=function(){};
 const notifier=function(){};Object.defineProperty(notifier,'permission',{get:()=>state.permission});
 notifier.requestPermission=async()=>{state.permissionRequests++;state.permission=state.permissionResult;if(state.focusOnPermission){window.dispatchEvent(new Event('focus'));await new Promise(resolve=>setTimeout(resolve,50))}return state.permission};window.Notification=notifier;
}'''


def profile(state, role='housekeeping'):
    return {'profile': {'id': state['user'], 'full_name': 'Other Lead' if state['user'] == OTHER else 'Fixture Lead',
                        'email': 'fixture@example.invalid', 'role': role},
            'preferences': copy.deepcopy(state['prefs']), 'profile_settings_available': True,
            'can_manage_users': role == 'chief_engineer', 'chatgpt_connection': None}


async def phone_button(page, enabled):
    button = page.get_by_role('button', name=re.compile(r'^(Disable|Desactivar)$' if enabled else r'^(Enable|Activar)$'))
    await expect(button).to_be_visible(timeout=60000)
    await expect(button).to_be_enabled()
    return button


async def save_profile(page):
    await page.get_by_role('button', name=re.compile(r'^(Save Profile|Guardar perfil)$')).click()
    await expect(page.get_by_role('button', name=re.compile(r'^(Save Profile|Guardar perfil)$'))).to_be_enabled()


async def run_width(browser, width):
    state = {'user': UID, 'prefs': copy.deepcopy(PREFS), 'configured': True, 'subscribed': False,
             'settings': {'timezone': 'America/Chicago', 'schedule': {day: {'enabled': False, 'start': '09:00', 'end': '17:00'} for day in DAYS}},
             'writes': [], 'fail': None, 'wrong': None, 'hold': False, 'permissionFocusRace': False, 'errors': []}
    held, released = asyncio.Event(), asyncio.Event()

    async def launch(role='housekeeping', unsupported=False, configured=True):
        context = await browser.new_context(viewport={'width': width, 'height': 1000 if width > 640 else 844},
                                            is_mobile=width < 640, has_touch=width < 640,
                                            service_workers='block', timezone_id='America/Chicago')
        await install(context, role)
        await context.add_init_script('(' + PUSH_STUB + ')()')
        if unsupported:
            await context.add_init_script('delete window.PushManager')

        async def api(route):
            request, url = route.request, urlparse(route.request.url)
            if url.hostname not in ('localhost', '127.0.0.1'):
                return await route.abort()
            if url.path == '/api/session':
                return await route.fulfill(json={'user': {'id': state['user'], 'name': 'Fixture Lead', 'role': role, 'email': 'fixture@example.invalid'},
                                                'hotelId': HOTEL, 'landing': '/work-orders' if role == 'housekeeping' else '/engineering', 'capabilities': CAPS[role]})
            if url.path == '/api/profile':
                if request.method == 'GET' and state['permissionFocusRace']:
                    await asyncio.sleep(.1)
                if request.method == 'PATCH':
                    body = request.post_data_json
                    assert 'role' not in body, 'Language save must not write account roles'
                    state['writes'].append({'path': url.path, 'body': body})
                    state['prefs'] = copy.deepcopy(body['preferences'])
                return await route.fulfill(json=profile(state, role))
            if url.path == '/api/profile/phone-notifications':
                if request.method == 'GET':
                    has_endpoint = parse_qs(url.query).get('endpoint', [''])[0] == ENDPOINT
                    return await route.fulfill(json={'configured': state['configured'] and configured, 'public_key': 'AAECAwQ' if configured else '',
                                                    'subscribed_on_this_device': state['subscribed'] and has_endpoint,
                                                    'settings': copy.deepcopy(state['settings'])})
                body = request.post_data_json
                action = body['action']
                owner = state['user']
                state['writes'].append({'path': url.path, 'body': body, 'owner': owner})
                if action == 'unsubscribe' and state['hold']:
                    held.set()
                    await released.wait()
                    # The old owner can acknowledge an idempotent removal;
                    # the new owner's device registration must remain enabled.
                    return await route.fulfill(json={'ok': True})
                if state['wrong'] == action:
                    return await route.fulfill(json={'ok': False})
                if state['fail'] == action:
                    return await route.fulfill(status=503, json={'error': 'Fixture unavailable'})
                if action == 'schedule':
                    state['settings'] = {key: copy.deepcopy(body[key]) for key in ['timezone', 'schedule']}
                    state['configured'] = True
                    if state['permissionFocusRace']:
                        await asyncio.sleep(.25)
                    return await route.fulfill(json={'ok': True, 'settings': copy.deepcopy(state['settings'])})
                if action == 'subscribe':
                    assert body['subscription']['endpoint'] == ENDPOINT
                    state['subscribed'] = True
                elif action == 'unsubscribe':
                    assert body['endpoint'] == ENDPOINT
                    state['subscribed'] = False
                else:
                    raise AssertionError('Unexpected notification action: ' + action)
                return await route.fulfill(json={'ok': True})
            if url.path == '/api/users' and role == 'housekeeping':
                return await route.fulfill(status=403, json={'error': 'Not authorized to manage users.'})
            if url.path.startswith('/api/') and request.method not in ('GET', 'HEAD'):
                raise AssertionError('Unexpected fixture write: ' + url.path)
            return await route.fallback()

        await context.route('**/*', api)
        await context.route_web_socket(re.compile(r'^wss?://'), lambda socket: socket.close())
        page = await context.new_page()
        page.on('pageerror', lambda error: state['errors'].append(str(error)))
        await page.goto(BASE + '/profile', wait_until='domcontentloaded')
        await page.get_by_role('button', name=re.compile(r'^(Save Profile|Guardar perfil)$')).wait_for(timeout=60000)
        return context, page

    context, page = await launch()
    language = page.locator('select').filter(has=page.locator('option[value="es"]')).first
    await language.select_option('es')
    await expect(page.get_by_role('button', name='Guardar perfil', exact=True)).to_be_visible()
    await save_profile(page)
    for _ in range(80):
        if state['prefs']['language'] == 'es':
            break
        await page.wait_for_timeout(50)
    assert state['prefs']['language'] == 'es'
    await page.reload()
    await expect(page.get_by_role('button', name='Guardar perfil', exact=True)).to_be_visible(timeout=60000)
    await expect(page.locator('input[readonly]').last).to_have_value('Supervisor de limpieza')
    await expect(page.get_by_role('button', name='Activar', exact=True)).to_be_visible()
    await page.goto(BASE + '/work-orders')
    await expect(page.get_by_role('button', name='Enviar solicitud', exact=True)).to_be_visible(timeout=60000)
    await page.goto(BASE + '/profile')
    await expect(page.get_by_role('button', name='Guardar perfil', exact=True)).to_be_visible(timeout=60000)
    state['wrong'] = 'subscribe'
    await page.get_by_role('button', name='Activar', exact=True).click()
    await page.wait_for_timeout(200)
    await phone_button(page, False)
    assert state['subscribed'] is False
    await expect(page.get_by_text('No se pudo registrar este dispositivo para recibir notificaciones en el teléfono.', exact=True)).to_be_visible()
    state['wrong'] = None
    await page.get_by_role('button', name='Activar', exact=True).click()
    await expect(page.get_by_role('button', name='Desactivar', exact=True)).to_be_enabled()
    await page.get_by_role('button', name='Desactivar', exact=True).click()
    await expect(page.get_by_role('button', name='Activar', exact=True)).to_be_enabled()
    language = page.locator('select').filter(has=page.locator('option[value="es"]')).first
    await language.select_option('en')
    await save_profile(page)
    for _ in range(80):
        if state['prefs']['language'] == 'en':
            break
        await page.wait_for_timeout(50)
    await page.reload()
    await expect(page.get_by_role('button', name='Save Profile', exact=True)).to_be_visible(timeout=60000)
    await expect(page.locator('input[readonly]').last).to_have_value('Lead Housekeeper')
    assert not await page.get_by_role('button', name='User Management', exact=True).count()

    monday = page.get_by_text('Monday', exact=True).locator('..')
    await monday.locator('input[type=checkbox]').check()
    await monday.locator('select').nth(0).select_option('07:00')
    state['wrong'] = 'schedule'
    await page.get_by_role('button', name='Save Schedule', exact=True).click()
    await expect(page.get_by_role('button', name='Save Schedule', exact=True)).to_be_enabled()
    await expect(monday.locator('input[type=checkbox]')).to_be_checked()
    assert state['settings']['schedule']['monday']['enabled'] is False
    state['wrong'] = None
    await page.get_by_role('button', name='Save Schedule', exact=True).click()
    await expect(page.get_by_role('button', name='Save Schedule', exact=True)).to_be_enabled()
    for _ in range(80):
        if state['settings']['schedule']['monday']['enabled']:
            break
        await page.wait_for_timeout(50)
    await page.reload()
    monday = page.get_by_text('Monday', exact=True).locator('..')
    await expect(monday.locator('input[type=checkbox]')).to_be_checked(timeout=60000)
    await expect(monday.locator('select').nth(0)).to_have_value('07:00')

    state['wrong'] = 'subscribe'
    await (await phone_button(page, False)).click()
    await page.wait_for_timeout(200)
    await phone_button(page, False)
    assert state['subscribed'] is False

    state['wrong'] = None
    await (await phone_button(page, False)).click()
    await phone_button(page, True)
    assert state['subscribed'] is True
    assert await page.evaluate('window.__pushFixture.subscribeCalls') == 1, 'Retry must reuse browser subscription'
    await page.reload()
    await phone_button(page, True)
    before = await page.evaluate('window.__pushFixture.unsubscribeCalls')
    for key in ['wrong', 'fail']:
        state[key] = 'unsubscribe'
        await (await phone_button(page, True)).click()
        await page.wait_for_timeout(200)
        await phone_button(page, True)
        assert state['subscribed'] is True
        assert await page.evaluate('window.__pushFixture.unsubscribeCalls') == before
        state[key] = None
    await (await phone_button(page, True)).click()
    await phone_button(page, False)
    await page.reload()
    await phone_button(page, False)
    assert state['subscribed'] is False

    await (await phone_button(page, False)).click()
    await phone_button(page, True)
    await page.evaluate('window.__pushFixture.unsubscribeResult=false')
    await (await phone_button(page, True)).click()
    await phone_button(page, False)
    assert state['subscribed'] is False
    assert await page.evaluate('window.__pushFixture.local') is True
    await page.reload()
    await phone_button(page, False)

    # No real browser permission dialog is opened. The denied mock prevents
    # schedule/subscription writes and leaves the toggle off.
    await page.evaluate("window.__pushFixture.permission='denied';window.__pushFixture.permissionResult='denied'")
    count = len(state['writes'])
    await (await phone_button(page, False)).click()
    await page.wait_for_timeout(200)
    await phone_button(page, False)
    assert len(state['writes']) == count
    state['permissionFocusRace'] = True
    await page.evaluate("window.__pushFixture.permission='default';window.__pushFixture.permissionResult='granted';window.__pushFixture.focusOnPermission=true")
    await (await phone_button(page, False)).click()
    await phone_button(page, True)
    state['permissionFocusRace'] = False

    state['hold'] = True
    await (await phone_button(page, True)).click()
    await asyncio.wait_for(held.wait(), 10)
    state['user'] = OTHER
    await page.evaluate('''user=>{
      const session=JSON.parse(sessionStorage.getItem('cmpri:auth:v1'));session.user.id=user;
      sessionStorage.setItem('cmpri:auth:v1',JSON.stringify(session));
      window.dispatchEvent(new Event('cmpri-workspace-sign-out'));window.dispatchEvent(new Event('focus'));
    }''', OTHER)
    await expect(page.get_by_label('Display name', exact=True)).to_have_value('Other Lead', timeout=15000)
    baseline_unsubscribe = await page.evaluate('window.__pushFixture.unsubscribeCalls')
    released.set()
    await page.wait_for_timeout(250)
    await phone_button(page, True)
    assert state['subscribed'] is True
    assert await page.evaluate('window.__pushFixture.unsubscribeCalls') == baseline_unsubscribe
    await page.screenshot(path=str(OUT / f'housekeeping-preferences-{width}.png'), full_page=True)
    assert not state['errors'], state['errors']
    await context.close()

    state['user'] = UID
    state['subscribed'] = False
    state['hold'] = False
    state['prefs']['language'] = 'es'
    context, page = await launch(unsupported=True)
    disabled = page.get_by_role('button', name='Activar', exact=True)
    await expect(disabled).to_be_disabled(timeout=60000)
    await expect(page.get_by_text('Este navegador no admite notificaciones Web Push.', exact=True)).to_be_visible()
    assert await page.evaluate('window.__pushFixture.permissionRequests') == 0
    await context.close()
    context, page = await launch(configured=False)
    await expect(page.get_by_role('button', name='Activar', exact=True)).to_be_disabled(timeout=60000)
    await expect(page.get_by_text('Las notificaciones del teléfono no están configuradas en este servidor.', exact=True)).to_be_visible()
    await context.close()
    return {'width': width, 'languageSaveReopenBothDirections': True, 'workOrderSpanishFollowsProfile': True,
            'spanishPhoneOnOffAndFailedAckMessageLocalized': True,
            'scheduleAcknowledgmentAndPersistence': True, 'phoneEnableDisableAndReopen': True,
            'wrongAckAndFailedDisableRetainState': True, 'deniedUnsupportedAndUnconfiguredStayOff': True,
            'sameAccountFocusDuringPermissionMockDoesNotBreakEnable': True,
            'browserCleanupFailureStillHonorsAcknowledgedBackendDisable': True,
            'lateOldAccountDisableCannotUnsubscribeNewAccount': True, 'realPermissionRequests': 0,
            'realPushes': 0, 'realDatabaseCalls': 0, 'pageErrors': state['errors']}


async def verify_user_controls(browser, width):
    user = {'id': OTHER, 'email': 'lead@example.invalid', 'full_name': 'Fixture Lead Housekeeper',
            'role': 'housekeeping', 'secondary_roles': [], 'active': True, 'can_manage': True}
    writes, errors = [], []
    context = await browser.new_context(viewport={'width': width, 'height': 1000 if width > 640 else 844}, service_workers='block')
    await install(context, 'chief_engineer')

    async def api(route):
        url = urlparse(route.request.url)
        if url.path == '/api/profile':
            return await route.fulfill(json={'profile': {'id': UID, 'role': 'chief_engineer', 'full_name': 'Manager'},
                                            'preferences': copy.deepcopy(PREFS), 'profile_settings_available': True})
        if url.path == '/api/users':
            if route.request.method == 'PATCH':
                body = route.request.post_data_json
                assert body['id'] == OTHER
                writes.append(body)
                if 'role' in body:
                    assert body['role'] in ['Lead Housekeeper', 'Front Desk'], 'Server accepts authorized assignment labels, not stored aliases'
                    user['role'] = {'Lead Housekeeper': 'housekeeping', 'Front Desk': 'front_desk'}[body['role']]
                if 'active' in body:
                    user['active'] = body['active']
                return await route.fulfill(json={'user': copy.deepcopy(user)})
            return await route.fulfill(json={'users': [copy.deepcopy(user)], 'assignable_roles': ['Lead Housekeeper', 'Front Desk']})
        return await route.fallback()

    await context.route('**/*', api)
    await context.route_web_socket(re.compile(r'^wss?://'), lambda socket: socket.close())
    page = await context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(BASE + '/management/users')
    await page.get_by_role('button', name='Deactivate', exact=True).wait_for(timeout=60000)
    await page.get_by_role('button', name='Deactivate', exact=True).click()
    await expect(page.get_by_role('button', name='Reactivate', exact=True)).to_be_enabled()
    await page.reload()
    await page.get_by_role('button', name='Reactivate', exact=True).click()
    await expect(page.get_by_role('button', name='Deactivate', exact=True)).to_be_enabled()
    row = page.get_by_role('button', name='Deactivate', exact=True).locator('..')
    select = row.get_by_role('combobox')
    await select.fill('Lead')
    await expect(page.get_by_role('option', name='Lead Housekeeper', exact=True)).to_have_count(1)
    await select.fill('Front Desk')
    await page.get_by_role('option', name='Front Desk', exact=True).click()
    await expect(select).to_have_value('Front Desk')
    await expect(select).to_be_enabled()
    await page.reload()
    row = page.get_by_role('button', name='Deactivate', exact=True).locator('..')
    await expect(row.get_by_role('combobox')).to_have_value('Front Desk')
    await row.get_by_role('combobox').fill('Lead')
    await expect(page.get_by_role('option', name='Lead Housekeeper', exact=True)).to_have_count(1)
    await page.get_by_role('option', name='Lead Housekeeper', exact=True).click()
    await expect(row.get_by_role('combobox')).to_be_enabled()
    await page.reload()
    row = page.get_by_role('button', name='Deactivate', exact=True).locator('..')
    await expect(row.get_by_role('combobox')).to_have_value(re.compile(r'^(Housekeeping|Lead Housekeeper)$'))
    assert user['active'] is True and user['role'] == 'housekeeping'
    assert len(writes) == 4, writes
    assert not errors, errors
    await context.close()
    return {'width': width, 'authorizedDeactivateReactivatePersists': True, 'authorizedRoleChangeAndRestorePersists': True,
            'fixtureWrites': writes, 'realDatabaseCalls': 0, 'pageErrors': errors}


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        try:
            for width in [1440, 390]:
                results.append(await run_width(browser, width))
                results.append(await verify_user_controls(browser, width))
                (OUT / 'housekeeping-preferences.json').write_text(json.dumps(results, indent=2, ensure_ascii=False))
        except Exception:
            for index, context in enumerate(browser.contexts):
                for number, page in enumerate(context.pages):
                    if not page.is_closed():
                        await page.screenshot(path=str(OUT / f'housekeeping-failure-{index}-{number}.png'), full_page=True)
                        (OUT / f'housekeeping-failure-{index}-{number}.txt').write_text(await page.locator('body').inner_text())
            raise
        finally:
            await browser.close()
    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
