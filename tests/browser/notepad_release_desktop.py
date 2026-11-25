"""Verify desktop placement, Ask access and profile time format against local fixtures."""
import asyncio
import os
import re

from cmpri_fixture import BASE, CAPS, HOTEL, OUT, UID, async_playwright, expect, install


async def verify(browser, role, email="fixture@example.invalid", user_id=UID, secondary_roles=()):
    context = await browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
    await install(context, role, user_id=user_id)
    is_chief = role == "chief_engineer" or bool(secondary_roles)
    profile = {
        "id": user_id, "full_name": "Fixture Account", "name": "Fixture Account",
        "email": email, "role": role, "secondary_roles": list(secondary_roles),
    }
    preferences = {
        "language": "en", "appearance": "dark", "notification_mode": "both",
        "notifications": {"new_work_orders": True, "status_changes": True, "mentions": True},
    }
    writes = []
    days = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

    async def session(route):
        await route.fulfill(json={
            "user": profile, "hotelId": HOTEL, "landing": "/engineering", "capabilities": CAPS[role],
        })

    async def profile_request(route):
        if route.request.method == "PATCH":
            body = route.request.post_data_json
            writes.append(body)
            preferences.update(body["preferences"])
        await route.fulfill(json={
            "profile": profile, "preferences": preferences, "profile_settings_available": True,
            "can_manage_users": role == "system_admin", "chatgpt_connection": None,
        })

    async def schedule_request(route):
        assert route.request.method == "GET", "changing the display preference must not save the schedule"
        await route.fulfill(json={
            "configured": True, "public_key": "", "subscribed_on_this_device": False,
            "settings": {"timezone": "America/Chicago", "schedule": {
                day: {"enabled": day == "monday", "start": "17:07", "end": "23:45"} for day in days
            }},
        })

    await context.route("**/api/session", session)
    await context.route("**/api/profile", profile_request)
    await context.route("**/api/profile/phone-notifications", schedule_request)
    await context.route("**/api/weather-preview?part=dashboard", lambda route: route.fulfill(json={
        "dashboard": {"current": 46, "high": 59, "low": 38, "precipitation": 10, "wind": 13,
                      "bearing": 300, "condition": "Cloudy", "icon": None, "isDaytime": True},
    }))
    page = await context.new_page()
    try:
        await page.goto(BASE + "/engineering", wait_until="domcontentloaded", timeout=90000)
        launcher = page.locator(".cmpri-guide-launcher")
        weather = page.locator("[data-cmpri-weather-dial]")
        control = page.locator(".cmpri-guide-launchers > .cmpri-animation-control")
        await expect(launcher).to_be_visible(timeout=60000)
        close_guide = page.get_by_role("button", name="Close Beginner’s Guide")
        if await close_guide.is_visible():
            await close_guide.click()
            await expect(page.locator("[data-cmpri-guide-dialog]")).to_have_count(0)
        await expect(page.locator("[data-desktop-ask-tab]")).to_have_count(int(is_chief))
        if secondary_roles:
            await expect(page.locator("[data-dashboard-role]")).to_have_text("Chief Engineer")
        if role == "chief_engineer":
            artwork_toggle = page.frame_locator('iframe[title^="Thanksgiving"]').locator("#toggle")
            await artwork_toggle.wait_for(state="attached")
            await expect(artwork_toggle).to_be_hidden()
            await page.add_style_tag(content="nextjs-portal { display: none !important }")
            for width, height in [(1440, 900), (1120, 608), (701, 580), (390, 844)]:
                await page.set_viewport_size({"width": width, "height": height})
                await expect(weather).to_be_visible()
                await expect(control).to_be_visible()
                dial, guide, toggle = await weather.bounding_box(), await launcher.bounding_box(), await control.bounding_box()
                assert abs(dial["x"] + dial["width"] - width) < 1 and abs(dial["y"] + dial["height"] - height) < 1, dial
                assert 0 <= toggle["x"] - guide["x"] - guide["width"] <= 8, (guide, toggle)
                assert abs((toggle["y"] + toggle["height"] / 2) - (guide["y"] + guide["height"] / 2)) < 1, (guide, toggle)
                await page.screenshot(path=str(OUT / f"release-desktop-{width}.png"))
            await control.click()
            await expect(control).to_have_attribute("aria-pressed", "true")
            await control.click()
            await expect(control).to_have_attribute("aria-pressed", "false")
        await page.evaluate("dispatchEvent(new CustomEvent('cmpri-ask-open', {detail: {tab: 'search'}}))")
        if is_chief:
            await expect(page.locator("#ask-cmpri[open]")).to_be_visible()
        else:
            await page.evaluate("dispatchEvent(new CustomEvent('cmpri-ask-open', {detail: {practice: true}}))")
            await page.wait_for_timeout(500)
            await expect(page.locator("#ask-cmpri[open]")).to_have_count(0)

        print(f"PASS {role} Chief-equivalent={is_chief}: dashboard controls and Ask entry", flush=True)
        await page.close()
        page = await context.new_page()
        await page.set_viewport_size({"width": 1120, "height": 760})
        await page.goto(BASE + "/profile", wait_until="commit", timeout=60000)
        combo = page.get_by_role("combobox", name="Time Format", exact=True)
        current = "24h" if is_chief else "12h"
        replacement = "12h" if is_chief else "24h"
        await expect(combo).to_have_value(current, timeout=60000)
        preferences_section = page.get_by_role("heading", name="Personal Preferences").locator("xpath=..")
        names = await preferences_section.get_by_role("combobox").evaluate_all("(fields) => fields.slice(0, 3).map(field => field.labels[0].firstChild.textContent.trim())")
        assert names == ["Language", "Time Format", "Appearance"], names
        language = await page.get_by_role("combobox", name="Language", exact=True).bounding_box()
        clock = await combo.bounding_box()
        appearance = await page.get_by_role("combobox", name="Appearance", exact=True).bounding_box()
        assert language["x"] < clock["x"] < appearance["x"] and clock["width"] < min(language["width"], appearance["width"])
        first_start = page.get_by_role("combobox", name="Start", exact=True).first
        first_end = page.get_by_role("combobox", name="End", exact=True).first
        if is_chief:
            await expect(first_start.locator("option:checked")).to_have_text("17:07 (current)", timeout=60000)
            await expect(first_end.locator("option:checked")).to_have_text("23:45")
        if role == "chief_engineer":
            await preferences_section.screenshot(path=str(OUT / "release-personal-preferences.png"))
        await combo.select_option(replacement)
        if is_chief:
            await expect(first_start.locator("option:checked")).to_have_text(re.compile(r"5:07\s+PM \(current\)"))
            await expect(first_end.locator("option:checked")).to_have_text(re.compile(r"11:45\s+PM"))
            await expect(first_start).to_have_value("17:07")
            await expect(first_end).to_have_value("23:45")
            assert writes == [], "the schedule labels should preview the draft before saving"
        await page.get_by_role("button", name="Save Profile", exact=True).click()
        await expect(page.get_by_text("Profile and preferences saved.", exact=True)).to_be_visible(timeout=60000)
        assert len(writes) == 1 and writes[0]["preferences"]["time_format"] == replacement, writes
        await page.reload(wait_until="commit", timeout=60000)
        await expect(combo).to_have_value(replacement, timeout=60000)
        print(f"PASS {role} Chief-equivalent={is_chief}: Ask access, layout and {current} → {replacement} preference", flush=True)
    finally:
        await context.close()


async def main():
    async with async_playwright() as playwright:
        executable = os.environ.get("CMPRI_CHROMIUM")
        browser = await playwright.chromium.launch(executable_path=executable, args=["--no-sandbox"])
        try:
            await verify(browser, "chief_engineer")
            await verify(browser, "system_admin")
            await verify(browser, "system_admin", "maint.cmpri@hawkeyehotels.com",
                         "750f77bf-7d5d-4ca6-8421-e025edea87ba", ("engineer",))
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
