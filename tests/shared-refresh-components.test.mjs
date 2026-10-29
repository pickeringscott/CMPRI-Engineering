import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import {JSDOM} from 'jsdom';

test('mounted header, closure notice and pool controls share results and clean up in StrictMode',async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const listeners=new Set();let invalidations=0;
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/desktop/PoolStatus.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports,crypto:globalThis.crypto,
    fetch:async()=>({ok:true,json:async()=>({closed:false,revision:3,manual_closed:false})}),
    require:name=>({'@/lib/events/shared-fetch':{sharedFetch:async()=>({ok:true,json:async()=>({closed:false,revision:3,manual_closed:false})})},react:React,'react/jsx-runtime':jsxRuntime,'@/lib/auth/client-session':{authorizationHeaders:async()=>({Authorization:'fixture'})},'@/lib/dashboard/browser-refresh':{
      subscribeDashboardRefresh:(key,listener)=>{assert.equal(key,'pool');listeners.add(listener);return()=>listeners.delete(listener);},
      invalidateDashboardRefresh:()=>invalidations++,
    }}[name]),
  });
  const Pool=exports.default,root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(React.createElement(React.StrictMode,null,
    React.createElement(Pool,{controlOnly:true}),React.createElement(Pool,{noticeOnly:true}),React.createElement(Pool,{engineer:true}))));
  assert.equal(listeners.size,3,'StrictMode does not leak old subscriptions');
  const emit=async event=>act(async()=>{for(const listener of listeners)listener(event);});
  await emit({data:{closed:true,manual_closed:true,hours_closed:false,reason:'Maintenance',revision:2,notifications:[{id:'p',reason:'Maintenance'}]}});
  assert.match(document.body.textContent,/Pool Status: CLOSED/);assert.match(document.body.textContent,/Pool closure: Maintenance/);assert.match(document.body.textContent,/Clear manual closure/);
  const clear=[...document.querySelectorAll('button')].find(b=>b.textContent==='Clear manual closure');
  await act(async()=>clear.click());assert.equal(invalidations,1,'confirmed change refreshes all siblings');
  await emit({data:{closed:false,manual_closed:false,hours_closed:false,reason:'',revision:3,notifications:[]}});
  assert.match(document.body.textContent,/Pool Status: OPEN/);assert.doesNotMatch(document.body.textContent,/Pool closure: Maintenance/);
  await emit({data:{closed:true,manual_closed:false,hours_closed:true,reason:'Closed 10 PM-7 AM',revision:4,notifications:[]}});
  const open=[...document.querySelectorAll('button')].find(b=>b.textContent==='Open pool');assert.equal(open.disabled,true,'hours gate remains active');
  await emit({reset:true});assert.match(document.body.textContent,/Pool Status: LOADING/);assert.doesNotMatch(document.body.textContent,/Maintenance/);
  await act(async()=>root.unmount());assert.equal(listeners.size,0);dom.window.close();
  delete globalThis.window;delete globalThis.document;delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});
