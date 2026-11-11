import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import * as manualHtml from '../src/lib/manual-document-html.ts';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://cmpri.test'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');const {createRoot}=await import('react-dom/client');const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/WorkOrderSourcePages.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const exports={};vm.runInNewContext(code,{exports,require(name){if(name==='react'||name==='react/jsx-runtime')return require(name);if(name==='@/lib/manual-document-html')return manualHtml;if(name==='@/lib/supabase/client')return {getValidSession:async()=>null};throw Error(name);}});

test('source page selector preserves the original PDF and resets when the issue or document changes',async()=>{
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 const passages=[{page:4,text:'Troubleshooting water leak',kind:'troubleshooting'},{page:8,text:'Diagnostic cooling noise',kind:'diagnostic'}];
 const render=async props=>React.act(async()=>root.render(React.createElement(exports.default,{passages:[passages[0]],sourceUrl:'https://cmpri.test/manual.pdf?token=one',...props}))); 
 try {
  await render({});const select=parent.querySelector('select');assert.ok(select);assert.deepEqual([...select.options].map(option=>option.value),['4']);assert.match(parent.textContent,/Troubleshooting water leak/);
  await React.act(async()=>{select.value='4';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(parent.querySelector('a').getAttribute('href'),'https://cmpri.test/manual.pdf?token=one#page=4');
  await render({passages:[passages[1]]});assert.match(parent.textContent,/Diagnostic cooling noise/);assert.deepEqual([...parent.querySelector('select').options].map(option=>option.value),['8']);
  await render({passages:[]});assert.equal(parent.querySelector('select'),null);
 } finally {await React.act(async()=>root.unmount());parent.remove();}
});

test('everyday wording finds source pages without claiming they are instructions', async()=>{
 const {manualSourcePassages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const pages=manualSourcePassages('PAGE 1\nTROUBLESHOOTING CHART\nValve leaks when shut off. Replace washers.\n\nPAGE 2\nTROUBLESHOOTING\nInspect the fan if noisy.');
 assert.deepEqual(relevantSourcePassages(pages,'shower leaking').map(page=>page.page),[1]);
 assert.deepEqual(relevantSourcePassages(pages,'unit makes noise').map(page=>page.page),[2]);
 assert.deepEqual(relevantSourcePassages(pages,'door stuck').map(page=>page.page),[]);
});

test('parts lists and their matching illustrated pages remain source references',async()=>{
 const {manualPartsPassages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const text='PAGE 1\nDoor Lock drawing\n\nPAGE 2\nDoor Lock\nREF PART NO. DESCRIPTION\n1 1234 Door Lock Cover\n\nPAGE 3\nElectrical safety\n\nPAGE 4\nDrain\nREF PART NO. DESCRIPTION\n1 5678 Drain Valve';
 const pages=manualPartsPassages(text);
 assert.deepEqual(pages.map(page=>page.page),[1,2,4]);
 assert.deepEqual(relevantSourcePassages(pages,'door lock broken').map(page=>page.page),[1,2]);
});

test('unlabelled source pages from future manuals remain searchable without becoming repair instructions',async()=>{
 const {manualReferencePages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const pages=manualReferencePages('PAGE 1\nTable of Contents\nWater pressure..........2\n\nPAGE 2\nWater pressure valve assembly and installation.\n\nPAGE 3\nDoor lock wiring diagram.');
 assert.deepEqual(pages.map(page=>page.page),[2,3]);assert.ok(pages.every(page=>page.kind==='reference'));
 assert.deepEqual(relevantSourcePassages(pages,'door lock broken').map(page=>page.page),[3]);
 const {normalizeManualKnowledge}=await import('../src/lib/manual-knowledge.ts');
 assert.equal(normalizeManualKnowledge({source_passages:pages})?.source_passages?.length,2);
});

test('source discovery handles ordinary word endings across unrelated equipment',async()=>{
 const {manualReferencePages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const pages=manualReferencePages('PAGE 1\nHinge squeals during operation.\n\nPAGE 2\nSprinkler leaks at the valve.\n\nPAGE 3\nVacuum brushes need cleaning.');
 assert.deepEqual(relevantSourcePassages(pages,'hinge squealing').map(page=>page.page),[1]);
 assert.deepEqual(relevantSourcePassages(pages,'sprinkler leaking').map(page=>page.page),[2]);
 assert.deepEqual(relevantSourcePassages(pages,'brush is dirty').map(page=>page.page),[3]);
});

test('source-page search updates if a source entry changes',async()=>{
 const {relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const page={page:1,kind:'reference',text:'Door latch diagram'};
 assert.equal(relevantSourcePassages([page],'door latch').length,1);
 page.text='Sprinkler valve diagram';
 assert.equal(relevantSourcePassages([page],'door latch').length,0);
 assert.equal(relevantSourcePassages([page],'sprinkler valve').length,1);
});


function imageViewer() {
 const pending=[];const revoked=[];const subscriptions=new Set();
 const session={user:{id:'reader-one'},access_token:'synthetic-token'};
 const state={session,nextUrl:0};
 const isolated={};
 vm.runInNewContext(code,{
  exports:isolated,AbortController,URLSearchParams,
  URL:{createObjectURL(){return `blob:manual-${++state.nextUrl}`;},revokeObjectURL(url){revoked.push(url);}},
  fetch(url,options){return new Promise(resolve=>pending.push({url,options,resolve}));},
  require(name){
   if(name==='react'||name==='react/jsx-runtime')return require(name);
   if(name==='@/lib/manual-document-html')return manualHtml;
   if(name==='@/lib/supabase/client')return {
    getValidSession:async()=>state.session,
    createClient:()=>({auth:{onAuthStateChange(callback){subscriptions.add(callback);return {data:{subscription:{unsubscribe(){subscriptions.delete(callback);}}}};}}}),
   };
   throw Error(name);
  },
 });
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 const props={passages:[{page:4,text:'Drain diagnostic chart',kind:'diagnostic'},{page:8,text:'Drain assembly diagram',kind:'reference'}],sourceUrl:'https://cmpri.test/source.pdf?token=one',assetId:'asset-one',sourceSha256:'a'.repeat(64),userId:'reader-one'};
 const render=async overrides=>React.act(async()=>root.render(React.createElement(isolated.default,{...props,...overrides})));
 const complete=async (request=pending.at(-1),ok=true)=>React.act(async()=>request.resolve({ok,blob:async()=>new Blob(['synthetic image'],{type:'image/png'})}));
 const auth=async session=>React.act(async()=>{state.session=session;for(const callback of subscriptions)callback('SIGNED_OUT',session);});
 const cleanup=async()=>{await React.act(async()=>root.unmount());parent.remove();};
 return {parent,pending,revoked,subscriptions,state,render,complete,auth,cleanup};
}

test('source pages load authenticated images, change pages and release their object URLs',async()=>{
 const h=imageViewer();
 try {
  await h.render({});assert.equal(h.pending.length,1);
  const first=h.pending[0];const query=new URL(first.url,'https://cmpri.test').searchParams;
  assert.equal(query.get('source'),'asset-upload');assert.equal(query.get('assetId'),'asset-one');assert.equal(query.get('sha256'),'a'.repeat(64));assert.equal(query.get('pageImage'),'4');
  assert.equal(first.options.headers.Authorization,'Bearer synthetic-token');assert.equal(first.options.cache,'no-store');
  await h.complete(first);assert.equal(h.parent.querySelector('img').getAttribute('src'),'blob:manual-1');
  await React.act(async()=>{const select=h.parent.querySelector('select');select.value='8';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(first.options.signal.aborted,true);assert.deepEqual(h.revoked,['blob:manual-1']);assert.equal(h.parent.querySelector('img'),null);
  assert.equal(new URL(h.pending[1].url,'https://cmpri.test').searchParams.get('pageImage'),'8');
  await h.complete();assert.equal(h.parent.querySelector('img').getAttribute('alt'),'Manual page 8, including diagrams and tables');
  await h.render({passages:[]});assert.equal(h.parent.querySelector('img'),null);assert.deepEqual(h.revoked,['blob:manual-1','blob:manual-2']);assert.equal(h.subscriptions.size,0);
 } finally {await h.cleanup();}
});

test('late page responses cannot publish after the source, account or selection changes',async()=>{
 for(const change of [{assetId:'asset-two'},{sourceSha256:'b'.repeat(64)},{userId:'reader-two'},{passages:[{page:9,text:'New report reference',kind:'reference'}]}]) {
  const h=imageViewer();
  try {
   await h.render({});const stale=h.pending[0];
   if(change.userId)h.state.session={user:{id:change.userId},access_token:'replacement-token'};
   await h.render(change);assert.equal(stale.options.signal.aborted,true);
   await h.complete(stale);assert.equal(h.parent.querySelector('img'),null);assert.equal(h.state.nextUrl,0);
   await h.complete(h.pending.at(-1));assert.equal(h.parent.querySelector('img').getAttribute('src'),'blob:manual-1');
  } finally {await h.cleanup();}
  assert.deepEqual(h.revoked,['blob:manual-1']);assert.equal(h.subscriptions.size,0);
 }
});

test('sign-out clears displayed source images and prevents pending images from appearing',async()=>{
 for(const finishBeforeSignOut of [true,false]) {
  const h=imageViewer();
  try {
   await h.render({});const request=h.pending[0];
   if(finishBeforeSignOut)await h.complete(request);
   await h.auth(null);assert.equal(request.options.signal.aborted,true);assert.equal(h.parent.querySelector('img'),null);
   if(!finishBeforeSignOut)await h.complete(request);
   assert.equal(h.parent.querySelector('img'),null);
   assert.deepEqual(h.revoked,finishBeforeSignOut?['blob:manual-1']:[]);
  } finally {await h.cleanup();}
 }
});

test('failed images keep the exact source-page link and extracted reference text available',async()=>{
 const h=imageViewer();
 try {
  await h.render({});await h.complete(h.pending[0],false);
  assert.equal(h.parent.querySelector('img'),null);assert.match(h.parent.textContent,/Drain diagnostic chart/);
  assert.equal(h.parent.querySelector('a').getAttribute('href'),'https://cmpri.test/source.pdf?token=one#page=4');
 } finally {await h.cleanup();}
});


test('the work-order viewer renders semantic source HTML and never trusts supplied markup', async () => {
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 try {
  await React.act(async()=>root.render(React.createElement(exports.default,{sourceUrl:'https://cmpri.test/manual.pdf',passages:[{page:6,kind:'reference',origin:'ocr',text:'Door lock stuck\n1. Inspect the latch.\n2. Check <script>alert(1)</script> wiring.',html:'<img src=x onerror=alert(2)>'}]})));
  assert.equal(parent.querySelector('[data-source-page="6"]').getAttribute('data-source-origin'),'ocr');
  assert.equal(parent.querySelector('h3').textContent,'Door lock stuck');
  assert.equal(parent.querySelectorAll('ol li').length,2);
  assert.equal(parent.querySelector('script,img,svg'),null);
  assert.match(parent.textContent,/<script>alert\(1\)<\/script>/);
  assert.match(parent.textContent,/OCR text: compare with the original source page/);
  assert.equal(parent.querySelector('a').getAttribute('href'),'https://cmpri.test/manual.pdf#page=6');
 } finally {await React.act(async()=>root.unmount());parent.remove();}
});
