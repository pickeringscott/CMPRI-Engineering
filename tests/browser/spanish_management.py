"""Spanish management UI and safe language switching, with isolated API doubles.

CMPRI_UI_BASE=http://127.0.0.1:PORT CMPRI_UI_OUTPUT=/tmp/cmpri-spanish-management \
  python tests/browser/spanish_management.py
No real database, account, push, notification permission or external service is used.
"""
import asyncio
import base64
import copy
import json
import re
import time
from urllib.parse import parse_qs, urlparse

from cmpri_fixture import BASE, HOTEL, OUT, UID, install
from playwright.async_api import async_playwright, expect

OTHER = "00000000-0000-4000-8000-000000000099"
NOTE = "00000000-0000-4000-8000-000000000101"
ITEM = "00000000-0000-4000-8000-000000000023"
LOCATION = "00000000-0000-4000-8000-000000000021"
NOTE_KEY = f"cmpri:general-notes:v1:{HOTEL}:{UID}"
USER_TEXT = "☐ Inspect seal\n• Leave this English staff note unchanged"


async def verify_width(browser, width):
    state = {"language": "es", "writes": [], "errors": []}
    user = {"id": OTHER, "email": "lead@example.invalid", "full_name": "Fixture Lead",
            "role": "housekeeping", "secondary_roles": [], "active": True, "can_manage": True}
    note = {"id": NOTE, "title": "Inspection checklist", "text": USER_TEXT, "fontSize": 16,
            "textStyles": [{"start": 2, "end": 14, "fontSize": 24, "color": "rgb(20, 100, 200)"}],
            "strokes": [], "revision": 1, "updated": 1, "titleAutomatic": False}
    item = {"id": ITEM, "item_name": "Bromine", "item_type": "Chemical", "inventory_revision": 1,
            "storage_location_id": LOCATION, "storage_location": "Pool Pump Room", "unit_of_measure": "LB",
            "quantity_on_hand": 25, "quantity_reserved": 2, "manufacturer": "", "vendor_sku": "BR-25",
            "preferred_vendor_id": None, "reorder_level": 10, "active": True, "unit_locked": True}
    inventory = {"inventory": [item], "ideas": [], "po_options": [], "vendors": [], "contacts": [],
                 "proposals": [], "compatibility": [], "assets": [], "work_order_items": [],
                 "locations": [{"id": LOCATION, "name": "Pool Pump Room", "active": True}],
                 "as_of": "2026-11-20T16:30:00Z"}
    po = {key: [] for key in ["cmpri_po_orders", "cmpri_po_lines", "cmpri_inventory_items",
                              "cmpri_po_receipts", "cmpri_po_shipments", "cmpri_po_sources"]}
    context = await browser.new_context(viewport={"width": width, "height": 1000 if width > 640 else 844},
                                        is_mobile=width < 640, has_touch=width < 640,
                                        service_workers="block", timezone_id="America/Chicago")
    await install(context, "chief_engineer")
    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")
    expiry = int(time.time()) + 7200
    token = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode({"sub": UID, "aud": "authenticated", "role": "authenticated", "exp": expiry}) + ".fixture"
    auth = {"access_token": token, "refresh_token": "fixture-refresh", "expires_at": expiry,
            "expires_in": 7200, "token_type": "bearer", "user": {"id": UID, "email": "fixture@example.invalid",
            "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}}}
    await context.add_init_script("sessionStorage.setItem('cmpri:auth:v1',%s);" % json.dumps(json.dumps(auth)))
    await context.add_init_script("localStorage.setItem(%s,%s);" % (json.dumps(NOTE_KEY + ":active-note"), json.dumps(NOTE)))

    async def api(route):
        request, url = route.request, urlparse(route.request.url)
        if url.hostname not in ("localhost", "127.0.0.1"):
            return await route.abort()
        if url.path == "/api/profile":
            assert request.method == "GET", "Language switch uses acknowledged fixture state only"
            return await route.fulfill(json={"profile": {"id": UID, "full_name": "Fixture Manager", "role": "chief_engineer"},
                                            "preferences": {"language": state["language"], "appearance": "dark"},
                                            "profile_settings_available": True})
        if url.path == "/api/users":
            if request.method == "PATCH":
                body = request.post_data_json
                assert body["id"] == OTHER
                assert set(body) <= {"id", "role", "active"}
                if "role" in body:
                    assert body["role"] in ("Lead Housekeeper", "Front Desk"), "Translated role must never be submitted"
                state["writes"].append({"path": url.path, "body": copy.deepcopy(body)})
                user.update({key: value for key, value in body.items() if key not in ("id", "role")})
                if "role" in body:
                    user["role"] = {"Lead Housekeeper": "housekeeping", "Front Desk": "front_desk"}[body["role"]]
                return await route.fulfill(json={"user": copy.deepcopy(user)})
            return await route.fulfill(json={"users": [copy.deepcopy(user)], "assignable_roles": ["Lead Housekeeper", "Front Desk"]})
        if url.path == "/api/notes/targets":
            return await route.fulfill(json={"mentions": []})
        if url.path == "/api/notes":
            if request.method == "PUT":
                body = request.post_data_json
                state["writes"].append({"path": url.path, "body": copy.deepcopy(body)})
                assert body["id"] == NOTE
                assert body["document"]["title"] == "Inspection checklist", "User note title must not be translated"
                assert body["document"]["textStyles"] == note["textStyles"], "Language must preserve rich formatting"
                note.update(copy.deepcopy(body["document"]))
                note.update(revision=note["revision"] + 1, updated=note["updated"] + 1)
                return await route.fulfill(json={"note": copy.deepcopy(note)})
            return await route.fulfill(json={"note": copy.deepcopy(note)} if "id" in parse_qs(url.query) else {"notes": [copy.deepcopy(note)]})
        if url.path == "/api/engineering/catalog":
            if request.method == "POST":
                body = request.post_data_json
                state["writes"].append({"path": url.path, "body": copy.deepcopy(body)})
                assert body["kind"] == "inventory" and body["item_type"] == "Chemical"
                assert body["storage_location_id"] == LOCATION and body["unit_of_measure"] == "LB"
                assert body["item_name"] == "New pool chemical" and body["reason"] == "Counted delivery"
                created = {**body, "id": body["request_id"], "storage_location": "Pool Pump Room", "inventory_revision": 1,
                           "quantity_reserved": 0, "unit_locked": True, "active": True}
                inventory["inventory"].append(created)
                return await route.fulfill(json={"inventory_item": created})
            return await route.fulfill(json=copy.deepcopy(inventory))
        if url.path.startswith("/api/engineering/inventory/"):
            return await route.fulfill(json={"item": copy.deepcopy(item), "notes": [], "has_more": False})
        if url.path == "/api/engineering/purchase-orders":
            if request.method == "POST":
                body = request.post_data_json
                state["writes"].append({"path": url.path, "body": copy.deepcopy(body)})
                assert body["action"] == "manual" and body["supplier"] == "Fixture Vendor"
                assert body["description"] == "Valve cartridge" and body["uom"] == "EA"
                assert body["quantity"] == 2
                po["cmpri_po_orders"].append({"id": body["id"], "external_reference": body["reference"],
                    "supplier": body["supplier"], "origin": "manual", "acceptance": "accepted", "acceptance_note": None})
                return await route.fulfill(json={"ok": True})
            return await route.fulfill(json=copy.deepcopy(po))
        if url.path.startswith("/api/") and request.method not in ("GET", "HEAD"):
            raise AssertionError("Unexpected write: " + url.path)
        return await route.fallback()

    await context.route("**/*", api)
    await context.route_web_socket(re.compile(r"^wss?://"), lambda socket: socket.close())
    page = await context.new_page()
    page.on("pageerror", lambda error: state["errors"].append(str(error)))

    async def switch(language):
        state["language"] = language
        await page.evaluate("language=>window.postMessage({type:'cmpri-profile-preferences-updated',preferences:{language,appearance:'dark'}},window.location.origin)", language)
        await expect(page.locator("html")).to_have_attribute("lang", language)

    async def capture(section):
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow: {section}, {width}"
        await page.screenshot(path=str(OUT / f"spanish-management-{section}-{width}.png"), full_page=True)

    await page.goto(BASE + "/management/users", wait_until="domcontentloaded")
    await expect(page.get_by_role("heading", name="Administración de usuarios", exact=True)).to_be_visible(timeout=60000)
    await expect(page.get_by_text("Usuarios activos: 1", exact=True)).to_be_visible()
    await expect(page.get_by_role("textbox", name="Nombre completo", exact=True)).to_be_visible()
    await expect(page.get_by_role("textbox", name="Correo electrónico", exact=True)).to_be_visible()
    await expect(page.get_by_role("button", name="Invitar usuario", exact=True)).to_be_visible()
    await expect(page.get_by_text("Rol de autorización", exact=True)).to_be_visible()
    await expect(page.get_by_role("button", name="Desactivar", exact=True)).to_be_visible()
    roles = page.get_by_role("combobox")
    await expect(roles.nth(1)).to_have_value("Supervisor de limpieza")
    await roles.nth(1).click()
    await expect(page.get_by_role("option", name="Supervisor de limpieza", exact=True)).to_have_count(1)
    await page.get_by_role("option", name="Recepción", exact=True).click()
    await expect(roles.nth(1)).to_have_value("Recepción")
    assert state["writes"][-1]["body"]["role"] == "Front Desk"
    await capture("users")
    await switch("en")
    await expect(page.get_by_role("heading", name="User Management", exact=True)).to_be_visible()
    await expect(roles.nth(1)).to_have_value("Front Desk")
    await switch("es")

    await page.goto(BASE + "/notes", wait_until="domcontentloaded")
    editor = page.get_by_role("textbox", name="Texto de la nota", exact=True)
    await expect(editor).to_be_visible(timeout=60000)
    await expect(editor).to_have_js_property("textContent", USER_TEXT)
    await expect(page.get_by_role("region", name="Cuaderno general", exact=True)).to_be_visible()
    await expect(page.get_by_role("textbox", name="Título de la nota", exact=True)).to_have_value("Inspection checklist")
    await expect(page.get_by_role("button", name="Cerrar notas", exact=True)).to_be_visible()
    await expect(page.get_by_role("button", name="Texto y escritura con teclado", exact=True)).to_be_visible()
    checkbox = page.get_by_role("checkbox", name="Inspect seal", exact=True)
    await expect(checkbox).to_have_css("font-size", "24px")
    await expect(checkbox).to_have_css("color", "rgb(20, 100, 200)")
    await checkbox.click()
    changed = USER_TEXT.replace("☐", "☑", 1)
    await expect(editor).to_have_js_property("textContent", changed)
    await expect(checkbox).to_have_attribute("aria-checked", "true")
    await switch("en")
    editor = page.get_by_role("textbox", name="Note text", exact=True)
    await expect(editor).to_have_js_property("textContent", changed)
    await expect(page.get_by_role("textbox", name="Note Title", exact=True)).to_have_value("Inspection checklist")
    await expect(checkbox).to_have_attribute("aria-checked", "true")
    await expect(checkbox).to_have_css("font-size", "24px")
    await switch("es")
    await expect(page.get_by_role("textbox", name="Texto de la nota", exact=True)).to_have_js_property("textContent", changed)
    await page.wait_for_function("key=>!JSON.parse(localStorage.getItem(key)||'[]').length", arg=NOTE_KEY + ":outbox")
    assert note["text"] == changed
    await expect(page.locator(".general-notes-save [role=status]")).to_have_text("Sincronizado")
    await capture("notes")
    await page.reload()
    await expect(page.get_by_role("textbox", name="Texto de la nota", exact=True)).to_have_js_property("textContent", changed, timeout=60000)
    await expect(page.get_by_role("checkbox", name="Inspect seal", exact=True)).to_have_attribute("aria-checked", "true")

    await page.goto(BASE + "/engineering/parts", wait_until="domcontentloaded")
    await expect(page.get_by_role("heading", name="Catálogo de piezas", exact=True)).to_be_visible(timeout=60000)
    await expect(page.get_by_role("heading", name="Inventario", exact=True)).to_be_visible()
    await expect(page.get_by_role("searchbox", name="Buscar inventario", exact=True)).to_be_visible()
    await expect(page.get_by_role("button", name="Detalles del inventario de Bromine", exact=True)).to_be_visible()
    await page.get_by_role("button", name="Agregar inventario", exact=True).click()
    dialog = page.get_by_role("dialog", name="Agregar inventario", exact=True)
    await expect(dialog).to_be_visible()
    await dialog.get_by_role("textbox", name="Nombre del artículo del inventario", exact=True).fill("New pool chemical")
    await dialog.get_by_role("combobox", name="Tipo de inventario", exact=True).select_option("Chemical")
    await dialog.get_by_role("combobox", name="Unidad de existencias", exact=True).select_option("LB")
    await dialog.get_by_role("spinbutton", name="Cantidad inicial", exact=True).fill("8")
    await dialog.get_by_role("textbox", name="Motivo del inventario", exact=True).fill("Counted delivery")
    await dialog.get_by_role("combobox", name="Seleccionar ubicación de almacén administrada", exact=True).click()
    await page.get_by_role("option", name="Pool Pump Room", exact=True).click()
    await dialog.get_by_role("button", name="Agregar artículo al inventario", exact=True).click()
    await expect(dialog).to_have_count(0)
    await capture("inventory")
    await switch("en")
    await expect(page.get_by_role("heading", name="Parts Catalog", exact=True)).to_be_visible()
    await expect(page.get_by_role("button", name="Add Inventory", exact=True)).to_be_visible()
    await switch("es")

    await page.goto(BASE + "/engineering/purchasing", wait_until="domcontentloaded")
    await expect(page.get_by_role("heading", name="Órdenes de compra", exact=True)).to_be_visible(timeout=60000)
    await expect(page.get_by_role("textbox", name="Buscar órdenes de compra", exact=True)).to_be_visible()
    await page.get_by_role("button", name="Agregar orden manual", exact=True).click()
    form = page.get_by_role("form", name="Orden manual", exact=True)
    await expect(form).to_be_visible()
    await form.get_by_label("Proveedor / pedido mediante", exact=True).fill("Fixture Vendor")
    await form.get_by_label("Referencia externa (opcional)", exact=True).fill("CMPRI-123")
    await form.get_by_label("Artículo", exact=True).fill("Valve cartridge")
    await form.get_by_label("Cantidad pedida", exact=True).fill("2")
    await form.get_by_label("Unidad de pedido (unidad, caja, paquete)", exact=True).fill("EA")
    await switch("en")
    await expect(page.get_by_role("form", name="Manual order", exact=True).get_by_label("Item", exact=True)).to_have_value("Valve cartridge")
    await switch("es")
    await capture("purchasing")
    await page.get_by_role("button", name="Registrar orden", exact=True).click()
    await expect(page.get_by_role("form", name="Orden manual", exact=True)).to_have_count(0)
    assert any(row["path"] == "/api/engineering/purchase-orders" for row in state["writes"])
    assert not state["errors"], state["errors"]
    await context.close()
    return {"width": width, "spanishUsersNotesInventoryPurchaseOrders": True, "englishSwitchRestoresLabels": True,
            "notesTextFormattingCheckboxAndReopenPreserved": True, "canonicalRoleInventoryAndPurchasePayloads": True,
            "noHorizontalOverflow": True, "realDatabaseWrites": 0, "realPushes": 0, "pageErrors": state["errors"]}


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        results = [await verify_width(browser, width) for width in (1440, 390)]
        await browser.close()
        (OUT / "spanish-management-results.json").write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
