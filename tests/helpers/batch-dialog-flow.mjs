// Mount the production batch dialog and its unchanged handlers in React/jsdom.
// Only surrounding app services and persistence are fixtures; POST uses the real route.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadTs} from './load-ts.mjs';
import {JSDOM} from 'jsdom';
import React from 'react';

export async function mountBatchFlow(fixture, issues, existing=[], stale=false) {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://fixture.invalid/work-orders'});
 globalThis.window=dom.window;globalThis.document=dom.window.document;
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=await import('react-dom/client');
 const source=readFileSync(new URL('../../src/app/work-orders/page.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declarations=new Map();
 function visit(node){
  if(ts.isFunctionDeclaration(node)&&node.name)declarations.set(node.name.text,node.getText(ast));
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='loadWorkOrders') declarations.set('loadWorkOrders',`const loadWorkOrders = ${node.initializer.arguments[0].getText(ast)};`);
  ts.forEachChild(node,visit);
 }
 visit(ast);
 const names=['possibleDuplicateFor','resolveSuggestionLocation','resolveRelatedAsset','assetsForLocation','createSingleBatchWorkOrder','createBatchWorkOrders','submitWorkOrders','handleBatchSuggestionRemoval','returnSingleBatchSuggestionToForm','loadWorkOrders'];
 const start=source.indexOf('{showBatchCreateDialog && selectedLocation && (');
 const end=source.indexOf('{showRelatedWorkOrderDialog &&',start);
 const dialog=source.slice(start+1,end).trim().slice(0,-1);
 const locations=[{id:'location-409',name:'Room 133'}];
 const config={assets:[],existing:[...existing],persist:true,profile:{role:'Chief Engineer',full_name:'Fixture'}};
 const f=fixture({},config), calls=[];
 const {createSuggestionFromIssueClause}=loadTs('src/lib/work-order-creation.ts');
 const initial=issues.map((issue,index)=>createSuggestionFromIssueClause(issue,index,locations,locations[0]));
 const exports={};
 const code=`function Harness(){
  const [batchCreateSuggestions,setBatchCreateSuggestions]=React.useState(initial);
  const [showBatchCreateDialog,setShowBatchCreateDialog]=React.useState(true);
  const [creatingBatchWorkOrders,setCreatingBatchWorkOrders]=React.useState(false);
  const [workOrders,setWorkOrders]=React.useState(initialExisting);
  const [message,setMessage]=React.useState('');
  const [issue,setIssue]=React.useState('');
  const submittingRef=React.useRef(false),submittedDisplayIdsRef=React.useRef([]);
  const selectedLocation=locations[0],locationId=selectedLocation.id;
  ${names.map(name=>declarations.get(name)).join('\n')}
  exports.state={batchCreateSuggestions,workOrders,message,issue};
  exports.reopen=(issues)=>{setBatchCreateSuggestions(issues.map((issue,index)=>createSuggestionFromIssueClause(issue,index,locations,locations[0])));setShowBatchCreateDialog(true);};
  return (${dialog});
 }
 exports.Component=Harness;`;
 const noOp=()=>{};
 vm.runInNewContext(ts.transpileModule(code,{fileName:'harness.tsx',compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText,{
  React,exports,initial,initialExisting:stale?[]:config.existing.slice(),locations,assets:[],
  createSuggestionFromIssueClause,likelyDuplicate:loadTs('src/lib/work-order-duplicates.ts').likelyDuplicate,inferWorkOrder:f.infer,
  isFrontDeskUser:false,isSubmitOnlyUser:false,staffFirstName:'Scott',notes:'Original report',
  cmpriSession:{capabilities:['view_work_orders']},pendingPhotoUploads:[],photos:[],activeDraftId:'',activeDraftRevision:null,
  locationOptions:[],tx:value=>value,formatWorkOrder:value=>value,
  SearchableSelect:()=>null,
  getValidSession:async()=>({access_token:'fixture'}),
  fetch:async(url,init={})=>{
   calls.push({url,method:init.method||'GET'});
   if(init.method==='POST'){
    const result=await f.handler({...f.request,json:async()=>JSON.parse(init.body)});
    return {ok:result.status===200,json:async()=>result.body};
   }
   return {ok:true,json:async()=>({work_orders:config.existing.slice()})};
  },
  clearSubmittedDraft:async()=>{},afterSuccessfulCreate:noOp,resetWorkOrderForm:noOp,notifyCreateModal:noOp,
  setCreateState:noOp,setCategory:noOp,setPriority:noOp,setAssetId:noOp,setManualAsset:noOp,
 });
 const root=createRoot(document.getElementById('root'));
 await React.act(async()=>{root.render(React.createElement(exports.Component));});
 const settle=async()=>{await new Promise(resolve=>setImmediate(resolve));};
 return {
  f,calls,existing:config.existing,dom,state:()=>exports.state,
  text:()=>document.body.textContent,
  alert:()=>document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
  inputs:()=>Array.from(document.querySelectorAll('input')),
  click:async(label,index=0)=>{await React.act(async()=>{Array.from(document.querySelectorAll('button')).filter(button=>button.textContent.startsWith(label))[index].click();await settle();});},
  edit:async(index,value)=>{await React.act(async()=>{
   const input=document.querySelectorAll('input')[index];
   Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);
   input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle();
  });},
  reopen:async(issues)=>{await React.act(async()=>{exports.reopen(issues);});},
  close:async()=>{await React.act(async()=>root.unmount());dom.window.close();},
 };
}
