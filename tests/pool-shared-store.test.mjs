import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFileSync} from 'node:fs';
test('header and embedded Pool share one authorized read/store and detach iframe subscribers',async()=>{
 const source=ts.transpileModule(readFileSync('src/lib/events/pool-store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 let reads=0,subscriptions=0,stops=0;const cleanups=[],observers=[];
 const host={};host.parent=host;
 function instance(window){const exports={};vm.runInNewContext(source,{exports,window,MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this)}observe(){}disconnect(){this.disconnected=true}},require(name){if(name==='react')return {useSyncExternalStore:(subscribe,read)=>{cleanups.push(subscribe(()=>{}));return read()}};if(name==='@/lib/auth/client-session')return {authorizationHeaders:async()=>({Authorization:'fixture'})};if(name==='./browser')return {subscribeResources:(_topics,load)=>{subscriptions++;void load();return()=>stops++}};throw Error(name)},fetch:async()=>{reads++;return {ok:true,json:async()=>({closed:true,reason:'Closed',revision:1,notifications:[]})}}});return exports}
 const parent=instance(host);parent.usePoolState();await new Promise(setImmediate);
 const events=new Map(),frame={isConnected:true};const childWindow={parent:host,frameElement:frame,addEventListener:(n,fn)=>events.set(n,fn),removeEventListener:n=>events.delete(n)};host.document={};
 const child=instance(childWindow);const state=child.usePoolState();assert.equal(state.state.closed,true);assert.equal(reads,1);assert.equal(subscriptions,1);
 child.updatePoolState({closed:false});assert.equal(host.__cmpriPoolStore.read().state.closed,false);
 frame.isConnected=false;observers[0].fn();assert.equal(events.size,0);assert.equal(stops,0);
 cleanups[0]();assert.equal(stops,1);cleanups[1]();assert.equal(stops,1,'Detachment and React cleanup are idempotent');
});
