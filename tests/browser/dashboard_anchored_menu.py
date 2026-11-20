import asyncio

from cmpri_fixture import BASE, CAPS, async_playwright, expect, install


ROLE_TABS = ["Daily Work", "Rooms & Reports", "Safety & Logs", "Assets & Inventory", "Account", "Admin"]
LIMITED_ROLES = {"front_desk", "housekeeping"}
CHIEF_MENU_ROLES = {"chief_engineer", "system_admin", "engineer", "senior_management"}


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

    if role in LIMITED_ROLES:
        tabs = ["Rooms & Reports", "Safety & Logs", "Account"]
    else:
        tabs = [tab for tab in ROLE_TABS if tab != "Admin" or role not in {"manager", "technician"}]
    assert await page.locator(".cmpri-header-v23 legend").all_text_contents() == tabs, role
    assert await page.locator(".cmpri-header-v23 legend[aria-expanded=true]").count() == 0

    rooms = await actions(page, "Rooms & Reports")
    pool = await actions(page, "Safety & Logs")
    if role in LIMITED_ROLES:
        assert rooms == ["Work Order List", "Room Ranker"]
        assert pool == ["Weather", "Notes", "Staff Notes"]
        assert await actions(page, "Account") == ["Sign Out"]
    else:
        assert {"GSS Reports", "Manage Locations"}.issubset(rooms)
        assert {"Pool Log", "Weather"}.issubset(pool)
    if role == "technician":
        assert {"Daily Room Ops", "Enseo Assignments"}.issubset(rooms)
        assert "Winter Preparedness 2026" in pool
    if role in CHIEF_MENU_ROLES:
        assert "Hours Tracker" in await actions(page, "Account")

    title = page.locator("[data-cmpri-menu-title]")
    before = await title.bounding_box()
    await (safety.tap() if width < 640 else safety.click())
    await expect(safety).to_have_attribute("aria-expanded", "true")
    assert await title.bounding_box() == before
    await expect(group(page, "Safety & Logs").get_by_role("button", name="Weather", exact=True)).to_be_visible()
    if role in LIMITED_ROLES:
        account = group(page, "Account").locator("legend")
        await (account.tap() if width < 640 else account.click())
        row = group(page, "Account")
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
          maximum: field.parentElement.clientWidth - field.minimumWidth,
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
    await install(context, "chief_engineer", layouts=layouts)
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


async def main():
    CAPS["engineer"] = CAPS["chief_engineer"].copy()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for role in CAPS:
            await inspect_role(browser, role, 1440)
        for role in ("front_desk", "housekeeping", "front_desk_manager", "technician"):
            await inspect_role(browser, role, 390)
        for width in (1440, 390):
            await check_drag_and_save(browser, width)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
