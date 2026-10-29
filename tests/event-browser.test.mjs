import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {changedResources} from '../src/lib/events/resources.ts';
const coordination={};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/events/cross-document.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:coordination,AbortController});
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
test('one private channel, event replay, hidden tab recovery, unchanged import and account cleanup',async()=>{
 let session={user:{id:'alice'},access_token:'a'},requests=0,channels=0,removed=0,onEvent,onAuth;
 const handlers=new Map(),events=[],doc={hidden:false,addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k)};
 let rows=[{resource:'room-operations',scope:'*',revision:'import-a'},{resource:'notifications',scope:'alice',revision:'n-a'}];
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/events/browser.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
 exports,queueMicrotask,AbortController,Event,crypto:globalThis.crypto,
 document:doc,window:{addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k),dispatchEvent:()=>{}},
 fetch:async()=>{requests++;return {ok:true,status:200,json:async()=>({user_id:session.user.id,hotel_id:'hotel',revisions:rows})};},
 require:name=>({
 '@/lib/supabase/client':{getValidSession:async()=>session,createClient:()=>({getChannels:()=>[],realtime:{disconnect(){}},auth:{onAuthStateChange:fn=>{onAuth=fn;return{data:{subscription:{unsubscribe(){}}}};}},channel:()=>{channels++;return {on:(_type,filter,fn)=>{assert.equal(filter.filter,'user_id=eq.'+session.user.id);onEvent=fn;return {subscribe:cb=>{queueMicrotask(()=>cb('SUBSCRIBED'));return {};}};}};},removeChannel:async()=>{removed++;}})},
 '@/lib/constants':{HOTEL_ID:'hotel'},'./resources':{changedResources},'./cross-document':coordination
 }[name])
 });
 const stopA=exports.subscribeResource('room-operations',r=>events.push(['room',r]));
 const stopB=exports.subscribeResource('notifications',r=>events.push(['inbox',r]));
 await flush();assert.equal(channels,1);
 assert.ok(events.some(e=>e[1]==='initial'));events.length=0;
 const idle=requests;await flush();assert.equal(requests,idle,'no polling timer');
 onEvent();await flush();assert.equal(events.length,0,'duplicate signal does not refetch snapshot');
 rows=[rows[0],{...rows[1],revision:'n-b'}];onEvent();await flush();
 assert.deepEqual(events,[['inbox','change']]);events.length=0;
 doc.hidden=true;rows=[{...rows[0],revision:'import-b'},rows[1]];onEvent();await flush();assert.equal(events.length,0);
 doc.hidden=false;handlers.get('visibilitychange')();await flush();assert.deepEqual(events,[['room','change']]);
 events.length=0;handlers.get('visibilitychange')();await flush();assert.equal(events.length,0);
 session=null;onAuth('SIGNED_OUT');await flush();assert.ok(events.some(e=>e[1]==='reset'));
 stopA();stopB();await flush();assert.ok(removed>=1);assert.equal(handlers.size,0);
});

