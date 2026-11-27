"""Verify that both dashboard launchers toggle the same cached Weather window."""

import asyncio
import os

from cmpri_fixture import BASE, UID, async_playwright, expect, install


async def expect_weather_open(page, opened):
    await page.wait_for_function(
        "opened => document.querySelector('[data-weather-cached-window] iframe')?.contentWindow"
        ".weatherPreview?.getState().opened === opened",
        arg=opened,
    )


async def verify(browser, path, role):
    context = await browser.new_context(
        viewport={"width": 1440, "height": 920}, service_workers="block", reduced_motion="reduce",
    )
    await install(context, role)
    await context.route_web_socket("wss://**", lambda socket: socket.close())
    await context.add_init_script(f"""
        localStorage.setItem('cmpri:beginners-guide:opened:{UID}', '1');
        sessionStorage.setItem('cmpri:beginners-guide:session:{UID}', '1');
    """)
    page = await context.new_page()
    await page.goto(BASE + path, wait_until="domcontentloaded")
    tab = page.get_by_role("button", name="Safety & Logs", exact=True)
    await expect(tab).to_be_visible(timeout=25000)
    group = tab.locator("xpath=ancestor::fieldset[1]")
    if await tab.get_attribute("aria-expanded") != "true" or await group.get_attribute("data-active") != "true":
        await tab.click()
    button = group.get_by_role("button", name="Weather", exact=True)
    dial = page.locator("[data-cmpri-weather-dial]")
    modal = page.locator("[data-weather-cached-window]")
    frame = modal.locator("iframe")

    await dial.click(position={"x": 116, "y": 30})
    await expect(modal).to_have_attribute("data-weather-visible", "true", timeout=10000)
    await expect(frame).to_be_visible()
    await expect_weather_open(page, True)
    await frame.evaluate("node => { window.originalWeatherFrame = node; }")

    await button.click()
    await expect(modal).to_have_attribute("data-weather-visible", "false", timeout=3000)
    await expect(frame).to_be_hidden()
    await expect_weather_open(page, False)

    await button.click()
    await expect(modal).to_have_attribute("data-weather-visible", "true")
    await expect(frame).to_be_visible()
    await expect_weather_open(page, True)
    assert await frame.evaluate("node => node === window.originalWeatherFrame")

    # Test an established window beyond the general launchers' quick-close interval.
    await page.evaluate("() => { const now = Date.now.bind(Date); Date.now = () => now() + 6000; }")
    await dial.click(position={"x": 116, "y": 30})
    await expect(modal).to_have_attribute("data-weather-visible", "false", timeout=3000)
    await expect(frame).to_be_hidden()
    await expect_weather_open(page, False)

    await dial.click(position={"x": 116, "y": 30})
    await expect(modal).to_have_attribute("data-weather-visible", "true")
    await expect_weather_open(page, True)
    await expect(modal).to_have_count(1)
    assert await frame.evaluate("node => node === window.originalWeatherFrame")
    await expect(tab).to_have_attribute("aria-expanded", "true")
    await context.close()
    print(f"{path}: both launchers toggle one cached Weather window", flush=True)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), args=["--no-sandbox"],
        )
        await verify(browser, "/engineering", "chief_engineer")
        await verify(browser, "/technician", "technician")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
