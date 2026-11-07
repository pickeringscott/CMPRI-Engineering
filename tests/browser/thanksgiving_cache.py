"""Exercise the real root service worker and static artwork with a persistent browser profile."""
import asyncio, hashlib, json, tempfile, threading
from collections import Counter
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path('/workspace/work/thanksgiving-production')
OUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT/'src/lib/ui/thanksgiving-assets.json').read_text())
layouts = json.loads((ROOT/'src/lib/ui/thanksgiving-layouts.json').read_text())
hits, overrides = [], {}

class Handler(SimpleHTTPRequestHandler):
 def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT/'public'), **kwargs)
 def log_message(self, *args): pass
 def end_headers(self):
  path=urlparse(self.path).path
  self.send_header('Cache-Control', 'no-cache' if path in ['/sw.js','/backgrounds/thanksgiving-animated/cache-worker.js','/cache-harness'] else 'public, max-age=31536000, immutable')
  super().end_headers()
 def do_GET(self):
  path=urlparse(self.path).path;hits.append(path)
  if path=='/cache-harness':
   body=('''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style><script>(async()=>{
   await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});await navigator.serviceWorker.ready;
   if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
   const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.src='''+json.dumps(manifest['entry'])+''';document.body.append(frame);
   })();</script>''').encode()
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(body)
  elif path in overrides:
   body=overrides[path];self.send_response(200);self.send_header('Content-Type','application/javascript' if path.endswith('.js') else 'text/html');self.end_headers();self.wfile.write(body)
  else:super().do_GET()

async def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(server.server_port)
 results=[];errors=[]
 with tempfile.TemporaryDirectory(prefix='theme-profile-',dir=str(OUT)) as profile:
  async with async_playwright() as p:
   ctx=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',args=['--no-sandbox'],viewport={'width':1440,'height':900})
   page=ctx.pages[0];page.on('pageerror',lambda e:errors.append(str(e)))
   await page.goto(base+'/cache-harness');await page.wait_for_function('document.querySelector("iframe")?.contentDocument?.getElementById("scene")?.dataset.layout==="desktop"')
   f=page.frames[1];await f.wait_for_function('Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)')
   async def geometry(frame):return await frame.locator('.decor').evaluate_all('es=>Object.fromEntries(es.map(e=>[e.id,{x:parseFloat(e.style.left),y:parseFloat(e.style.top),width:parseFloat(e.style.width),height:parseFloat(e.style.height),layer:+e.style.zIndex-10}]))')
   assert await geometry(f)==layouts['desktop']['objects']
   assert await f.locator('.leaf').count()==96
   assert await f.locator('#scene').get_attribute('data-leaf-size')=='41'
   files=set(manifest['files']);counts=Counter(h for h in hits if h in files)
   assert all(counts[path]==1 for path in files),counts
   before=len(hits);await page.wait_for_timeout(1500);assert len(hits)==before,(hits[before:])
   await page.screenshot(path=str(OUT/'desktop-fixed.png'))
   await page.set_viewport_size({'width':390,'height':844});await f.wait_for_function('document.getElementById("scene").dataset.layout==="mobile"')
   assert await geometry(f)==layouts['mobile']['objects'];assert await f.locator('#scene').get_attribute('data-leaf-size')=='32'
   await page.screenshot(path=str(OUT/'mobile-fixed.png'))
   results.append({'test':'exact desktop/mobile geometry and 96 local leaves; initial assets fetched once; animation produces zero requests','passed':True})
   # Reloading only the art navigation must be entirely local after the initial install.
   before=len(hits);await f.evaluate('location.reload()');await page.wait_for_function('document.querySelector("iframe").contentDocument?.getElementById("scene")?.dataset.layout==="mobile"')
   await page.wait_for_timeout(300);assert len(hits)==before,hits[before:]
   # Simulate one changed file in a new deployment. Unchanged files must transfer from the old cache locally.
   changed=(ROOT/('public'+manifest['entry'])).read_bytes()+b'\n<!-- changed deployment -->'
   new_entry='/backgrounds/thanksgiving-animated/index.'+hashlib.sha256(changed).hexdigest()[:16]+'.html'
   new_files=[new_entry if x==manifest['entry'] else x for x in manifest['files']]
   version=hashlib.sha256(json.dumps(new_files).encode()).hexdigest()[:16]
   overrides[new_entry]=changed
   overrides['/backgrounds/thanksgiving-animated/cache-worker.js']=(ROOT/'public/backgrounds/thanksgiving-animated/cache-worker.js').read_bytes().replace(manifest['version'].encode(),version.encode()).replace(manifest['entry'].encode(),new_entry.encode())
   await page.evaluate('caches.open("another-feature")');before=len(hits)
   await page.evaluate('navigator.serviceWorker.getRegistration("/").then(r=>r.update())')
   for _ in range(200):
    keys=await page.evaluate('caches.keys()')
    if 'cmpri-thanksgiving-'+version in keys and 'cmpri-thanksgiving-'+manifest['version'] not in keys:break
    await page.wait_for_timeout(50)
   else:raise AssertionError({'worker update did not activate':keys})
   assert await page.evaluate('caches.has("another-feature")')
   art_hits=[path for path in hits[before:] if path in files or path==new_entry]
   state=await page.evaluate('async()=>{const out={};for(const n of await caches.keys()){out[n]=(await (await caches.open(n)).keys()).map(r=>r.url)}return out}')
   assert art_hits==[new_entry],{"hits":hits[before:],"expected":new_entry,"cache":state}
   await page.locator('iframe').evaluate('(e,url)=>e.src=url',base+new_entry)
   await page.wait_for_function('document.querySelector("iframe").contentDocument?.getElementById("scene")?.dataset.layout==="mobile"')
   results.append({'test':'worker detects changed file, downloads only the new HTML, reuses all unchanged assets, preserves unrelated caches','passed':True})
   await ctx.close()
   # Restart the browser with the network disabled: this proves persistence beyond the page or browser session.
   ctx=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',args=['--no-sandbox'],viewport={'width':390,'height':844},offline=True)
   page=ctx.pages[0];page.on('pageerror',lambda e:errors.append(str(e)));before=len(hits)
   await page.goto(base+new_entry);await page.wait_for_function('document.getElementById("scene")?.dataset.layout==="mobile"')
   await page.wait_for_function('Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)')
   assert await geometry(page)==layouts['mobile']['objects'];assert len(hits)==before,hits[before:]
   first=await page.locator('.leaf').first.get_attribute('style');await page.wait_for_timeout(150);assert first!=await page.locator('.leaf').first.get_attribute('style')
   results.append({'test':'offline browser restart loads pumpkins, turkey, greeting, scripts and leaves from the persistent device cache and continues animating','passed':True})
   # Explicitly clearing both browser and theme caches allows a normal one-time refill.
   await ctx.set_offline(False);await page.evaluate('async()=>{for(const name of await caches.keys())if(name.startsWith("cmpri-thanksgiving-"))await caches.delete(name)}')
   cdp=await ctx.new_cdp_session(page);await cdp.send('Network.clearBrowserCache');before=len(hits)
   await page.reload();await page.wait_for_function('document.getElementById("scene")?.dataset.layout==="mobile"');await page.wait_for_function('Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)')
   actual=Counter(path for path in hits[before:] if path in set(new_files));assert all(actual[path]==1 for path in new_files),actual
   before=len(hits);await page.reload();await page.wait_for_function('document.getElementById("scene")?.dataset.layout==="mobile"');assert len(hits)==before,hits[before:]
   results.append({'test':'cleared cache refills each file once, subsequent reloads remain local','passed':True})
   assert not any(path.startswith('/api/') for path in hits),hits
   assert not errors,errors
   await ctx.close()
 server.shutdown();(OUT/'cache-browser.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
asyncio.run(main())
