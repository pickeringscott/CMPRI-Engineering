import asyncio

from cmpri_fixture import BASE, CAPS, UID, async_playwright, expect, install as install_fixture


ROLE_TABS = ["Daily Work", "Rooms & Reports", "Safety & Logs", "Assets & Inventory", "Account", "Admin"]
LIMITED_ROLES = {"front_desk", "housekeeping"}
CHIEF_MENU_ROLES = {"chief_engineer", "system_admin", "engineer", "senior_management"}

async def install(context, *args, **kwargs):
    # These tests start at the dashboard after the user has dismissed the guide.
    await install_fixture(context, *args, **kwargs)
    await context.add_init_script(f"""try {{
        localStorage.setItem("cmpri:beginners-guide:opened:{UID}", "1");
        sessionStorage.setItem("cmpri:beginners-guide:session:{UID}", "1");
    }} catch {{}}""")


def group(page, name):
    return page.locator("fieldset.group").filter(has=page.get_by_role("button", name=name, exact=True))


async def actions(page, name):
    return await group(page, name).locator(".action").all_text_contents()


async def check_header_rail(page):
    shelf = page.locator("header > .cmpri-header-shelf:first-child")
    rail = page.locator("nav.cmpri-dashboard-menu-rail")
    await expect(shelf.locator("[data-cmpri-menu-title]")).to_be_visible()
    await expect(shelf.locator("[data-dashboard-name]")).to_be_visible()
    await expect(shelf.locator("[data-dashboard-role]")).to_be_visible()
    await expect(rail).to_be_visible()
    assert await rail.evaluate("rail => rail.previousElementSibling?.classList.contains('cmpri-header-shelf')")

    bounds = await shelf.evaluate("""shelf => {
      const rect = selector => shelf.querySelector(selector)?.getBoundingClientRect().toJSON();
      return {
        shelf: shelf.getBoundingClientRect().toJSON(),
        title: rect('[data-cmpri-menu-title]'),
        name: rect('[data-dashboard-name]'),
        role: rect('[data-dashboard-role]'),
        pool: rect('.cmpri-header-status-pill'),
        create: rect('.cmpri-header-create'),
        rail: shelf.nextElementSibling.getBoundingClientRect().toJSON(),
      };
    }""")
    first_tab = await rail.locator("legend").first.bounding_box()
    assert first_tab and 0 <= first_tab["x"] - bounds["rail"]["left"] <= 20, first_tab
    assert abs(bounds["rail"]["left"] - bounds["shelf"]["left"]) <= 1, bounds
    assert abs(bounds["rail"]["right"] - bounds["shelf"]["right"]) <= 1, bounds
    assert bounds["rail"]["top"] >= bounds["shelf"]["bottom"] - 1, bounds
    assert bounds["name"]["top"] >= bounds["title"]["bottom"] - 1, bounds
    assert bounds["role"]["top"] >= bounds["name"]["bottom"] - 1, bounds
    assert bounds["rail"]["top"] >= max(bounds["role"]["bottom"], bounds["pool"]["bottom"]) - 1, bounds
    assert bounds["pool"]["left"] > bounds["role"]["left"], bounds
    if bounds["create"]:
        assert bounds["create"]["top"] >= bounds["pool"]["bottom"] - 1, bounds
        assert bounds["rail"]["top"] >= bounds["create"]["bottom"] - 1, bounds
        pool_center = (bounds["pool"]["left"] + bounds["pool"]["right"]) / 2
        create_center = (bounds["create"]["left"] + bounds["create"]["right"]) / 2
        assert abs(pool_center - create_center) <= 1, bounds


async def check_menu_overlay(page, touch):
    rail = page.locator(".cmpri-dashboard-menu-rail")
    tab = rail.get_by_role("button", name="Safety & Logs", exact=True)
    snapshot = """tab => {
      const rail = tab.closest('.cmpri-dashboard-menu-rail');
      const header = rail.parentElement;
      const row = tab.closest('fieldset');
      const rect = node => node.getBoundingClientRect().toJSON();
      const headerStyle = getComputedStyle(header);
      const closestRow = (x, y) => document.elementFromPoint(x, y)?.closest('fieldset.group');
      const bounds = {
        header: rect(header), rail: rect(rail), shelf: rect(header.firstElementChild),
        title: rect(header.querySelector('[data-cmpri-menu-title]')),
        content: rect(document.querySelector('.cmpri-desktop, [data-cmpri-technician-window-anchor]')),
        border: parseFloat(headerStyle.borderBottomWidth),
        color: headerStyle.borderBottomColor,
      };
      const rowRect = rect(row);
      const gapX = [bounds.rail.left + 1, bounds.rail.right - 1]
        .find(x => x < rowRect.left || x > rowRect.right);
      const rowY = rowRect.top + rowRect.height / 2;
      return {
        bounds, tab: rect(tab), row: rowRect,
        rowHit: closestRow(rowRect.left + rowRect.width / 2, rowY) === row,
        gapHit: gapX != null && Boolean(document.elementFromPoint(gapX, rowY)
          ?.closest('.cmpri-dashboard-menu-overlay')),
      };
    }"""
    before = await tab.evaluate(snapshot)
    bounds = before["bounds"]
    assert bounds["rail"]["height"] == 14
    assert bounds["border"] == 1 and bounds["color"] != "rgba(0, 0, 0, 0)", bounds
    assert abs(bounds["rail"]["bottom"] + bounds["border"] - bounds["header"]["bottom"]) <= 1, bounds
    assert abs(before["tab"]["bottom"] - bounds["header"]["bottom"]) <= 1, before

    toggle = tab.tap if touch else tab.click
    await toggle()
    await expect(tab).to_have_attribute("aria-expanded", "true")
    opened = await tab.evaluate(snapshot)
    assert opened["bounds"] == bounds, opened
    assert abs(opened["tab"]["bottom"] - bounds["header"]["bottom"]) <= 1, opened
    assert opened["row"]["top"] >= bounds["header"]["bottom"] - 0.5, opened
    assert opened["rowHit"] and not opened["gapHit"], opened

    await toggle()
    await expect(tab).to_have_attribute("aria-expanded", "false")
    assert (await tab.evaluate(snapshot))["bounds"] == bounds


async def inspect_role(browser, role, width):
    context = await browser.new_context(viewport={"width": width, "height": 850},
                                        has_touch=width < 640, is_mobile=width < 640,
                                        service_workers="block")
    if role not in LIMITED_ROLES:
        CAPS[role] = sorted(set([*CAPS[role], "view_locations", "view_pool_log", "operate_pool_log"]))
    layouts = {}
    await install(context, role, layouts=layouts, connected=False)
    page = await context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    path = "/front-desk" if role == "front_desk" else "/technician" if role == "technician" else "/engineering"
    await page.goto(BASE + path, wait_until="domcontentloaded")
    safety = group(page, "Safety & Logs").locator("legend")
    await expect(safety).to_be_visible(timeout=60000)
    await check_header_rail(page)
    await check_menu_overlay(page, width < 640)

    if role in LIMITED_ROLES:
        tabs = ["Rooms & Reports", "Safety & Logs", "Account"]
    else:
        tabs = [tab for tab in ROLE_TABS if tab != "Admin" or role not in {"manager", "technician"}]
    native_tabs = page.locator(".cmpri-header-v23 fieldset.group:not([data-ask-launcher-tab]) > legend")
    assert await native_tabs.all_text_contents() == tabs, role
    assert await native_tabs.and_(page.locator("[aria-expanded=true]")).count() == 0
    await expect(page.locator("[data-cmpri-ask-launcher=mobile]" if width < 640 else "#desktop-ask-query")).to_be_visible()

    rooms = await actions(page, "Rooms & Reports")
    pool = await actions(page, "Safety & Logs")
    if role in LIMITED_ROLES:
        assert rooms == ["Work Order List", "Room Ranker"]
        assert pool == ["Weather", "Notes", "Staff Notes"]
        assert await actions(page, "Account") == (["Manage Profile", "Sign Out"] if role == "housekeeping" else ["Sign Out"])
    else:
        assert {"GSS Reports", "Manage Locations"}.issubset(rooms)
        assert "Pool Log" in pool
        assert ("Weather" in pool) == (role not in {"assistant_manager", "front_desk_manager"})
    if role == "technician":
        assert (await actions(page, "Daily Work"))[:2] == ["Work Order List", "Technician Dashboard"]
        assert {"Daily Room Ops", "Enseo Assignments"}.issubset(rooms)
        assert "Winter Preparedness 2026" in pool
    if role in CHIEF_MENU_ROLES:
        assert "Hours Tracker" in await actions(page, "Account")

    title = page.locator("[data-cmpri-menu-title]")
    before = await title.bounding_box()
    await (safety.tap() if width < 640 else safety.click())
    await expect(safety).to_have_attribute("aria-expanded", "true")
    assert await title.bounding_box() == before
    await expect(group(page, "Safety & Logs").get_by_role("button", name="Weather" if "Weather" in pool else "Pool Log", exact=True)).to_be_visible()
    if role in LIMITED_ROLES:
        account = group(page, "Account").locator("legend")
        await (account.tap() if width < 640 else account.click())
        row = group(page, "Account")
        if role == "front_desk":
            button = await row.get_by_role("button", name="Sign Out").bounding_box()
            buttons = await row.locator(".buttons").bounding_box()
            assert abs(button["x"] + button["width"] / 2 - buttons["x"] - buttons["width"] / 2) < 1
        assert await title.bounding_box() == before
        await expect(safety).to_have_attribute("aria-expanded", "true")
        assert "blur(" in await group(page, "Safety & Logs").locator(".buttons").evaluate("element => getComputedStyle(element).filter")
    assert not errors, errors
    await context.close()
    print(f"{role} {width}px verified", flush=True)


async def drag_between(page, context, touch, origin, destination, edge_hold_ms=0):
    x, y = origin
    to_x, to_y = destination
    if touch:
        pointer = await context.new_cdp_session(page)
        await pointer.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1}],
        })
        await page.wait_for_timeout(370)
        for step in range(1, 13):
            await pointer.send("Input.dispatchTouchEvent", {
                "type": "touchMove",
                "touchPoints": [{"x": x + (to_x - x) * step / 12, "y": y + (to_y - y) * step / 12, "id": 1}],
            })
        if edge_hold_ms:
            await page.wait_for_timeout(edge_hold_ms)
        await pointer.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        await pointer.detach()
    else:
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(to_x, to_y, steps=14)
        if edge_hold_ms:
            await page.wait_for_timeout(edge_hold_ms)
        await page.mouse.up()


async def check_tab_endpoints(page, context, layouts, touch):
    daily = group(page, "Daily Work")
    tab = daily.locator("legend")
    menu = page.locator(".cmpri-dashboard-menu-rail .anchored-menu")
    identity = page.locator("[data-dashboard-role]")
    create = page.locator(".cmpri-header-utilities .cmpri-header-create")
    header_title = page.locator("[data-cmpri-menu-title]")
    title_position = await header_title.bounding_box()
    rail_position = await menu.bounding_box()
    original_tab_y = (await tab.bounding_box())["y"]

    for edge, under in (("right", create), ("left", identity)):
        await tab.scroll_into_view_if_needed()
        start = await tab.bounding_box()
        x, y = start["x"] + start["width"] / 2, start["y"] + start["height"] / 2
        target = rail_position["x"] + (rail_position["width"] - 5 if edge == "right" else 5)
        # A held pointer on the phone traverses the outer rail's overflow.
        await drag_between(page, context, touch, (x, y), (target, y), edge_hold_ms=850)

        positions = await daily.evaluate("""field => ({
          x: parseFloat(field.style.left),
          maximum: field.parentElement.clientWidth - field.tabWidth - 26,
        })""")
        expected = positions["maximum"] if edge == "right" else 0
        assert abs(positions["x"] - expected) <= 1, (edge, positions)
        end = await tab.bounding_box()
        referent = await under.bounding_box()
        assert abs(end["y"] - original_tab_y) <= 1, (edge, start, end)
        assert end["x"] < referent["x"] + referent["width"] and end["x"] + end["width"] > referent["x"], (edge, end, referent)
        assert await header_title.bounding_box() == title_position
        for _ in range(30):
            saved = layouts.get("chief_engineer", {}).get("positions", {}).get("Daily Work")
            if saved is not None and abs(saved - expected) <= 1:
                break
            await page.wait_for_timeout(50)
        else:
            raise AssertionError(f"Daily Work did not save its {edge} position: {positions}")

        await page.reload(wait_until="domcontentloaded")
        await expect(tab).to_be_visible(timeout=60000)
        assert abs(await daily.evaluate("field => parseFloat(field.style.left)") - expected) <= 1
        assert "Work Order List" in await actions(page, "Rooms & Reports")


async def check_drag_and_save(browser, width):
    touch = width < 640
    context = await browser.new_context(viewport={"width": width, "height": 850}, has_touch=touch,
                                        is_mobile=touch, service_workers="block")
    layouts = {}
    await install(context, "chief_engineer", layouts=layouts, connected=False)
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    daily = group(page, "Daily Work")
    label = daily.locator("legend")
    await expect(label).to_be_visible(timeout=60000)
    await (label.tap() if touch else label.click())
    title = page.locator("[data-cmpri-menu-title]")
    pinned = await title.bounding_box()
    origin = await daily.get_by_role("button", name="Work Order List", exact=True).bounding_box()
    target = group(page, "Rooms & Reports").locator("legend")
    destination = await target.bounding_box()
    assert origin and destination
    x, y = origin["x"] + origin["width"] / 2, origin["y"] + origin["height"] / 2
    to_x, to_y = destination["x"] + destination["width"] / 2, destination["y"] + destination["height"] / 2
    await drag_between(page, context, touch, (x, y), (to_x, to_y))
    assert "Work Order List" not in await actions(page, "Daily Work")
    assert "Work Order List" in await actions(page, "Rooms & Reports")
    await expect(target).to_be_focused()
    await expect(target).to_have_attribute("aria-current", "true")
    assert await page.get_by_role("dialog").count() == 0
    assert await title.bounding_box() == pinned
    for _ in range(30):
        if "work-order-list::Work Order List" in layouts.get("chief_engineer", {}).get("buttons", {}).get("Rooms & Reports", []):
            break
        await page.wait_for_timeout(50)
    else:
        raise AssertionError("Moved launcher was not saved to the authenticated layout.")
    await page.reload(wait_until="domcontentloaded")
    await expect(target).to_be_visible(timeout=60000)
    assert "Work Order List" in await actions(page, "Rooms & Reports")
    await check_tab_endpoints(page, context, layouts, touch)
    await context.close()
    print(f"cross-tab drag, rail endpoints and reload at {width}px verified", flush=True)


async def check_wake_and_scroll(browser, width):
    touch = width < 640
    context = await browser.new_context(viewport={"width": width, "height": 850}, has_touch=touch,
                                        is_mobile=touch, service_workers="block")
    await install(context, "chief_engineer", connected=False)
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    daily = group(page, "Daily Work")
    rooms = group(page, "Rooms & Reports")
    daily_tab, rooms_tab = daily.locator("legend"), rooms.locator("legend")
    await expect(daily_tab).to_be_visible(timeout=60000)
    await (daily_tab.tap() if touch else daily_tab.click())
    await expect(daily_tab).to_have_attribute("aria-expanded", "true")
    await (rooms_tab.tap() if touch else rooms_tab.click())
    await expect(rooms).to_have_attribute("data-active", "true")
    assert await daily.locator(".buttons").evaluate("node => getComputedStyle(node).filter") != "none"
    work = daily.get_by_role("button", name="Work Order List", exact=True)
    await (work.tap() if touch else work.click())
    await expect(daily).to_have_attribute("data-active", "true")
    assert await page.locator('[data-cmpri-desktop-window="work-order-list"]').count() == 0
    assert int(await daily.evaluate("node => node.style.zIndex")) > int(await rooms.evaluate("node => node.style.zIndex"))

    await (rooms_tab.tap() if touch else rooms_tab.click())
    row = rooms.locator(".buttons")
    if not touch:
        edge = rooms.locator(".resize-edge")
        bounds = await edge.bounding_box()
        x, y = bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2
        # Ask floats above the expanded button row. Move it aside when its
        # pill is directly covering the existing row-resize handle.
        if await page.evaluate("([x,y]) => Boolean(document.elementFromPoint(x,y)?.closest('#desktop-ask-search'))", [x, y]):
            ask = await page.locator("#desktop-ask-tab").bounding_box()
            center = (ask["x"] + ask["width"] / 2, ask["y"] + ask["height"] / 2)
            await drag_between(page, context, False, center, (width - 5, center[1]))
        await drag_between(page, context, False, (x, y), (x - 350, y))
    scrollbar = rooms.get_by_role("slider", name="Scroll Rooms & Reports buttons")
    await expect(scrollbar).to_be_visible()
    if touch:
        bounds = await row.bounding_box()
        y, right = bounds["y"] + bounds["height"] / 2, min(width - 5, bounds["x"] + bounds["width"] - 8)
        pointer = await context.new_cdp_session(page)
        await pointer.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": right, "y": y, "id": 1}],
        })
        await pointer.send("Input.dispatchTouchEvent", {
            "type": "touchMove", "touchPoints": [{"x": bounds["x"] + 10, "y": y, "id": 1}],
        })
        await pointer.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        await pointer.detach()
        assert await row.evaluate("node => node.scrollLeft") > 0
    await scrollbar.press("End")
    last = rooms.get_by_role("button", name="Enseo Assignments", exact=True)
    reachability = await last.evaluate("""node => {
        const box = node.getBoundingClientRect();
        const row = node.parentElement.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return {
          last: box.toJSON(), row: row.toJSON(),
          scroll: node.parentElement.scrollLeft, hit: hit?.className,
          reachable: box.right <= row.right + 1 && hit?.closest('button') === node,
        };
    }""")
    assert reachability["reachable"], reachability
    await context.close()
    print(f"blurred row wake and last button reachable at {width}px verified", flush=True)


async def check_resize_and_retry(browser):
    context = await browser.new_context(viewport={"width": 1440, "height": 850}, service_workers="block")
    layouts = {}
    await install(context, "chief_engineer", layouts=layouts, connected=False)
    failures = []

    async def intercept(route):
        if route.request.method != "PUT":
            return await route.fallback()
        failures.append(route.request.post_data_json["layout"])
        await route.fulfill(status=503)

    await context.route("**/api/profile/header-layout", intercept)
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    daily = group(page, "Daily Work")
    tab = daily.locator("legend")
    await expect(tab).to_be_visible(timeout=60000)
    tab_edge = daily.locator(".tab-resize-edge")
    await expect(tab_edge).to_be_visible()
    before, edge = await daily.evaluate("""field => [
      field.querySelector('legend').getBoundingClientRect().toJSON(),
      field.querySelector('.tab-resize-edge').getBoundingClientRect().toJSON(),
    ]""")
    x, y = edge["x"] + edge["width"] / 2, edge["y"] + edge["height"] / 2
    await drag_between(page, context, False, (x, y), (x + 35, y))
    resized = (await tab.bounding_box())["width"]
    assert resized > before["width"] + 20
    await expect(tab).to_have_attribute("aria-expanded", "false")
    await expect(page.get_by_text("Layout sync failed.", exact=False)).to_be_visible()
    assert failures[-1]["tabWidths"]["Daily Work"] == resized
    await page.reload(wait_until="domcontentloaded")
    await expect(tab).to_be_visible(timeout=60000)
    assert (await tab.bounding_box())["width"] == resized
    await expect(page.get_by_text("Layout sync failed.", exact=False)).to_be_visible()
    await context.unroute("**/api/profile/header-layout", intercept)
    await page.reload(wait_until="domcontentloaded")
    await expect(tab).to_be_visible(timeout=60000)
    for _ in range(30):
        if layouts.get("chief_engineer", {}).get("tabWidths", {}).get("Daily Work") == resized:
            break
        await page.wait_for_timeout(50)
    else:
        raise AssertionError("Resized tab never synchronized after the failed save.")
    await context.close()
    print("closed tab resizing and rejected save retry verified", flush=True)


async def check_housekeeping_profile(browser):
    context = await browser.new_context(viewport={"width": 390, "height": 850}, has_touch=True,
                                        is_mobile=True, service_workers="block")
    await install(context, "housekeeping", connected=False)
    saved = []

    async def profile(route):
        body = route.request.post_data_json if route.request.method == "PATCH" else {}
        if body:
            saved.append(body)
        await route.fulfill(json={
            "profile": {"id": UID, "role": "housekeeping", "full_name": body.get("full_name", "Alex Morgan")},
            "preferences": {"appearance": "dark", "language": "en"},
        })

    await context.route("**/api/profile", profile)
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    account = group(page, "Account")
    await expect(account.locator("legend")).to_be_visible(timeout=60000)
    await account.locator("legend").tap()
    await account.get_by_role("button", name="Manage Profile", exact=True).tap()
    frame = page.frame_locator('[data-cmpri-desktop-window="/profile"] iframe')
    await expect(frame.get_by_label("Display name")).to_be_visible(timeout=60000)
    await frame.get_by_label("Display name").fill("Alex Housekeeping")
    await frame.get_by_role("button", name="Save Profile").click()
    await expect(frame.get_by_text("Profile and preferences saved.", exact=True)).to_be_visible()
    assert saved[-1]["full_name"] == "Alex Housekeeping"
    await context.close()
    print("Housekeeping profile launcher and own-account save verified", flush=True)


async def check_mobile_window_clearance(browser):
    context = await browser.new_context(viewport={"width": 390, "height": 850}, has_touch=True,
                                        is_mobile=True, service_workers="block")
    await install(context, "chief_engineer")
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    create = page.locator(".cmpri-header-create")
    await expect(create).to_be_visible(timeout=60000)
    await create.tap()
    window = page.locator('[data-cmpri-desktop-window="/work-orders"]')
    await expect(window).to_be_visible()
    before = await window.bounding_box()
    safety = group(page, "Safety & Logs").locator("legend")
    await safety.tap()
    await expect(safety).to_have_attribute("aria-expanded", "true")
    assert await window.bounding_box() == before
    await window.locator("[data-cmpri-window-close]").tap()
    await expect(window).to_have_count(0)
    await context.close()
    print("mobile window close remains reachable when a tab is open", flush=True)


async def check_telescope_to_moved_launcher(browser):
    context = await browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
    await install(context, "chief_engineer", connected=False)
    await context.add_init_script("""{
      window.telescopeEndpoints = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (options?.id?.startsWith('cmpri-window-telescope-')) {
          const box = this.getBoundingClientRect();
          const opening = options.id.endsWith('-open');
          const transform = new DOMMatrix(frames[opening ? 0 : frames.length - 1].transform);
          window.telescopeEndpoints.push({
            direction: opening ? 'open' : 'close',
            x: box.left + box.width / 2 + transform.e,
            y: box.top + box.height / 2 + transform.f,
            width: box.width * transform.a, height: box.height * transform.d,
          });
        }
        return animate.call(this, frames, options);
      };
    }""")
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    daily = group(page, "Daily Work")
    await daily.locator("legend").click()
    opener = page.locator('button[data-key="work-order-list"]')
    panel = page.locator('[data-cmpri-desktop-window="work-order-list"]')

    async def assert_endpoint(direction, target):
        endpoint = await page.wait_for_function(
            "direction => window.telescopeEndpoints.find(item => item.direction === direction)", arg=direction
        )
        recorded = await endpoint.json_value()
        assert abs(recorded["x"] - target["x"] - target["width"] / 2) < 1, (recorded, target)
        assert abs(recorded["y"] - target["y"] - target["height"] / 2) < 1, (recorded, target)
        assert abs(recorded["width"] - target["width"]) < 1, (recorded, target)
        assert abs(recorded["height"] - target["height"]) < 1, (recorded, target)

    original = await opener.bounding_box()
    await opener.click()
    await expect(panel).to_be_visible()
    await expect(daily.locator("legend")).to_have_attribute("aria-current", "true")
    await assert_endpoint("open", original)
    destination = group(page, "Rooms & Reports").locator("legend")
    drop = await destination.bounding_box()
    await drag_between(page, context, False,
                       (original["x"] + original["width"] / 2, original["y"] + original["height"] / 2),
                       (drop["x"] + drop["width"] / 2, drop["y"] + drop["height"] / 2))
    await expect(destination).to_be_focused()
    moved = await opener.bounding_box()
    assert abs(moved["x"] - original["x"]) > 10
    await panel.locator("[data-cmpri-window-close]").click()
    await assert_endpoint("close", moved)
    await expect(panel).to_have_count(0)
    await context.close()
    print("windows telescope to the exact same launcher after a cross-tab move", flush=True)


async def main():
    CAPS["engineer"] = CAPS["chief_engineer"].copy()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for role in CAPS:
            await inspect_role(browser, role, 1440)
        for role in ("front_desk", "housekeeping", "front_desk_manager", "technician"):
            await inspect_role(browser, role, 390)
        await inspect_role(browser, "technician", 320)
        for width in (1440, 390):
            await check_drag_and_save(browser, width)
            await check_wake_and_scroll(browser, width)
        await check_resize_and_retry(browser)
        await check_housekeeping_profile(browser)
        await check_mobile_window_clearance(browser)
        await check_telescope_to_moved_launcher(browser)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
