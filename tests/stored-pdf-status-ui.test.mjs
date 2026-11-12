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
 const requests=[];const links=files.slice(0,2).map(file=>({...file,manufacturer:'UniMac',models:['UWN'],selected_model:'UWN',applicability:'reference',notes:'',reason:'Prior review',preferred:false}));
 const component=compile('../src/components/StoredPdfImporter.tsx',{'@/lib/manual-applicability':applicability,'@/lib/stored-pdf-link':validation,'@/lib/pdf-direct-upload':{pdfImportResponse:r=>r.json()},'@/lib/equipment-pdf-suggestions':{pdfReviewSuggestions:title=>({title,manufacturer:'',models:[],selected_model:'',applicability:'reference',notes:'',reason:''})}},{FormData,AbortController,fetch:async(_url,options)=>{requests.push(options);if(!options.body)return Response.json({files,links,asset_identity,updated_at:'now'});const id=options.body.get('object_id');assert.equal(options.body.get('import_action'),'review','no save should occur while selecting/reviewing');return Response.json({file:files.find(f=>f.object_id===id),sha256:'a'.repeat(64),url:'https://cmpri.test/original',saved_fields:links.find(l=>l.object_id===id),suggestions:null,readable_text:true,asset_identity,updated_at:'now'});}}).default;
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 await React.act(async()=>root.render(React.createElement(component,{assetId:'one-asset',assetName:'Washer #1',token:async()=>'token',onSaved:()=>{throw Error('not saved')}})));
 const click=async(button)=>React.act(async()=>button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
 const button=text=>[...parent.querySelectorAll('button')].find(b=>b.textContent===text);
 await click(button('Load stored PDFs and saved links'));
 return {parent,requests,click,button,dispose:async()=>{await React.act(async()=>root.unmount());parent.remove()}};
}
test('linked PDFs share one asset and selection requires review rather than creating an asset or saving automatically',async()=>{
 const h=await harness();try{
 assert.match(h.parent.textContent,/0 linked manual/);
 await h.click(h.button('Review manual choice'));
 assert.equal(h.button('Save and verify association').disabled,true);
 assert.match(h.parent.textContent,/does not infer a serial range/);
 const applicabilitySelect=[...h.parent.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value==='confirmed_model'));
 await React.act(async()=>{applicabilitySelect.value='confirmed_model';applicabilitySelect.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 assert.equal(h.button('Save and verify association').disabled,true,'explicit final confirmation and reason still required');
 assert.equal(h.parent.querySelector('input[value="Parts"]').value,'Parts');
 assert.equal(h.requests.filter(r=>r.body).length,1);
 assert.equal(h.requests.at(-1).body.get('asset_id'),'one-asset');
 }finally{await h.dispose();}
});
test('stored catalog warnings require explicit acknowledgement before a deliberate choice',async()=>{
 const h=await harness();try{
 const select=h.parent.querySelector('select');
 assert.match(select.textContent,/Stored, not linked — Quarantined/);
 await React.act(async()=>{select.value='bad';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 await h.click(h.button('Open / re-read selected PDF'));
 assert.match(h.parent.textContent,/wrong serial range/);
 assert.match(h.parent.textContent,/may deliberately choose/);
 const acknowledgement=[...h.parent.querySelectorAll('input[type=checkbox]')].find(input=>input.parentElement.textContent.includes('catalog mismatch warning'));
 assert.ok(acknowledgement);assert.equal(acknowledgement.checked,false);
 assert.equal(h.button('Save and verify association').disabled,true);
 }finally{await h.dispose();}
});
test('reviewer can enter a numeric serial range and see the current asset match',async()=>{
 const h=await harness();try{
  await h.click(h.button('Review manual choice'));
  const check=[...h.parent.querySelectorAll('input[type=checkbox]')].find(input=>input.parentElement.textContent.includes('manufacturer-confirmed numeric serial range'));
  assert.ok(check);await h.click(check);
  const labels=[...h.parent.querySelectorAll('label')];
  const from=labels.find(label=>label.textContent.includes('First serial number')).querySelector('input');
  const to=labels.find(label=>label.textContent.includes('Last serial number')).querySelector('input');
  const nativeSetter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
  await React.act(async()=>{nativeSetter.call(from,'1300000000');from.dispatchEvent(new dom.window.Event('input',{bubbles:true}));nativeSetter.call(to,'1400000000');to.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  assert.match(h.parent.textContent,/Range check: match/);
 }finally{await h.dispose();}
});
