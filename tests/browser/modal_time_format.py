"""Verify an account time change reaches a separate, already-open modal."""
import asyncio
import os
import re

from playwright.async_api import async_playwright, expect

from cmpri_fixture import BASE, CAPS, HOTEL, UID, install
from notepad_giphy import NOTE, note


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"))
        context = await browser.new_context(viewport={"width": 1440, "height": 900},
                                            reduced_motion="reduce", service_workers="block")
        await install(context, "chief_engineer")
        await context.route_web_socket("wss://**", lambda socket: socket.close())
        profile = {"id": UID, "full_name": "Avery Fixture", "name": "Avery Fixture",
                   "role": "chief_engineer", "secondary_roles": [], "email": "fixture@example.invalid"}
        preferences = {"language": "en", "appearance": "dark", "time_format": "12h",
                       "notification_mode": "both", "notifications": {}}
        schedule = {day: {"enabled": True, "start": "17:07", "end": "23:45"} for day in
                    ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")}
        saved = []
        note_fixture = note(NOTE, "Time display fixture")
        note_fixture.update(createdAt="2026-11-25T04:38:00Z", updatedAt="2026-11-25T04:38:00Z")

        async def profile_request(route):
            if route.request.method == "PATCH":
                change = route.request.post_data_json["preferences"]
                preferences.update(change)
                saved.append(change["time_format"])
            await route.fulfill(json={"profile": profile, "preferences": preferences,
                                      "profile_settings_available": True, "chatgpt_connection": None})

        await context.route("**/api/profile", profile_request)
        await context.route("**/api/session", lambda route: route.fulfill(json={
            "user": profile, "hotelId": HOTEL, "landing": "/engineering", "capabilities": CAPS["chief_engineer"],
        }))
        await context.route("**/api/profile/phone-notifications", lambda route: route.fulfill(json={
            "configured": True, "public_key": "", "subscribed_on_this_device": False,
            "settings": {"timezone": "America/Chicago", "schedule": schedule},
        }))
        # Freeze this bootstrap response at the original format to prove that
        # the open editor receives the account event without reloading its note.
        await context.route("**/api/notepad", lambda route: route.fulfill(json={
            "hotelId": HOTEL, "userId": UID, "roles": [], "people": [],
            "notes": [note_fixture], "order": [NOTE], "legacyAliases": {}, "timeFormat": "12h",
        }))
        page = await context.new_page()
        await page.goto(f"{BASE}/engineering", wait_until="domcontentloaded", timeout=120_000)
        await expect(page.locator("html")).to_have_attribute("data-cmpri-time-format", "12h", timeout=60_000)
        await expect(page.get_by_role("button", name="Beginner’s Guide", exact=True)).to_be_visible(timeout=60_000)
        await expect(page.locator("[data-cmpri-guide-dialog]")).to_have_count(0)

        async def open_modal(path, title):
            await page.evaluate("""([href, title]) => {
                window.dispatchEvent(new CustomEvent('cmpri-open-modal', {detail: {href, title}}));
            }""", [path, title])

        await open_modal(f"/notepad?note={NOTE}", "Notepad")
        note_page = page.frame_locator('iframe[src*="/notepad?"]')
        editor = note_page.frame_locator('iframe[title="Notepad"]')
        timestamp = editor.locator(".sidebar-creation")
        await expect(timestamp).to_have_text("24 Nov 10:38 PM", timeout=60_000)
        await open_modal("/profile", "Manage Profile")
        account = page.frame_locator('iframe[src*="/profile"]')
        selection = account.get_by_role("combobox", name="Time Format", exact=True)
        start = account.get_by_role("combobox", name="Start", exact=True).first
        await expect(selection).to_have_value("12h", timeout=60_000)
        await expect(start).to_have_value("17:07")
        await expect(start.locator("option:checked")).to_have_text(re.compile(r"5:07\s*PM"))

        await selection.select_option("24h")
        await expect(start).to_have_value("17:07")
        await expect(start.locator("option:checked")).to_have_text(re.compile(r"^17:07"))
        await expect(timestamp).to_have_text("24 Nov 10:38 PM")
        assert saved == []
        await account.get_by_role("button", name="Save Profile", exact=True).click()
        await expect(account.get_by_text("Profile and preferences saved.", exact=True)).to_be_visible(timeout=60_000)
        await expect(timestamp).to_have_text("24 Nov 22:38", timeout=60_000)
        await expect(page.locator("html")).to_have_attribute("data-cmpri-time-format", "24h")
        assert saved == ["24h"]
        print("Profile schedule preview updates before save and the already-open Notepad updates after save.")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
