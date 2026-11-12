import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://cmpri.test'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react'),{createRoot}=await import('react-dom/client'),require=createRequire(import.meta.url);
function compile(path,deps={},globals={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>name in deps?deps[name]:require(name),console,...globals});return exports;}
const applicability=compile('../src/lib/manual-applicability.ts');
const validation=compile('../src/lib/stored-pdf-link.ts',{'./manual-applicability':applicability});
const asset_identity={asset_id:'one-asset',manufacturer:'UniMac',model_number:'UWN',model_family:'',serial_number:'1305000216'};
const files=[{object_id:'parts',storage_path:'Asset Docs/parts.pdf',size:12,title:'Parts',catalog_status:'complete'},{object_id:'programming',storage_path:'Asset Docs/programming.pdf',size:12,title:'Programming',catalog_status:'complete'},{object_id:'bad',storage_path:'Asset Docs/bad.pdf',size:12,title:'Quarantined',catalog_status:'content_mismatch',catalog_warnings:['Source covers the wrong serial range.']}];
async function harness(){
 const requests=[], saved=[];let version='before';
 const links=files.slice(0,2).map(file=>({...file,manufacturer:'UniMac',models:['UWN'],selected_model:'UWN',applicability:'reference',notes:'',reason:'Prior review',preferred:false}));
 const component=compile('../src/components/StoredPdfImporter.tsx',{'@/lib/manual-applicability':applicability,'@/lib/stored-pdf-link':validation,'@/lib/pdf-direct-upload':{pdfImportResponse:r=>r.json()},'@/lib/equipment-pdf-suggestions':{pdfReviewSuggestions:title=>({title,manufacturer:'',models:[],selected_model:'',applicability:'reference',notes:'',reason:''})}},{FormData,AbortController,fetch:async(_url,options)=>{requests.push(options);if(!options.body)return Response.json({files,links,asset_identity,updated_at:version});const id=options.body.get('object_id');if(options.body.get('import_action')==='save'){version='after';return Response.json({updated_at:version});}assert.equal(options.body.get('import_action'),'review');return Response.json({file:files.find(f=>f.object_id===id),sha256:'a'.repeat(64),url:'https://cmpri.test/original',saved_fields:links.find(l=>l.object_id===id),suggestions:null,readable_text:true,asset_identity,updated_at:version});}}).default;
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 await React.act(async()=>root.render(React.createElement(component,{assetId:'one-asset',assetName:'Washer #1',token:async()=>'token',onSaved:(...args)=>saved.push(args)})));
 const click=async(button)=>React.act(async()=>button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
 const button=text=>[...parent.querySelectorAll('button')].find(b=>b.textContent===text);
 return {parent,requests,saved,click,button,dispose:async()=>{await React.act(async()=>root.unmount());parent.remove()}};
}
test('selecting a PDF opens review; save records the user’s troubleshooting choice and the new asset version',async()=>{
 const h=await harness();try{
  const select=h.parent.querySelector('select');await React.act(async()=>{select.value='parts';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(h.requests.filter(r=>r.body).length,1);assert.equal(h.requests.at(-1).body.get('import_action'),'review');
  const use=[...h.parent.querySelectorAll('input[type=checkbox]')].find(input=>input.parentElement.textContent.includes('work-order troubleshooting'));
  assert.ok(use);assert.equal(use.checked,false);await h.click(use);
  await h.click(h.button('Save manual changes'));
  const saved=h.requests.find(r=>r.body?.get('import_action')==='save').body;
  const fields=JSON.parse(saved.get('fields'));assert.equal(fields.applicability,'confirmed_model');assert.equal(fields.applicability_review.asset_id,'one-asset');assert.equal(saved.get('review_confirmed'),'true');assert.match(fields.reason,/manual association/i);
  assert.deepEqual(h.saved,[['before','after']]);
 }finally{await h.dispose();}
});
test('a mismatched PDF requires acknowledgement before attachment',async()=>{
 const h=await harness();try{
  const select=h.parent.querySelector('select');await React.act(async()=>{select.value='bad';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.match(h.parent.textContent,/wrong serial range/);assert.equal(h.button('Attach manual').disabled,true);
  const acknowledgement=[...h.parent.querySelectorAll('input[type=checkbox]')].find(input=>input.parentElement.textContent.includes('reviewed the warning'));await h.click(acknowledgement);
  assert.equal(h.button('Attach manual').disabled,false);
 }finally{await h.dispose();}
});
test('optional serial range shows whether this asset matches',async()=>{
 const h=await harness();try{
  await h.click(h.button('Parts'));
  const check=[...h.parent.querySelectorAll('input[type=checkbox]')].find(input=>input.parentElement.textContent.includes('numeric serial-number range'));await h.click(check);
  const labels=[...h.parent.querySelectorAll('label')];const from=labels.find(label=>label.textContent.includes('First serial number')).querySelector('input');const to=labels.find(label=>label.textContent.includes('Last serial number')).querySelector('input');
  const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
  await React.act(async()=>{setter.call(from,'1300000000');from.dispatchEvent(new dom.window.Event('input',{bubbles:true}));setter.call(to,'1400000000');to.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  assert.match(h.parent.textContent,/Range check: match/);
 }finally{await h.dispose();}
});
