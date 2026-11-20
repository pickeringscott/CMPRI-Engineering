import asyncio
from urllib.parse import parse_qs, urlparse

from cmpri_fixture import BASE, async_playwright, expect, install, reveal_dashboard_launcher


async def check_technician_windows(browser, width):
    touch = width < 640
    context = await browser.new_context(
        viewport={"width": width, "height": 850},
        has_touch=touch, is_mobile=touch, service_workers="block",
    )
    await install(context, "technician")
    page = await context.new_page()
    await page.goto(BASE + "/technician", wait_until="domcontentloaded")

    async def activate(locator):
        await (locator.tap() if touch else locator.click())

    rail = page.get_by_role("navigation", name="Open dashboard windows")
    safety = rail.get_by_role("button", name="Safety & Logs", exact=True)
    daily = rail.get_by_role("button", name="Daily Work", exact=True)
    await expect(safety).to_be_visible(timeout=60000)
    await activate(safety)
    await activate(rail.get_by_role("button", name="Weather", exact=True))

    weather = page.locator('[data-cmpri-desktop-window="/previews/cmpri-weather-preview.html"]')
    cached_weather = page.locator("[data-weather-cached-window]")
    await expect(weather).to_be_visible()
    frame = weather.locator('iframe[title="Weather"]')
    query = parse_qs(urlparse(await frame.get_attribute("src")).query)
    assert query["embedded"] == ["1"] and query.get("modalToken") and query["clock"] == ["12"]
    await frame.evaluate("frame => frame.dataset.retentionCheck = 'initial'")

    header = page.locator("header:has(nav[aria-label='Open dashboard windows'])")
    header_bounds = await header.bounding_box()
    weather_bounds = await weather.bounding_box()
    assert weather_bounds["y"] >= header_bounds["y"] + header_bounds["height"] - 1
    bell = header.locator(".cmpri-approved-bell")
    await activate(bell)
    await expect(page.get_by_role("heading", name="Active notifications", exact=False)).to_be_visible()
    await expect(weather).to_be_visible()

    async with page.expect_response(lambda response: (
        "/api/work-orders?" in response.url and "filter=all" in response.url
    )) as pending_response:
        await activate(daily)
        await activate(rail.get_by_role("button", name="Work Order List", exact=True))
    assert (await pending_response.value).ok
    work_orders = page.get_by_role("dialog", name="Work Order List", exact=True)
    await expect(work_orders).to_be_visible()
    await expect(work_orders.get_by_role("button", name="Open work order", exact=False).first).to_be_visible()
    await expect(work_orders).to_have_attribute("aria-modal", "false")
    await expect(weather).to_be_visible()
    await expect(safety).to_have_attribute("aria-expanded", "true")
    await expect(daily).to_have_attribute("aria-expanded", "true")

    await activate(work_orders.get_by_role("button", name="Open work order", exact=False).first)
    detail = page.locator('[data-cmpri-desktop-window^="/work-orders/"]')
    await expect(detail).to_be_visible()
    detail_query = parse_qs(urlparse(await detail.locator("iframe").get_attribute("src")).query)
    assert detail_query["embedded"] == ["1"] and detail_query.get("modalToken")
    await expect(detail.frame_locator("iframe").get_by_title("Fixture drain needs repair", exact=True)).to_be_visible(timeout=60000)
    await activate(detail.get_by_role("button", name="Close Work Order", exact=False))
    await expect(detail).to_have_count(0)
    await expect(work_orders).to_be_visible()
    await activate(work_orders.get_by_role("button", name="Close Work Order List", exact=True))
    await activate(weather.get_by_role("button", name="Close Weather", exact=True))
    await expect(cached_weather).to_have_attribute("data-weather-visible", "false")
    await page.wait_for_function("""() => {
      const saved = Object.entries(localStorage).find(([key]) => key.startsWith('cmpri:workspace:v1:'));
      return saved && !JSON.parse(saved[1]).modals.views.some(view => view.href?.startsWith('/previews/cmpri-weather-preview.html'));
    }""")
    await expect(frame).to_have_attribute("data-retention-check", "initial")
    await activate(safety)
    await activate(rail.get_by_role("button", name="Weather", exact=True))
    await expect(cached_weather).to_have_attribute("data-weather-visible", "true")
    await expect(frame).to_have_attribute("data-retention-check", "initial")
    await expect(page.locator("[data-cmpri-global-modal-shell]")).to_have_count(0)
    await context.close()
    print(f"Technician modeless Weather, bell, Work Order List, and retained reopen at {width}px verified", flush=True)


async def check_embedded_technician_list(browser):
    context = await browser.new_context(viewport={"width": 1440, "height": 850}, service_workers="block")
    await install(context, "technician")
    page = await context.new_page()
    await page.goto(BASE + "/engineering", wait_until="domcontentloaded")
    daily = page.get_by_role("button", name="Daily Work", exact=True)
    await expect(daily).to_be_visible(timeout=60000)
    await daily.click()
    await page.get_by_role("button", name="Technician Dashboard", exact=True).click()
    technician = page.locator('[data-cmpri-desktop-window="/technician"]')
    await expect(technician).to_be_visible()
    iframe = technician.frame_locator('iframe[title="Technician Dashboard"]')
    await (await reveal_dashboard_launcher(iframe.get_by_role("button", name="Work Order List", exact=True))).click()
    await expect(page.get_by_role("dialog", name="Work Order List", exact=True)).to_be_visible()
    await expect(technician).to_be_visible()
    await context.close()
    print("Embedded Technician opens the Engineering Work Order List alongside its own window", flush=True)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        for width in (1440, 390):
            await check_technician_windows(browser, width)
        await check_embedded_technician_list(browser)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
