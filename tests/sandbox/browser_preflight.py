import asyncio,json
from pathlib import Path
from playwright.async_api import async_playwright
from browser_support import diagnose_context,login,save_browser_diagnostics,redirect_snapshot,preflight_passes
from diagnostics import sanitize,local_secrets
OUT=Path(__file__).resolve().parents[2]/'.sandbox'
async def main():
    result={'phase':'Real browser login/navigation preflight','passed':False,'clientNavigationPassed':False,'directNavigationPassed':False,'createFormPassed':False}
    user=json.loads((OUT/'synthetic-users.json').read_text())[0]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context(viewport={'width':1280,'height':1000},service_workers='block')
        page,evidence=await diagnose_context(context,OUT,user['label'])
        try:
            await login(page,user,evidence)
            result['clientNavigationPassed']=True
        except Exception as e:
            result['clientError']=str(e)
            await redirect_snapshot(page,evidence,'client navigation failed',user['id'])
            # Snapshot pending navigation BEFORE direct navigation can cancel it.
            result['pendingAtClientFailure']=[dict(r) for r in evidence['requests'] if r['state']=='pending'][-25:]
        # Diagnostic comparison only. A successful direct load NEVER makes a failed
        # client-side login pass and NEVER permits the seven-role suite to proceed.
        try:
            evidence['phase']='direct navigation comparison'
            response=await page.goto('http://127.0.0.1:3112/engineering',wait_until='domcontentloaded',timeout=30000)
            result['directStatus']=response.status if response else None
            await page.locator('[data-dashboard-title]').wait_for(timeout=20000)
            result['directNavigationPassed']=True
            await redirect_snapshot(page,evidence,'direct navigation passed',user['id'])
        except Exception as e:
            result['directError']=str(e)
            await redirect_snapshot(page,evidence,'direct navigation failed',user['id'])
        if result['clientNavigationPassed'] and result['directNavigationPassed']:
            try:
                evidence['phase']='Create form readiness'
                await page.goto('http://127.0.0.1:3112/work-orders',timeout=45000)
                await page.get_by_placeholder('Example: 316 not cooling').wait_for(timeout=30000)
                assert not evidence['pageErrors'],evidence['pageErrors']
                assert not evidence['blockedExternal'],evidence['blockedExternal']
                result['createFormPassed']=True
                result['passed']=preflight_passes(result)
            except Exception as e:result['formError']=str(e)
        await save_browser_diagnostics(page,evidence,OUT)
        await context.close();await browser.close()
    result=sanitize(result,local_secrets(OUT))
    (OUT/'browser-preflight-results.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
    assert result['passed'],'Browser preflight failed; direct navigation cannot bypass a client navigation failure'
if __name__=='__main__':
    asyncio.run(main())
