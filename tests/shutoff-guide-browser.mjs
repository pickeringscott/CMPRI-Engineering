import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {build}=require(process.env.CMPRI_ESBUILD_MODULE || 'esbuild');
const {chromium}=require('playwright');
const root=process.cwd();
const result=await build({absWorkingDir:root,stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Guide from './src/components/TroubleshootingGuideDropdown';createRoot(document.getElementById('root')).render(<Guide/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife',outdir:'/tmp/shutoff-browser',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^@\/lib\/auth\/client-session$/},()=>({path:'auth',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export async function authorizationHeaders(){return {Authorization:'Bearer local-fixture'}}`,loader:'js'}));
}}]});
const css=(await require('postcss')([require('@tailwindcss/postcss')({base:root})]).process('@import "tailwindcss";',{from:resolve(root,'src/app/globals.css')})).css;
const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text;
const modules=result.outputFiles.find(f=>f.path.endsWith('.css')).text;
let fail=false,requests=0;
const server=createServer((req,res)=>{
 if(req.url.startsWith('/api/guides/shutoff/')){
  requests++;assert.equal(req.headers.authorization,'Bearer local-fixture');
  if(fail){res.writeHead(403);return res.end();}
  const name=req.url.split('/').pop();res.writeHead(200,{'Content-Type':'image/png'});return res.end(readFileSync(`src/server-assets/shutoff/${name}.png`));
 }
 res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${modules}</style><div id="root"></div><script>${js}</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
 for(const width of [360,768,1440]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('Front Desk Quick Guides').selectOption('shutoff');
  await page.getByRole('heading',{name:'Shutoff reference guide',exact:true}).waitFor();
  assert.equal(await page.locator('article img').count(),3);
  await page.waitForFunction(()=>[...document.querySelectorAll('article img')].every(i=>i.complete&&i.naturalWidth===1426));
  assert.equal(await page.locator('article').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.equal(await page.locator('article').evaluate(el=>getComputedStyle(el).letterSpacing),'normal');
  const popup=page.waitForEvent('popup');await page.getByRole('link',{name:'Open full-size water main reference'}).click();const tab=await popup;await tab.waitForLoadState();assert.ok(tab.url().startsWith('blob:'));await tab.close();
  await page.locator('article').evaluate(el=>el.parentElement.scrollTop=0);
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#root').evaluate(el=>getComputedStyle(el).display),'none');
  assert.equal(await page.locator('dialog').evaluate(el=>getComputedStyle(el).overflow),'visible');
  await page.emulateMedia({media:'screen'});
  await page.screenshot({path:`/tmp/shutoff-${width}.png`});
  await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.getByLabel('Front Desk Quick Guides').evaluate(el=>el===document.activeElement),true);
  await page.getByLabel('Front Desk Quick Guides').selectOption('shutoff');await page.getByRole('heading',{name:'Shutoff reference guide',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close guide',exact:true}).click();
  await page.close();
 }
 fail=true;
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByLabel('Front Desk Quick Guides').selectOption('shutoff');await page.getByRole('alert').waitFor();assert.equal(await page.locator('article img').count(),0);
 console.log(JSON.stringify({passed:true,widths:[360,768,1440],checks:['authenticated image requests','original image dimensions','no horizontal overflow','normal text spacing','full-size opening','Escape and focus restoration','close and reopen','access failure'],requests}));
} finally {await browser.close();server.close();}
