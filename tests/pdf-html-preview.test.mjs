import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://cmpri.test'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{createRoot}=await import('react-dom/client'),require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync('src/components/PdfHtmlPreview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function fixture(){
 const subscriptions=new Set(),pending=[],opened=[],destroyed=[];
 const state={session:{user:{id:'reader'},access_token:'token'}};
 const observer=class{observe(){}disconnect(){}};
 const exports={};
 vm.runInNewContext(code,{exports,AbortController,Uint8Array,URL,Error,ResizeObserver:observer,IntersectionObserver:observer,window,
  fetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})),
  require(name){
   if(['react','react/jsx-runtime'].includes(name))return require(name);
   if(name==='./PdfArtworkZoom')return {default:()=>null};
   if(name==='./PdfHtmlPreview.module.css')return {default:{page:'page',viewport:'viewport',textLayer:'textLayer'}};
   if(name==='@/lib/ocr/local-ocr')return {localOcrPaths:()=>({pdfWorkerPath:'/worker',standardFontDataUrl:'/fonts',cMapUrl:'/cmaps',wasmUrl:'/wasm'})};
   if(name==='@/lib/work-orders/diagram-theme')return {themeSourceDiagramBlob:async(blob)=>({blob,adapted:false})};
   if(name==='@/lib/supabase/client')return {getValidSession:async()=>state.session,createClient:()=>({auth:{onAuthStateChange(fn){subscriptions.add(fn);return {data:{subscription:{unsubscribe(){subscriptions.delete(fn);}}}};}}})};
   if(name==='pdfjs-dist')return {GlobalWorkerOptions:{},getDocument(options){const task={promise:Promise.resolve({numPages:9}),destroy:async()=>destroyed.push(task)};opened.push({task,options});return task;}};
   throw Error(name);
  }});
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 const props={sourceUrl:'/api/assets/documentation/source?assetId=asset&fileId=file&sha256='+ 'a'.repeat(64),userId:'reader'};
 return {state,pending,opened,destroyed,parent,
  render:async(overrides={})=>React.act(async()=>root.render(React.createElement(exports.default,{...props,...overrides}))),
  complete:async(request=pending.at(-1),ok=true)=>React.act(async()=>request.resolve({ok,status:ok?200:409,headers:new Headers({'content-type':'application/pdf'}),json:async()=>({error:'The manual association changed.'}),arrayBuffer:async()=>new TextEncoder().encode('%PDF-test').buffer})),
  auth:async(session)=>React.act(async()=>{state.session=session;for(const fn of subscriptions)fn('SIGNED_OUT',session);}),
  cleanup:async()=>{await React.act(async()=>root.unmount());parent.remove();},subscriptions,
 };
}

test('nine HTML pages share one authenticated original read; closing/reopening does not download it again',async()=>{
 const f=fixture();try{
  await f.render();assert.equal(f.pending.length,1);
  const request=f.pending[0];assert.equal(new URL(request.url,'https://cmpri.test').searchParams.get('format'),'pdf');assert.equal(request.options.headers.Authorization,'Bearer token');
  await f.complete();assert.equal(f.opened.length,1);assert.equal(f.parent.querySelectorAll('[data-pdf-html-page]').length,9);
  await f.render({isOpen:false});await f.render({isOpen:true});assert.equal(f.pending.length,1);assert.equal(f.destroyed.length,0);
 }finally{await f.cleanup();}assert.equal(f.destroyed.length,1);assert.equal(f.subscriptions.size,0);
});
test('a closed guide does not fetch a PDF until opened',async()=>{
 const f=fixture();try{await f.render({isOpen:false});assert.equal(f.pending.length,0);await f.render();assert.equal(f.pending.length,1);}finally{await f.cleanup();}
});
test('a source/account change cancels a pending original and prevents it appearing under another source',async()=>{
 for(const change of [{sourceUrl:'/api/assets/documentation/source?fileId=new'}, {userId:'another'}]){
  const f=fixture();try{await f.render();const old=f.pending[0];if(change.userId)f.state.session={user:{id:'another'},access_token:'other'};await f.render(change);assert.equal(old.options.signal.aborted,true);await f.complete(old);assert.equal(f.opened.length,0);await f.complete();assert.equal(f.opened.length,1);}finally{await f.cleanup();}
 }
});
test('sign-out removes rendered HTML and destroys the worker; late downloads cannot reopen it',async()=>{
 for(const loaded of [false,true]){const f=fixture();try{await f.render();if(loaded)await f.complete();await f.auth(null);assert.equal(f.pending[0].options.signal.aborted,true);if(!loaded)await f.complete();assert.equal(f.parent.querySelectorAll('[data-pdf-html-page]').length,0);assert.match(f.parent.textContent,/account changed/);}finally{await f.cleanup();}}
});
test('sign-out removes HTML even when the guide supplied an explicit page list',async()=>{
 const f=fixture();try{await f.render({pageNumbers:[4,8]});await f.complete();assert.equal(f.parent.querySelectorAll('[data-pdf-html-page]').length,2);await f.auth(null);assert.equal(f.parent.querySelectorAll('[data-pdf-html-page]').length,0);}finally{await f.cleanup();}
});
test('source failures show a retry instead of silently substituting plain text',async()=>{
 const f=fixture();try{await f.render();await f.complete(undefined,false);assert.match(f.parent.textContent,/manual association changed/);assert.match(f.parent.textContent,/Retry preview/);await React.act(async()=>[...f.parent.querySelectorAll('button')].find(button=>button.textContent==='Retry preview').click());await f.complete();assert.equal(f.pending.length,2);assert.equal(f.parent.querySelectorAll('[data-pdf-html-page]').length,9);}finally{await f.cleanup();}
});
