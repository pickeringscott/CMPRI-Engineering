"""Pool close/save and browser-restart acceptance; synthetic APIs only."""
import asyncio
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect
import cmpri_fixture

BASE = os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3050")
assert urlparse(BASE).hostname in ["127.0.0.1", "localhost"]
OUT = Path(os.environ.get("CMPRI_UI_OUTPUT", "/tmp/cmpri-pool-close-save"))
OUT.mkdir(parents=True, exist_ok=True)
FACILITY = {"id": "00000000-0000-4000-8000-000000000050", "pool_name": "Fixture Pool", "facility_name": "Fixture Pool", "sanitizer": "Bromine"}


async def check(playwright, width):
    print(json.dumps({"width": width, "step": "start"}), flush=True)
    profile = tempfile.mkdtemp(prefix=f"cmpri-pool-{width}-")
    state = {"row": None, "posts": [], "fail_next": False, "gate": None, "error": [], "hotel": cmpri_fixture.HOTEL, "pool_version": 1, "gets": 0}

    async def start():
        context = await playwright.chromium.launch_persistent_context(profile, executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"], viewport={"width": width, "height": 1000 if width > 500 else 844}, service_workers="block")
        await cmpri_fixture.install(context, "chief_engineer", hotel_id=state["hotel"], revisions={key: state["pool_version"] if key == "pool" else 1 for key in ["orders", "inbox", "pool", "rooms", "feedback", "session", "reference"]})

        async def pool_route(route):
            request = route.request
            if request.method == "POST":
                body = request.post_data_json
                state["posts"].append(body)
                if state["gate"]:
                    await state["gate"].wait()
                if state["fail_next"]:
                    state["fail_next"] = False
                    return await route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "Fixture save unavailable; readings retained."}))
                old = state["row"] or {}
                row = {**old, **body, "id": "fixture-log", "revision": old.get("revision", 0) + 1, "completed_by_initials": "AM", "updated_at": "2026-11-20T18:00:00Z", "updated_by": cmpri_fixture.UID, "manual_closure": False, "closure_condition": False}
                for period in ["am", "pm"]:
                    row[f"sample_location_{period}"] = None if row.get(f"ph_{period}") is None else body.get(f"sample_location_{period}") or (old.get(f"sample_location_{period}") if old.get(f"ph_{period}") is not None else "shared")
                row.pop("expected_revision", None)
                retest = body.get("retest")
                if retest:
                    row["retest_submission"] = retest
                state["row"] = row
                result = {"log": row, "closure_required": False, "closure_reasons": [], "warnings": []}
            else:
                state["gets"] += 1
                result = {"facility": FACILITY, "facilities": [FACILITY], "log": state["row"], "retests": [], "daily_entries": [], "can_edit": True, "can_edit_saved": False}
            await route.fulfill(content_type="application/json", body=json.dumps(result))

        await context.route("**/api/pool-log?*", pool_route)
        await context.route("**/api/pool-log", pool_route)
        page = context.pages[0] if context.pages else await context.new_page()
        page.on("pageerror", lambda error: state["error"].append(str(error)))
        await page.goto(BASE + "/engineering")
        await expect(page.get_by_role("button", name="Pool Log", exact=True)).to_be_visible(timeout=60000)
        await page.wait_for_function("Object.keys(localStorage).some(key => key.startsWith('cmpri:workspace:v1:'))")
        return context, page

    async def open_pool(page):
        frames = page.locator('iframe[src*="/engineering/pool-log"]')
        if not await frames.count():
            await page.get_by_role("button", name="Pool Log", exact=True).click()
        frame = page.frame_locator('iframe[src*="/engineering/pool-log"]').first
        try:
            await expect(frame.get_by_label("Notes / actions taken", exact=True)).to_be_visible(timeout=60000)
        except Exception:
            await page.screenshot(path=str(OUT / f"pool-open-failed-{width}.png"), full_page=True)
            print(json.dumps({"width": width, "step": "open-failed", "page_errors": state["error"], "frames": [item.url for item in page.frames]}), flush=True)
            raise
        return frame

    context, page = await start()
    frame = await open_pool(page)
    # Undoing every edit must not resurrect an abandoned draft on reopen.
    await frame.locator("#pool-ph_am").select_option("7.4")
    await frame.locator("#pool-ph_am").select_option("")
    await page.get_by_role("button", name="Close Pool Log", exact=True).click()
    await expect(page.locator('iframe[src*="/engineering/pool-log"]')).to_have_count(0)
    frame = await open_pool(page)
    await expect(frame.locator("#pool-ph_am")).to_have_value("")
    assert len(state["posts"]) == 0
    await frame.locator("#pool-ph_am").select_option("8.0")
    await frame.locator("#pool-sanitizer_band_am").select_option("0")
    await expect(frame.get_by_role("heading", name="⚠ The pool must be closed", exact=True)).to_have_count(0)
    await frame.locator("#pool-temperature_f").fill("84")
    await frame.locator("#pool-flow_rate_gpm").fill("60")
    await frame.locator("#pool-main_drain_visible").select_option("true")
    await expect(frame.get_by_role("heading", name="⚠ The pool must be closed", exact=True)).to_have_count(0)
    await frame.locator("#pool-filter_backwashed").select_option("false")
    await expect(frame.get_by_role("heading", name="⚠ The pool must be closed", exact=True)).to_be_visible()
    await page.screenshot(path=str(OUT / f"pool-warning-{width}.png"), full_page=True)
    await frame.locator("#pool-ph_am").select_option("7.4")
    await frame.locator("#pool-sanitizer_band_am").select_option("3-6")
    await expect(frame.get_by_role("heading", name="⚠ The pool must be closed", exact=True)).to_have_count(0)
    await frame.get_by_label("Notes / actions taken", exact=True).fill("Same test note")

    # Repeated close requests share one save and cannot dismiss pending work.
    state["gate"] = asyncio.Event()
    close = page.get_by_role("button", name="Close Pool Log", exact=True)
    await close.click()
    await page.wait_for_function("document.querySelector('iframe[src*=\"/engineering/pool-log\"]') !== null")
    await close.click()
    await expect(frame.get_by_role("button", name="Saving…", exact=True)).to_be_visible()
    assert len(state["posts"]) == 1, state["posts"]
    state["gate"].set()
    await expect(page.locator('iframe[src*="/engineering/pool-log"]')).to_have_count(0)
    state["gate"] = None
    print(json.dumps({"width": width, "step": "close-ack-passed"}), flush=True)

    frame = await open_pool(page)
    await expect(frame.get_by_label("Notes / actions taken", exact=True)).to_have_value("")
    await frame.get_by_role("button", name="Record another test", exact=True).click()
    await frame.locator("#pool-retest_ph").select_option("7.4")
    await frame.locator("#pool-retest_band").select_option("3-6")
    await frame.get_by_label("Notes / actions taken", exact=True).fill("Same test note")
    await frame.get_by_role("button", name="Save Pool Log", exact=True).click()
    await expect(frame.get_by_label("Notes / actions taken", exact=True)).to_have_value("")
    assert state["row"]["remarks"] == "Same test note\nSame test note", state["row"]

    await frame.get_by_role("button", name="Record another test", exact=True).click()
    await frame.locator("#pool-retest_ph").select_option("7.6")
    await frame.locator("#pool-retest_band").select_option("3-6")
    await frame.get_by_label("Notes / actions taken", exact=True).fill("Keep this failed save")
    state["fail_next"] = True
    await page.get_by_role("button", name="Close Pool Log", exact=True).click()
    await expect(frame.get_by_text("Fixture save unavailable; readings retained.", exact=True)).to_be_visible()
    await expect(frame.get_by_label("Notes / actions taken", exact=True)).to_have_value("Keep this failed save")
    failed = state["posts"][-1]
    await page.get_by_role("button", name="Close Pool Log", exact=True).click()
    await expect(page.locator('iframe[src*="/engineering/pool-log"]')).to_have_count(0)
    assert state["posts"][-1] == failed, "Close retry must retain the same test operation and notes"
    print(json.dumps({"width": width, "step": "notes-and-retry-passed"}), flush=True)

    frame = await open_pool(page)
    await frame.locator("#pool-ph_pm").select_option("7.6")
    await frame.get_by_label("Notes / actions taken", exact=True).fill("Retain these in-progress readings after browser close")
    await page.screenshot(path=str(OUT / f"pool-draft-{width}.png"), full_page=True)
    post_count = len(state["posts"])
    gets_before_restart = state["gets"]
    await context.close()
    context, page = await start()
    frame = await open_pool(page)
    await expect(frame.locator("#pool-ph_pm")).to_have_value("7.6")
    await expect(frame.get_by_label("Notes / actions taken", exact=True)).to_have_value("Retain these in-progress readings after browser close")
    assert state["gets"] > gets_before_restart, "Retained edits require an authoritative saved-record revision"
    assert len(state["posts"]) == post_count, "Browser shutdown/reopen must not submit an incomplete test"
    await page.screenshot(path=str(OUT / f"pool-reopened-{width}.png"), full_page=True)
    print(json.dumps({"width": width, "step": "restart-passed"}), flush=True)

    # A changed server record must retain, but never silently apply, stale work.
    await context.close()
    state["row"] = {**state["row"], "revision": state["row"]["revision"] + 1, "ph_pm": 7.8, "sanitizer_band_pm": "3-6"}
    state["pool_version"] += 1
    context, page = await start()
    frame = await open_pool(page)
    await expect(frame.get_by_text("Saved readings changed while these entries were pending.", exact=False)).to_be_visible()
    await expect(frame.locator("#pool-ph_pm")).to_have_value("7.8")
    await frame.get_by_text("Review Retained Entries", exact=True).click()
    await expect(frame.get_by_text("Retain these in-progress readings after browser close", exact=True)).to_be_visible()
    assert len(state["posts"]) == post_count
    await context.close()
    # Even with the same account, date and facility, a new verified property
    # cannot hydrate the previous property's retained readings or selection.
    state["hotel"] = "00000000-0000-4000-8000-000000000099"
    context, page = await start()
    frame = await open_pool(page)
    await expect(frame.get_by_label("Notes / actions taken", exact=True)).to_have_value("")
    await expect(frame.get_by_text("Review Retained Entries", exact=True)).to_have_count(0)
    assert await page.evaluate("hotel => Object.entries(localStorage).some(([key,value]) => key.startsWith('cmpri:pool-log-draft:v1:' + hotel + ':') && value.includes('Retain these in-progress readings'))", cmpri_fixture.HOTEL)
    assert not state["error"], state["error"]
    await context.close()
    return {"width": width, "complete_warning_only": True, "close_waits_for_one_ack": True, "failure_keeps_open": True, "per_test_notes_clear": True, "browser_restart_draft": True, "stale_draft_retained": True, "property_switch_isolated": True, "undone_draft_does_not_return": True, "fixture_posts": len(state["posts"]), "real_database_requests": 0}


async def check_cleared_sample(playwright, width):
    profile = tempfile.mkdtemp(prefix=f"cmpri-pool-clear-{width}-")
    state = {"posts": [], "errors": [], "gets": 0, "row": {"id": "fixture-clear-log", "revision": 5, "log_date": "2026-11-20", "pool_facility_id": FACILITY["id"], "ph_am": 7.4, "ph_pm": 7.6, "sanitizer_am": None, "sanitizer_pm": None, "sanitizer_band_am": "3-6", "sanitizer_band_pm": "3-6", "sample_location_am": "shared", "sample_location_pm": "shared", "temperature_f": 84, "flow_rate_gpm": 60, "main_drain_visible": True, "filter_backwashed": False, "requires_attention": False, "manual_closure": False, "closure_condition": False, "closure_reason": None, "remarks": "Earlier AM and PM tests", "completed_by_initials": "AM", "updated_by": cmpri_fixture.UID, "updated_at": "2026-11-20T18:00:00Z"}}

    async def start():
        context = await playwright.chromium.launch_persistent_context(profile, executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"], viewport={"width": width, "height": 1000 if width > 500 else 844}, service_workers="block")
        await cmpri_fixture.install(context, "chief_engineer")

        async def pool_route(route):
            if route.request.method == "POST":
                body = route.request.post_data_json
                state["posts"].append(body)
                if len(state["posts"]) == 1:
                    # A 200 response containing the previous row does not
                    # acknowledge a request that explicitly clears its AM test.
                    return await route.fulfill(json={"log": state["row"], "unchanged": True})
                state["row"] = {**state["row"], **body, "revision": 6, "sample_location_am": None, "updated_by": cmpri_fixture.UID}
                return await route.abort("failed")  # Saved, but its response was lost.
            state["gets"] += 1
            await route.fulfill(json={"facility": FACILITY, "facilities": [FACILITY], "log": state["row"], "daily_entries": [], "can_edit": True, "can_edit_saved": True})

        await context.route("**/api/pool-log?*", pool_route)
        await context.route("**/api/pool-log", pool_route)
        page = context.pages[0] if context.pages else await context.new_page()
        page.on("pageerror", lambda error: state["errors"].append(str(error)))
        await page.goto(BASE + "/engineering/pool-log")
        await expect(page.get_by_label("Notes / actions taken", exact=True)).to_be_visible(timeout=60000)
        return context, page

    async def retained(page):
        return await page.evaluate("Object.entries(localStorage).filter(([key]) => key.startsWith('cmpri:pool-log-draft:v1:')).map(([, value]) => JSON.parse(value))")

    context, page = await start()
    await page.get_by_role("button", name="Edit saved log", exact=True).click()
    await page.locator("#pool-ph_am").select_option("")
    await page.locator("#pool-sanitizer_band_am").select_option("")
    await page.wait_for_function("Object.entries(localStorage).some(([key, value]) => key.startsWith('cmpri:pool-log-draft:v1:') && JSON.parse(value).form.sanitizer_band_am === '')")
    await context.close()

    gets = state["gets"]
    context, page = await start()
    await expect(page.get_by_text("Unsaved pool readings restored from this device.", exact=True)).to_be_visible()
    await expect(page.locator("#pool-ph_am")).to_have_value("")
    await expect(page.locator("#pool-sanitizer_band_am")).to_have_value("")
    await expect(page.locator("#pool-ph_pm")).to_have_value("7.6")
    await expect(page.get_by_role("button", name="Editing saved log", exact=True)).to_be_visible()
    assert state["gets"] > gets and not state["posts"]
    assert len(await retained(page)) == 1
    await page.get_by_role("button", name="Save Pool Log", exact=True).click()
    await expect(page.get_by_text("The response did not confirm all submitted pool entries.", exact=False)).to_be_visible()
    await expect(page.locator("#pool-ph_am")).to_have_value("")
    assert len(await retained(page)) == 1, "An unrelated success response must preserve the clear intent"
    await page.get_by_role("button", name="Retry Save Pool Log", exact=True).click()
    await expect(page.get_by_text("Failed to fetch", exact=False)).to_be_visible()
    assert state["posts"][0] == state["posts"][1]
    assert state["posts"][1]["edit_mode"] == "replace" and state["posts"][1]["ph_am"] is None and state["posts"][1]["sanitizer_band_am"] is None
    assert state["row"]["remarks"] == "Earlier AM and PM tests"
    assert (await retained(page))[0]["uncertainSave"] is True
    await context.close()

    context, page = await start()
    await expect(page.locator("#pool-ph_am")).to_have_value("")
    await expect(page.locator("#pool-ph_pm")).to_have_value("7.6")
    await expect(page.get_by_label("Notes / actions taken", exact=True)).to_have_value("")
    assert not await retained(page), "The exact next saved revision acknowledges the lost response"
    assert len(state["posts"]) == 2, "Restart must not repeat an already saved correction"
    assert not state["errors"], state["errors"]
    await page.screenshot(path=str(OUT / f"pool-cleared-sample-recovered-{width}.png"), full_page=True)
    await context.close()
    return {"width": width, "cleared_am_restored_with_complete_pm": True, "wrong_ack_retains_draft": True, "cleared_edit_lost_ack_reconciled": True, "per_test_notes_preserved": True, "fixture_posts": 2, "real_database_requests": 0}


async def main():
    async with async_playwright() as playwright:
        results = []
        for width in os.environ.get("CMPRI_UI_WIDTHS", "1440,390").split(","):
            results.append(await check(playwright, int(width)))
            results.append(await check_cleared_sample(playwright, int(width)))
    (OUT / "report.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results))


asyncio.run(main())
