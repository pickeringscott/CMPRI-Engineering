import asyncio
import os
from base64 import b64decode
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, GIF, HOTEL, OUT, UID, install

NOTE = "00000000-0000-4000-8000-000000000081"
OTHER = "00000000-0000-4000-8000-000000000082"
# Three frames of a 16 × 16 solid-color WebM.
VIDEO = b64decode(
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAItEU2bdLpNu4tTq4QVSalmU6yBoU27i1Or"
    "hBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggIX7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrX"
    "sYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAXgAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIYrzPpL6O"
    "7BqcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4JCwgRC6gRCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNP"
    "REVSRIeMTGF2ZjYxLjcuMTAzc3PWY8CLY8WIYrzPpL6O7BpnyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhn"
    "yKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjEyMDAwMDAwMAAfQ7Z17+eBAKO8gQAAgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1"
    "qgP4A/oCDU0YAP79bvP/4rWHWcX/it//02TxV4z/6YsAo5WBACgAsQEABRCsABgAGFgv9AAIAACjlYEAUACxAQAFEKwAGAAY"
    "WC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAaPwgQM="
)
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
    uploads = {}
    original_text = b"Fixture attachment contents"
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        context = await browser.new_context(
            viewport={"width": SIZES[0][0], "height": SIZES[0][1]},
            reduced_motion="reduce", service_workers="block", has_touch=True,
        )
        await install(context, "chief_engineer")
        await context.route_web_socket("wss://**", lambda socket: socket.close())

        async def notepad(route):
            if route.request.method == "PUT":
                save = route.request.post_data_json
                saves.append(save)
                target = next(entry for entry in notes if entry["id"] == save["id"])
                target.update(save["document"])
                for attachment in target["attachments"]:
                    if attachment["id"] in uploads:
                        attachment["url"] = uploads[attachment["id"]]["url"]
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

        async def upload(route):
            item = route.request.post_data_json
            file_id = item["id"]
            if route.request.method == "POST":
                suffix = "?download=fixture.txt" if item["type"] == "text/plain" else ""
                item["url"] = f"https://notepad-fixture.example/{file_id}{suffix}"
                uploads[file_id] = item
                return await route.fulfill(json={"id": file_id, "path": file_id, "token": "fixture"})
            await route.fulfill(json={"id": file_id, "ready": True, "url": uploads[file_id]["url"]})

        async def storage(route):
            file_id = urlparse(route.request.url).path.rsplit("/", 1)[-1]
            await route.fulfill(json={"Key": file_id})

        async def original(route):
            item = uploads[urlparse(route.request.url).path.rsplit("/", 1)[-1]]
            if item["type"] in ("image/gif", "video/webm"):
                return await route.fulfill(content_type=item["type"],
                                           body=GIF if item["type"] == "image/gif" else VIDEO)
            await route.fulfill(content_type=item["type"], body=original_text,
                                headers={"Content-Disposition": 'attachment; filename="fixture.txt"'})

        await context.route("**/api/notepad", notepad)
        await context.route("**/api/notepad/uploads", upload)
        await context.route("**/storage/v1/object/upload/sign/**", storage)
        await context.route("https://notepad-fixture.example/**", original)
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
        close = picker.get_by_role("button", name="Close GIF picker")

        async def open_picker():
            await trigger.click()
            await expect(picker).to_be_visible()

        await expect(toolbar).to_be_visible(timeout=60_000)
        await expect(toolbar.get_by_role("button", name="Take a photo")).to_be_hidden()
        await expect(editor.locator(".note-creator")).to_have_text("Alex")
        await expect(editor.get_by_label("Font", exact=True)).to_have_css("text-align-last", "center")
        await expect(editor.get_by_label("Font Size", exact=True)).to_have_css("text-align-last", "center")
        for label in ("Font", "Font Size"):
            await expect(editor.get_by_label(label, exact=True)).to_have_css("justify-content", "center")
        assert not provider_queries, provider_queries
        await page.emulate_media(reduced_motion="no-preference")
        await trigger.evaluate("""button => {
            const animate = Element.prototype.animate;
            Element.prototype.animate = function(frames, options) {
                if (this.matches('.note-giphy-picker')) {
                    const rect = button.getBoundingClientRect();
                    const parent = this.offsetParent.getBoundingClientRect();
                    const [originX, originY] = this.style.transformOrigin.split(' ').map(parseFloat);
                    this.dataset.openedFromButton = String(
                        Math.abs(parent.left + this.offsetLeft + originX - rect.left - rect.width / 2) < 1
                        && Math.abs(parent.top + this.offsetTop + originY - rect.top - rect.height / 2) < 1
                        && frames[0].opacity === '0' && frames[1].opacity === '1'
                    );
                }
                return animate.call(this, frames, options);
            };
        }""")
        await open_picker()
        await expect(picker).to_have_attribute("data-opened-from-button", "true")
        await picker.evaluate("element => Promise.all(element.getAnimations().map(animation => animation.finished))")
        await page.emulate_media(reduced_motion="reduce")
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
            if columns == 6:
                assert bounds["y"] + bounds["height"] >= dock["y"] + dock["height"]
                assert await trigger.evaluate("""button => {
                    const rect = button.getBoundingClientRect();
                    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
                }"""), (width, bounds, dock)
            else:
                assert bounds["y"] + bounds["height"] <= writing["y"] + writing["height"] - 6.9
                assert bounds["width"] <= dock["width"] + .02, (width, bounds, dock)
            assert abs(badge_box["x"] + badge_box["width"] - bounds["x"] - bounds["width"]) <= 1
            assert abs(badge_box["y"] + badge_box["height"] - bounds["y"] - bounds["height"] + (35 if columns == 6 else 0)) <= 1
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
        await expect(toolbar.get_by_role("button", name="Take a photo")).to_be_visible()
        narrower = int((await picker.bounding_box())["width"]) - 28
        await toolbar.evaluate("(dock, width) => { dock.style.maxWidth = width + 'px'; }", narrower)
        await expect(picker).to_have_css("width", f"{narrower}px")
        await toolbar.evaluate("dock => dock.style.removeProperty('max-width')")
        writing_box = await body.bounding_box()
        popup_box = await picker.bounding_box()
        outside_x, outside_y = writing_box["x"] + 14, writing_box["y"] + 12
        assert outside_y < popup_box["y"], (writing_box, popup_box)
        await page.touchscreen.tap(outside_x, outside_y)
        await expect(picker).to_be_visible()
        scroll = body.locator(".general-notes-scroll")
        await page.mouse.move(outside_x, outside_y)
        await page.mouse.wheel(0, 160)
        for _ in range(20):
            writing_scroll = await scroll.evaluate("element => element.scrollTop")
            if writing_scroll > 0:
                break
            await asyncio.sleep(.03)
        assert writing_scroll > 0
        assert await grid.evaluate("element => element.scrollTop") == 0
        await expect(picker).to_be_visible()
        await grid.hover()
        await page.mouse.wheel(0, 2500)
        await expect(editor.get_by_role("button", name="Select Fixture trending-53", exact=True)).to_be_attached()
        assert provider_queries == [("", 0), ("", 48)], provider_queries
        assert await scroll.evaluate("element => element.scrollTop") == writing_scroll
        await search.fill("pump")
        await expect(editor.get_by_role("button", name="Select Fixture pump-0", exact=True)).to_be_visible()
        assert provider_queries == [("", 0), ("", 48), ("pump", 0)], provider_queries
        await close.click()
        await editor.locator(".note-content").evaluate("""body => {
            body.focus();
            const range = document.createRange();
            range.setStart(body.firstElementChild.firstChild, 7);
            range.collapse(true);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        }""")
        await open_picker()
        await search.fill("pump")
        await editor.get_by_role("button", name="Select Fixture pump-0", exact=True).click()
        await expect(picker).to_have_count(0)
        await expect(editor.get_by_role("button", name="Open Fixture pump-0")).to_be_visible()
        for _ in range(40):
            if saves:
                break
            await asyncio.sleep(.05)
        assert saves and saves[-1]["document"]["attachments"][0]["gifId"] == "pump-0", saves
        stored = saves[-1]["document"]
        file_id = stored["attachments"][0]["id"]
        marker = f'<span data-notepad-attachment-id="{file_id}" contenteditable="false"></span>'
        assert f"Review {marker}the fictional pump checklist." in stored["content"]
        await expect(editor.locator("[data-open-inline-attachment] img")).to_have_attribute(
            "src", "https://media.giphy.com/pump-0.gif"
        )
        await expect(editor.locator(".editor-attachments [data-open-attachment]")).to_have_count(0)
        await editor.get_by_role("button", name="Open Fixture pump-0").click()
        viewer = editor.get_by_role("dialog", name="Fixture pump-0")
        await expect(viewer.locator("img")).to_have_attribute("src", "https://media.giphy.com/pump-0-full.gif")
        await viewer.get_by_role("button", name="Close attachment").click()

        await page.set_viewport_size({"width": 1024, "height": 720})
        await expect(editor.get_by_role("button", name="Open Fixture pump-0")).to_be_visible()
        await editor.locator(".note-content").evaluate("""body => {
            body.focus();
            const range = document.createRange();
            range.setStart(body.firstElementChild.firstChild, 3);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        }""")
        async with page.expect_file_chooser() as choosing:
            await toolbar.get_by_role("button", name="Add attachment").click()
        await (await choosing.value).set_files([
            {"name": "photo.gif", "mimeType": "image/gif", "buffer": GIF},
            {"name": "clip.webm", "mimeType": "video/webm", "buffer": VIDEO},
            {"name": "fixture.txt", "mimeType": "text/plain", "buffer": original_text},
        ])
        photo = editor.get_by_role("button", name="Open photo.gif", exact=True)
        file_button = editor.get_by_role("link", name="Open fixture.txt", exact=True)
        await expect(photo).to_be_visible()
        await expect(file_button).to_be_visible()
        assert await editor.locator(".note-content p").first.evaluate("""p => {
            const files = [...p.querySelectorAll('[data-open-inline-attachment]')];
            return p.firstChild.textContent === 'Rev' && files[0].title === 'photo.gif'
                && files[1].title === 'clip.webm' && files[2].title === 'fixture.txt';
        }""")
        await photo.hover()
        preview = editor.locator(".inline-attachment-preview img")
        await expect(preview).to_be_visible()
        assert (await preview.bounding_box())["width"] > (await photo.bounding_box())["width"]
        await file_button.hover()
        await expect(editor.locator(".inline-attachment-preview")).to_have_text("fixture.txt")
        await photo.click()
        await expect(editor.locator(".inline-attachment-preview")).to_have_count(0)
        photo_viewer = editor.get_by_role("dialog", name="photo.gif")
        await photo_viewer.locator("img").evaluate("image => image.decode()")
        await photo_viewer.get_by_role("button", name="Close attachment").click()
        clip = editor.get_by_role("button", name="Open clip.webm", exact=True)
        await clip.hover()
        await editor.locator(".inline-attachment-preview video").evaluate("""async video => {
            if (video.readyState < 2) await Promise.race([new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })), new Promise(resolve => setTimeout(resolve, 3000))]);
            if (video.videoWidth !== 16) throw new Error('Expected the uploaded video in the hover preview');
        }""", timeout=10000)
        await clip.click()
        video_viewer = editor.get_by_role("dialog", name="clip.webm")
        await video_viewer.locator("video").evaluate("async video => { await video.play(); }")
        assert await video_viewer.locator("video").evaluate("video => video.videoWidth") == 16
        await video_viewer.get_by_role("button", name="Close attachment").click()

        async with page.expect_download() as downloading:
            await file_button.click()
        download = await downloading.value
        assert download.suggested_filename == "fixture.txt"
        assert (await download.path()).read_bytes() == original_text
        await editor.get_by_role("dialog", name="fixture.txt").get_by_role("button", name="Close attachment").click()
        await open_picker()
        await search.press("Escape")
        await expect(picker).to_have_count(0)
        await expect(trigger).to_be_focused()
        await open_picker()
        await close.click()
        await expect(picker).to_have_count(0)
        await expect(trigger).to_be_focused()
        await page.set_viewport_size({"width": 1024, "height": 720})
        await open_picker()
        await title.click()
        await expect(picker).to_have_count(0)
        await expect(title).to_be_focused()
        await sidebar.get_by_text("Valve checklist", exact=True).click()
        await expect(editor.locator("#note-title")).to_have_value("Valve checklist")
        assert not failures, failures
        print(f"Writing-area inset, dock width and three-row mobile cap, spacing and 6/5/3 columns passed at {SIZES}. Hover stays still; paging, search, selection, save and dismissal passed.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
