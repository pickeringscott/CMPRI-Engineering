// Isolated local rendering; all API traffic is intercepted. No production credentials.
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {build}=require(process.env.CMPRI_ESBUILD_MODULE||'esbuild');
const {chromium}=require('playwright');
const root=resolve(new URL('..',import.meta.url).pathname);
const output=await build({absWorkingDir:root,stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import Page from './src/app/management/equipment/page';createRoot(document.getElementById('root')).render(<Page/>);",resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',plugins:[{name:'local-fixtures',setup(b){
 b.onResolve({filter:/^@\/(lib\/supabase\/client|lib\/auth\/session-preference|components\/use-embedded-modal|components\/ModalDashboardLink)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.endsWith('client')?"export async function getValidSession(){return {access_token:'fixture-only'}}":a.path.endsWith('session-preference')?"export async function enforceSessionPreference(){return true}":a.path.endsWith('use-embedded-modal')?'export default function(){return false}':'export default function(){return null}',loader:'js'}));
 b.onResolve({filter:/^@\//},a=>{const path=resolve(root,'src',a.path.slice(2));return {path:['.ts','.tsx'].map(e=>path+e).find(existsSync)}});
}}]});
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<div id="root"></div><script>${output.outputFiles[0].text}</script>`)});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CMPRI_CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 let asset={id:'fixture',name:'Fixture lock',asset_type:'Access Control',active:true,manufacturer:'Fixture',model_family:null,model_number:'Model',serial_number:'',install_year:null,documentation_verified:true,documentation_revision_id:null,updated_at:'2026-10-13T00:00:00Z'};
 await page.route('**/api/**',async route=>{const r=route.request(),path=new URL(r.url()).pathname;let payload;
  if(path==='/api/assets'&&r.method()==='PATCH'){const body=r.postDataJSON();writes.push(body);
   if(body.begin_documentation_revision){asset={...asset,documentation_verified:false,documentation_revision_id:'revision-fixture',updated_at:'2026-10-13T01:00:00Z'};payload={revision_open:true};}
   else if(body.verify_with_documentation){asset={...asset,documentation_verified:true,documentation_revision_id:null};payload={verified:true};}
   else{asset={...asset,...body,updated_at:'2026-10-13T02:00:00Z'};payload={asset};}
  }else if(path==='/api/assets')payload={assets:[asset],can_manage:true};
  else if(path==='/api/assets/documentation')payload={documents:[{name:'original.pdf',storage_path:'fixture/original.pdf',source:'asset'}],verified:asset.documentation_verified};
  else throw Error('Unexpected API '+path);
  await route.fulfill({json:payload});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/management/equipment`);
 await page.getByRole('combobox').fill('Fixture');await page.getByRole('option').first().click();
 assert.equal(await page.getByRole('button',{name:'Edit Equipment',exact:true}).count(),0);
 const open=page.getByRole('button',{name:'Open Revision & Edit'});assert.ok(await open.isDisabled());
 await page.getByLabel('Revision reason').fill('Correct identity from saved manufacturer PDF');await open.click();
 await page.getByRole('button',{name:'Save Equipment',exact:true}).waitFor();
 const name=page.getByLabel('Equipment name',{exact:true});
 const names=await page.locator('label').allTextContents();
 const input=(await name.count())?name:page.getByLabel('Name',{exact:true});
 if(!await input.count())throw Error('Name label unavailable: '+names.join(','));
 await input.fill('Corrected fixture lock');
 const verify=page.getByRole('button',{name:'Confirm with Documentation & Lock Fields'});
 assert.ok(await verify.isDisabled());assert.equal(writes.filter(x=>x.verify_with_documentation).length,0);
 await page.getByRole('button',{name:'Save Equipment',exact:true}).click();await page.getByRole('button',{name:'Edit Equipment',exact:true}).click();
 await verify.click();await page.getByRole('button',{name:'Open Revision & Edit'}).waitFor();
 assert.deepEqual(errors,[]);assert.equal(writes.length,3);assert.equal(writes[0].begin_documentation_revision,true);assert.equal(writes[2].expected_updated_at,'2026-10-13T02:00:00Z');
 console.log('PASS verified lock → reasoned revision → editable fields → unsaved verification blocked → save → reverify/relock; all requests local fixtures');
}finally{await browser.close();await new Promise(r=>server.close(r));}
