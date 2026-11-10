import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import {loadTs} from './helpers/load-ts.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://cmpri.test'});
globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.HTMLElement=dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const require=createRequire(import.meta.url);
const source=readFileSync('src/components/desktop/PoolStatus.tsx','utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;

function fixture({canReopen=true,manual=true,fail=false,confirm=true}={}) {
 const requests=[],updated=[],prompts=[];
 const state={closed:true,manual_closed:manual,hours_closed:false,reason:'Maintenance',revision:3,notifications:[]};
 const exports={};
 const rootWindow={confirm:message=>{prompts.push(message);return confirm}};
 vm.runInNewContext(code,{exports,window:rootWindow,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'},fetch:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return {ok:!fail,json:async()=>fail?{error:'Closed pending pool testing.'}:{...state,closed:false,revision:4}}},require(name){
  if(name==='react'||name==='react/jsx-runtime')return require(name);
  if(name==='@/lib/events/pool-store')return {usePoolState:()=>({state,error:''}),updatePoolState:value=>updated.push(value)};
  if(name==='@/lib/auth/client-session')return {authorizationHeaders:async()=>({Authorization:'Bearer fixture'})};
  throw Error(name);
 }});
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
 return {state,requests,updated,prompts,container,async render(){await React.act(async()=>root.render(React.createElement(exports.default,{canReopen})))},async click(text){const button=[...container.querySelectorAll('button')].find(button=>button.textContent===text);assert.ok(button,text);await React.act(async()=>button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})))},async input(value){const input=container.querySelector('input');const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;await React.act(async()=>{setter.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));})},async submit(){await React.act(async()=>container.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})))},async dispose(){await React.act(async()=>root.unmount());container.remove()}};
}

test('authorized staff see only close and open; closing requires a reason',async()=>{
 const f=fixture();try{await f.render();assert.deepEqual([...f.container.querySelectorAll('button')].map(b=>b.textContent),['Close pool','Open pool']);await f.submit();assert.match(f.container.textContent,/Enter a reason/);assert.equal(f.requests.length,0);await f.input('  Broken pump  ');await f.submit();assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.closed,true);assert.equal(f.requests[0].body.reason,'Broken pump');assert.equal(f.requests[0].body.expectedRevision,3);}finally{await f.dispose()}
});
test('manual open confirms once, uses the one-step action, and preserves server refusal',async()=>{
 const f=fixture({fail:true});try{await f.render();await f.click('Open pool');assert.equal(f.prompts.length,1);assert.match(f.prompts[0],/required tests/);assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.action,'pool-status');assert.equal(f.requests[0].body.closed,false);assert.equal(f.updated.length,0);assert.match(f.container.textContent,/Closed pending pool testing/);}finally{await f.dispose()}
});
test('cancelling the manual reopen and lacking permission never sends an open',async()=>{
 const f=fixture({confirm:false});try{await f.render();await f.click('Open pool');assert.equal(f.requests.length,0);}finally{await f.dispose()}
 const automatic=fixture({manual:false,confirm:false});try{await automatic.render();await automatic.click('Open pool');assert.equal(automatic.prompts.length,1);assert.equal(automatic.requests.length,0);}finally{await automatic.dispose()}
 const readOnly=fixture({canReopen:false});try{await readOnly.render();assert.deepEqual([...readOnly.container.querySelectorAll('button')].map(b=>b.textContent),['Close pool']);}finally{await readOnly.dispose()}
});

test('a notification read failure after the action reports the confirmed pool state',async()=>{
 const queries=[],snapshot={closed:false,reason:'',revision:4,hours_closed:false,manual_closed:false,log:null};
 const admin={from(table){queries.push(table);const q={select(){return q},eq(){return q},like(){return q},is(){return q},order(){return q},limit(){return Promise.resolve(table==='pool_facilities'?{data:[{id:'pool'}],error:null}:{data:null,error:{message:'notification read failed'}})}};return q},rpc:async(name,args)=>{assert.equal(name,'cmpri_pool_action');assert.equal(args.p_action,'open');return {data:snapshot,error:null}}};
 const route=loadTs('src/app/api/pool-status/route.ts',{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},'@/lib/server/auth':{requireUser:async()=>({principal:{profile:{role:'Engineer'},identity:{id:'actor'}},admin})},'@/lib/server/roles':{roleKey:()=> 'engineer'},'@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/pool-log':{poolCurrentClosureReasons:()=>[]}});
 const response=await route.POST({json:async()=>({id:'11111111-1111-4111-8111-111111111111',action:'pool-status',closed:false,reason:'',expectedRevision:3})});
 assert.equal(response.status,200);assert.equal(response.body.closed,false);assert.equal(response.body.revision,4);assert.match(response.body.warning,/status saved/i);assert.equal('notifications' in response.body,false);assert.deepEqual(queries,['pool_facilities','cmpri_dashboard_notifications']);
});
