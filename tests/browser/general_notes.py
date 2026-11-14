"""Local production-build acceptance test. All account/API responses are fixtures.
Run with Playwright Python installed and CMPRI_FIXTURE_URL=http://127.0.0.1:3000.
Build first using the repository's CI Supabase placeholders; never point at production.
"""
import base64
import json
import os
import shutil
import time
from urllib.parse import urlparse
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get("CMPRI_FIXTURE_URL", "http://127.0.0.1:3000")
if urlparse(BASE).hostname not in ("localhost", "127.0.0.1", "::1"):
    raise RuntimeError("This fixture test only runs against a local server.")
USER_A = "00000000-0000-4000-8000-000000000001"
USER_B = "00000000-0000-4000-8000-000000000002"
HOTEL = "00000000-0000-4000-8000-000000000010"

def session(user):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    expiry = int(time.time()) + 7200
    token = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"sub": user, "aud": "authenticated", "role": "authenticated", "exp": expiry}) + ".fixture"
    return {"access_token": token, "refresh_token": "fixture", "expires_at": expiry,
            "expires_in": 7200, "token_type": "bearer", "user": {"id": user, "aud": "authenticated", "role": "authenticated", "email": "fixture@example.invalid", "app_metadata": {}, "user_metadata": {}}}

def bootstrap(user):
    return "sessionStorage.setItem('cmpri:auth:v1', JSON.stringify(" + json.dumps(session(user)) + "));"

with sync_playwright() as playwright:
    executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
    browser = playwright.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
    context = browser.new_context(viewport={"width": 1360, "height": 1000})
    context.add_init_script(bootstrap(USER_A))
    account = {"id": USER_A}
    requests, errors = [], []

    def api(route):
        requests.append((route.request.method, urlparse(route.request.url).path))
        if urlparse(route.request.url).path == "/api/session":
            route.fulfill(json={"user": {"id": account["id"], "name": "Fixture", "role": "engineer"}, "hotelId": HOTEL, "landing": "/engineering", "capabilities": ["view_work_orders"]})
        else:
            route.fulfill(json={})

    context.route("**/api/**", api)
    context.route("https://ci-placeholder.supabase.co/**", lambda route: route.fulfill(json={}))
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE + "/notes")
    title = page.locator("#general-note-title")
    text = page.get_by_role("textbox", name="Note text", exact=True)
    title.fill("Pump checklist")
    text.fill("Inspection")
    page.get_by_role("button", name="Text and keyboard handwriting", exact=True).click()
    page.get_by_role("button", name="Checklist", exact=True).click()
    assert text.input_value() == "Inspection\n    ☐ "
    page.keyboard.type("Inspect seal")
    page.keyboard.press("Enter")
    page.keyboard.press("Backspace")
    assert text.input_value() == "Inspection\n    ☐ Inspect seal\n"
    page.get_by_label("Text size", exact=True).select_option("20")
    page.get_by_role("button", name="Handwritten ink", exact=True).click()
    page.get_by_role("button", name="sky ink", exact=True).click()
    page.get_by_label("Pen width", exact=True).fill("8")
    title.click()
    assert not page.locator(".general-notes-bubble").count()
    page.get_by_role("button", name="Writing settings", exact=True).click()
    assert page.get_by_label("Pen width", exact=True).input_value() == "8"
    assert page.get_by_role("button", name="sky ink", exact=True).get_attribute("aria-pressed") == "true"
    assert page.locator(".general-notes-bubble").bounding_box()["height"] <= 170
    page.keyboard.press("Escape")
    assert not page.locator(".general-notes-bubble").count()
    paper = page.locator("[data-ink-layer]").bounding_box()
    page.mouse.move(paper["x"] + 40, paper["y"] + 140)
    page.mouse.down()
    page.mouse.move(paper["x"] + 150, paper["y"] + 180, steps=15)
    page.mouse.up()
    assert page.locator("[data-ink-layer] g").count() == 1
    page.get_by_role("button", name="Undo ink", exact=True).click()
    assert page.locator("[data-ink-layer] g").count() == 0
    page.get_by_role("button", name="Redo ink", exact=True).click()
    page.get_by_role("button", name="Save note", exact=True).click()
    page.get_by_role("status").filter(has_text="Saved on this device").wait_for()
    page.get_by_role("button", name="＋ New note", exact=True).click()
    title.fill("Parts list")
    text.fill("Seal kit")
    page.get_by_role("button", name="Save note", exact=True).click()
    page.get_by_role("status").filter(has_text="Saved on this device").wait_for()
    page.locator(".general-notes-list button").filter(has_text="Pump checklist").click()
    assert page.locator("[data-ink-layer] g").count() == 1
    page.get_by_role("button", name="Writing settings", exact=True).click()
    assert page.get_by_label("Text size", exact=True).input_value() == "20"
    title.click()
    assert page.locator(".general-notes-dock > button").count() == 6
    assert page.locator(".general-notes-dock select, .general-notes-dock input").count() == 0
    assert not page.locator(".general-notes-bubble").count()
    page.get_by_role("button", name="Writing settings", exact=True).click()
    assert page.locator(".general-notes-bubble").is_visible()
    assert page.locator(".general-notes-bubble").bounding_box()["height"] <= 105
    assert page.get_by_label("Text size", exact=True).input_value() == "20"
    title.click()
    assert not page.locator(".general-notes-bubble").count()
    assert page.locator("html").evaluate("e => getComputedStyle(e).getPropertyValue('--cmpri-action-rgb').trim()") == "207,144,254"
    page.reload()
    page.locator(".general-notes-list button").filter(has_text="Pump checklist").click()
    assert page.locator("[data-ink-layer] g").count() == 1

    account["id"] = USER_B
    page.add_init_script(bootstrap(USER_B))
    page.reload()
    page.get_by_role("status").filter(has_text="Notes save on this device only.").wait_for()
    assert page.locator(".general-notes-list button").count() == 0
    account["id"] = USER_A
    page.add_init_script(bootstrap(USER_A))
    page.reload()
    page.locator(".general-notes-list button").filter(has_text="Pump checklist").wait_for()

    page.set_viewport_size({"width": 390, "height": 650})
    page.get_by_label("Open saved note", exact=True).select_option(label="Pump checklist")
    page.get_by_role("button", name="Handwritten ink", exact=True).click()
    page.get_by_role("button", name="Close settings", exact=True).click()
    paper = page.locator("[data-ink-layer]").bounding_box()
    x, y = paper["x"] + 80, paper["y"] + 130
    protocol = context.new_cdp_session(page)
    protocol.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, 7):
        protocol.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - i * 12}]})
    protocol.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert page.locator(".general-notes-scroll").evaluate("e => e.scrollTop") > 20
    protocol.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y - 20}]})
    protocol.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert text.evaluate("e => document.activeElement === e")
    protocol.send("Input.imeSetComposition", {"text": "Recognized handwriting", "selectionStart": 22, "selectionEnd": 22})
    protocol.send("Input.insertText", {"text": "Recognized handwriting"})
    text.dispatch_event("pointerdown", {"pointerType": "pen", "buttons": 1, "bubbles": True})
    assert page.get_by_role("button", name="Text and keyboard handwriting", exact=True).get_attribute("aria-pressed") == "true"
    assert "Recognized handwriting" in text.input_value()
    assert not text.evaluate("e => e.readOnly")
    assert not page.evaluate("document.documentElement.scrollWidth > innerWidth")
    screenshots = os.environ.get("CMPRI_NOTES_SCREENSHOTS")
    if screenshots:
        output = Path(screenshots)
        output.mkdir(parents=True, exist_ok=True)
        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("button", name="Writing settings", exact=True).click()
        page.screenshot(path=str(output / "cmpri-notes-corrected-text.png"))
        page.get_by_role("button", name="Handwritten ink", exact=True).click()
        page.screenshot(path=str(output / "cmpri-notes-corrected-pen.png"))
    assert not errors, errors
    assert not [(method, path) for method, path in requests if method != "GET" and path != "/api/presence"]
    anonymous = browser.new_page()
    anonymous.goto(BASE + "/notes")
    anonymous.get_by_text("Sign in to CMPRI to use your notebook.").wait_for()
    assert anonymous.locator("#general-note-title").count() == 0
    browser.close()
    print("PASS: integrated Notes, desktop/mobile, account isolation, ink, lists, font size, native palette, approved icon dock/bubbles and retained selections, finger gestures, IME input. Physical Gboard UI remains unverified.")
