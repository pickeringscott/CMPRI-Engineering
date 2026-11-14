"""Production browser -> actual note API -> isolated PostgreSQL, two devices.
Run through npm run test:general-notes-ui after building/starting locally with CI placeholders.
"""
import base64
import json
import os
import re
import shutil
import time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("CMPRI_FIXTURE_URL", "http://127.0.0.1:3000")
if urlparse(BASE).hostname not in ("localhost", "127.0.0.1", "::1"):
    raise RuntimeError("This test is restricted to a local app server.")
BACKEND = "http://127.0.0.1:3128"
USER_A = "00000000-0000-4000-8000-000000000001"
USER_B = "00000000-0000-4000-8000-000000000002"
HOTEL = "00000000-0000-4000-8000-000000000010"

def session(user):
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    expiry = int(time.time()) + 7200
    token = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"sub": user, "aud": "authenticated", "role": "authenticated", "exp": expiry}) + ".fixture"
    return {"access_token": token, "refresh_token": "fixture", "expires_at": expiry, "expires_in": 7200, "token_type": "bearer", "user": {"id": user, "aud": "authenticated", "role": "authenticated", "email": "fixture@example.invalid", "app_metadata": {}, "user_metadata": {}}}

with sync_playwright() as playwright:
    executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
    browser = playwright.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
    errors = []

    def device(user, mobile=False):
        context = browser.new_context(viewport={"width": 390 if mobile else 1360, "height": 740 if mobile else 1000}, is_mobile=mobile, has_touch=mobile)
        context.add_init_script("sessionStorage.setItem('cmpri:auth:v1',JSON.stringify(" + json.dumps(session(user)) + "));")

        def api(route):
            path = urlparse(route.request.url)
            if path.path == "/api/notes":
                response = route.fetch(url=BACKEND + path.path + ("?" + path.query if path.query else ""))
                route.fulfill(response=response)
            elif path.path == "/api/session":
                route.fulfill(json={"user": {"id": user, "name": "Fixture", "role": "engineer"}, "hotelId": HOTEL, "landing": "/engineering", "capabilities": ["view_work_orders"]})
            else:
                route.fulfill(json={})
        context.route("**/api/**", api)
        context.route("https://ci-placeholder.supabase.co/**", lambda route: route.fulfill(json={}))
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(BASE + "/notes")
        expect(page.locator("#general-note-title")).to_be_enabled()
        return context, page

    def synced(page):
        expect(page.get_by_role("status")).to_have_text("Synced", timeout=15000)

    def open_settings(page):
        control = page.get_by_role("button", name="Writing settings", exact=True)
        if control.get_attribute("aria-expanded") != "true":
            control.click()

    def state():
        return desktop_context.request.get(BACKEND + "/fixture/state").json()

    desktop_context, desktop = device(USER_A)
    title = desktop.locator("#general-note-title")
    text = desktop.get_by_role("textbox", name="Note text", exact=True)
    expect(desktop.get_by_role("button", name="Delete saved note", exact=True)).to_be_disabled()
    assert desktop.get_by_role("button", name="Save note", exact=True).count() == 0
    assert desktop.get_by_role("button", name="Download notes and draft", exact=True).count() == 0
    assert desktop.locator("select[aria-label='Open saved note'] + button").get_attribute("aria-label") == "Delete saved note"
    title.fill("Pump inspection")
    text.click()
    desktop.get_by_role("button", name="Text and keyboard handwriting", exact=True).click()
    desktop.get_by_role("button", name="Checklist", exact=True).click()
    expect(text).to_have_value("☐ ")
    desktop.keyboard.press("Backspace")
    expect(text).to_have_value("")
    desktop.get_by_role("button", name="Bullet list", exact=True).click()
    expect(text).to_have_value("• ")
    desktop.keyboard.type("Task")
    desktop.keyboard.press("Enter")
    expect(text).to_have_value("• Task\n• ")
    desktop.keyboard.press("Backspace")
    expect(text).to_have_value("• Task\n")
    text.fill("Heading")
    open_settings(desktop)
    desktop.get_by_role("button", name="Checklist", exact=True).click()
    desktop.keyboard.type("Inspect seal")
    expect(text).to_have_value("Heading\n    ☐ Inspect seal")
    desktop.get_by_label("Text size", exact=True).select_option("20")
    synced(desktop)
    assert len(state()["records"]) == 1
    writes = state()["writes"]
    text.click()
    desktop.keyboard.press("Control+End")
    desktop.keyboard.type(" and pressure")
    synced(desktop)
    assert state()["writes"] == writes + 1, "A typing burst should coalesce to one server save"
    desktop.get_by_role("button", name="Handwritten ink", exact=True).click()
    desktop.get_by_role("button", name="sky ink", exact=True).click()
    desktop.get_by_label("Pen width", exact=True).fill("8")
    title.click()
    assert not desktop.locator(".general-notes-bubble").count()
    open_settings(desktop)
    expect(desktop.get_by_label("Pen width", exact=True)).to_have_value("8")
    desktop.get_by_role("button", name="Close settings", exact=True).click()
    paper = desktop.locator("[data-ink-layer]").bounding_box()
    desktop.mouse.move(paper["x"] + 40, paper["y"] + 140)
    desktop.mouse.down()
    desktop.mouse.move(paper["x"] + 150, paper["y"] + 180, steps=15)
    desktop.mouse.up()
    synced(desktop)
    original_ink = desktop.locator("[data-ink-layer]").inner_html()
    desktop.get_by_role("button", name="Text and keyboard handwriting", exact=True).click()
    assert desktop.locator("[data-ink-layer]").inner_html() == original_ink
    assert text.evaluate("e=>getComputedStyle(e).backgroundColor") == "rgba(0, 0, 0, 0)"
    assert desktop.locator("[data-ink-layer]").evaluate("e=>+getComputedStyle(e).zIndex") > text.evaluate("e=>+getComputedStyle(e).zIndex")
    assert text.get_attribute("placeholder") == ""
    expect(desktop.get_by_role("button", name="Delete saved note", exact=True)).to_be_disabled()
    desktop.get_by_role("button", name="Create another note", exact=True).click()
    text.fill("Shopping list\nSeal kit")
    desktop.get_by_role("button", name="Create another note", exact=True).click()
    expect(desktop.get_by_label("Open saved note", exact=True).locator("option").filter(has_text="Shopping list")).to_have_count(1)
    # The first-line title is finalized on leaving the note, without a Save button.
    assert any(row["document"] and row["document"]["title"] == "Shopping list" for row in state()["records"])
    assert text.get_attribute("placeholder") == "Type, or select the pen to write…"
    metrics = text.evaluate("e=>{const s=getComputedStyle(e),p=getComputedStyle(e,'::placeholder');return [s.fontSize,p.fontSize,s.lineHeight,p.lineHeight]}")
    assert metrics[0] == metrics[1] and metrics[2] == metrics[3]
    desktop.get_by_role("button", name="Handwritten ink", exact=True).click()
    desktop.get_by_role("button", name="Close settings", exact=True).click()
    paper = desktop.locator("[data-ink-layer]").bounding_box()
    desktop.mouse.move(paper["x"] + 60, paper["y"] + 120)
    desktop.mouse.down()
    desktop.mouse.move(paper["x"] + 100, paper["y"] + 150)
    desktop.mouse.up()
    synced(desktop)
    assert any(row["document"] and row["document"]["title"] == "Untitled" and row["document"]["strokes"] for row in state()["records"])
    desktop.get_by_role("button", name="Create another note", exact=True).click()

    # A real second browser context has no local notes from the desktop.
    mobile_context, mobile = device(USER_A, True)
    mobile.get_by_label("Open saved note", exact=True).select_option(label="Pump inspection")
    phone_text = mobile.get_by_role("textbox", name="Note text", exact=True)
    expect(phone_text).to_have_value(re.compile("Inspect seal"), timeout=15000)
    expect(mobile.locator("[data-ink-layer] g")).to_have_count(1)
    expect(mobile.get_by_role("button", name="Delete saved note", exact=True)).to_be_enabled()
    desktop.get_by_label("Open saved note", exact=True).select_option(label="Pump inspection")
    phone_text.fill(phone_text.input_value() + "\nPhone update")
    synced(mobile)
    desktop.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(text).to_have_value(phone_text.input_value(), timeout=15000)
    protocol = mobile_context.new_cdp_session(mobile)
    phone_text.click()
    protocol.send("Input.imeSetComposition", {"text": "Recognized handwriting", "selectionStart": 22, "selectionEnd": 22})
    protocol.send("Input.insertText", {"text": "Recognized handwriting"})
    phone_text.dispatch_event("pointerdown", {"pointerType": "pen", "buttons": 1, "bubbles": True})
    expect(mobile.get_by_role("button", name="Text and keyboard handwriting", exact=True)).to_have_attribute("aria-pressed", "true")
    assert not phone_text.evaluate("e=>e.readOnly")
    mobile.get_by_role("button", name="Handwritten ink", exact=True).click()
    mobile.get_by_role("button", name="Close settings", exact=True).click()
    paper = mobile.locator("[data-ink-layer]").bounding_box()
    x, y = paper["x"] + 80, paper["y"] + 110
    protocol.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    for i in range(1, 7):
        protocol.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - i * 10}]})
    protocol.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert mobile.locator(".general-notes-scroll").evaluate("e=>e.scrollTop") > 20
    protocol.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y - 20}]})
    protocol.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    assert phone_text.evaluate("e=>document.activeElement===e")
    assert not mobile.evaluate("document.documentElement.scrollWidth > innerWidth")
    other_context, other = device(USER_B, True)
    assert other.get_by_label("Open saved note", exact=True).locator("option").count() == 1
    expect(other.get_by_role("button", name="Delete saved note", exact=True)).to_be_disabled()
    screenshots = os.environ.get("CMPRI_NOTES_SCREENSHOTS")
    if screenshots:
        output = Path(screenshots)
        output.mkdir(parents=True, exist_ok=True)
        mobile.set_viewport_size({"width": 390, "height": 844})
        open_settings(mobile)
        mobile.screenshot(path=str(output / "cmpri-notes-autosave-text.png"))
        mobile.get_by_role("button", name="Handwritten ink", exact=True).click()
        mobile.screenshot(path=str(output / "cmpri-notes-autosave-pen.png"))
    assert not errors, errors
    browser.close()
    print("PASS: actual note API + isolated PostgreSQL, independent desktop/mobile contexts, autosave coalescing, first-line/Untitled titles, multiple notes, ink retention, headerless lists, placeholder metrics, approved controls, trash placement, account isolation, gestures and IME input.")
