"""Browser-restart acceptance for CMPRI workspace recovery, using fixtures only.

Run against a localhost build with synthetic public Supabase configuration:
  CMPRI_UI_BASE=http://127.0.0.1:3050 python tests/browser/workspace_resume.py
No production API, Supabase, provider, or WebSocket traffic is permitted.
"""
import asyncio
import base64
import json
import os
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

import cmpri_fixture as fixture


BASE = os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3050").rstrip("/")
assert urlparse(BASE).hostname in {"localhost", "127.0.0.1"}, "Local fixtures only"
OUT = Path(os.environ.get("CMPRI_UI_OUTPUT", "/tmp/cmpri-workspace-resume"))
OUT.mkdir(parents=True, exist_ok=True)
WORKSPACE_KEY = f"cmpri:workspace:v1:{fixture.UID}:{fixture.HOTEL}"
OUTBOX_KEY = f"cmpri:fixture-protected-outbox:{fixture.HOTEL}:{fixture.UID}"
LIST = '[data-cmpri-desktop-window="work-order-list"]'
PROFILE = '[data-cmpri-desktop-window="/profile"]'


class ApiFixtureContext:
    """Reuse API fixtures while this test owns its remembered JWT lifecycle."""
    def __init__(self, context):
        self.context = context

    async def add_init_script(self, *_args, **_kwargs):
        # The shared fixture's non-JWT token is unsuitable for restart/logout
        # testing, and rerunning it inside an artwork iframe signs back in.
        return None

    async def route(self, *args, **kwargs):
        return await self.context.route(*args, **kwargs)


def session_payload(role="chief_engineer", user_id=fixture.UID, hotel_id=fixture.HOTEL, capabilities=None):
    return {
        "user": {"id": user_id, "name": "Alex Morgan", "role": role, "email": "fixture@example.invalid"},
        "hotelId": hotel_id,
        "landing": {"technician": "/technician", "housekeeping": "/work-orders", "front_desk": "/front-desk"}.get(role, "/engineering"),
        "capabilities": fixture.CAPS[role] if capabilities is None else capabilities,
    }


def profile_payload(session):
    user = session["user"]
    return {
        "profile": {"id": user["id"], "email": user["email"], "full_name": "Alex Morgan", "role": user["role"]},
        "preferences": {"appearance": "dark", "language": "en", "notification_mode": "in_app",
                        "notifications": {"new_work_orders": True, "status_changes": True, "mentions": True}},
        "profile_settings_available": True,
        "can_manage_users": True,
        "chatgpt_connection": {"connected": False, "status": "disconnected", "access": "disconnected",
                               "provider": "fixture", "endpoint": "", "message": ""},
    }


async def launch(playwright, profile, width, state, session=None, gate=None, seed_workspace=None, start_path="/engineering"):
    """Install the complete network guard before the first application navigation."""
    session = session or session_payload()
    context = await playwright.chromium.launch_persistent_context(
        str(profile), executable_path="/usr/bin/chromium", headless=True,
        args=["--no-sandbox"], viewport={"width": width, "height": 1000 if width > 640 else 844},
        is_mobile=width < 640, has_touch=width < 640, timezone_id="America/Chicago", service_workers="block",
    )
    state.setdefault("startup_pages", []).append([page.url for page in context.pages])
    await fixture.install(ApiFixtureContext(context), session["user"]["role"], user_id=session["user"]["id"],
                          hotel_id=session["hotelId"], revisions=state["revisions"])
    # A remembered session is synthetic here. Reopening tests the real persistent
    # storage boundary instead of Playwright's serialized storage_state shortcut.
    expiry = int(time.time()) + 7200
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    token = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"sub": session["user"]["id"], "aud": "authenticated", "role": "authenticated", "exp": expiry}) + ".fixture"
    auth = {"access_token": token, "refresh_token": "fixture-refresh", "expires_at": expiry,
            "expires_in": 7200, "token_type": "bearer", "user": {"id": session["user"]["id"], "email": "fixture@example.invalid",
                                                                  "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}}}
    await context.add_init_script("""(() => {
      try {
        if(window!==window.top) return;
        if(location.pathname==='/') {
          localStorage.removeItem('cmpri:auth:v1');
          sessionStorage.removeItem('cmpri:auth:v1');
          return;
        }
        localStorage.setItem('cmpri:remember', 'true');
        localStorage.setItem('cmpri:auth:v1', %s);
        sessionStorage.setItem('cmpri:auth:v1', %s);
        %s
      } catch {}
    })();""" % (json.dumps(json.dumps(auth)), json.dumps(json.dumps(auth)),
                  "if(window===window.top && location.pathname===%s) localStorage.setItem(%s,%s);" % (json.dumps(urlparse(start_path).path), json.dumps(WORKSPACE_KEY), json.dumps(seed_workspace))
                  if seed_workspace is not None else ""))
    requested = asyncio.Event()

    async def guarded(route):
        request = route.request
        parsed = urlparse(request.url)
        if parsed.hostname not in {"localhost", "127.0.0.1"}:
            state["blocked_external"].add(parsed.hostname or "unknown")
            return await route.abort()
        if parsed.path == "/__cmpri_workspace_fixture__":
            return await route.fulfill(content_type="text/html", body="<!doctype html><title>Local recovery fixture</title>")
        if parsed.path.startswith("/api/"):
            state["api_requests"].append({"path": parsed.path, "method": request.method})
            if request.method not in {"GET", "HEAD"} and parsed.path != "/api/profile/header-layout":
                state["unexpected_writes"].append({"path": parsed.path, "method": request.method})
        if parsed.path == "/api/session":
            requested.set()
            if gate is not None:
                await gate.wait()
            return await route.fulfill(json=session)
        if parsed.path == "/api/profile":
            return await route.fulfill(json=profile_payload(session))
        if parsed.path == "/api/notes":
            return await route.fulfill(json={"notes": [], "note": None})
        if parsed.path == "/api/profile/phone-notifications":
            return await route.fulfill(json={"configured": False, "public_key": "", "subscribed_on_this_device": False,
                                            "settings": {"timezone": "America/Chicago", "schedule": {
                                                day: {"enabled": False, "start": "08:00", "end": "17:00"}
                                                for day in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]}}})
        marker = parse_qs(parsed.query).get("workspaceResume", [None])[0]
        if parsed.path == "/api/rooms" and marker:
            state["cache_hits"][marker] = state["cache_hits"].get(marker, 0) + 1
            return await route.fulfill(json={"locations": [], "fixtureVersion": state["revisions"]["rooms"]})
        return await route.fallback()

    await context.route("**/*", guarded)
    await context.route_web_socket(re.compile(r"^wss?://(?!(?:localhost|127\.0\.0\.1)(?::\d+)?(?:/|$))"), lambda socket: socket.close())
    page = context.pages[0] if context.pages else await context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # Read persisted navigation before any application script can hydrate it.
    # This document is fulfilled locally and contains no application code.
    await page.goto(BASE + "/__cmpri_workspace_fixture__", wait_until="domcontentloaded")
    state.setdefault("startup_workspaces", []).append(await workspace(page))
    await page.goto(BASE + start_path, wait_until="domcontentloaded", timeout=60000)
    return context, page, requested, errors


async def dashboard_ready(page):
    await page.get_by_role("button", name="Work Order List", exact=True).wait_for(timeout=60000)


async def activate(page, name):
    button = page.get_by_role("button", name=name, exact=True)
    await button.focus()
    await button.press("Enter")


async def workspace(page):
    return await page.evaluate("key => JSON.parse(localStorage.getItem(key) || 'null')", WORKSPACE_KEY)


async def wait_saved(page, keys, active=None):
    await page.wait_for_function("""([key,keys,active]) => {
      const saved=JSON.parse(localStorage.getItem(key)||'null');
      return saved && keys.length===saved.desktop.views.length
        && keys.every(key=>saved.desktop.views.some(view=>view.key===key))
        && (!active || saved.desktop.zOrder.at(-1)===active);
    }""", arg=[WORKSPACE_KEY, keys, active], timeout=15000)


async def wait_top_href(page, href):
    await page.wait_for_function("""([key,href]) => JSON.parse(localStorage.getItem(key)||'null')?.topHref===href""",
                                 arg=[WORKSPACE_KEY, href], timeout=15000)


async def guarded_desktop_return(page, profile_window):
    frame_handle = await profile_window.locator("iframe").element_handle()
    frame = await frame_handle.content_frame()
    name_input = frame.get_by_role("textbox", name="Display name", exact=False)
    await expect(name_input).to_be_visible(timeout=30000)
    protected_name = f"Fixture retained profile {page.viewport_size['width']}"
    await name_input.fill(protected_name)
    await frame.evaluate("""() => {
      window.fixtureGuardRequests=0;
      document.addEventListener('cmpri-modal-cancel-request',event=>{
        window.fixtureGuardRequests++;event.preventDefault();event.stopImmediatePropagation();
      },true);
      const button=document.createElement('button');
      button.textContent='Fixture guarded return';button.dataset.cmpriModalDashboard='true';
      button.dataset.cmpriModalDashboardHref='/engineering';document.body.prepend(button);
    }""")
    await frame.get_by_role("button", name="Fixture guarded return", exact=True).click()
    await frame.wait_for_function("window.fixtureGuardRequests===1")
    await expect(profile_window).to_be_visible()
    await frame.evaluate("""() => parent.postMessage({type:'cmpri-modal-dashboard',
      modalToken:new URLSearchParams(location.search).get('modalToken')},location.origin)""")
    await frame.wait_for_function("window.fixtureGuardRequests===2")
    await frame.evaluate("history.replaceState({},'', '/front-desk')")
    try:
        # Next's history wrapper can replay the attempted route. Every attempt
        # must remain guarded; the refused frame must retain its original URL.
        await frame.wait_for_function("window.fixtureGuardRequests>=3", timeout=5000)
        assert urlparse(await frame.evaluate("location.href")).path == "/profile"
        await expect(name_input).to_be_visible()
        await expect(name_input).to_have_value(protected_name)
    except Exception:
        details = await frame.evaluate("""() => ({requests:window.fixtureGuardRequests,href:location.href,
          replace:String(history.replaceState),push:String(history.pushState)})""")
        (OUT / f"guarded-return-failure-{page.viewport_size['width']}.json").write_text(json.dumps(details, indent=2))
        raise
    await expect(profile_window).to_be_visible()
    assert any(view["key"] == "/profile" for view in (await workspace(page))["desktop"]["views"])
    await frame.evaluate("""() => parent.postMessage({type:'cmpri-modal-close',
      modalToken:new URLSearchParams(location.search).get('modalToken')},location.origin)""")
    await expect(profile_window).to_have_count(0)


async def cache_read(page, marker):
    return await page.evaluate("""async marker => {
      const token=JSON.parse(localStorage.getItem('cmpri:auth:v1')||sessionStorage.getItem('cmpri:auth:v1')).access_token;
      const response=await fetch('/api/rooms?workspaceResume='+encodeURIComponent(marker),
        {headers:{Authorization:'Bearer '+token},cache:'no-store'});
      return {status:response.status,hit:response.headers.get('X-CMPRI-Data-Cache'),body:await response.json()};
    }""", marker)


async def expire_disk_record(page, marker):
    return await page.evaluate("""marker=>new Promise((resolve,reject)=>{
      const open=indexedDB.open('cmpri-device-data-v1',1);
      open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{
        const db=open.result,tx=db.transaction('entries','readwrite'),store=tx.objectStore('entries');
        let found=0;const cursor=store.openCursor();
        cursor.onsuccess=()=>{const item=cursor.result;if(!item)return;
          if(item.value.key.includes('workspaceResume='+marker)){
            item.update({...item.value,expiresAt:Date.now()-1});found++;
          }item.continue();};
        tx.oncomplete=()=>{db.close();resolve(found)};tx.onerror=()=>reject(tx.error);
      };
    })""", marker)


async def check_tally_anchor(page, width, results):
    iframe = page.locator('iframe[title="Illinois versus Iowa football background"]')
    await expect(iframe).to_have_count(1)
    child = page.frame_locator('iframe[title="Illinois versus Iowa football background"]')
    await child.locator(".sim-tally").wait_for()
    await page.wait_for_function("""()=>{
      const frame=document.querySelector('iframe[title="Illinois versus Iowa football background"]');
      return frame?.contentWindow?.cmpriTheme?.action && frame?.contentWindow?.cmpriTheme?.game;
    }""")
    await page.locator(".cmpri-desktop-topbar").wait_for(state="visible")
    await expect(child.locator("body")).to_have_class(re.compile(r"\bcmpri-tally-header\b"))

    async def geometry(label):
        await page.wait_for_timeout(100)
        parent = await page.locator(".cmpri-desktop-topbar").bounding_box()
        score = await child.locator("#cmpriScorebug").bounding_box()
        tally = await child.locator(".sim-tally").bounding_box()
        anchored = await child.locator("body").evaluate("body=>body.classList.contains('cmpri-tally-header')")
        assert anchored and abs(tally["y"] - parent["y"] - parent["height"] - 4) <= 1, (label, parent, tally)
        assert abs(parent["x"] + parent["width"] - tally["x"] - tally["width"] - 8) <= 1, (label, parent, tally)
        line = await child.locator(".sim-betting-line").bounding_box()
        assert line and line["x"] >= tally["x"] and line["y"] >= tally["y"] and line["y"] + line["height"] <= tally["y"] + tally["height"], (label, line, tally)
        return {"state": label, "header": parent, "scoreboard": score, "tally": tally}

    checks = [await geometry("expanded")]
    if width > 640:
        groups = page.locator(".cmpri-desktop-topbar fieldset.group:visible")
        first = groups.first.locator("legend")
        await first.click()
        checks.append(await geometry("group collapsed"))
        await first.click()
        checks.append(await geometry("group expanded"))
        await page.set_viewport_size({"width": width - 160, "height": 1000})
        checks.append(await geometry("title bar resized"))
        await page.set_viewport_size({"width": width, "height": 1000})
        checks.append(await geometry("title bar restored"))
    results.append({"width": width, "test": "W-L/betting strip follows the dashboard title bar with a four-pixel gap and eight-pixel right margin", "passed": True, "geometry": checks})


async def check_width(playwright, width, results):
    marker = f"restart-{width}"
    state = {"revisions": {name: 1 for name in ["orders", "inbox", "pool", "rooms", "feedback", "session", "reference"]},
             "cache_hits": {}, "blocked_external": set(), "unexpected_writes": [], "api_requests": []}
    close_number = 0

    async def close_context(context):
        nonlocal close_number
        close_number += 1
        pages = []
        for open_page in context.pages:
            details = {"url": open_page.url}
            if urlparse(open_page.url).netloc == urlparse(BASE).netloc:
                details["workspace"] = await workspace(open_page)
                details["windows"] = await open_page.locator("[data-cmpri-desktop-window]").evaluate_all("items=>items.map(item=>({key:item.dataset.cmpriDesktopWindow,active:item.dataset.active}))")
            pages.append(details)
        (OUT / f"workspace-context-{width}-{close_number}.json").write_text(json.dumps({"pages": pages, "startupPages": state["startup_pages"], "startupWorkspaces": state["startup_workspaces"]}, indent=2))
        # Close the CMPRI tab through its normal lifecycle before stopping the
        # browser. Otherwise Chromium may restore and execute the old app tab
        # before Playwright can install the next context's network guard.
        blank = next((item for item in context.pages if item.url == "about:blank"), None)
        blank = blank or await context.new_page()
        for open_page in list(context.pages):
            if open_page is not blank:
                await open_page.close()
        await context.close()
    with tempfile.TemporaryDirectory(prefix=f"workspace-{width}-", dir=OUT) as directory:
        profile = Path(directory)
        context, page, _, errors = await launch(playwright, profile, width, state)
        try:
            await dashboard_ready(page)
            await check_tally_anchor(page, width, results)
            await activate(page, "Work Order List")
            listing = page.locator(LIST)
            await expect(listing).to_be_visible()
            await expect(listing.locator(".work-order-ticket-line")).to_have_count(1)
            if width > 640:
                title = await listing.locator(".cmpri-desktop-titlebar").bounding_box()
                await page.mouse.move(title["x"] + title["width"] / 2, title["y"] + title["height"] / 2)
                await page.mouse.down()
                await page.mouse.move(title["x"] + title["width"] / 2 + 32, title["y"] + title["height"] / 2 + 24, steps=6)
                await page.mouse.up()
            list_rect = await listing.bounding_box()
            await activate(page, "Manage Profile")
            profile_window = page.locator(PROFILE)
            await expect(profile_window).to_be_visible()
            await expect(profile_window.frame_locator("iframe").get_by_role("textbox", name="Display name", exact=False)).to_be_visible(timeout=30000)
            await wait_saved(page, ["work-order-list", "/profile"], "/profile")
            token_before = parse_qs(urlparse(await profile_window.locator("iframe").get_attribute("src")).query)["modalToken"][0]
            original_workspace = json.dumps(await workspace(page))
            initial = await cache_read(page, marker)
            assert initial["status"] == 200 and initial["hit"] is None, initial
            assert (await cache_read(page, marker))["hit"] == "hit"
            assert state["cache_hits"][marker] == 1
            assert not errors, errors
            await page.screenshot(path=str(OUT / f"workspace-before-{width}.png"))
        finally:
            await close_context(context)

        # A complete Chromium close/relaunch reuses localStorage and IndexedDB.
        # Hold fresh authorization to prove no restored private screen appears first.
        gate = asyncio.Event()
        context, page, requested, errors = await launch(playwright, profile, width, state, gate=gate)
        try:
            await asyncio.wait_for(requested.wait(), timeout=30)
            await page.wait_for_timeout(180)
            assert await page.locator("[data-cmpri-desktop-window]").count() == 0
            assert not any(urlparse(frame.url).path == "/profile" for frame in page.frames)
            gate.set()
            await dashboard_ready(page)
            listing, profile_window = page.locator(LIST), page.locator(PROFILE)
            await expect(listing).to_be_visible()
            await expect(profile_window).to_be_visible()
            await expect(profile_window).to_have_attribute("data-active", "true")
            token_after = parse_qs(urlparse(await profile_window.locator("iframe").get_attribute("src")).query)["modalToken"][0]
            assert token_after and token_after != token_before
            restored_rect = await listing.bounding_box()
            assert all(abs(restored_rect[key] - list_rect[key]) <= 2 for key in ["x", "y", "width", "height"]), (list_rect, restored_rect)
            reused = await cache_read(page, marker)
            assert reused["hit"] == "hit" and state["cache_hits"][marker] == 1, reused
            results.append({"width": width, "test": "complete browser restart restores authorized windows, geometry and active window with fresh tokens; valid cached data is reused", "passed": True})
            await page.screenshot(path=str(OUT / f"workspace-restored-{width}.png"))
            assert await expire_disk_record(page, marker) == 1
            await guarded_desktop_return(page, profile_window)
            await wait_saved(page, ["work-order-list"], "work-order-list")
            results.append({"width": width, "test": "embedded return button, dashboard message and history honor a refused save guard; close acknowledgment dismisses once", "passed": True})
            (OUT / f"workspace-closed-{width}.json").write_text(json.dumps(await workspace(page), indent=2))
            assert not errors, errors
        finally:
            gate.set()
            await close_context(context)

        context, page, _, errors = await launch(playwright, profile, width, state)
        try:
            await dashboard_ready(page)
            await expect(page.locator(LIST)).to_be_visible()
            if await page.locator(PROFILE).count():
                (OUT / f"workspace-resurrection-{width}.json").write_text(json.dumps({
                    "url": page.url, "workspace": await workspace(page),
                    "frames": [frame.url for frame in page.frames], "errors": errors,
                    "storage": await page.evaluate("Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('cmpri:workspace:')))"),
                }, indent=2))
                await page.screenshot(path=str(OUT / f"workspace-resurrection-{width}.png"))
            await expect(page.locator(PROFILE)).to_have_count(0)
            expired = await cache_read(page, marker)
            assert expired["hit"] is None and state["cache_hits"][marker] == 2, expired
            results.append({"width": width, "test": "explicitly closed window stays closed after restart; expired disk cache fetches fresh fixture data", "passed": True})
            assert not errors, errors
        finally:
            await close_context(context)

        state["revisions"]["rooms"] += 1
        context, page, _, errors = await launch(playwright, profile, width, state)
        try:
            await dashboard_ready(page)
            changed = await cache_read(page, marker)
            assert changed["hit"] is None and changed["body"]["fixtureVersion"] == 2 and state["cache_hits"][marker] == 3, changed
            results.append({"width": width, "test": "changed resource revision invalidates durable cache before it can be served", "passed": True})
            assert not errors, errors
        finally:
            await close_context(context)

        # Seed only the prior navigation snapshot between variants. The production
        # reader must ignore it after each fresh identity/permission check.
        variants = [
            ("account", session_payload(user_id="00000000-0000-4000-8000-000000000081")),
            ("property", session_payload(hotel_id="00000000-0000-4000-8000-000000000082")),
            ("role", session_payload(role="technician")),
            ("capabilities", session_payload(capabilities=[cap for cap in fixture.CAPS["chief_engineer"] if cap != "manage_assets"])),
        ]
        for label, session in variants:
            context, page, _, errors = await launch(playwright, profile, width, state, session=session, seed_workspace=original_workspace)
            try:
                await dashboard_ready(page)
                await page.wait_for_timeout(120)
                assert await page.locator("[data-cmpri-desktop-window]").count() == 0, label
                assert not any(urlparse(frame.url).path == "/profile" for frame in page.frames), label
                assert not errors, errors
                results.append({"width": width, "test": f"changed {label} cannot restore the prior private workspace", "passed": True})
            finally:
                await close_context(context)

        context, page, _, errors = await launch(playwright, profile, width, state, seed_workspace=original_workspace)
        try:
            await dashboard_ready(page)
            await expect(page.locator(PROFILE)).to_be_visible()
            await page.evaluate("key=>localStorage.setItem(key,JSON.stringify({body:'Fixture unsynced work',checked:true}))", OUTBOX_KEY)
            await activate(page, "Sign Out")
            await page.wait_for_url(re.compile(r"/$"), timeout=15000)
            await page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            assert await page.evaluate("key=>localStorage.getItem(key)", WORKSPACE_KEY) is None
            assert json.loads(await page.evaluate("key=>localStorage.getItem(key)", OUTBOX_KEY)) == {"body": "Fixture unsynced work", "checked": True}
            assert not errors, errors
            results.append({"width": width, "test": "actual sign-out forgets navigation without erasing protected editor recovery; late pagehide cannot recreate it", "passed": True})
        finally:
            await close_context(context)
        assert not state["unexpected_writes"], state["unexpected_writes"]
        results.append({"width": width, "test": "network isolation", "passed": True, "productionDataAccessed": False,
                        "apiRequestsIntercepted": len(state["api_requests"]), "blockedExternalHosts": sorted(state["blocked_external"])})


async def check_standalone_roles(playwright, width, results):
    """Close/relaunch real app tabs; never seed navigation for the restart itself."""
    async def close_context(context):
        blank = next((item for item in context.pages if item.url == "about:blank"), None)
        blank = blank or await context.new_page()
        for open_page in list(context.pages):
            if open_page is not blank:
                await open_page.close()
        await context.close()

    for role in ["technician", "housekeeping"]:
        session = session_payload(role=role)
        landing = session["landing"]
        state = {"revisions": {name: 1 for name in ["orders", "inbox", "pool", "rooms", "feedback", "session", "reference"]},
                 "cache_hits": {}, "blocked_external": set(), "unexpected_writes": [], "api_requests": []}
        top_href = "/notes?tab=journal"
        with tempfile.TemporaryDirectory(prefix=f"standalone-{role}-{width}-", dir=OUT) as directory:
            profile = Path(directory)
            context, page, _, errors = await launch(playwright, profile, width, state, session=session, start_path=landing)
            try:
                await wait_top_href(page, landing)
                await page.goto(BASE + top_href, wait_until="domcontentloaded")
                await expect(page.get_by_role("heading", name="Notes", exact=True)).to_be_visible()
                await wait_top_href(page, top_href)
                original_workspace = json.dumps(await workspace(page))
                assert not errors, errors
            finally:
                await close_context(context)

            gate = asyncio.Event()
            context, page, requested, errors = await launch(playwright, profile, width, state, session=session, gate=gate, start_path=landing)
            try:
                await asyncio.wait_for(requested.wait(), timeout=30)
                await page.wait_for_timeout(150)
                assert urlparse(page.url).path == landing
                assert not any(urlparse(frame.url).path == "/notes" for frame in page.frames)
                assert (await workspace(page))["topHref"] == top_href, "initial landing cannot clobber the pending restore decision"
                gate.set()
                await page.wait_for_url(BASE + top_href, timeout=30000)
                await expect(page.get_by_role("heading", name="Notes", exact=True)).to_be_visible()
                await wait_top_href(page, top_href)
                assert not errors, errors
                results.append({"width": width, "role": role, "test": "complete browser restart resumes the last standalone view from the authorized landing after fresh verification", "passed": True})
            finally:
                gate.set()
                await close_context(context)

            # Isolated seeds keep these explicit-navigation cases independent
            # of their preceding case; all HTTP reads remain fixture guarded.
            for explicit in [landing + "?tab=explicit", "/staff-notes?view=explicit"]:
                context, page, _, errors = await launch(playwright, profile, width, state, session=session,
                                                       seed_workspace=original_workspace, start_path=explicit)
                try:
                    await wait_top_href(page, explicit)
                    assert page.url == BASE + explicit
                    assert not errors, errors
                finally:
                    await close_context(context)
            results.append({"width": width, "role": role, "test": "explicit landing query and direct standalone URL override an earlier saved view without a navigation loop", "passed": True})

            context, page, _, errors = await launch(playwright, profile, width, state, session=session,
                                                   seed_workspace=original_workspace, start_path=landing + "?tab=signout")
            try:
                await wait_top_href(page, landing + "?tab=signout")
                await page.evaluate("key=>localStorage.setItem(key,'fixture protected unsynced data')", OUTBOX_KEY)
                if role == "housekeeping":
                    await page.goto(BASE + "/profile", wait_until="domcontentloaded")
                    await expect(page.get_by_role("heading", name="Manage Profile", exact=True)).to_be_visible()
                await activate(page, "Sign Out")
                await page.wait_for_url(re.compile(r"/$"), timeout=15000)
                await page.evaluate("""() => {
                  window.dispatchEvent(new CustomEvent('cmpri-data-cache-invalidated',{detail:{topics:['session']}}));
                  window.dispatchEvent(new Event('pagehide'));
                }""")
                assert await page.evaluate("key=>localStorage.getItem(key)", WORKSPACE_KEY) is None
                assert await page.evaluate("key=>localStorage.getItem(key)", OUTBOX_KEY) == "fixture protected unsynced data"
                assert await page.locator('[data-modal-entry] iframe, [data-cmpri-desktop-window] iframe').count() == 0
                assert not errors, errors
                results.append({"width": width, "role": role, "test": "actual sign-out forgets navigation; late session invalidation and pagehide cannot recreate it or erase unsynced editor data", "passed": True})
            finally:
                await close_context(context)
        assert not state["unexpected_writes"], state["unexpected_writes"]
        results.append({"width": width, "role": role, "test": "standalone role network isolation", "passed": True,
                        "productionDataAccessed": False, "apiRequestsIntercepted": len(state["api_requests"]),
                        "blockedExternalHosts": sorted(state["blocked_external"])})


async def main():
    results = []
    try:
        async with async_playwright() as playwright:
            for width in [int(value) for value in os.environ.get("CMPRI_TEST_WIDTHS", "1440,390").split(",")]:
                await check_width(playwright, width, results)
                await check_standalone_roles(playwright, width, results)
    finally:
        (OUT / "workspace-resume.json").write_text(json.dumps(results, indent=2))
    print(json.dumps({"passed": True, "checks": results, "productionDataAccessed": False}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
