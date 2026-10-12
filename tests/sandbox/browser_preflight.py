import asyncio,json
from pathlib import Path
from playwright.async_api import async_playwright
from browser_support import diagnose_context,login,save_browser_diagnostics
from diagnostics import sanitize,local_secrets
OUT=Path(__file__).resolve().parents[2]/'.sandbox'
async def main():
    result={'phase':'Real browser login preflight','passed':False}
    user=json.loads((OUT/'synthetic-users.json').read_text())[0]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context(viewport={'width':1280,'height':1000},service_workers='block')
        page,evidence=await diagnose_context(context,OUT,user['label'])
        try:
            await login(page,user)
            await page.goto('http://127.0.0.1:3112/work-orders',timeout=45000)
            await page.get_by_placeholder('Example: 316 not cooling').wait_for(timeout=30000)
            assert not evidence['pageErrors'],evidence['pageErrors']
            assert not evidence['blockedExternal'],evidence['blockedExternal']
            result['passed']=True
        except Exception as e:result['error']=str(e)
        finally:
            await save_browser_diagnostics(page,evidence,OUT)
            await context.close();await browser.close()
    result=sanitize(result,local_secrets(OUT))
    (OUT/'browser-preflight-results.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
    assert result['passed'],'Browser preflight failed; stopped before seven-role matrix'
asyncio.run(main())
