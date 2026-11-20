import asyncio

from cmpri_fixture import BASE, CAPS, async_playwright, expect, install


ROLE_TABS = ["Daily Work", "Rooms & Reports", "Safety & Logs", "Assets & Inventory", "Account", "Admin"]
LIMITED_ROLES = {"front_desk", "housekeeping"}
CHIEF_MENU_ROLES = {"chief_engineer", "system_admin", "engineer", "senior_management"}


def group(page, name):
    return page.locator("fieldset.group").filter(has=page.get_by_role("button", name=name, exact=True))


async def actions(page, name):
    return await group(page, name).locator(".action").all_text_contents()


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
        await pointer.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    else:
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(to_x, to_y, steps=14)
        await page.mouse.up()
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
    await context.close()
    print(f"cross-tab drag and reload at {width}px verified", flush=True)


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
