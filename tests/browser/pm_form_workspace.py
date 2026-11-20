"""Real Chromium restarts for nested PM forms; every API is a local fixture.

CMPRI_UI_BASE=http://127.0.0.1:3050 python tests/browser/pm_form_workspace.py
"""
import asyncio
import base64
import copy
import json
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from playwright.async_api import async_playwright, expect

import cmpri_fixture as fixture
from workspace_resume import ApiFixtureContext, profile_payload, session_payload


BASE = os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3050").rstrip("/")
assert urlparse(BASE).hostname in {"localhost", "127.0.0.1"}, "Local fixtures only"
OUT = Path(os.environ.get("CMPRI_UI_OUTPUT", "/tmp/cmpri-pm-form-workspace"))
OUT.mkdir(parents=True, exist_ok=True)
WINDOW = '[data-cmpri-desktop-window="/engineering/preventive-maintenance"]'
FORM = 'section[aria-labelledby="pm-form-title"]'
WEEK = "2026-11-16"
ROOM = {"templateId": "pdf:room-pm-checklist", "periodStart": "2026-10-01", "scopeKey": "room:101"}
INSPECTION = {"templateId": "pdf:monthly-sprinkler-valve-insp", "periodStart": "2026-11-01", "scopeKey": "equipment:valve-a"}
ROOM_NOTES = "Room 101 retained observations after complete Chromium shutdown"
INSPECTION_NOTES = "Valve A retained observations after complete Chromium shutdown"


def entry(identity, revision=2):
    return {
        "id": "fixture-" + identity["templateId"], "template_id": identity["templateId"],
        "period_start": identity["periodStart"], "scope_key": identity["scopeKey"],
        "revision": revision, "responses": {}, "form_data": {"location": "valve-a"} if identity == INSPECTION else {},
        "notes": "Authoritative fixture notes", "deficiency_notes": "", "completed_on": None,
        "is_complete": False, "completed_by_name": None, "work_order_id": None,
        "updated_at": "2026-11-20T18:00:00Z", "status": "pending", "can_edit_entry": True,
    }


def draft_key(identity, hotel=fixture.HOTEL, user=fixture.UID):
    return "cmpri:pm-form-draft:v1:" + ":".join([
        quote(hotel, safe=""), quote(user, safe=""), quote(identity["templateId"], safe=""),
        identity["periodStart"], quote(identity["scopeKey"], safe=""),
    ])


async def close_browser(context):
    """Leave only a blank tab before stopping the actual Chromium process."""
    if not context.pages:
        return await context.close()
    blank = next((page for page in context.pages if page.url == "about:blank"), None)
    blank = blank or await context.new_page()
    for page in list(context.pages):
        if page is not blank:
            await page.close()
    await context.close()


async def launch(playwright, profile, width, state, session=None, auth_gate=None, pm_gate=None):
    session = session or session_payload()
    context = await playwright.chromium.launch_persistent_context(
        str(profile), executable_path="/usr/bin/chromium", headless=True, args=["--no-sandbox"],
        viewport={"width": width, "height": 1000 if width > 640 else 844},
        is_mobile=width < 640, has_touch=width < 640, timezone_id="America/Chicago", service_workers="block",
    )
    startup = [page.url for page in context.pages]
    state["startup_pages"].append(startup)
    assert all(url == "about:blank" for url in startup), startup
    await fixture.install(ApiFixtureContext(context), session["user"]["role"],
                          user_id=session["user"]["id"], hotel_id=session["hotelId"], revisions=state["revisions"])
    expiry = int(time.time()) + 7200

    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    token = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"sub": session["user"]["id"], "aud": "authenticated", "role": "authenticated", "exp": expiry}) + ".fixture"
    auth = {"access_token": token, "refresh_token": "fixture-refresh", "expires_at": expiry,
            "expires_in": 7200, "token_type": "bearer", "user": {"id": session["user"]["id"],
            "email": "fixture@example.invalid", "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}}}
    await context.add_init_script("""(() => {try {
      if(window!==window.top)return;
      localStorage.setItem('cmpri:remember','true');
      localStorage.setItem('cmpri:auth:v1',%s);
      sessionStorage.setItem('cmpri:auth:v1',%s);
    }catch{}})();""" % (json.dumps(json.dumps(auth)), json.dumps(json.dumps(auth))))
    auth_requested, pm_requested = asyncio.Event(), asyncio.Event()

    async def guarded(route):
        request = route.request
        parsed = urlparse(request.url)
        if parsed.hostname not in {"localhost", "127.0.0.1"}:
            state["blocked_external"].add(parsed.hostname or "unknown")
            return await route.abort()
        if parsed.path == "/__pm_form_fixture__":
            return await route.fulfill(content_type="text/html", body="<!doctype html><title>PM fixture</title>")
        if parsed.path.startswith("/api/"):
            state["api_requests"].append({"path": parsed.path, "method": request.method})
        if parsed.path == "/api/session":
            auth_requested.set()
            if auth_gate is not None:
                await auth_gate.wait()
            return await route.fulfill(json=session)
        if parsed.path == "/api/profile":
            return await route.fulfill(json=profile_payload(session))
        if parsed.path == "/api/profile/phone-notifications":
            return await route.fulfill(json={"configured": False, "public_key": "", "subscribed_on_this_device": False,
                "settings": {"timezone": "America/Chicago", "schedule": {day: {"enabled": False, "start": "08:00", "end": "17:00"}
                for day in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]}}})
        if parsed.path == "/api/preventive-maintenance":
            if request.method == "POST":
                state["attempts"].append(copy.deepcopy(request.post_data_json))
                return await route.fulfill(status=409, json={"error": "Fixture PM revision conflict. Your draft is retained."})
            assert request.method == "GET", request.method
            state["pm_reads"].append({"week": parse_qs(parsed.query).get("week", [""])[0], "hotel": session["hotelId"], "user": session["user"]["id"]})
            pm_requested.set()
            if pm_gate is not None:
                await pm_gate.wait()
            return await route.fulfill(json={
                "entries": [entry(ROOM, state["room_revision"]), entry(INSPECTION, 4)],
                "workbook": {"daily": {}, "weekly": {}, "monthly": {}, "rooms": [], "fetchedAt": "2026-11-20T18:00:00Z"},
                "review_queue": [], "locations": [{"id": "fixture-room-101", "name": "Room 101", "room_number": "101", "location_type": "Guest Room", "area": "Guest Rooms"}],
                "actor_id": session["user"]["id"], "actor_name": "Alex Morgan", "can_edit": True, "can_review": True,
                "access_roles": ["chief_engineer"], "spreadsheet_sync_enabled": False,
            })
        if parsed.path == "/api/preventive-maintenance/recorded-issues":
            return await route.fulfill(json={"entries": [], "issues": [], "work_orders": []})
        if parsed.path.startswith("/api/") and request.method not in {"GET", "HEAD"} and parsed.path != "/api/profile/header-layout":
            state["unexpected_writes"].append({"path": parsed.path, "method": request.method})
            return await route.fulfill(status=405, json={"error": "Fixture blocks this write"})
        # The shared fixture fulfills every remaining API; only local assets
        # and application documents are allowed to reach the local Next server.
        return await route.fallback()

    await context.route("**/*", guarded)
    await context.route_web_socket(re.compile(r"^wss?://(?!(?:localhost|127\.0\.0\.1)(?::\d+)?(?:/|$))"), lambda socket: socket.close())
    page = context.pages[0] if context.pages else await context.new_page()
    page.on("pageerror", lambda error: state["errors"].append(str(error)))
    await page.goto(BASE + "/__pm_form_fixture__", wait_until="domcontentloaded")
    state["startup_drafts"].append(await page.evaluate("() => Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('cmpri:pm-form-')))"))
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded", timeout=60000)
    return context, page, auth_requested, pm_requested


async def dashboard_ready(page):
    await expect(page.get_by_role("button", name="Preventative Maintenance", exact=True)).to_be_visible(timeout=60000)


async def pm_frame(page, open_if_missing=False):
    if open_if_missing and not await page.locator(WINDOW).count():
        await dashboard_ready(page)
        await page.get_by_role("button", name="Preventative Maintenance", exact=True).click()
    await expect(page.locator(WINDOW)).to_be_visible(timeout=60000)
    frame = page.frame_locator(WINDOW + " iframe")
    await expect(frame.get_by_label("Week beginning", exact=True)).to_be_visible(timeout=60000)
    return frame


async def stored(page, key):
    return await page.evaluate("key=>JSON.parse(localStorage.getItem(key)||'null')", key)


async def wait_draft(page, identity, notes, revision):
    await page.wait_for_function("""([key,notes,revision,identity])=>{
      const value=JSON.parse(localStorage.getItem(key)||'null');
      return value?.formNotes===notes&&value.revision===revision
        &&Object.keys(identity).every(key=>value.identity[key]===identity[key]);
    }""", arg=[draft_key(identity), notes, revision, identity])


async def room_form(frame):
    await frame.get_by_role("button", name="Quarterly PM", exact=True).click()
    await frame.get_by_label("Search rooms", exact=True).fill("101")
    row = frame.get_by_role("row").filter(has=frame.get_by_role("rowheader", name="Room 101", exact=True))
    await row.get_by_role("button", name="Open PM", exact=True).click()
    form = frame.locator(FORM)
    await expect(form).to_be_visible()
    return form


async def check(playwright, width):
    state = {"revisions": {key: 1 for key in ["orders", "inbox", "pool", "rooms", "feedback", "session", "reference"]},
             "room_revision": 2, "api_requests": [], "pm_reads": [], "attempts": [], "unexpected_writes": [],
             "blocked_external": set(), "errors": [], "startup_pages": [], "startup_drafts": []}
    context = None
    with tempfile.TemporaryDirectory(prefix=f"pm-form-{width}-", dir=OUT) as profile:
        try:
            context, page, _, _ = await launch(playwright, profile, width, state)
            frame = await pm_frame(page, open_if_missing=True)
            await frame.get_by_label("Week beginning", exact=True).fill(WEEK)
            await expect(frame.get_by_role("checkbox").first).to_be_enabled(timeout=60000)
            await expect(frame.get_by_text("Loading PM records…", exact=True)).to_have_count(0)
            form = await room_form(frame)
            await form.get_by_label("Room rank", exact=True).select_option("Red")
            await form.get_by_placeholder("Record observations, readings, or context…").fill(ROOM_NOTES)
            await form.get_by_placeholder("Describe what needs repair and the next step…").fill("Retain the room 101 follow-up plan")
            await form.get_by_role("button", name="/ Follow-up", exact=True).first.click()
            await form.get_by_label("Quarterly room PM completion date *", exact=True).fill("2026-11-19")
            await form.get_by_label("Work-order location", exact=True).select_option("fixture-room-101")
            await wait_draft(page, ROOM, ROOM_NOTES, 2)
            token_before = parse_qs(urlparse(await page.locator(WINDOW + " iframe").get_attribute("src")).query)["modalToken"][0]
            await page.screenshot(path=str(OUT / f"pm-room-before-{width}.png"), full_page=True)
            assert not state["attempts"]
            await close_browser(context)

            # The remembered browser profile is reopened by a new Chromium process.
            # Neither the navigation snapshot nor PM recovery is reseeded.
            auth_gate, pm_gate = asyncio.Event(), asyncio.Event()
            context, page, auth_requested, pm_requested = await launch(playwright, profile, width, state, auth_gate=auth_gate, pm_gate=pm_gate)
            await asyncio.wait_for(auth_requested.wait(), timeout=30)
            await expect(page.locator(WINDOW)).to_have_count(0)
            auth_gate.set()
            await asyncio.wait_for(pm_requested.wait(), timeout=30)
            frame = await pm_frame(page)
            await expect(frame.locator(FORM)).to_have_count(0)
            pm_gate.set()
            form = frame.locator(FORM)
            await expect(form.get_by_role("heading", name="Guest Room Quarterly PM · Room 101", exact=True)).to_be_visible(timeout=60000)
            await expect(form.get_by_placeholder("Record observations, readings, or context…")).to_have_value(ROOM_NOTES)
            await expect(form.get_by_label("Room rank", exact=True)).to_have_value("Red")
            await expect(form.get_by_label("Quarterly room PM completion date *", exact=True)).to_have_value("2026-11-19")
            await expect(form.get_by_label("Work-order location", exact=True)).to_have_value("fixture-room-101")
            await expect(form.get_by_role("button", name="/ Follow-up", exact=True).first).to_have_attribute("aria-pressed", "true")
            await wait_draft(page, ROOM, ROOM_NOTES, 2)
            token_after = parse_qs(urlparse(await page.locator(WINDOW + " iframe").get_attribute("src")).query)["modalToken"][0]
            assert token_after != token_before
            assert not state["attempts"]
            await page.screenshot(path=str(OUT / f"pm-room-restored-{width}.png"), full_page=True)
            await close_browser(context)

            reads_before = len(state["pm_reads"])
            state["room_revision"] = 9
            # Keep resource versions unchanged: forced PM revision reads must
            # bypass a still-valid durable cache entry from the earlier process.
            context, page, _, _ = await launch(playwright, profile, width, state)
            frame = await pm_frame(page)
            form = frame.locator(FORM)
            await expect(form.get_by_text("This PM entry changed elsewhere.", exact=False)).to_be_visible(timeout=60000)
            assert len(state["pm_reads"]) > reads_before
            await expect(form.get_by_placeholder("Record observations, readings, or context…")).to_have_value(ROOM_NOTES)
            await form.get_by_role("button", name="Save draft", exact=True).click()
            await expect(form.get_by_text("Fixture PM revision conflict. Your draft is retained.", exact=True)).to_be_visible()
            assert len(state["attempts"]) == 1 and state["attempts"][0]["expectedRevision"] == 2
            await wait_draft(page, ROOM, ROOM_NOTES, 2)
            original_draft = await stored(page, draft_key(ROOM))
            await close_browser(context)

            for label, session in [
                ("property", session_payload(hotel_id="00000000-0000-4000-8000-000000000082")),
                ("account", session_payload(user_id="00000000-0000-4000-8000-000000000081")),
            ]:
                context, page, _, _ = await launch(playwright, profile, width, state, session=session)
                await dashboard_ready(page)
                await expect(page.locator(WINDOW)).to_have_count(0)
                frame = await pm_frame(page, open_if_missing=True)
                await expect(frame.get_by_role("checkbox").first).to_be_enabled(timeout=60000)
                await expect(frame.locator(FORM)).to_have_count(0)
                assert await stored(page, draft_key(ROOM)) == original_draft, label
                await close_browser(context)

            context, page, _, _ = await launch(playwright, profile, width, state)
            frame = await pm_frame(page)
            form = frame.locator(FORM)
            await expect(form.get_by_placeholder("Record observations, readings, or context…")).to_have_value(ROOM_NOTES)
            await form.get_by_role("button", name="Close", exact=True).click()
            await expect(frame.locator(FORM)).to_have_count(0)
            await close_browser(context)
            context, page, _, _ = await launch(playwright, profile, width, state)
            frame = await pm_frame(page)
            await expect(frame.locator(FORM)).to_have_count(0)
            assert await stored(page, draft_key(ROOM)) == original_draft

            # A second PM form exercises equipment identity, form fields and
            # repeatable inspection rows through the same real restart boundary.
            await frame.get_by_role("button", name="Inspection Forms", exact=True).click()
            await frame.get_by_role("button", name="valve-a · Draft", exact=True).click()
            form = frame.locator(FORM)
            await expect(form.get_by_role("heading", name="Sprinkler Valve Monthly Inspection", exact=True)).to_be_visible()
            await form.get_by_label("Equipment location / identifier", exact=False).fill("valve-a")
            await form.get_by_label("Valve location", exact=False).fill("Riser A")
            await form.get_by_label("Area controlled", exact=False).fill("West Wing")
            await form.get_by_placeholder("Record observations, readings, or context…").fill(INSPECTION_NOTES)
            await wait_draft(page, INSPECTION, INSPECTION_NOTES, 4)
            await close_browser(context)
            context, page, _, _ = await launch(playwright, profile, width, state)
            frame = await pm_frame(page)
            form = frame.locator(FORM)
            await expect(form.get_by_role("heading", name="Sprinkler Valve Monthly Inspection", exact=True)).to_be_visible(timeout=60000)
            await expect(form.get_by_label("Equipment location / identifier", exact=False)).to_have_value("valve-a")
            await expect(form.get_by_label("Valve location", exact=False)).to_have_value("Riser A")
            await expect(form.get_by_label("Area controlled", exact=False)).to_have_value("West Wing")
            await expect(form.get_by_placeholder("Record observations, readings, or context…")).to_have_value(INSPECTION_NOTES)
            await wait_draft(page, INSPECTION, INSPECTION_NOTES, 4)
            await page.screenshot(path=str(OUT / f"pm-inspection-restored-{width}.png"), full_page=True)
            assert not state["unexpected_writes"], state["unexpected_writes"]
            assert len(state["attempts"]) == 1, state["attempts"]
            assert not state["errors"], state["errors"]
            return {"width": width, "room_form_restart": True, "inspection_form_restart": True,
                "fresh_authorization_and_pm_revision_before_restore": True, "stale_baseline_retained": True,
                "account_and_property_isolated": True, "intentional_nested_close_stays_closed": True,
                "fresh_pm_reads": len(state["pm_reads"]), "fixture_conflict_posts": len(state["attempts"]),
                "api_requests_intercepted": len(state["api_requests"]), "blocked_external_hosts": sorted(state["blocked_external"]),
                "startup_pages": state["startup_pages"], "page_errors": state["errors"], "real_database_writes": 0}
        except Exception:
            if context and context.pages:
                try:
                    await context.pages[0].screenshot(path=str(OUT / f"pm-form-failed-{width}.png"), full_page=True)
                except Exception:
                    pass
            (OUT / f"pm-form-failed-{width}.json").write_text(json.dumps({**state, "blocked_external": sorted(state["blocked_external"])}, indent=2))
            raise
        finally:
            if context:
                await close_browser(context)


async def main():
    results = []
    async with async_playwright() as playwright:
        for width in [int(value) for value in os.environ.get("CMPRI_UI_WIDTHS", "1440,390").split(",")]:
            print(json.dumps({"width": width, "step": "starting nested PM form browser restarts"}), flush=True)
            results.append(await check(playwright, width))
            print(json.dumps(results[-1]), flush=True)
    (OUT / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
