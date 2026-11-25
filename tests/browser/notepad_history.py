import asyncio
import json
import os
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, HOTEL, OUT, UID, install

ROOT = Path(__file__).resolve().parents[2]
TECH = "00000000-0000-4000-8000-000000000008"
SCOTT = "00000000-0000-4000-8000-000000000009"


def person(user_id, name, role, roles):
    return {"id": user_id, "name": name, "short": name.split()[0], "initials": "X",
            "role": role, "displayRole": role, "roles": roles, "active": True,
            "taggable": True, "recipientSelectable": True}


async def main():
    fixture = json.loads(subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import {historyExamples,historyPeople} from './tests/fixtures/notepad-history-examples.mjs'; "
        "console.log(JSON.stringify({historyExamples,historyPeople}));",
    ], cwd=ROOT, text=True, encoding="utf-8"))
    examples = fixture["historyExamples"]
    assert len(examples) == 5
    notes = [example["note"] for example in examples]
    for note in notes:
        note.update(authorId=UID, createdAt="2026-11-25T04:38:00Z")
    notes[0].update(
        title="Synthetic note about the overnight boiler inspection, replacement parts, and the morning shift handoff",
        priority="Urgent", titleFontFamily="", audience={"all": False, "people": [TECH], "roles": []},
    )
    notes[0]["content"] = (
        '<p><span class="mention" contenteditable="false" data-mention-kind="location" '
        'data-mention-id="lobby">@Lobby</span> '
        f'<span class="mention" contenteditable="false" data-mention-kind="person" data-mention-id="{TECH}">@Morgan</span></p>'
        + notes[0]["content"]
    )
    through = [note["id"] for note in notes]
    people = [person(UID, "Avery Reed", "Chief Engineer", ["engineer"]),
              person(TECH, "Morgan Rivera", "Maintenance Technician", ["technician"]),
              person(SCOTT, "Scott Pickering", "Chief Engineer", ["engineer", "system_admin"]),
              *fixture["historyPeople"]]
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        context = await browser.new_context(viewport={"width": 1280, "height": 840}, service_workers="block")
        await install(context, "chief_engineer")
        await context.route_web_socket("wss://**", lambda socket: socket.close())
        time_format = "24h"
        bootstrap_reads = 0
        read_history = []

        async def notepad(route):
            nonlocal bootstrap_reads
            if route.request.method == "PUT":
                data = route.request.post_data_json
                target = next(note for note in notes if note["id"] == data["id"])
                target.update(data["document"])
                target["revision"] += 1
                return await route.fulfill(json={"note": target, "revision": target["revision"]})
            if route.request.method == "PATCH":
                return await route.fulfill(json={"order": route.request.post_data_json["order"]})
            bootstrap_reads += 1
            await route.fulfill(json={"hotelId": HOTEL, "userId": UID, "people": people, "notes": notes,
                                      "roles": [{"id": "engineer", "label": "Chief Engineer"}],
                                      "order": through, "legacyAliases": {}, "timeFormat": time_format})

        async def history(route):
            params = parse_qs(urlparse(route.request.url).query)
            note_id = params["id"][0]
            read_history.append(note_id)
            example = next(row for row in examples if row["note"]["id"] == note_id)
            await route.fulfill(json={"entries": example["entries"], "next": None})

        await context.route("**/api/notepad", notepad)
        await context.route("**/api/notepad/history?*", history)
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(f"{BASE}/notepad?note={through[0]}", timeout=120_000)
        await page.add_style_tag(content="nextjs-portal { display: none; }")
        frame = page.frame_locator('iframe[title="Notepad"]')
        title = frame.get_by_role("textbox", name="Note title", exact=True)
        await expect(title).to_have_value(notes[0]["title"], timeout=60_000)
        creator = frame.locator(".note-attribution")
        history_link = creator.get_by_role("button", name="Edit History")
        priority = frame.locator('select[aria-label="Priority"]')
        share_button = frame.get_by_role("button", name="Shared with…")
        trash_button = frame.get_by_role("button", name="Delete note")
        priority_label = frame.locator('label[for="note-priority"]')

        async def header_geometry():
            title_box, label_box = await title.bounding_box(), await priority_label.bounding_box()
            share_box, trash_box = await share_button.bounding_box(), await trash_button.bounding_box()
            attribution_box = await creator.bounding_box()
            stamp_box, history_box = await creator.locator("time").bounding_box(), await history_link.bounding_box()
            assert label_box["y"] >= title_box["y"] + title_box["height"] - 1
            assert abs(label_box["x"] - (title_box["x"] + 2)) <= 1
            assert abs(share_box["y"] + share_box["height"] - trash_box["y"] - trash_box["height"]) <= 1
            assert 0 < attribution_box["y"] - (trash_box["y"] + trash_box["height"]) <= 5
            assert history_box["x"] >= stamp_box["x"] + stamp_box["width"]
            assert abs(history_box["y"] - stamp_box["y"]) <= 1
            font_size = "element => getComputedStyle(element).fontSize"
            attribution_size = await creator.locator(".note-creator").evaluate(font_size)
            for control in (priority_label, priority):
                assert await control.evaluate(font_size) == attribution_size

        await header_geometry()
        assert await priority.evaluate("element => getComputedStyle(element).borderTopWidth") == "0px"
        share_style = "button => {const s=getComputedStyle(button);return [s.color,s.boxShadow,s.cursor];}"
        before_hover, shadow, cursor = await share_button.evaluate(share_style)
        await share_button.hover()
        hovered, hover_shadow, hover_cursor = await share_button.evaluate(share_style)
        assert before_hover != hovered and shadow == hover_shadow == "none" and cursor == hover_cursor == "pointer"
        active_row = frame.locator(f'[data-note="{through[0]}"]')
        await expect(active_row.locator(".audience-meta")).to_have_text("Morgan")
        await expect(active_row.locator("time")).to_have_text("24 Nov 22:38")
        assert notes[0]["authorName"] not in await active_row.inner_text()
        await page.set_viewport_size({"width": 440, "height": 700})
        await expect(active_row.locator("time")).to_be_visible()
        await expect(active_row.locator(".audience-meta")).to_be_visible()
        await header_geometry()
        assert await title.evaluate("textarea => textarea.clientHeight > 32 && textarea.scrollHeight <= textarea.clientHeight + 1")
        await page.set_viewport_size({"width": 1280, "height": 840})
        assert "Comic Sans MS" in await title.evaluate("element => getComputedStyle(element).fontFamily")
        for label, value in (("Font", "Times New Roman"), ("Font Size", "36")):
            dropdown = frame.locator(f'select[aria-label="{label}"]')
            assert await dropdown.evaluate("""(control, label) => {
                const style = getComputedStyle(control);
                const canvas = document.createElement('canvas').getContext('2d');
                canvas.font = style.font;
                return Array.from(control.options).some(option => option.text === label)
                    && control.clientWidth - parseFloat(style.paddingLeft) - 22 >= canvas.measureText(label).width;
            }""", value)

        for dropdown in (priority, frame.get_by_label("Font", exact=True), frame.get_by_label("Font Size", exact=True)):
            assert await dropdown.evaluate("control => getComputedStyle(control).borderTopWidth") == "0px"
            await dropdown.click()
            active_option = dropdown.locator("option:checked")
            await expect(active_option).to_be_visible()
            assert await dropdown.evaluate("""control => {
                const picker = getComputedStyle(control, '::picker(select)');
                return picker.borderTopWidth === '0px' && picker.overflowY === 'auto'
                    && picker.scrollbarColor !== 'auto';
            }""")
            hovered_option = dropdown.locator("option:not(:checked)").first
            await hovered_option.hover()
            for option in (active_option, hovered_option):
                assert await option.evaluate("""option => {
                    const style = getComputedStyle(option);
                    const accent = new Option();
                    accent.style.color = style.getPropertyValue('--accent').trim();
                    return style.color === accent.style.color;
                }""")
            await page.keyboard.press("Escape")
            assert not await dropdown.evaluate("control => control.matches(':open')")

        location = frame.locator('.note-content [data-mention-kind="location"]')
        mention = frame.locator('.note-content [data-mention-kind="person"]')
        await expect(location).to_have_text("Lobby")
        await expect(mention).to_have_text("@Morgan")
        color = "element => getComputedStyle(element).color"
        assert await location.evaluate(color) != await mention.evaluate(color)

        await share_button.click()
        form = frame.locator(".recipient-dialog")
        await expect(form.get_by_text("Morgan Rivera (Maintenance Technician)", exact=True)).to_be_visible()
        await expect(form.get_by_text("Scott Pickering (Chief Engineer)", exact=True)).to_be_visible()
        first_group = form.get_by_role("heading", name="Individual Names")
        second_group = form.get_by_role("heading", name="Roles and Departments")
        assert (await first_group.bounding_box())["y"] < (await second_group.bounding_box())["y"]
        await expect(form.get_by_role("button", name="Cancel", exact=True)).to_have_count(0)
        await expect(form.get_by_role("button", name="Close recipients")).to_be_visible()
        await form.get_by_text("Scott Pickering (Chief Engineer)", exact=True).click()
        bounds = await form.bounding_box()
        await page.mouse.click(bounds["x"] - 8, bounds["y"] + bounds["height"] / 2)
        await expect(form).to_have_count(0)
        assert notes[0]["audience"] == {"all": False, "people": [TECH], "roles": []}

        await frame.get_by_role("button", name="New Note", exact=True).click()
        create = form.get_by_role("button", name="Create Note", exact=True)
        private_choice = form.get_by_text("Just Me", exact=True).locator("..")
        await expect(create).to_be_visible()
        await expect(form).to_have_css("opacity", "1")
        bounds, create_box, private_box = await form.bounding_box(), await create.bounding_box(), await private_choice.bounding_box()
        assert abs(create_box["x"] + create_box["width"] / 2 - bounds["x"] - bounds["width"] / 2) <= 2
        assert abs(create_box["y"] + create_box["height"] / 2 - private_box["y"] - private_box["height"] / 2) <= 1
        assert create_box["width"] >= 100
        await page.mouse.click(bounds["x"] - 8, bounds["y"] + bounds["height"] / 2)
        await expect(form).to_have_count(0)
        assert len(notes) == 5

        await title.click()
        await title.press("End")
        samples = await title.evaluate("""async title => {
            const sidebar = document.querySelector('.note-item[aria-current="true"] .note-urgent');
            const marker = title.parentElement.querySelector('.note-urgent');
            const records = [];
            const start = performance.now();
            while (performance.now() - start < 2600) {
              const overlay = document.querySelector('.notepad-caret-overlay');
              const caret = overlay
                ? (!overlay.hidden && Number(getComputedStyle(overlay).opacity) > 0)
                : getComputedStyle(title).caretColor !== 'rgba(0, 0, 0, 0)';
              records.push([Number(getComputedStyle(sidebar).opacity), Number(getComputedStyle(marker).opacity), caret]);
              await new Promise(resolve => setTimeout(resolve, 30));
            }
            return records;
        }""")
        assert all(sidebar == marker for sidebar, marker, _ in samples)
        assert {(marker, caret) for _, marker, caret in samples} == {(0, False), (0, True), (1, False), (1, True)}
        for mode, cursor in (("Handwritten ink", "pencil"), ("Erase ink stroke", "eraser")):
            await frame.get_by_role("button", name=mode).click()
            assert cursor + "-cursor.svg" in await frame.locator(".note-ink").evaluate("element => getComputedStyle(element).cursor")
            assert "-cursor.svg" not in await title.evaluate("element => getComputedStyle(element).cursor")
        await frame.get_by_role("button", name="Text and keyboard handwriting").click()

        panel = frame.locator(".note-history")
        for note_id in through:
            await frame.locator(f'[data-note="{note_id}"]').click()
            await history_link.click()
            await expect(panel).to_be_visible()
            await expect(panel.locator(".history-version").first).to_be_visible()
            assert await panel.locator(".history-editor-name").count() >= 2
            await expect(panel.locator(".history-line[data-change=added]").first).to_be_visible()
            await expect(panel.locator(".history-line[data-change=removed]").first).to_be_visible()
            await expect(frame.locator(".general-notes-body")).to_be_hidden()
            if note_id == through[0]:
                await page.screenshot(path=OUT / "notepad-edit-history.png", animations="disabled")
            await panel.get_by_role("button", name="Back to note").click()
            await expect(frame.locator(".general-notes-body")).to_be_visible()
        assert read_history == through
        await frame.locator(f'[data-note="{through[0]}"]').click()
        time_format = "12h"
        before = bootstrap_reads
        await page.evaluate("""window.postMessage({type:'cmpri-profile-preferences-updated'}, window.location.origin)""")
        await expect(active_row.locator("time")).to_have_text("24 Nov 10:38 PM", timeout=60_000)
        assert bootstrap_reads > before
        assert not errors, errors
        print("Header geometry, recipient dismissal and Create Note alignment, five histories, both time formats, tags, drawing cursors, and caret timing passed.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
