"""Prove the scanner finds painted navy and exercises CSS states before trusting an audit."""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

SCAN=Path(__file__).with_name('modal_element_scan.js').read_text()

async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  page=await browser.new_page()
  await page.set_content('''<style>
   body {color:#eee;background:#181818}
   #paint {color:#cbd5e1;background:#0f172a;border:1px solid #334155;box-shadow:0 2px 4px #020617}
   #paint::before {content:'icon';color:#94a3b8}
   #state {color:#eee;background:#181818}
   #state:hover {background:#0f172a}
   #state:focus-visible {outline:2px solid #475569}
   #state:disabled {color:#64748b}
   #hidden {display:none;background:#020617}
   input::placeholder {color:#94a3b8}
  </style><button id="paint">Painted</button><button id="state">States</button>
  <input placeholder="Find navy"><div id="hidden">Hidden</div>
  <svg width="20" height="20"><path d="M0 0L20 20" stroke="#475569"/></svg>
  <div class="tier-m" style="color:#0f172a">Brand</div>''')
  result=await page.evaluate(SCAN)
  assert result['stats']['elements']>0,'A missing evaluate argument must never produce an empty scan'
  props={f['property'] for f in result['findings']}
  assert {'color','backgroundColor','borderTopColor','boxShadow','stroke','outlineColor'}<=props,props
  assert any(f['pseudo']=='::before' for f in result['findings'])
  assert any(f['pseudo']=='::placeholder' for f in result['findings'])
  assert any(f['id']=='state' and f['state']=='hover' and f['property']=='backgroundColor' for f in result['findings'])
  assert any(f['id']=='state' and f['state']=='disabled' and f['property']=='color' for f in result['findings'])
  assert not any(f['id']=='hidden' for f in result['findings'])
  assert result['exceptions'],'Intentional brand colors must be reported separately'
  assert await page.locator('[data-cmpri-audit-hover]').count()==0,'State attributes must be restored'
  assert await page.locator('#state').evaluate('e=>getComputedStyle(e).backgroundColor')=='rgb(24, 24, 24)'
  print({'passed':True,'modes':result['modes'],'elementsInspected':result['stats']['elements'],'propertiesChecked':result['stats']['paintProperties']})
  await browser.close()

asyncio.run(main())
