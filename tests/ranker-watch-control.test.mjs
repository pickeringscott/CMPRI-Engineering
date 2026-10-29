import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import React,{act} from 'react';import {createRoot} from 'react-dom/client';import * as jsx from 'react/jsx-runtime';import {JSDOM} from 'jsdom';
test('operator control gates access, activates once, verifies provider receipt and holds uncertain outcomes',async()=>{
 const dom=new JSDOM('<div id="root"></div>');globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 let permitted=false,active=false,fail=false,calls=0;const exports={};
 const fetch=async(_url,options)=>{if(options.method==='POST'){calls++;assert.deepEqual(JSON.parse(options.body),{action:'activate'});if(fail)throw Error('connection lost');active=true;return {ok:true,json:async()=>({status:'active'})};}return {ok:permitted,status:permitted?200:403,json:async()=>({channels:active?[{status:'active',expires_at:'2099-01-01',sync_received_at:'2026-10-29'}]:[]})};};
 vm.runInNewContext(ts.transpileModule(readFileSync('src/components/RankerWatchControl.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports,fetch,queueMicrotask,require:n=>({react:React,'react/jsx-runtime':jsx,'@/lib/supabase/client':{getValidSession:async()=>({access_token:'fixture'}),createClient:()=>({auth:{onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}})}}[n])});
 let root=createRoot(document.getElementById('root'));
 try{await act(async()=>root.render(React.createElement(exports.default)));assert.equal(document.querySelector('button'),null);await act(async()=>root.unmount());
 permitted=true;root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(exports.default)));
 const enable=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Enable'));
 await act(async()=>{enable().click();enable().click();});assert.equal(calls,1);assert.match(document.body.textContent,/confirmed by Google Drive/);assert.equal(enable().disabled,true);
 active=false;await act(async()=>document.querySelectorAll('button')[1].click());fail=true;await act(async()=>enable().click());assert.match(document.body.textContent,/outcome unconfirmed/);assert.equal(enable().disabled,true);assert.equal(calls,2);
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
