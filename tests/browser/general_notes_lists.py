"""Notes list/format recovery on desktop and phone, with isolated API fixtures.

CMPRI_UI_BASE=http://127.0.0.1:3050 python tests/browser/general_notes_lists.py
The browser profile really closes/reopens; no storage_state shortcut or live DB.
"""
import asyncio
import base64
import time
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect
import cmpri_fixture as fixture

BASE = os.environ.get('CMPRI_UI_BASE', 'http://127.0.0.1:3050').rstrip('/')
assert urlparse(BASE).hostname in {'localhost', '127.0.0.1'}, 'Local fixture server only'
OUT = Path(os.environ.get('CMPRI_UI_OUTPUT', '/tmp/cmpri-notes-lists'))
OUT.mkdir(parents=True, exist_ok=True)
OLDER = '00000000-0000-4000-8000-000000000101'
NEWER = '00000000-0000-4000-8000-000000000102'
KEY = f'cmpri:general-notes:v1:{fixture.HOTEL}:{fixture.UID}'


def initial_notes():
    return {
        OLDER: {'id': OLDER, 'title': 'Inspection checklist', 'text': '☐ Inspect seal', 'fontSize': 16,
                'textStyles': [{'start': 2, 'end': 14, 'fontSize': 24, 'color': 'rgb(20, 100, 200)'}],
                'strokes': [], 'revision': 1, 'updated': 1, 'titleAutomatic': False},
        NEWER: {'id': NEWER, 'title': 'Newer separate note', 'text': 'Other note stays separate',
                'fontSize': 16, 'strokes': [], 'revision': 1, 'updated': 2, 'titleAutomatic': False},
    }


async def select_text(editor, start=None, end=None):
    await editor.evaluate('''(root,args)=>{
      root.focus();const start=args[0]??root.textContent.length,end=args[1]??start;
      const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),range=document.createRange();
      let at=0,first=null,last=null,a=0,b=0;
      while(walk.nextNode()){const node=walk.currentNode;
        if(!first&&start<=at+node.length){first=node;a=start-at;}
        if(end<=at+node.length){last=node;b=end-at;break;}at+=node.length;
      }
      if(first){range.setStart(first,a);range.setEnd(last||first,last?b:a);}
      else{range.selectNodeContents(root);range.collapse(false);}
      const selected=getSelection();selected.removeAllRanges();selected.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }''', [start, end])


async def launch(playwright, profile, width, state, seed=False):
    context = await playwright.chromium.launch_persistent_context(
        str(profile), executable_path='/usr/bin/chromium', headless=True,
        args=['--no-sandbox'], viewport={'width': width, 'height': 1000 if width > 640 else 844},
        is_mobile=width < 640, has_touch=width < 640, service_workers='block', timezone_id='America/Chicago')
    await fixture.install(context, 'chief_engineer')
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    expiry = int(time.time()) + 7200
    token = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode({'sub': fixture.UID, 'aud': 'authenticated', 'role': 'authenticated', 'exp': expiry}) + '.fixture'
    auth = {'access_token': token, 'refresh_token': 'fixture', 'expires_at': expiry, 'expires_in': 7200,
            'token_type': 'bearer', 'user': {'id': fixture.UID, 'aud': 'authenticated', 'role': 'authenticated',
            'email': 'fixture@example.invalid', 'app_metadata': {}, 'user_metadata': {}}}
    await context.add_init_script('localStorage.setItem("cmpri:remember","true");localStorage.setItem("cmpri:auth:v1",%s);sessionStorage.setItem("cmpri:auth:v1",%s);' % (json.dumps(json.dumps(auth)), json.dumps(json.dumps(auth))))
    if seed:
        await context.add_init_script('localStorage.setItem(%s,%s);' % (json.dumps(KEY + ':active-note'), json.dumps(OLDER)))

    async def notes_api(route):
        parsed = urlparse(route.request.url)
        if parsed.path == '/api/notes/targets':
            return await route.fulfill(json={'mentions': []})
        if parsed.path != '/api/notes':
            return await route.fallback()
        if route.request.method == 'PUT':
            state['writes'].append(route.request.post_data_json)
            # All writes are intercepted. Keep unsynced work protected so reopen
            # exercises the durable outbox rather than a server round trip.
            return await route.fulfill(status=503, json={'error': 'Fixture offline; local draft retained'})
        note_id = parse_qs(parsed.query).get('id', [None])[0]
        if note_id:
            return await route.fulfill(json={'note': state['notes'].get(note_id)})
        return await route.fulfill(json={'notes': list(state['notes'].values())})

    await context.route('**/api/notes**', notes_api)
    if hasattr(context, 'route_web_socket'):
        await context.route_web_socket(re.compile(r'^wss?://(?!127[.]0[.]0[.]1(?::[0-9]+)?/|localhost(?::[0-9]+)?/).*'), lambda ws: ws.close())
    page = context.pages[0] if context.pages else await context.new_page()
    page.on('pageerror', lambda error: state['errors'].append(str(error)))
    page.on('console', lambda msg: state.setdefault('console', []).append(msg.text))
    page.on('request', lambda request: state.setdefault('requests', []).append(request.url) if '/api/' in request.url else None)
    await page.goto(BASE + '/notes', wait_until='domcontentloaded', timeout=60000)
    try:
        await expect(page.locator('#general-note-title')).to_be_enabled(timeout=30000)
    except Exception:
        state['runtime'] = await page.evaluate('''async()=>({ready:document.readyState,cacheInstalled:!!window.__cmpriDeviceData,authStored:!!localStorage.getItem('cmpri:auth:v1'),sessionStored:!!sessionStorage.getItem('cmpri:auth:v1'),remember:localStorage.getItem('cmpri:remember'),locks:await navigator.locks.query(),scripts:[...document.scripts].map(s=>s.src).filter(Boolean)})''')
        (OUT / ('failure-' + str(width) + '.json')).write_text(json.dumps(state, indent=2))
        await page.screenshot(path=str(OUT / ('failure-' + str(width) + '.png')), full_page=True)
        raise
    await expect(page.locator('#general-note-title')).to_have_value('Inspection checklist')
    # The Next devtools badge overlaps the phone's approved bottom dock. This
    # fixture-only CSS hides that development overlay; pageerrors still fail.
    await page.add_style_tag(content='nextjs-portal { display: none !important; }')
    return context, page


async def run(playwright, width):
    state = {'notes': initial_notes(), 'writes': [], 'errors': []}
    with tempfile.TemporaryDirectory(prefix=f'cmpri-notes-{width}-') as directory:
        print(f'Notes {width}: initial open', flush=True)
        context, page = await launch(playwright, Path(directory), width, state, seed=True)
        editor = page.get_by_role('textbox', name='Note text', exact=True)
        await expect(editor).to_have_js_property('textContent', '☐ Inspect seal')
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_css('font-size', '24px')
        await page.get_by_role('checkbox', name='Inspect seal', exact=True).click()
        await expect(editor).to_have_js_property('textContent', '☑ Inspect seal')
        await select_text(editor)
        await page.keyboard.press('Enter')
        await expect(editor).to_have_js_property('textContent', '☑ Inspect seal\n☐ ')
        await page.keyboard.press('Enter')
        await expect(editor).to_have_js_property('textContent', '☑ Inspect seal\n')
        await page.keyboard.press('Shift+Enter')
        await expect(editor).to_have_js_property('textContent', '☑ Inspect seal\n\n')
        await editor.fill('• Task')
        await select_text(editor)
        await page.keyboard.press('Enter')
        await expect(editor).to_have_js_property('textContent', '• Task\n• ')
        await page.keyboard.press('Enter')
        await expect(editor).to_have_js_property('textContent', '• Task\n')
        # A mobile keyboard supplies beforeinput rather than a physical keydown.
        await editor.evaluate("root=>root.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertLineBreak',bubbles:true,cancelable:true}))")
        await expect(editor).to_have_js_property('textContent', '• Task\n\n')
        await editor.fill('☑ Inspect seal\n• Staff check')
        await select_text(editor, 0, len('☑ Inspect seal\n• Staff check'))
        await page.get_by_role('button', name='Text and keyboard handwriting', exact=True).click()
        await page.get_by_label('Text size', exact=True).select_option('24')
        color_button = page.get_by_role('button', name='apricot text', exact=True)
        color = await color_button.evaluate('node=>getComputedStyle(node).backgroundColor')
        await color_button.click()
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_css('color', color)
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_attribute('aria-checked', 'true')
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_css('font-size', '24px')
        await page.wait_for_function('(key)=>{const rows=JSON.parse(localStorage.getItem(key)||"[]");return rows.some(row=>row.note.text==="☑ Inspect seal\\n• Staff check"&&row.note.textStyles?.some(style=>style.fontSize===24));}', arg=KEY + ':outbox')
        outbox = await page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY + ':outbox')
        pending = next(row for row in outbox if row['note']['id'] == OLDER)
        await page.screenshot(path=str(OUT / f'notes-{width}-before-restart.png'), full_page=True)
        # The process/profile really closes. LocalStorage must preserve the chosen
        # older note and protected rich draft without selecting the newer note.
        await context.close()
        print(f'Notes {width}: reopen persistent profile', flush=True)
        context, page = await launch(playwright, Path(directory), width, state)
        editor = page.get_by_role('textbox', name='Note text', exact=True)
        await expect(editor).to_have_js_property('textContent', '☑ Inspect seal\n• Staff check')
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_attribute('aria-checked', 'true')
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_css('font-size', '24px')
        await expect(page.get_by_role('checkbox', name='Inspect seal', exact=True)).to_have_css('color', color)
        recovered = await page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY + ':outbox')
        assert next(row for row in recovered if row['note']['id'] == OLDER)['changeId'] == pending['changeId']
        await page.screenshot(path=str(OUT / f'notes-{width}-after-restart.png'), full_page=True)
        assert not state['errors'], state['errors']
        await context.close()
        return {'width': width, 'physical_context_restart': True, 'checked_state_and_24px_color_format_restored': True,
                'keyboard_and_mobile_beforeinput': True, 'offline_writes_intercepted': len(state['writes']), 'errors': state['errors']}


async def main():
    async with async_playwright() as playwright:
        results = [await run(playwright, width) for width in [1440, 390]]
    (OUT / 'report.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
