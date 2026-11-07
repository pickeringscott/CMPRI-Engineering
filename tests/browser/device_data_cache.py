"""Functional tests for the new device cache, using synthetic API data only (not a fetch audit)."""
import asyncio,json,subprocess,tempfile,threading,time
from collections import Counter
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse,parse_qs
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[2];OUT=Path('/workspace/work/app-cache-release');OUT.mkdir(parents=True,exist_ok=True)
state={'rooms':1,'pool':1,'reference':1,'session':1};hits=Counter();delay={};active=True
bundle=subprocess.check_output(['node','--input-type=module','-e',r'''
import ts from 'typescript';import{readFileSync}from'node:fs';
const modules={};for(const name of ['store','policy','core','browser'])modules[name]=ts.transpileModule(readFileSync('src/lib/data-cache/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
process.stdout.write('(()=>{const sources='+JSON.stringify(modules)+';const cache={};function load(name){name=name.replace("./","");if(cache[name])return cache[name];const exports={};cache[name]=exports;new Function("exports","require",sources[name])(exports,load);return exports}window.cache=load("browser");cache.browser.installDeviceDataCache()})();');
'''],cwd=ROOT)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  path=urlparse(self.path).path;q=parse_qs(urlparse(self.path).query);auth=self.headers.get('Authorization','');identity='B' if auth=='Bearer B' else 'A';hits[(identity,path)]+=1
  if path=='/bundle.js':return self.send(bundle,'application/javascript')
  if not path.startswith('/api/'):return self.send(b'<!doctype html><script src="/bundle.js"></script><body>Cache test</body>','text/html')
  if not active:return self.send_json({'error':'revoked'},401)
  if 'delay' in q:time.sleep(float(q['delay'][0]))
  if path=='/api/session':return self.send_json({'user':{'id':identity,'role':'engineer'},'hotelId':'hotel'+identity,'capabilities':['view_dashboard']})
  if path=='/api/resource-revisions':return self.send_json({'userId':identity,'hotelId':'hotel'+identity,'versions':state.copy()})
  if path=='/api/rooms':return self.send_json({'identity':identity,'revision':state['rooms']})
  if path=='/api/pool-status':return self.send_json({'identity':identity,'revision':state['pool']})
  if path=='/api/engineering/catalog':return self.send_json({'identity':identity,'revision':state['reference']})
  if path=='/api/profile':return self.send_json({'private':True})
  return self.send_json({'ok':True})
 def do_POST(self):
  path=urlparse(self.path).path;state['rooms']+=1;self.send_json({'ok':True,'revision':state['rooms']})
 def send_json(self,data,status=200):self.send(json.dumps(data).encode(),'application/json',status)
 def send(self,data,mime,status=200):
  self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.end_headers()
  try:self.wfile.write(data)
  except (BrokenPipeError,ConnectionResetError):pass
async def main():
 global active
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(server.server_port)
 results=[];errors=[]
 with tempfile.TemporaryDirectory(dir=OUT,prefix='data-profile-') as profile:
  async with async_playwright() as p:
   context=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',args=['--no-sandbox']);page=context.pages[0];page.on('pageerror',lambda e:errors.append(str(e)));await page.goto(base)
   async def read(path,identity='A',view=None):return await (view or page).evaluate('async([url,id])=>{const r=await fetch(url,{headers:{Authorization:"Bearer "+id},cache:"no-store"});return{status:r.status,body:await r.json(),hit:r.headers.get("X-CMPRI-Data-Cache")}}',[path,identity])
   first=await read('/api/rooms');assert first['body']=={'identity':'A','revision':1}
   assert (await read('/api/rooms'))['hit']=='hit';assert hits[('A','/api/rooms')]==1
   await page.evaluate('()=>{const f=document.createElement("iframe");f.src="/modal";document.body.append(f)}');await page.wait_for_function('document.querySelector("iframe").contentWindow.cache!==undefined');child=page.frames[1]
   assert (await read('/api/rooms',view=child))['hit']=='hit';assert hits[('A','/api/rooms')]==1
   before=hits[('A','/api/engineering/catalog')]
   host_read=asyncio.create_task(read('/api/engineering/catalog?delay=0.1'));modal_read=asyncio.create_task(read('/api/engineering/catalog?delay=0.1',view=child));a,b=await asyncio.gather(host_read,modal_read)
   assert a['body']==b['body'] and hits[('A','/api/engineering/catalog')]==before+1
   results.append({'test':'host and modal share memory, IndexedDB and in-flight reads; repeated reads use one request','passed':True})
   # Both callers share a network read; cancelling one must not cancel the other.
   outcome=await page.evaluate('''async()=>{const c=new AbortController();const options={headers:{Authorization:'Bearer A'}};const a=fetch('/api/engineering/catalog?delay=0.15&abort=1',{...options,signal:c.signal}).then(()=>false,e=>e.name==='AbortError');const b=fetch('/api/engineering/catalog?delay=0.15&abort=1',options).then(r=>r.json());setTimeout(()=>c.abort(),20);return await Promise.all([a,b])}''');assert outcome[0] is True and outcome[1]['identity']=='A'
   # Effects may abort before an awaited session resolves. Every nested promise must remain handled.
   assert await page.evaluate('''async()=>{const c=new AbortController();c.abort();return fetch('/api/engineering/catalog?delay=0.05&already-aborted=1',{headers:{Authorization:'Bearer A'},signal:c.signal}).then(()=>false,e=>e.name==='AbortError')}''')
   await page.wait_for_timeout(150);assert not errors,errors
   results.append({'test':'cancelled and already-cancelled callers reject cleanly without cancelling shared reads or leaking rejections','passed':True})
   await context.close()
   # The same authorized account reuses persisted data after restarting the browser.
   context=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',args=['--no-sandbox']);page=context.pages[0];page.on('pageerror',lambda e:errors.append(str(e)));await page.goto(base)
   before=hits[('A','/api/rooms')];assert (await read('/api/rooms'))['hit']=='hit';assert hits[('A','/api/rooms')]==before
   await context.close();state['rooms']+=1
   context=await p.chromium.launch_persistent_context(profile,executable_path='/usr/bin/chromium',args=['--no-sandbox']);page=context.pages[0];page.on('pageerror',lambda e:errors.append(str(e)));await page.goto(base)
   updated=await read('/api/rooms');assert updated['body']['revision']==2 and hits[('A','/api/rooms')]==before+1
   results.append({'test':'restart reuses unchanged durable data; a missed revision refreshes changed rows before serving them','passed':True})
   await read('/api/pool-status');before=hits[('A','/api/pool-status')];state['rooms']+=1;await page.evaluate('cache.invalidateCachedResources(["rooms"],3)');assert (await read('/api/rooms'))['body']['revision']==3
   assert (await read('/api/pool-status'))['hit']=='hit' and hits[('A','/api/pool-status')]==before
   other=await context.new_page();other.on('pageerror',lambda e:errors.append(str(e)));await other.goto(base);await read('/api/rooms',view=other)
   await page.evaluate('fetch("/api/rooms",{method:"POST",headers:{Authorization:"Bearer A"}})');await page.wait_for_timeout(100)
   assert (await read('/api/rooms',view=other))['body']['revision']==4
   assert (await read('/api/rooms','B'))['body']['identity']=='B'
   records=await page.evaluate('''()=>new Promise((resolve,reject)=>{const r=indexedDB.open('cmpri-device-data-v1',1);r.onsuccess=()=>{const q=r.result.transaction('entries').objectStore('entries').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)}})''')
   assert all(e['scope'].startswith('B:hotelB:') and 'Bearer' not in json.dumps(e) for e in records)
   results.append({'test':'targeted invalidation, cross-tab writes and account/property isolation','passed':True})
   await read('/api/profile','B');await read('/api/profile','B');assert hits[('B','/api/profile')]==2
   late=asyncio.create_task(read('/api/engineering/catalog?delay=0.2&late=1','B'));await page.wait_for_timeout(25);await page.evaluate('cache.clearDeviceDataCache()');assert (await late)['status']==401
   active=False;assert (await read('/api/rooms','B'))['status']==401
   assert not errors,errors
   await context.close();results.append({'test':'private profile stays uncached; logout blocks late responses and revoked accounts cannot retrieve cached data','passed':True})
 server.shutdown();(OUT/'device-cache-browser.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
asyncio.run(main())
