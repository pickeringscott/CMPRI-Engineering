import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {loadTs} from './helpers/load-ts.mjs';
const {groupLocations}=loadTs('src/lib/location-management.ts');

test('open Manage Locations refreshes on resource changes, retains expansion and ignores stale reads',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'https://fixture.test/management/rooms'});
 const previous={window:globalThis.window,document:globalThis.document,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
 let refresh,topics,stopped=false,reads=0,pending=[];
 const records=(count,planned=false)=>({locations:[{id:'room',name:'Room 204',room_number:'204',area:'Guest Rooms',location_type:'Guest Room',active:true}],
  work_orders:Array.from({length:count},(_,i)=>({id:String(i),location_id:'room',room:'204',issue:'Sample issue',status:'Open'})),
  pm_plans:planned?[{id:'plan',location_id:'room',asset_id:null,title:'Room inspection',description:null,checklist:[],frequency_value:3,frequency_unit:'MONTH',last_completed_on:null,active:true,next_due_on:'2100-01-01'}]:[],pm_completions:[],can_edit:true,can_manage_corporate_pm:true});
 let payload=records(2),defer=false;
 const response=value=>({ok:true,json:async()=>value});
 const exports={};
 const deps={
  react:React,'react/jsx-runtime':jsxRuntime,
  '@/lib/supabase/client':{getValidSession:async()=>({access_token:'fixture'})},
  '@/lib/auth/client-session':{loadCmpriSession:async()=>({landing:'/engineering'}),hasCapability:()=>true},
  '@/components/ModalNavigationButton':{default:({children})=>jsxRuntime.jsx('button',{children})},
  '@/components/ModalDashboardLink':{default:()=>null},
  '@/components/use-embedded-modal':{default:()=>true},
  '@/lib/location-management':{groupLocations},
  '@/lib/ui/header-palette':{modalTitleStyle:()=>({color:'#00d492'})},
  '@/lib/events/browser':{subscribeResources:(next,load,initial)=>{topics=next;refresh=load;assert.equal(initial,false);return()=>{stopped=true;};}},
  './locations.css':{},
 };
 const source=readFileSync(new URL('../src/app/management/rooms/page.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
  exports,require:name=>{assert.ok(name in deps,name);return deps[name];},window:dom.window,document:dom.window.document,
  fetch:async url=>{assert.equal(url,'/api/rooms');reads++;return defer?new Promise(resolve=>pending.push(resolve)):response(payload);}
 });
 const root=createRoot(dom.window.document.getElementById('app'));
 try {
  await React.act(async()=>{root.render(jsxRuntime.jsx(exports.default,{}));});
  await React.act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
  assert.equal(reads,1);
  assert.equal([...topics].sort().join(','),'orders,reference,rooms');
  const doc=dom.window.document;
  const count=()=>doc.querySelector('.location-work-order-count').textContent;
  assert.equal(count(),'2 Work Orders');
  await React.act(async()=>{doc.querySelector('.location-toggle').click();});
  assert.ok(doc.querySelector('[role=region]'));
  payload=records(3,true);
  await React.act(async()=>{await refresh();});
  assert.equal(count(),'3 Work Orders');
  assert.match(doc.querySelector('.location-pm-status').textContent,/Scheduled/);
  assert.ok(doc.querySelector('[role=region]'),'expanded location stays open');
  defer=true;
  await React.act(async()=>{
   const old=refresh(),latest=refresh();await Promise.resolve();await Promise.resolve();
   assert.equal(pending.length,2);
   pending[1](response(records(5,true)));await latest;
   pending[0](response(records(4,false)));await old;
  });
  assert.equal(count(),'5 Work Orders','older response cannot undo a newer refresh');
 } finally {
  await React.act(async()=>root.unmount());
  assert.equal(stopped,true);
  dom.window.close();Object.assign(globalThis,previous);
 }
});
