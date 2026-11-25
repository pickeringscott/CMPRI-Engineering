import asyncio
import os

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, HOTEL, OUT, UID, install

STYLES = {'bullet': 'ul > li', 'letter': 'ol > li', 'number': 'ol > li', 'check': '.note-check'}


def fixture_note(index, title, content):
    return {
        'id': f'00000000-0000-4000-8000-{index:012d}', 'authorId': UID,
        'title': title, 'audience': {'all': False, 'people': [], 'roles': []}, 'content': content,
        'priority': 'Normal', 'fontSize': 16, 'fontFamily': 'Comic Sans MS',
        'titleFontFamily': 'Comic Sans MS', 'ink': [], 'itemThreads': {}, 'attachments': [],
        'createdAt': '2026-11-24T22:38:00Z', 'updatedAt': '2026-11-24T22:38:00Z', 'revision': 1,
    }


async def main():
    mixed_html = ('<p data-item-id="paragraph">Prior paragraph</p><p data-item-id="task">Checkbox</p>'
                  '<p data-item-id="child">Nested letter</p><p data-item-id="bullet">Sized bullet</p>'
                  '<p data-item-id="number">Sized number</p>')
    notes = [fixture_note(index, kind, '<strong>First line</strong><div data-item-id="second" '
                          'style="text-align:right">Second line</div>')
             for index, kind in enumerate(STYLES, 10)]
    notes.append(fixture_note(20, 'Mixed nesting and sizes', mixed_html))
    order = [note['id'] for note in notes]

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'))
        context = await browser.new_context(viewport={'width': 1120, 'height': 840}, reduced_motion='reduce', service_workers='block')
        await install(context, 'chief_engineer')
        await context.route_web_socket('wss://**', lambda socket: socket.close())

        async def notepad(route):
            if route.request.method == 'PUT':
                payload = route.request.post_data_json
                target = next(note for note in notes if note['id'] == payload['id'])
                target.update(payload['document'])
                target['revision'] += 1
                return await route.fulfill(json={'note': target, 'revision': target['revision']})
            return await route.fulfill(json={
                'hotelId': HOTEL, 'userId': UID, 'timeFormat': '24h', 'order': order, 'notes': notes, 'legacyAliases': {},
                'people': [{'id': UID, 'name': 'Avery Fixture', 'short': 'Avery', 'roles': ['engineer'],
                            'role': 'Chief Engineer', 'active': True, 'taggable': True}],
                'roles': [{'id': 'engineer', 'label': 'Chief Engineer'}],
            })

        await context.route('**/api/notepad', notepad)
        page = await context.new_page()
        page_errors = []
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        await page.goto(f'{BASE}/notepad?note={order[0]}', timeout=120_000)
        await page.add_style_tag(content='nextjs-portal { display: none; }')
        frame = page.frame_locator('iframe[title="Notepad"]')
        editor = frame.locator('.note-content')
        title = frame.get_by_role('textbox', name='Note title')

        async def command(name):
            await frame.locator(f'[data-format-command={name}]').click()

        try:
            await expect(editor).to_be_visible(timeout=30_000)
        except AssertionError as error:
            raise AssertionError(f'Notepad did not initialize: {await page.locator("body").inner_text()}; {page_errors}') from error
        for index, (kind, selector) in enumerate(STYLES.items()):
            if index:
                await frame.locator(f'[data-note="{order[index]}"]').click()
            await expect(title).to_have_value(kind)
            await editor.locator('[data-item-id=second]').click()
            await command(kind)
            await expect(editor.locator('p strong')).to_have_text('First line')
            await expect(editor.locator('p').first).to_have_css('text-align', 'start')
            items = editor.locator(selector)
            await expect(items.first).to_have_text('Second line')
            await expect(items.first).to_have_css('text-align', 'right')
            await expect(items.first).to_have_attribute('data-list-level', '2')
            await page.keyboard.press('End')
            await page.keyboard.press('Enter')
            await expect(items).to_have_count(2)
            await page.keyboard.press('Enter')
            await expect(items).to_have_count(1)
            paragraph = editor.locator('p').last
            await expect(paragraph).to_have_attribute('data-list-level', '1')
            await command('align-center')
            await page.keyboard.insert_text('Centered after leaving list')
            await expect(paragraph).to_have_text('Centered after leaving list')
            await expect(paragraph).to_have_css('text-align', 'center')

        await page.keyboard.press('Control+a')
        await page.keyboard.press('Backspace')
        await expect(editor.locator('p')).to_have_count(1)
        await command('align-right')
        await page.keyboard.insert_text('Aligned after clearing')
        await expect(editor.locator('p')).to_have_text('Aligned after clearing')
        await expect(editor.locator('p')).to_have_css('text-align', 'right')

        await frame.locator(f'[data-note="{order[-1]}"]').click()
        await expect(title).to_have_value('Mixed nesting and sizes')
        paragraph = editor.locator('[data-item-id=paragraph]')
        await paragraph.click()
        await page.keyboard.press('Tab')
        await expect(paragraph).to_have_attribute('data-list-level', '2')
        for item_id, style in [('task', 'check'), ('child', 'letter'), ('bullet', 'bullet'), ('number', 'number')]:
            await editor.locator(f'[data-item-id={item_id}]').click()
            await command(style)
        for item_id, size in [('task', 20), ('child', 36), ('bullet', 20), ('number', 36)]:
            item = editor.locator(f'[data-item-id={item_id}]')
            text = item.locator('.task-label') if item_id == 'task' else item
            await text.evaluate('''line => {
                line.closest('.task-label,.note-content').focus();
                getSelection().selectAllChildren(line);
                document.dispatchEvent(new Event('selectionchange'));
            }''')
            await frame.get_by_label('Font Size', exact=True).select_option(str(size))
            marker_size = await item.evaluate('''line => line.matches('li')
                ? getComputedStyle(line, '::marker').fontSize : getComputedStyle(line.querySelector('input')).width''')
            assert marker_size == f'{size}px', (item_id, marker_size)
        child = editor.locator('[data-item-id=child]')
        await child.click()
        for _ in range(4):
            await page.keyboard.press('Tab')
        await expect(child).to_have_attribute('data-list-level', '5')
        await expect(child).to_have_css('list-style-type', 'lower-alpha')
        assert (await child.bounding_box())['x'] > (await editor.locator('[data-item-id=task]').bounding_box())['x']
        await page.screenshot(path=OUT / 'notepad-list-formatting.png', animations='disabled')
        assert not page_errors, page_errors
        await browser.close()
    print('Notepad lists passed all formats, alignment, Enter, Tab, nesting, marker sizes, and clearing.')


if __name__ == '__main__':
    asyncio.run(main())
