import asyncio
import os
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, HOTEL, OUT, UID, install

NOTE = "00000000-0000-4000-8000-000000000081"
OTHER = "00000000-0000-4000-8000-000000000082"
SIZES = [(1440, 900, 6), (1024, 330, 6), (768, 620, 6), (600, 620, 5), (420, 630, 3), (320, 440, 3)]


def dimensions(index, full=False):
    width, height = [(160, 80), (80, 160), (160, 120)][index % 3]
    return (width * 2, height * 2) if full else (width, height)


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
                def media(full=False):
                    width, height = dimensions(index, full)
                    suffix = "-full" if full else ""
                    return {"url": f"https://media.giphy.com/{gif_id}{suffix}.gif", "width": str(width), "height": str(height)}
                items.append({"id": gif_id, "title": f"Fixture {gif_id}",
                              "images": {"fixed_width": media(), "original": media(True)}})
            await route.fulfill(json={"data": items, "pagination": {"total_count": total}})

        async def image(route):
            stem = urlparse(route.request.url).path.removesuffix(".gif")
            full = stem.endswith("-full")
            index = int(stem.removesuffix("-full").rsplit("-", 1)[-1])
            width, height = dimensions(index, full)
            svg = (
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
                f'<rect width="{width}" height="{height}" fill="hsl({index * 37 % 360}, 50%, 35%)"/>'
                f'<circle cx="{width / 2}" cy="{height / 2}" r="{min(width, height) * .24}" fill="white" opacity=".22"/>'
                f'<text x="{width / 2}" y="{height / 2 + 8}" text-anchor="middle" font-size="23" fill="white">{index + 1}</text></svg>'
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
        toolbar = editor.get_by_role("toolbar", name="Notepad controls")
        sidebar = editor.get_by_role("complementary", name="Saved notes")
        first = editor.get_by_role("button", name="Select Fixture trending-0", exact=True)
        trigger = toolbar.locator("[data-notepad-gif-trigger]")
        badge = picker.get_by_role("link", name="Powered by GIPHY")
        search = picker.get_by_role("searchbox", name="Search GIPHY")
        title = editor.get_by_role("textbox", name="Note title")
        grid = picker.locator(".staff-gif-grid")

        async def open_picker():
            await trigger.click()
            await expect(picker).to_be_visible()

        await expect(toolbar).to_be_visible(timeout=60_000)
        assert not provider_queries, provider_queries
        await open_picker()
        await expect(first).to_be_visible()
        await expect(badge).to_be_visible()
        await expect(search).to_be_focused()
        assert await picker.evaluate("element => !element.matches(':modal') && element.parentElement.matches('.general-notes-body')")
        assert await first.evaluate("""element => {
            const style = getComputedStyle(element);
            return style.borderTopWidth === '0px' && style.borderRadius === '5px'
                && style.outlineStyle === 'none' && style.boxShadow === 'none'
                && style.breakInside === 'avoid';
        }""")
        assert provider_queries == [("", 0)], provider_queries
        for width, height, columns in SIZES:
            await page.set_viewport_size({"width": width, "height": height})
            await expect(picker).to_be_visible()
            bounds = await picker.bounding_box()
            writing = await body.bounding_box()
            dock = await toolbar.bounding_box()
            badge_box = await badge.bounding_box()
            assert bounds["x"] >= writing["x"] + 6.9 and bounds["y"] >= writing["y"] + 6.9, (width, bounds, writing)
            assert abs(bounds["x"] + bounds["width"] - (writing["x"] + writing["width"] - 7)) <= .1
            assert bounds["y"] + bounds["height"] <= writing["y"] + writing["height"] - 6.9
            if columns == 6:
                assert abs(bounds["y"] - writing["y"] - 7) <= .1, (height, bounds, writing)
                assert abs(bounds["height"] - min(440, writing["height"] - 14)) <= .1, (height, bounds, writing)
            else:
                assert bounds["width"] <= dock["width"] + .02, (width, bounds, dock)
            assert abs(badge_box["x"] + badge_box["width"] - bounds["x"] - bounds["width"]) <= 1
            assert abs(badge_box["y"] + badge_box["height"] - bounds["y"] - bounds["height"]) <= 1
            assert await search.evaluate("element => getComputedStyle(element).borderRadius") == "9999px"
            geometry = await picker.locator(".staff-gif-results").evaluate("""results => {
                const css = getComputedStyle(results);
                const tiles = [...results.querySelectorAll('button')];
                const boxes = tiles.map(tile => tile.getBoundingClientRect());
                const viewport = results.parentElement.getBoundingClientRect();
                const visibleRows = new Set(boxes.filter(box => box.bottom > viewport.top && box.top < viewport.bottom - .04).map(box => box.y));
                return {
                    columns: Number(css.columnCount), gap: css.columnGap,
                    lanes: new Set(boxes.map(box => box.x)).size,
                    stackedGap: boxes[1].top - boxes[0].bottom,
                    naturalAspect: boxes[0].width / boxes[0].height,
                    visibleRows: visibleRows.size,
                    viewportHeight: viewport.height,
                    tileHeight: boxes[0].height,
                    tallestTile: Math.max(...boxes.map(box => box.height)),
                    fitsWithoutCrop: getComputedStyle(tiles[1].querySelector('img')).objectFit === 'contain',
                    rowGap: css.rowGap,
                };
            }""")
            assert geometry["lanes"] == columns and geometry["gap"] == "4px", (width, geometry)
            assert geometry["fitsWithoutCrop"], geometry
            if columns == 6:
                assert geometry["columns"] == columns and abs(geometry["stackedGap"] - 4) <= .02, geometry
                assert geometry["tallestTile"] <= geometry["viewportHeight"], geometry
                if height >= 620:
                    assert abs(geometry["naturalAspect"] - 2) <= .01, geometry
            else:
                assert geometry["rowGap"] == "4px" and 1 <= geometry["visibleRows"] <= 3, (width, geometry)
                assert geometry["viewportHeight"] <= 3 * geometry["tileHeight"] + 8.1, geometry
            if width in (1440, 600, 420, 320):
                await first.locator("img").evaluate("image => image.decode()")
                await page.screenshot(path=OUT / f"notepad-giphy-inset-{width}.png", animations="disabled")

        tile_before = await first.bounding_box()
        await first.hover()
        await asyncio.sleep(.9)
        assert await first.bounding_box() == tile_before
        await expect(picker.locator("[data-attachment-gif-preview]")).to_have_count(0)
        assert provider_queries == [("", 0)], provider_queries
        await page.set_viewport_size({"width": 420, "height": 630})
        narrower = int((await picker.bounding_box())["width"]) - 28
        await toolbar.evaluate("(dock, width) => { dock.style.maxWidth = width + 'px'; }", narrower)
        await expect(picker).to_have_css("width", f"{narrower}px")
        await toolbar.evaluate("dock => dock.style.removeProperty('max-width')")
        await grid.hover()
        await page.mouse.wheel(0, 2500)
        await expect(editor.get_by_role("button", name="Select Fixture trending-53", exact=True)).to_be_attached()
        assert provider_queries == [("", 0), ("", 48)], provider_queries
        assert await body.locator(".general-notes-scroll").evaluate("body => body.scrollTop") == 0
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
        await expect(trigger).to_be_focused()
        await open_picker()
        await title.click()
        await expect(picker).to_have_count(0)
        await expect(title).to_be_focused()
        await page.set_viewport_size({"width": 1024, "height": 720})
        await sidebar.get_by_text("Valve checklist", exact=True).click()
        await expect(editor.locator("#note-title")).to_have_value("Valve checklist")
        assert not failures, failures
        print(f"Writing-area inset, dock width and three-row mobile cap, spacing and 6/5/3 columns passed at {SIZES}. Hover stays still; paging, search, selection, save and dismissal passed.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
