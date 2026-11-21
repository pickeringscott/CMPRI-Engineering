import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as queueRules from '../src/lib/pm/task-queue.ts';
import { tapTask } from '../src/lib/pm/task-review.ts';
const dom=new JSDOM('<div id="root"></div>',{url:'https://cmpri.test/engineering/preventive-maintenance?embedded=1&modalToken=fixture-fresh',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react'),{createRoot}=await import('react-dom/client'),require=createRequire(import.meta.url);
const template={id:'workbook:daily',kind:'routine',cadence:'daily',checklist:[{id:'fire',label:'Check Fire Panel'},{id:'doors',label:'Check Exterior Doors'}]};
const actor={id:'alex',name:'Alex',role:'technician'},owner={hotelId:'hotel',userId:'alex'};
const initialContext={weekStart:'2026-11-16',frequency:'daily',tab:'week',phoneDay:3};
let hook,root,mode,serverEntry,requests,saved,errors,posts,verified,release;
Object.defineProperty(window,'parent',{configurable:true,get:()=>({postMessage:(message,origin)=>posts.push({message,origin})})});
const globals={exports:{},window,document,localStorage:window.localStorage,URLSearchParams,Promise,fetch:async(url,options)=>{
 requests.push({url,cache:options?.cache,method:options?.method||'GET',body:options?.body?JSON.parse(options.body):null});
 if(options?.method!=='PATCH')return {ok:true,json:async()=>({entries:serverEntry?[serverEntry]:[]})};
 if(mode==='blocked')await new Promise(resolve=>{release=resolve;});
 if(mode==='fail')return {ok:false,json:async()=>({error:'Fixture service unavailable'})};
 const body=JSON.parse(options.body),states={...(serverEntry?.task_states||{})};
 for(const change of body.changes)for(let i=0;i<change.tapCount;i++)states[change.itemId]=tapTask(states[change.itemId],actor,{pool:false,poolLogFilled:true,attachedForm:false});
 serverEntry={id:'record',template_id:template.id,period_start:body.periodStart,scope_key:'property',status:'pending',revision:(serverEntry?.revision||0)+1,task_states:states};
 if(mode==='lost')throw Error('Fixture lost acknowledgement');
 return {ok:true,json:async()=>({entry:serverEntry})};
}};
globals.require=name=>{
 if(name==='react')return require(name);
 if(name.endsWith('/supabase/client'))return {getValidSession:async()=>({access_token:'fixture-only-token'})};
 if(name.endsWith('/auth/client-session'))return {loadCmpriSession:async()=>verified};
 if(name==='./catalog')return {findPmTemplate:id=>id===template.id?template:null,validPmPeriod:()=>true,pmWeekStart:()=>initialContext.weekStart};
 if(name==='./task-queue')return queueRules;
 throw Error('Unexpected import '+name);
};
vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/pm/use-task-queue.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,globals);
function Harness(){const [context,setContext]=React.useState(initialContext);hook=globals.exports.usePmTaskQueue({owner,actor,canEdit:true,context,onRestoreContext:setContext,onSaved:entry=>saved.push(entry),onError:message=>errors.push(message),onPoolRequired:()=>{}});return null;}
async function settle(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
async function mount(){root=createRoot(document.getElementById('root'));await React.act(async()=>{root.render(React.createElement(Harness));await settle();});}
async function unmount(){await React.act(async()=>root.unmount());}
function reset(){window.localStorage.clear();mode='ok';serverEntry=null;requests=[];saved=[];errors=[];posts=[];verified={user:{id:'alex'},hotelId:'hotel',capabilities:['view_pm']};}
async function click(item='fire'){await React.act(async()=>{hook.queue(template,'2026-11-19',item,undefined);await settle();});}
async function close(){const event=new dom.window.Event('cmpri-modal-cancel-request',{cancelable:true});await React.act(async()=>{document.dispatchEvent(event);await settle();});return event;}

test('editing changes local state only and closing saves the whole period once',async()=>{
 reset();await mount();try{await click();await click('doors');assert.equal(requests.length,0);assert.equal(hook.periods[0].changes.length,2);
 const event=await close();assert.equal(event.defaultPrevented,true);assert.equal(requests.filter(r=>r.method==='PATCH').length,1);assert.equal(requests.find(r=>r.method==='PATCH').body.changes.length,2);assert.equal(hook.periods.length,0);assert.equal(posts.length,1);assert.equal(posts[0].message.modalToken,'fixture-fresh');assert.equal(posts[0].origin,'https://cmpri.test');}finally{await unmount();}
});
test('queued intent and selected week survive a complete hook remount without a write',async()=>{
 reset();await mount();await click();await unmount();await mount();try{assert.equal(hook.periods[0].changes[0].itemId,'fire');assert.equal(requests.length,0);const snapshot=JSON.parse(window.localStorage.getItem(queueRules.pmQueueStorageKey('hotel','alex')));assert.equal(snapshot.context.phoneDay,3);assert.equal(snapshot.context.weekStart,'2026-11-16');}finally{await unmount();}
});
test('failed close retains the editor and durable changes, then retry can acknowledge once',async()=>{
 reset();await mount();try{await click();mode='fail';await close();assert.equal(posts.length,0);assert.equal(hook.periods.length,1);assert.match(errors[0],/unavailable/);assert.equal(queueRules.readPmTaskQueue(window.localStorage.getItem(queueRules.pmQueueStorageKey('hotel','alex'))).periods.length,1);mode='ok';await close();assert.equal(posts.length,1);assert.equal(hook.periods.length,0);}finally{await unmount();}
});
test('lost acknowledgement is recognized by a fresh read and cannot toggle the saved task back',async()=>{
 reset();await mount();try{await click();mode='lost';await close();assert.equal(posts.length,0);assert.equal(serverEntry.task_states.fire.workerChecked,true);mode='ok';await close();assert.equal(requests.filter(r=>r.method==='PATCH').length,1);assert.ok(requests.filter(r=>r.method==='GET').every(r=>r.cache==='reload'));assert.equal(posts.length,1);assert.equal(hook.periods.length,0);}finally{await unmount();}
});
test('another writer revision blocks close instead of rebasing or replacing its work',async()=>{
 reset();await mount();try{await click();serverEntry={template_id:template.id,period_start:'2026-11-19',status:'pending',revision:4,task_states:{doors:{status:'needs',workerId:'other',workerChecked:true}}};await close();assert.equal(posts.length,0);assert.equal(requests.filter(r=>r.method==='PATCH').length,0);assert.equal(hook.periods.length,1);assert.match(errors[0],/changed elsewhere/);}finally{await unmount();}
});
test('multiple close requests share the same in-flight save and emit one close acknowledgement',async()=>{
 reset();await mount();try{await click();mode='blocked';await close();await close();assert.equal(requests.filter(r=>r.method==='PATCH').length,1);await React.act(async()=>{release();await settle();});assert.equal(posts.length,1);}finally{await unmount();}
});
test('a newly verified different property cannot submit an earlier property queue',async()=>{
 reset();await mount();try{await click();verified={...verified,hotelId:'other'};await close();assert.equal(requests.length,0);assert.equal(posts.length,0);assert.equal(hook.periods.length,1);assert.match(errors[0],/same account and property/);}finally{await unmount();}
});


test('legacy deleted submitters normalize to a valid compare-only baseline without changing ownership',()=>{
 const legacy={template_id:template.id,period_start:'2026-11-19',status:'pending',revision:7,responses:{fire:true},submitted_by:null,submitted_by_name:null};
 const state=globals.exports.pmEntryTaskState(legacy,template,'fire');
 const wire=JSON.parse(JSON.stringify(state));
 assert.equal(queueRules.isPmTaskState(wire),true);assert.equal('workerId' in wire,false);assert.equal('workerName' in wire,false);
 assert.equal(queueRules.pmTaskStatesEqual(wire,{status:'needs',workerChecked:true,workerId:null,workerName:null,poolSubmitted:false}),true);
 const ledger=globals.exports.pmEntryTaskState({...legacy,task_states:{fire:{status:'needs',workerChecked:true,workerId:null,workerName:null,reviewedBy:null}}},template,'fire');
 assert.equal(queueRules.isPmTaskState(JSON.parse(JSON.stringify(ledger))),true);
});
