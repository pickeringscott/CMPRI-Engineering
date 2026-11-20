"""Room 124 + Open/Oldest First and browser-restart preferences; isolated APIs only."""
from cmpri_fixture import *
import re
import tempfile


async def main():
    checks = []
    async with async_playwright() as p:
        for width in [1440, 390]:
            requests = []
            errors = []
            writes = []
            examples = [
                ("room-new", "124", "Open", "2026-11-20T10:00:00Z", "Newest Room 124"),
                ("room-old-b", "124", "Open", "2026-11-18T10:00:00Z", "Old Room 124 B"),
                ("room-old-a", "124", "Open", "2026-11-18T10:00:00Z", "Old Room 124 A"),
                ("closed-room", "124", "Closed", "2026-11-01T10:00:00Z", "Closed Room 124"),
                ("long-room", "1240", "Open", "2026-11-01T10:00:00Z", "Different Room 1240"),
                ("ticket-124", "100", "Open", "2026-11-01T10:00:00Z", "Ticket number 124"),
            ]
            data = [{**orders[0], "id": item[0], "room": item[1], "status": item[2], "created_at": item[3], "issue": item[4],
                     "display_id": "124" if item[0] == "ticket-124" else str(4000 + i)} for i, item in enumerate(examples)]
            counts = {"all": 6, "open": 5, "closed": 1, "pending": 0, "progress": 0, "priority": 5, "overdue": 0, "completed": 0}

            async def intercept(route):
                parsed = urlparse(route.request.url)
                if parsed.path != "/api/work-orders":
                    return await route.fallback()
                assert route.request.method == "GET", "No work-order writes are authorized in this test"
                q = parse_qs(parsed.query)
                requests.append(q)
                rows = data[:]
                selected = q.get("filter", ["all"])[0]
                if selected == "open":
                    rows = [row for row in rows if row["status"] in ["Open", "In Progress", "Done"]]
                elif selected == "closed":
                    rows = [row for row in rows if row["status"] in ["Closed", "Will Not Do"]]
                query = q.get("q", [""])[0].strip().lower()
                if query:
                    rows = [row for row in rows if row["room"].lower() == query]
                if q.get("sort", ["default"])[0] == "created-oldest":
                    rows.sort(key=lambda row: (row["created_at"], row["id"]))
                return await route.fulfill(json={"work_orders": rows, "total": len(rows), "counts": counts})

            with tempfile.TemporaryDirectory(prefix=f"room-search-{width}-", dir=OUT) as profile:
                async def launch():
                    context = await p.chromium.launch_persistent_context(profile, executable_path="/usr/bin/chromium", args=["--no-sandbox"],
                        viewport={"width": width, "height": 960}, is_mobile=width < 640, has_touch=width < 640,
                        timezone_id="America/Chicago", service_workers="block")
                    await install(context, "chief_engineer")
                    await context.route("**/api/work-orders**", intercept)
                    await context.route_web_socket(re.compile(r"^wss://[^/]*\.supabase\.co/"), lambda socket: socket.close())
                    page = context.pages[0]
                    page.on("pageerror", lambda error: errors.append({"message": str(error), "stack": error.stack}))
                    page.on("request", lambda request: writes.append(request.url) if request.method not in ["GET", "HEAD"] and "/api/work-orders" in request.url else None)
                    await page.goto(BASE + "/engineering", timeout=60000)
                    await page.get_by_role("button", name="Work Order List", exact=True).wait_for(timeout=60000)
                    return context, page

                context, page = await launch()
                launch_button = page.get_by_role("button", name="Work Order List", exact=True)
                await launch_button.focus()
                await launch_button.press("Enter")
                modal = page.locator('[data-cmpri-desktop-window="work-order-list"]')
                await expect(modal).to_be_visible(timeout=15000)
                await expect(modal.locator("[data-preview-status]")).to_have_count(6)
                await modal.locator('[data-preview-kpi="open"]').click()
                await modal.get_by_role("combobox", name="Sort work orders").select_option("created-oldest")
                await modal.get_by_role("searchbox").fill("124")
                await expect(modal.locator("[data-preview-status]")).to_have_count(3)
                await expect(modal.locator('[data-preview-kpi="open"]')).to_have_attribute("aria-pressed", "true")
                expected = ["Old Room 124 A", "Old Room 124 B", "Newest Room 124"]

                async def verify():
                    await expect(modal.get_by_role("searchbox")).to_have_value("124")
                    await expect(modal.get_by_role("combobox", name="Sort work orders")).to_have_value("created-oldest")
                    await expect(modal.locator('[data-preview-kpi="open"]')).to_have_attribute("aria-pressed", "true")
                    await expect(modal.locator("[data-preview-status]")).to_have_count(3)
                    text = await modal.locator("[data-preview-status]").all_text_contents()
                    for row, issue in zip(text, expected):
                        assert issue in row, (width, text)
                    assert "Closed Room" not in "".join(text) and "1240" not in "".join(text) and "WO#124Open" not in "".join(text)
                    dimensions = await modal.locator('.cmpri-work-order-list').evaluate("e=>({viewport:innerWidth,width:e.clientWidth,scroll:e.scrollWidth})")
                    assert dimensions["scroll"] <= dimensions["width"] + 1, (width, dimensions)

                await verify()
                await modal.get_by_role("button", name="Close Work Order List", exact=True).click()
                await expect(modal).to_have_count(0)
                await launch_button.focus()
                await launch_button.press("Enter")
                await expect(modal).to_be_visible()
                await verify()
                await page.screenshot(path=str(OUT / f"room-124-{width}.png"))
                await context.close()

                # A real Chromium process/profile restart, not just a remounted component.
                context, page = await launch()
                modal = page.locator('[data-cmpri-desktop-window="work-order-list"]')
                await expect(modal).to_be_visible(timeout=15000)
                await verify()
                await page.screenshot(path=str(OUT / f"room-124-restarted-{width}.png"))
                await context.close()

            assert any(q.get("filter") == ["open"] and q.get("sort") == ["created-oldest"] and q.get("q") == ["124"] for q in requests), requests
            assert not writes, writes
            assert not errors, errors
            checks.append({"width": width, "exactRoom": True, "openOldestFirst": True, "modalReopen": True, "browserRestart": True, "writes": 0})
    OUT.joinpath("work-order-room-search.json").write_text(json.dumps(checks, indent=2))
    print(json.dumps({"passed": True, "checks": checks, "productionDataAccessed": False}))


asyncio.run(main())
