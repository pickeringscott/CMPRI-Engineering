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
    session_trace = []
    pending_saves = []
    flags = {"session_unavailable": False, "notes_unavailable": False, "session_restart": False, "notes_hang": False}

    def device(user, mobile=False):
        context = browser.new_context(viewport={"width": 390 if mobile else 1360, "height": 740 if mobile else 1000}, is_mobile=mobile, has_touch=mobile)
        context.add_init_script("sessionStorage.setItem('cmpri:auth:v1',JSON.stringify(" + json.dumps(session(user)) + "));")

        def api(route):
            path = urlparse(route.request.url)
            if path.path == "/api/notes":
                if flags["notes_hang"] and route.request.method == "PUT":
                    pending_saves.append(route)
                    return
                if flags["notes_unavailable"] and route.request.method == "PUT":
                    route.fulfill(status=503, json={"error": "Temporary connection failure"})
                    return
                response = route.fetch(url=BACKEND + path.path + ("?" + path.query if path.query else ""))
                route.fulfill(response=response)
            elif path.path == "/api/notes/targets":
                route.fulfill(json={"mentions":[{"id":"person-a","kind":"person","label":"Fixture","description":"Fixture Person","userIds":[]},{"id":"role-front","kind":"role","label":"Front Desk","userIds":[]},{"id":"location-a","kind":"location","label":"Lobby","userIds":[]},{"id":"fd-a","kind":"front_desk_name","label":"Pat","userIds":[]}]})
            elif path.path == "/api/work-orders/references":
                route.fulfill(json={"tickets":[{"id":"00000000-0000-4000-8000-000000000321","display_id":"WO-321","room":"Lobby","issue":"Fixture work","status":"open"}]})
            elif path.path == "/api/session":
                session_trace.append({"frame": route.request.frame.url, "unavailable": flags["session_unavailable"]})
                if flags["session_restart"]:
                    flags["session_restart"] = False
                    route.fulfill(status=401, headers={"Content-Type":"application/json"}, json={"error":"The device session changed. Reload to continue."})
                    return
                if flags["session_unavailable"]:
                    route.fulfill(status=503, json={"error": "Temporary verification failure"})
                    return
                route.fulfill(json={"user": {"id": user, "name": "Fixture", "role": "engineer"}, "hotelId": HOTEL, "landing": "/engineering", "capabilities": ["view_work_orders"]})
            else:
                route.fulfill(json={"work_orders":[], "notifications":[], "drafts":[], "rooms":[]})
        context.route("**/api/**", api)
        context.route("https://ci-placeholder.supabase.co/**", lambda route: route.fulfill(json={"work_orders":[], "notifications":[], "drafts":[], "rooms":[]}))
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(BASE + "/notes")
        expect(page.locator("#general-note-title")).to_be_enabled()
        return context, page

    def expect_editor(locator, value, timeout=5000):
        if isinstance(value, str):
            expect(locator).to_have_js_property("textContent", value, timeout=timeout)
        else:
            expect(locator).to_have_text(value, timeout=timeout)

    def select_text(locator, start=0, end=None):
        locator.evaluate("""(e,args)=>{e.focus();const start=args[0],end=args[1]??e.textContent.length,walk=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),r=document.createRange();let at=0,a=null,b=null,ao=0,bo=0;while(walk.nextNode()){const n=walk.currentNode;if(!a&&start<=at+n.length){a=n;ao=start-at}if(end<=at+n.length){b=n;bo=end-at;break}at+=n.length}if(a){r.setStart(a,ao);r.setEnd(b||a,b?bo:ao);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'))}}""",[start,end])

    def synced(page):
        expect(page.get_by_role("status")).to_have_text("Synced", timeout=15000)

    def open_settings(page):
        if page.locator(".general-notes-bubble").count():
            return
        control = page.get_by_role("button", name="Text and keyboard handwriting", exact=True)
        if control.get_attribute("aria-pressed") != "true":
            control = page.get_by_role("button", name="Handwritten ink", exact=True)
        control.click()

    def state():
        return desktop_context.request.get(BACKEND + "/fixture/state").json()

    desktop_context, desktop = device(USER_A)
    title = desktop.locator("#general-note-title")
    text = desktop.get_by_role("textbox", name="Note text", exact=True)
    expect(desktop.get_by_role("button", name="Delete saved note", exact=True)).to_be_disabled()
    assert desktop.get_by_role("button", name="Save note", exact=True).count() == 0
    assert desktop.get_by_role("button", name="Download notes and draft", exact=True).count() == 0
    assert desktop.locator(".general-notes-title-picker + button").get_attribute("aria-label") == "Delete saved note"
    expect(title).to_have_attribute("placeholder", "Note Title")
    assert desktop.locator("label[for='general-note-title']").count() == 0
    assert desktop.get_by_role("button", name="Writing settings", exact=True).count() == 0
    assert desktop.locator(".general-notes-help").count() == 0
    assert desktop.locator(".general-notes-paper").evaluate("e=>getComputedStyle(e).backgroundImage") == "none"
    assert desktop.locator(".general-notes-scroll").evaluate("e=>getComputedStyle(e).paddingLeft") == "8px"
    assert desktop.locator(".general-notes-mobile-library").evaluate("e=>getComputedStyle(e).gap") == "2px"
    geometry = title.evaluate("e=>({input:e.getBoundingClientRect().toJSON(),box:e.parentElement.getBoundingClientRect().toJSON()})")
    assert geometry["input"]["top"] >= geometry["box"]["top"]
    assert geometry["input"]["bottom"] <= geometry["box"]["bottom"]
    assert geometry["box"]["height"] == 32
    title.fill("Pump inspection")
    text.click()
    desktop.get_by_role("button", name="Text and keyboard handwriting", exact=True).click()
    desktop.get_by_role("button", name="Checklist", exact=True).click()
    expect_editor(text, "☐ ")
    desktop.keyboard.press("Backspace")
    expect_editor(text, "")
    desktop.get_by_role("button", name="Bullet list", exact=True).click()
    expect_editor(text, "• ")
    desktop.keyboard.type("Task")
    desktop.keyboard.press("Enter")
    expect_editor(text, "• Task\n• ")
    desktop.keyboard.press("Backspace")
    expect_editor(text, "• Task\n")
    text.fill("Heading")
    open_settings(desktop)
    desktop.get_by_role("button", name="Checklist", exact=True).click()
    desktop.keyboard.type("Inspect seal")
    expect_editor(text, "Heading\n    ☐ Inspect seal")
    select_text(text)
    desktop.get_by_label("Text size", exact=True).select_option("20")
    assert desktop.get_by_role("button", name="Check or uncheck item", exact=True).count() == 0
    expect(text.locator("span").filter(has_text="Inspect seal")).to_have_css("font-size", "20px")
    checkbox = desktop.get_by_role("checkbox", name="Inspect seal", exact=True)
    expect(checkbox).to_have_css("font-size", "20px")
    checkbox.click()
    expect_editor(text, "Heading\n    ☑ Inspect seal")
    checkbox.click()
    expect_editor(text, "Heading\n    ☐ Inspect seal")
    checkbox.focus()
    desktop.keyboard.press("Space")
    expect_editor(text, "Heading\n    ☑ Inspect seal")
    desktop.keyboard.press("Space")
    expect_editor(text, "Heading\n    ☐ Inspect seal")
    open_settings(desktop)
    select_text(text)
    desktop.get_by_label("Text size", exact=True).select_option("24")
    expect(text.locator("span").filter(has_text="Inspect seal")).to_have_css("font-size", "24px")
    expect(checkbox).to_have_css("font-size", "24px")
    select_text(text)
    desktop.get_by_label("Text size", exact=True).select_option("20")
    assert desktop.get_by_role("button", name="Text and keyboard handwriting", exact=True).bounding_box()["width"] == 30
    assert desktop.locator(".general-notes-bubble").bounding_box()["width"] == 232
    if os.environ.get("CMPRI_NOTES_SCREENSHOTS"):
        desktop.screenshot(path=str(Path(os.environ["CMPRI_NOTES_SCREENSHOTS"]) / "cmpri-notes-desktop-controls.png"))
    synced(desktop)
    assert len(state()["records"]) == 1
    writes = state()["writes"]
    text.click()
    desktop.keyboard.press("Control+End")
    desktop.keyboard.type(" and pressure")
    synced(desktop)
    assert state()["writes"] == writes + 1, "A typing burst should coalesce to one server save"
    desktop.get_by_role("button", name="Handwritten ink", exact=True).click()
    assert desktop.locator(".general-notes-bubble").bounding_box()["width"] == 232
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
    assert text.get_attribute("data-placeholder") == ""
    expect(desktop.get_by_role("button", name="Delete saved note", exact=True)).to_be_enabled()
    desktop.get_by_role("button", name="Create another note", exact=True).click()
    text.fill("Shopping list\nSeal kit")
    desktop.get_by_role("button", name="Create another note", exact=True).click()
    expect(desktop.locator(".general-notes-list button").filter(has_text="Shopping list")).to_have_count(1)
    # The first-line title is finalized on leaving the note, without a Save button.
    assert any(row["document"] and row["document"]["title"] == "Shopping list" for row in state()["records"])
    assert text.get_attribute("data-placeholder") == "Type, or select the pen to write…"
    metrics = text.evaluate("e=>{const s=getComputedStyle(e),p=getComputedStyle(e,'::before');return [s.fontSize,p.fontSize,s.lineHeight,p.lineHeight]}")
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
    mobile.get_by_label("Open saved note", exact=True).click()
    mobile.locator(".general-notes-picker-results").get_by_role("button", name="Pump inspection", exact=True).click()
    mobile.get_by_label("Open saved note", exact=True).click()
    search = mobile.get_by_role("searchbox", name="Search note titles and text", exact=True)
    search.fill("Inspect seal")
    mobile.wait_for_timeout(200)
    assert mobile.locator(".general-notes-picker-results button").count() >= 2
    mobile.wait_for_timeout(350)
    expect(mobile.locator(".general-notes-picker-results button")).to_have_count(1)
    expect(mobile.locator(".general-notes-picker-results button")).to_have_text("Pump inspection")
    search.fill("")
    mobile.wait_for_timeout(550)
    mobile.get_by_label("Open saved note", exact=True).click()
    phone_text = mobile.get_by_role("textbox", name="Note text", exact=True)
    expect_editor(phone_text, re.compile("Inspect seal"), timeout=15000)
    expect(mobile.locator("[data-ink-layer] g")).to_have_count(1)
    expect(mobile.get_by_role("button", name="Delete saved note", exact=True)).to_be_enabled()
    desktop.get_by_label("Open saved note", exact=True).click()
    desktop.locator(".general-notes-picker-results").get_by_role("button", name="Pump inspection", exact=True).click()
    phone_text.fill(phone_text.evaluate("e=>e.textContent") + "\nPhone update")
    synced(mobile)
    desktop.evaluate("window.dispatchEvent(new Event('focus'))")
    expect_editor(text, phone_text.evaluate("e=>e.textContent"), timeout=15000)
    protocol = mobile_context.new_cdp_session(mobile)
    phone_text.click()
    protocol.send("Input.imeSetComposition", {"text": "Recognized handwriting", "selectionStart": 22, "selectionEnd": 22})
    protocol.send("Input.insertText", {"text": "Recognized handwriting"})
    phone_text.dispatch_event("pointerdown", {"pointerType": "pen", "buttons": 1, "bubbles": True})
    expect(mobile.get_by_role("button", name="Text and keyboard handwriting", exact=True)).to_have_attribute("aria-pressed", "true")
    assert phone_text.evaluate("e=>e.isContentEditable")
    mobile.get_by_role("button", name="Handwritten ink", exact=True).click()
    mobile.get_by_role("button", name="Close settings", exact=True).click()
    mobile.set_viewport_size({"width": 390, "height": 620})
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
    other.get_by_label("Open saved note", exact=True).click()
    assert other.locator(".general-notes-picker-results button").count() == 0
    expect(other.get_by_role("button", name="Delete saved note", exact=True)).to_be_disabled()
    desktop.get_by_role("button", name="Create another note", exact=True).click()
    title.fill("Linked note")
    text.fill("@Fix")
    text.press("End")
    desktop.get_by_role("option").filter(has_text="Fixture Person").click()
    expect_editor(text, "@Fixture ")
    for query, label in [("@Front", "Front Desk"), ("@Lob", "Lobby"), ("@Pa", "Pat"), ("@321", "WO#321")]:
        text.press("Control+End")
        desktop.keyboard.type(query)
        desktop.get_by_role("option").filter(has_text=label).click()
    text.press("Control+End")
    desktop.keyboard.type("https://example.invalid/manual")
    synced(desktop)
    linked_text = text.evaluate("e=>e.textContent")
    expect(desktop.locator(".general-notes-rich-layer a[href='https://example.invalid/manual']")).to_have_attribute("target", "_blank")
    expect(desktop.locator(".general-notes-rich-layer a[href='/work-orders/00000000-0000-4000-8000-000000000321']")).to_have_attribute("aria-label", "@321")
    desktop_context.route("https://example.invalid/**", lambda route: route.fulfill(content_type="text/html", body="<title>Fixture manual</title>"))
    with desktop.expect_popup() as opened:
        desktop.locator(".general-notes-rich-layer a[href='https://example.invalid/manual']").click()
    opened.value.wait_for_load_state()
    assert opened.value.url == "https://example.invalid/manual"
    opened.value.close()
    desktop.reload()
    expect_editor(text, linked_text)
    expect(desktop.locator(".general-notes-text [data-note-mention='location']")).to_have_text("@Lobby")
    linked_record = next(r for r in state()["records"] if r["document"] and r["document"]["title"] == "Linked note")
    assert len(linked_record["document"]["mentions"]) == 5
    assert mobile.get_by_role("button", name="Text and keyboard handwriting", exact=True).bounding_box()["width"] == 44
    desktop.get_by_role("button", name="Create another note", exact=True).click()
    title.fill("Styled note")
    text.fill("Small blue and large gold")
    open_settings(desktop)
    select_text(text, 0, 10)
    desktop.get_by_label("Text size", exact=True).select_option("12")
    desktop.get_by_role("button", name="sky text", exact=True).click()
    blue = desktop.get_by_role("button", name="sky text", exact=True).evaluate("e=>getComputedStyle(e).backgroundColor")
    expect(text.locator("span").filter(has_text="Small blue")).to_have_css("font-size", "12px")
    expect(text.locator("span").filter(has_text="Small blue")).to_have_css("color", blue)
    select_text(text, 15, 25)
    desktop.get_by_label("Text size", exact=True).select_option("24")
    desktop.get_by_role("button", name="apricot text", exact=True).click()
    gold = desktop.get_by_role("button", name="apricot text", exact=True).evaluate("e=>getComputedStyle(e).backgroundColor")
    expect(text.locator("span").filter(has_text="large gold")).to_have_css("font-size", "24px")
    expect(text.locator("span").filter(has_text="large gold")).to_have_css("color", gold)
    select_text(text, 0, 5)
    desktop.get_by_label("Text size", exact=True).select_option("18")
    expect(text.locator("span").filter(has_text="Small")).to_have_css("color", blue)
    text.press("Control+z")
    expect(text.locator("span").filter(has_text="Small blue")).to_have_css("font-size", "12px")
    text.press("Control+Shift+z")
    expect(text.locator("span").filter(has_text="Small")).to_have_css("font-size", "18px")
    select_text(text, 25, 25)
    desktop.get_by_label("Text size", exact=True).select_option("22")
    desktop.get_by_role("button", name="orchid text", exact=True).click()
    text.press("End")
    desktop.keyboard.type(" tail")
    expect(text.locator("span").filter(has_text="tail")).to_have_css("font-size", "22px")
    text.press("Control+z")
    expect_editor(text, "Small blue and large gold")
    text.press("Control+Shift+z")
    expect_editor(text, "Small blue and large gold tail")
    text.press("Control+z")
    expect_editor(text, "Small blue and large gold")
    synced(desktop)
    desktop.reload()
    expect_editor(text, "Small blue and large gold")
    expect(text.locator("span").filter(has_text="large gold")).to_have_css("font-size", "24px")
    expect(text.locator("span").filter(has_text="large gold")).to_have_css("color", gold)
    # A second independent device receives formatting without sharing local storage.
    mobile.reload()
    expect_editor(phone_text, "Small blue and large gold")
    expect(phone_text.locator("span").filter(has_text="Small")).to_have_css("font-size", "18px")
    expect(phone_text.locator("span").filter(has_text="Small")).to_have_css("color", blue)
    # Resize only the list labels, leaving markers outside the selection.
    other.get_by_role("button", name="Create another note", exact=True).click()
    other.locator("#general-note-title").fill("Delete me")
    list_text = other.get_by_role("textbox", name="Note text", exact=True)
    list_text.fill("☐ Small item\n• Bullet item")
    open_settings(other)
    select_text(list_text, 2, 12)
    other.get_by_label("Text size", exact=True).select_option("8")
    small_check = other.get_by_role("checkbox", name="Small item", exact=True).locator("svg").bounding_box()["width"]
    select_text(list_text, 2, 12)
    other.get_by_label("Text size", exact=True).select_option("24")
    big_check = other.get_by_role("checkbox", name="Small item", exact=True).locator("svg").bounding_box()["width"]
    assert big_check > small_check * 2.5, (small_check, big_check)
    bullet_label = "☐ Small item\n• Bullet item".index("Bullet")
    select_text(list_text, bullet_label, bullet_label + 11)
    other.get_by_label("Text size", exact=True).select_option("8")
    bullet = list_text.locator("[data-note-list-marker]").filter(has_text="•")
    small_bullet = bullet.bounding_box()["width"]
    select_text(list_text, bullet_label, bullet_label + 11)
    other.get_by_label("Text size", exact=True).select_option("24")
    big_bullet = bullet.bounding_box()["width"]
    assert big_bullet > small_bullet * 2.5, (small_bullet, big_bullet)
    synced(other)
    if os.environ.get("CMPRI_NOTES_SCREENSHOTS"):
        other.screenshot(path=str(Path(os.environ["CMPRI_NOTES_SCREENSHOTS"]) / "cmpri-notes-scaled-markers.png"))
    expect(other.get_by_role("button", name="Delete saved note", exact=True)).to_be_enabled()
    delete_context, delete_desktop = device(USER_B)
    delete_field = delete_desktop.get_by_role("textbox", name="Note text", exact=True)
    expect_editor(delete_field, "☐ Small item\n• Bullet item")
    assert delete_desktop.get_by_role("checkbox", name="Small item", exact=True).locator("svg").bounding_box()["width"] > small_check * 2.5
    expect(delete_field.locator("[data-note-list-marker]").filter(has_text="•")).to_have_css("font-size", "24px")
    delete_desktop.get_by_role("button", name="Delete saved note", exact=True).click()
    deletion = delete_desktop.get_by_role("alertdialog", name="Delete saved note?", exact=True)
    deletion.get_by_role("button", name="Cancel", exact=True).click()
    expect_editor(delete_field, "☐ Small item\n• Bullet item")
    delete_desktop.get_by_role("button", name="Delete saved note", exact=True).click()
    deletion.get_by_role("button", name="Delete", exact=True).click()
    expect_editor(delete_field, "")
    assert all(row["document"] is None for row in state()["records"] if row["user_id"] == USER_B)
    other.reload()
    try:
        synced(other)
        expect_editor(list_text, "")
        expect(other.get_by_role("button", name="Delete saved note", exact=True)).to_be_disabled()
    except Exception:
        print("DELETE_DIAGNOSTICS", json.dumps({"text":list_text.evaluate("e=>e.textContent"),"status":other.get_by_role("status").all_text_contents(),"records":[r for r in state()["records"] if r["user_id"]==USER_B],"outbox":other.evaluate("Object.fromEntries(Object.keys(localStorage).filter(k=>k.endsWith(':outbox')).map(k=>[k,localStorage.getItem(k)]))")}),flush=True)
        raise
    other.locator("#general-note-title").fill("Mobile delete")
    list_text.fill("Delete directly after autosave")
    synced(other)
    other.get_by_role("button", name="Delete saved note", exact=True).tap()
    other.get_by_role("alertdialog", name="Delete saved note?", exact=True).get_by_role("button", name="Delete", exact=True).tap()
    expect_editor(list_text, "")
    other.reload()
    expect_editor(list_text, "")
    deleted = [row for row in state()["records"] if row["user_id"] == USER_B]
    assert len(deleted) == 2 and all(row["deleted_at"] and row["document"] is None for row in deleted)
    # A tooltip can appear on a disabled HTML button; verify actual clicks/taps
    # before the first server acknowledgement, not just after Synced.
    for page, touch in [(other, True), (delete_desktop, False)]:
        page.get_by_role("button", name="Create another note", exact=True).click()
        field = page.get_by_role("textbox", name="Note text", exact=True)
        flags["notes_hang"] = True
        field.fill("First line title\nBody")
        expect(page.locator("#general-note-title")).to_have_value("First line title")
        early_trash = page.get_by_role("button", name="Delete saved note", exact=True)
        expect(early_trash).to_be_enabled()
        if touch:
            early_trash.tap()
        else:
            early_trash.hover()
            early_trash.click()
        dialog = page.get_by_role("alertdialog", name="Delete saved note?", exact=True)
        expect(dialog).to_be_visible()
        dialog.get_by_role("button", name="Cancel", exact=True).click()
        flags["notes_hang"] = False
        for pending_save in pending_saves:
            try:
                pending_save.fulfill(status=503, json={"error":"Retry fixture"})
            except Exception:
                pass
        pending_saves.clear()
        field.fill("Changed first line\nBody")
        expect(page.locator("#general-note-title")).to_have_value("Changed first line")
        synced(page)
        assert any(row["document"] and row["document"]["title"] == "Changed first line" for row in state()["records"] if row["user_id"]==USER_B)
        page.locator("#general-note-title").fill("Manual title")
        field.fill("Another first line\nBody")
        expect(page.locator("#general-note-title")).to_have_value("Manual title")
        if touch:
            early_trash.tap()
        else:
            early_trash.click()
        dialog.get_by_role("button", name="Delete", exact=True).click()
        expect_editor(field, "")
    delete_context.close()
    resize_host = desktop_context.new_page()
    resize_host.on("pageerror", lambda error: errors.append(str(error)))
    resize_host.goto(BASE + "/engineering")
    resize_host.locator(".cmpri-header-v23 [data-key='/notes']").click()
    expect(resize_host.locator("[data-cmpri-desktop-window='/notes']")).to_be_visible()
    frame = resize_host.frame_locator('iframe[title="Notes"]')
    expect(frame.locator("#general-note-title")).to_be_enabled()
    frame.get_by_role("button", name="Create another note", exact=True).click()
    flags["notes_unavailable"] = True
    resize_text = frame.get_by_role("textbox", name="Note text", exact=True)
    resize_text.fill("Unsynced resize draft")
    identity = frame.locator("html").evaluate("()=>window.__resizeIdentity=crypto.randomUUID()")
    flags["session_unavailable"] = True
    resize_host.wait_for_timeout(15100)  # Exercise the real 15-second session-recheck boundary.
    for width, height in [(640, 560), (1100, 740), (510, 520), (900, 650)]:
        handle = resize_host.locator("[data-cmpri-desktop-window='/notes'] .cmpri-desktop-resize-se")
        box = handle.bounding_box()
        modal = resize_host.locator("[data-cmpri-desktop-window='/notes']").bounding_box()
        resize_host.mouse.move(box["x"] + box["width"]/2, box["y"] + box["height"]/2)
        resize_host.mouse.down()
        resize_host.mouse.move(modal["x"] + width, modal["y"] + height, steps=8)
        resize_host.mouse.up()
        frame.locator("html").evaluate("()=>window.dispatchEvent(new Event('focus'))")
        expect_editor(resize_text, "Unsynced resize draft")
        assert frame.locator("html").evaluate("()=>window.__resizeIdentity") == identity
    expect(frame.locator(".general-notes-session-notice")).to_contain_text("temporarily unavailable")
    assert frame.get_by_text("Sign in to CMPRI to use your notebook.").count() == 0
    assert frame.locator("html").evaluate("()=>Object.keys(localStorage).some(k=>k.endsWith(':outbox')&&localStorage.getItem(k).includes('Unsynced resize draft'))")
    flags["notes_unavailable"] = False
    flags["session_unavailable"] = False
    frame.locator("html").evaluate("()=>location.reload()")
    expect_editor(frame.get_by_role("textbox", name="Note text", exact=True), "Unsynced resize draft", timeout=15000)
    try:
        synced(frame)
    except Exception:
        print("RESIZE_DIAGNOSTICS", json.dumps({"requests": session_trace, "errors": errors, "frame": frame.locator("html").evaluate("async()=>({url:location.href,ready:document.readyState,keys:Object.keys(sessionStorage),locks:await navigator.locks.query(),resources:performance.getEntriesByType('resource').map(e=>new URL(e.name).pathname).filter(p=>p.includes('/api/'))})")}), flush=True)
        raise
    resize_host.close()
    dashboard_mobile = mobile_context.new_page()
    dashboard_mobile.goto(BASE + "/engineering")
    mobile_launcher = dashboard_mobile.get_by_role("button", name="Notes", exact=True)
    # Direct mobile entry remains available even when Operations is collapsed.
    expect(mobile_launcher.first).to_be_visible()
    flags["session_restart"] = True
    mobile_launcher.first.click()
    expect(dashboard_mobile.frame_locator('iframe[title="Notes"]').locator("#general-note-title")).to_be_enabled(timeout=15000)
    mobile_frame = dashboard_mobile.frame_locator('iframe[title="Notes"]')
    mobile_frame.get_by_role("button", name="Create another note", exact=True).click()
    closing_text = mobile_frame.get_by_role("textbox", name="Note text", exact=True)
    flags["notes_unavailable"] = True
    flags["notes_hang"] = True
    closing_text.fill("Protected mobile close")
    closing_text.dispatch_event("compositionstart")
    dashboard_mobile.get_by_role("button", name="Close Notes", exact=True).click()
    expect(dashboard_mobile.locator("iframe[title='Notes']")).to_have_count(0, timeout=5000)
    flags["notes_unavailable"] = False
    flags["notes_hang"] = False
    for pending_save in pending_saves:
        try:
            pending_save.fulfill(status=503, json={"error":"Temporary connection failure"})
        except Exception:
            pass  # The closed frame may already have cancelled its connection.
    mobile_launcher.first.click()
    expect_editor(mobile_frame.get_by_role("textbox", name="Note text", exact=True), "Protected mobile close", timeout=15000)
    synced(mobile_frame)
    trash = mobile_frame.get_by_role("button", name="Delete saved note", exact=True)
    target = trash.bounding_box()
    hit = trash.evaluate("e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===e}")
    assert hit, "Trash is covered inside the mobile modal"
    trash.tap()
    inline_delete = mobile_frame.get_by_role("alertdialog", name="Delete saved note?", exact=True)
    expect(inline_delete).to_be_visible()
    inline_delete.get_by_role("button", name="Cancel", exact=True).tap()
    trash.tap()
    inline_delete.get_by_role("button", name="Delete", exact=True).tap()
    expect_editor(mobile_frame.get_by_role("textbox", name="Note text", exact=True), "")
    dashboard_mobile.get_by_role("button", name="Close Notes", exact=True).click()
    expect(dashboard_mobile.locator("iframe[title='Notes']")).to_have_count(0, timeout=5000)
    dashboard_mobile.close()
    screenshots = os.environ.get("CMPRI_NOTES_SCREENSHOTS")
    if screenshots:
        output = Path(screenshots)
        output.mkdir(parents=True, exist_ok=True)
        mobile.set_viewport_size({"width": 390, "height": 844})
        open_settings(mobile)
        mobile.screenshot(path=str(output / "cmpri-notes-autosave-text.png"))
        mobile.get_by_role("button", name="Handwritten ink", exact=True).click()
        mobile.screenshot(path=str(output / "cmpri-notes-autosave-pen.png"))
        mobile.get_by_role("button", name="Create another note", exact=True).click()
        mobile.screenshot(path=str(output / "cmpri-notes-compact-empty.png"))
    assert not errors, errors
    browser.close()
    print("PASS: actual note API + isolated PostgreSQL, independent desktop/mobile contexts, autosave coalescing, first-line/Untitled titles, multiple notes, ink retention, headerless lists, placeholder metrics, desktop-scaled controls and bubbles, visually scaled checkbox/dot for label-only formatting, direct autosaved-note deletion with inline confirmation, size-matched clickable checkboxes, preserved mention identities, clickable URLs, mobile close during stalled sync/IME, contained compact title picker, 500ms title/body search, mobile dashboard launcher, actual desktop resize handles, legacy/current cache session restarts, unruled page, five approved dock icons, resize/session failure recovery, trash placement, account isolation, gestures and IME input.")
