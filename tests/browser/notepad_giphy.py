import asyncio
import os
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, HOTEL, OUT, UID, install

NOTE = "00000000-0000-4000-8000-000000000081"
OTHER = "00000000-0000-4000-8000-000000000082"
SIZES = [(1440, 900), (1024, 720), (768, 620), (420, 630)]


def note(note_id, title):
    return {
        "id": note_id, "authorId": UID, "authorName": "Alex Morgan", "title": title,
        "audience": {"all": False, "people": [], "roles": []},
        "content": "<p>Review the fictional pump checklist.</p>" * 30,
        "priority": "Normal", "fontSize": 16, "fontFamily": "Comic Sans MS",
        "titleFontFamily": "Comic Sans MS", "ink": [], "itemThreads": {}, "attachments": [],
        "createdAt": "2026-11-24T22:38:00Z", "updatedAt": "2026-11-24T22:38:00Z", "revision": 1,
    }


async def main():
    notes = [note(NOTE, "Pump checklist"), note(OTHER, "Valve checklist")]
    saves, provider_queries, failures = [], [], []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        context = await browser.new_context(
            viewport={"width": SIZES[0][0], "height": SIZES[0][1]},
            reduced_motion="reduce", service_workers="block",
        )
        await install(context, "chief_engineer")
        await context.route_web_socket("wss://**", lambda socket: socket.close())

        async def notepad(route):
            if route.request.method == "PUT":
                save = route.request.post_data_json
                saves.append(save)
                target = next(entry for entry in notes if entry["id"] == save["id"])
                target.update(save["document"])
                target["revision"] += 1
                return await route.fulfill(json={"note": target, "revision": target["revision"]})
            return await route.fulfill(json={
                "hotelId": HOTEL, "userId": UID, "people": [{
                    "id": UID, "name": "Alex Morgan", "short": "Alex", "initials": "AM",
                    "roles": ["engineer"], "role": "Chief Engineer", "active": True,
                    "taggable": True, "recipientSelectable": True,
                }],
                "roles": [{"id": "engineer", "label": "Chief Engineer"}],
                "notes": notes, "order": [NOTE, OTHER], "legacyAliases": {}, "timeFormat": "24h",
            })

        async def giphy(route):
            params = parse_qs(urlparse(route.request.url).query)
            query = params.get("q", [""])[0]
            offset = int(params.get("offset", ["0"])[0])
            provider_queries.append((query, offset))
            total = 6 if query else 54
            items = []
            for index in range(offset, min(offset + 48, total)):
                gif_id = f"{query or 'trending'}-{index}"
                media = {"url": f"https://media.giphy.com/{gif_id}.gif", "width": "160", "height": "120"}
                items.append({"id": gif_id, "title": f"Fixture {gif_id}",
                              "images": {"fixed_width": media, "original": media}})
            await route.fulfill(json={"data": items, "pagination": {"total_count": total}})

        async def image(route):
            index = int(urlparse(route.request.url).path.rsplit("-", 1)[-1].split(".")[0])
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">'
                f'<rect width="160" height="120" fill="hsl({index * 37 % 360}, 50%, 35%)"/>'
                f'<circle cx="80" cy="60" r="32" fill="white" opacity=".22"/>'
                f'<text x="80" y="68" text-anchor="middle" font-size="23" fill="white">{index + 1}</text></svg>'
            )
            await route.fulfill(content_type="image/svg+xml", body=svg)

        await context.route("**/api/notepad", notepad)
        await context.route("https://api.giphy.com/**", giphy)
        await context.route("https://media.giphy.com/**", image)
        page = await context.new_page()
        page.on("pageerror", lambda error: failures.append(str(error)))
        await page.goto(f"{BASE}/notepad?note={NOTE}", wait_until="domcontentloaded", timeout=120_000)
        await page.add_style_tag(content="nextjs-portal { display: none; }")
        editor = page.frame_locator('iframe[title="Notepad"]')
        picker = editor.get_by_role("dialog", name="GIPHY picker")
        body = editor.locator(".general-notes-body")
        workspace = editor.locator(".general-notes-workspace")
        toolbar = editor.get_by_role("toolbar", name="Notepad controls")
        heading = editor.locator(".title-row")
        sidebar = editor.get_by_role("complementary", name="Saved notes")
        first = editor.get_by_role("button", name="Select Fixture trending-0", exact=True)
        close = editor.get_by_role("button", name="Close GIF picker")

        async def open_picker():
            await toolbar.get_by_role("button", name="Add attachment").click()
            await editor.get_by_role("menuitem", name="Choose a GIF").click()
            await expect(picker).to_be_visible()

        await expect(toolbar).to_be_visible(timeout=60_000)
        assert not provider_queries, provider_queries
        await open_picker()
        await expect(first).to_be_visible()
        await expect(picker.locator(".staff-gif-search").get_by_role("link", name="Powered by GIPHY")).to_be_visible()
        assert await first.evaluate("""element => {
            const style = getComputedStyle(element);
            return style.borderTopWidth === '0px' && style.borderRadius === '0px'
                && style.backgroundColor === 'rgba(0, 0, 0, 0)';
        }""")
        assert provider_queries == [("", 0)], provider_queries
        widths = []
        for width, height in SIZES:
            await page.set_viewport_size({"width": width, "height": height})
            await expect(picker).to_be_visible()
            bounds = await picker.bounding_box()
            writing = await body.bounding_box()
            workspace_box = await workspace.bounding_box()
            toolbar_box = await toolbar.bounding_box()
            grid_box = await picker.locator(".staff-gif-grid").bounding_box()
            assert bounds and writing, (width, bounds, writing)
            assert bounds["x"] >= writing["x"] + 6, (width, bounds, writing)
            assert abs(writing["x"] + writing["width"] - bounds["x"] - bounds["width"] - 7) <= 1
            assert abs(bounds["y"] - writing["y"] - 7) <= 1
            assert abs(workspace_box["y"] + workspace_box["height"] - bounds["y"] - bounds["height"]) <= 1
            assert grid_box["y"] + grid_box["height"] > toolbar_box["y"] + toolbar_box["height"] - 1
            assert grid_box["x"] < toolbar_box["x"] + toolbar_box["width"]
            assert await toolbar.evaluate("""dock => {
                const box = dock.getBoundingClientRect();
                return document.elementFromPoint(box.right - 16, box.y + box.height / 2)
                    ?.closest('.general-notes-dock') === dock;
            }""")
            for surrounding in (toolbar, heading, sidebar):
                await expect(surrounding).to_be_visible()
            boxes = [await picker.locator("[data-attachment-gif]").nth(index).bounding_box() for index in range(7)]
            assert all(boxes), (width, boxes)
            assert len({round(box["y"], 1) for box in boxes[:6]}) == 1, (width, boxes)
            assert boxes[6]["y"] > boxes[0]["y"] and boxes[6]["x"] == boxes[0]["x"], (width, boxes)
            widths.append(boxes[0]["width"])
            if width in (1024, 420):
                await first.locator("img").evaluate("image => image.decode()")
                await page.screenshot(path=OUT / f"notepad-giphy-{width}.png", animations="disabled")
        assert widths[0] > widths[-1] and widths == sorted(widths, reverse=True), widths

        async def style(element):
            return await element.evaluate("""element => {
              const css = getComputedStyle(element);
              return [css.opacity, css.transform, css.backgroundColor, css.filter];
            }""")

        await page.mouse.move(0, 0)
        tile_before, close_before = await style(first), await style(close)
        await first.hover()
        assert await style(first) == tile_before
        await close.hover()
        assert await style(close) == close_before
        assert provider_queries == [("", 0)], provider_queries
        await page.set_viewport_size({"width": 1024, "height": 720})
        grid = picker.locator(".staff-gif-grid")
        await grid.hover()
        await page.mouse.wheel(0, 2500)
        await expect(editor.get_by_role("button", name="Select Fixture trending-53", exact=True)).to_be_attached()
        assert provider_queries == [("", 0), ("", 48)], provider_queries
        assert await body.locator(".general-notes-scroll").evaluate("body => body.scrollTop") == 0
        search = editor.get_by_role("searchbox", name="Search GIPHY")
        await search.fill("pump")
        await expect(editor.get_by_role("button", name="Select Fixture pump-0", exact=True)).to_be_visible()
        assert provider_queries == [("", 0), ("", 48), ("pump", 0)], provider_queries
        await editor.get_by_role("button", name="Select Fixture pump-0", exact=True).click()
        await expect(picker).to_have_count(0)
        await expect(editor.get_by_role("button", name="Open Fixture pump-0")).to_be_visible()
        for _ in range(40):
            if saves:
                break
            await asyncio.sleep(.05)
        assert saves and saves[-1]["document"]["attachments"][0]["gifId"] == "pump-0", saves
        await open_picker()
        await search.press("Escape")
        await expect(picker).to_have_count(0)
        await expect(editor.get_by_role("menuitem", name="Choose a GIF")).to_be_focused()
        await editor.get_by_role("menuitem", name="Choose a GIF").click()
        await sidebar.get_by_text("Valve checklist", exact=True).click()
        await expect(picker).to_have_count(0)
        await expect(editor.locator("#note-title")).to_have_value("Valve checklist")
        assert not failures, failures
        print(f"Six plain columns scroll behind the dock at {SIZES}. Tile widths: {widths}. No footer or hover effects. Paging, search, selection, save, Escape and note switching passed.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
