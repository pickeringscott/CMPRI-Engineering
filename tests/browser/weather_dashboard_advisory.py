"""Verify the advisory's native dashboard tab layout with fixture sessions."""

import asyncio
import os
import time

from cmpri_fixture import BASE, UID, async_playwright, expect, install


async def verify(browser, role, width):
    mobile = width < 640
    context = await browser.new_context(
        viewport={"width": width, "height": 900},
        is_mobile=mobile,
        has_touch=mobile,
        service_workers="block",
    )
    await install(context, role)
    await context.route_web_socket("wss://**", lambda socket: socket.close())
    await context.add_init_script(f"""
        localStorage.setItem('cmpri:beginners-guide:opened:{UID}', '1');
        sessionStorage.setItem('cmpri:beginners-guide:session:{UID}', '1');
    """)
    advisory = None

    async def snapshot(route):
        assert route.request.method == "GET"
        await route.fulfill(json={
            "alert": advisory,
            "publicationId": "advisory-fixture" if advisory else None,
            "revision": "advisory-fixture:clear" if advisory else "none:clear",
            "nwsActive": False,
        })

    await context.route("**/api/weather-preview/manual-alert*", snapshot)
    page = await context.new_page()
    path = {"front_desk": "/front-desk", "technician": "/technician"}.get(role, "/engineering")
    await page.goto(BASE + path, wait_until="domcontentloaded")
    rail = page.locator(".cmpri-dashboard-menu-rail")
    safety = rail.get_by_role("button", name="Safety & Logs", exact=True)
    await expect(safety).to_be_visible(timeout=25000)
    await (safety.tap() if mobile else safety.click())
    await expect(safety).to_have_attribute("aria-expanded", "true")
    await safety.evaluate("node => { window.originalSafetyTab = node; }")

    advisory = {
        "severity": "advisory", "custom": True, "override": False, "attention": False,
        "text": "Use caution on the sidewalks. The full message continues across the banner.",
        "color": "#302600", "textColor": "#ffe36c", "expires": int((time.time() + 3600) * 1000),
    }
    heading = rail.locator("[data-weather-advisory-heading-host]")
    await expect(heading.get_by_text("Property Advisory", exact=True)).to_be_visible(timeout=12000)
    assert await safety.evaluate("node => node === window.originalSafetyTab")
    await expect(safety).to_have_attribute("aria-expanded", "true")

    for name in ["Safety & Logs", "Account"]:
        tab = rail.get_by_role("button", name=name, exact=True)
        await tab.evaluate("node => node.scrollIntoView({block: 'nearest', inline: 'nearest'})")
        if await tab.get_attribute("aria-expanded") != "true":
            await (tab.tap() if mobile else tab.click())
        await expect(tab).to_have_attribute("aria-expanded", "true")
        geometry = await tab.evaluate("""tab => {
            const box = element => element.getBoundingClientRect();
            const panel = tab.closest('fieldset');
            const rail = tab.closest('nav');
            const bubble = box(tab), body = box(panel);
            const title = box(rail.querySelector('[data-weather-advisory-heading-host] strong'));
            const expiry = box(rail.querySelector('[data-weather-advisory-heading-host] time'));
            const ticker = box(document.querySelector('[data-weather-manual-alert-ticker]'));
            const x = Math.max(body.left, box(rail).left) + 3;
            const y = body.top + body.height / 2;
            return {
                lineError: Math.max(Math.abs(title.bottom - bubble.bottom), Math.abs(expiry.bottom - bubble.bottom)),
                horizontalAnchor: bubble.left >= body.left && bubble.left < body.right,
                verticalGap: body.top - bubble.bottom,
                tickerClearance: ticker.top - body.bottom,
                panelHit: document.elementFromPoint(x, y)?.closest('fieldset') === panel,
            };
        }""")
        assert geometry["lineError"] <= 2, geometry
        assert geometry["horizontalAnchor"] and abs(geometry["verticalGap"]) <= 3, geometry
        assert geometry["tickerClearance"] >= 0 and geometry["panelHit"], geometry

    message = page.get_by_text(advisory["text"], exact=True)
    assert await message.evaluate("node => getComputedStyle(node).animationPlayState") == "running"
    position = await message.evaluate("node => node.getBoundingClientRect().left")
    await page.wait_for_function(
        "start => document.querySelector('[data-weather-manual-alert-ticker] span').getBoundingClientRect().left !== start",
        arg=position,
    )
    advisory = None
    await expect(heading.get_by_text("Property Advisory", exact=True)).to_have_count(0, timeout=12000)
    assert abs((await rail.bounding_box())["height"] - 14) <= 1
    await context.close()
    print(f"{role} at {width}px: shared header line, anchored open panels, scrolling message below", flush=True)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox"],
        )
        await verify(browser, "chief_engineer", 1440)
        await verify(browser, "front_desk", 390)
        await verify(browser, "technician", 1100)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
