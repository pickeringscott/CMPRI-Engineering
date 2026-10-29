import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {changedResources} from '../src/lib/events/resources.ts';
import assert from 'node:assert/strict';
import {coordinateEventTransport} from '../src/lib/events/cross-document.ts';
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
export function infrastructure(){
 const queues=new Map(),owners=new Map(),buses=new Map(),messages=[];
 function drain(key){if(owners.has(key))return;const queue=queues.get(key)||[];const next=queue.shift();if(!next)return;if(next.signal.aborted){drain(key);return;}owners.set(key,next);Promise.resolve().then(next.callback).then(next.resolve,next.reject).finally(()=>{if(owners.get(key)===next)owners.delete(key);drain(key)});}
 const locks={request(key,{signal},callback){return new Promise((resolve,reject)=>{if(signal.aborted){reject(new DOMException('aborted','AbortError'));return;}const item={signal,callback,resolve,reject};const queue=queues.get(key)||[];queue.push(item);queues.set(key,queue);signal.addEventListener('abort',()=>{if(owners.get(key)!==item){const i=queue.indexOf(item);if(i>=0)queue.splice(i,1);reject(new DOMException('aborted','AbortError'));}},{once:true});drain(key);});}};
 function openBus(key){const peers=buses.get(key)||new Set();buses.set(key,peers);const bus={onmessage:null,postMessage(data){messages.push(structuredClone(data));for(const peer of peers)if(peer!==bus)queueMicrotask(()=>peer.onmessage?.({data:structuredClone(data)}));},close(){peers.delete(bus);}};peers.add(bus);return bus;}
 return {locks,openBus,messages,owners};
}
test('tabs and iframe share one transport; hide/close failover waits for cleanup; credentials never broadcast',async()=>{
 const infra=infrastructure(),active=new Map(),maximum=new Map(),wakes=[],signals=new Map();let releaseCleanup;
 const make=(id,key,delayed=false)=>coordinateEventTransport({key,...infra,wake:()=>wakes.push(id),failed:()=>assert.fail('unexpected coordination failure'),start:wake=>{signals.set(id,wake);active.set(key,(active.get(key)||0)+1);maximum.set(key,Math.max(maximum.get(key)||0,active.get(key)));return async()=>{if(delayed)await new Promise(r=>releaseCleanup=r);active.set(key,active.get(key)-1);};}});
 const a=make('tab','hotel:alice',true),b=make('iframe','hotel:alice'),c=make('other-tab','hotel:alice');a.setActive(true);b.setActive(true);c.setActive(true);await flush();assert.equal(active.get('hotel:alice'),1);
 signals.get('tab')();await flush();assert.deepEqual(wakes.sort(),['iframe','other-tab','tab']);assert.deepEqual(infra.messages,[{type:'wake'}]);wakes.length=0;
 a.setActive(false);await flush();assert.equal(signals.has('iframe'),false,'cleanup finishes before follower acquires');signals.get('tab')();assert.equal(wakes.length,0,'retired owner cannot emit');releaseCleanup();await flush();assert.ok(signals.has('iframe'));
 b.close();await flush();assert.ok(signals.has('other-tab'));assert.equal(maximum.get('hotel:alice'),1);
 a.close();c.close();await flush();assert.equal(active.get('hotel:alice'),0);assert.equal(infra.owners.size,0);
});
test('user/property namespaces, pending unsubscribe, stale callback and resume are isolated',async()=>{
 const infra=infrastructure(),signals={},wakes=[];const make=(id,key)=>coordinateEventTransport({key,...infra,wake:()=>wakes.push(id),failed:()=>assert.fail('unexpected failure'),start:wake=>{signals[id]=wake;return()=>{}}});
 const a=make('alice','h1:alice'),b=make('bob','h1:bob'),c=make('other-hotel','h2:alice'),pending=make('pending','h1:alice');
 for(const x of [a,b,c,pending])x.setActive(true);await flush();pending.close();signals.alice();await flush();assert.deepEqual(wakes,['alice']);
 a.setActive(false);await flush();signals.alice();assert.deepEqual(wakes,['alice']);a.setActive(true);await flush();signals.alice();await flush();assert.deepEqual(wakes,['alice','alice']);
 for(const x of [a,b,c])x.close();await flush();assert.equal(infra.owners.size,0);
});
test('unsupported browser fallback remains functional and performs no periodic reads',async()=>{
 let starts=0,stops=0,wakes=0;const c=coordinateEventTransport({key:'one',wake:()=>wakes++,failed:()=>assert.fail(),start:wake=>{starts++;wake();return()=>{stops++}}});
 c.setActive(true);c.setActive(true);await flush();assert.equal(starts,1);assert.equal(wakes,1);await flush();assert.equal(wakes,1);c.close();await flush();assert.equal(stops,1);
});

test('actual browser adapters coordinate tabs/iframe, recover missed imports, and reject logout/account stale responses',async()=>{
 const infra=infrastructure(),signals=new Map();let channels=0,revision='import-a';
 const source=ts.transpileModule(readFileSync('src/lib/events/browser.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 function realm(id,user='alice',hotel='hotel'){
   let session={user:{id:user},access_token:id+'-private-token'},onAuth,requests=0,hold=false,release,cleanupHang=false,disconnects=0;
   const handlers=new Map(),received=[],doc={hidden:false,addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k)};
   const exports={};
   vm.runInNewContext(source,{exports,queueMicrotask,AbortController,Event,crypto:globalThis.crypto,document:doc,navigator:{locks:infra.locks},BroadcastChannel:function(name){return infra.openBus(name)},window:{addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k),dispatchEvent(){}},
    fetch:async(_url,options)=>{requests++;assert.equal(options.headers.Authorization,'Bearer '+session.access_token);const captured=session.user.id,data={user_id:captured,hotel_id:hotel,revisions:[{resource:'room-operations',scope:'*',revision}]};if(hold)await new Promise(r=>release=r);return{ok:true,status:200,json:async()=>data}},
    require:n=>({'./cross-document':{coordinateEventTransport},'./resources':{changedResources},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/supabase/client':{getValidSession:async()=>session,createClient:()=>({getChannels:()=>[...signals.keys()].filter(c=>c.id===id),realtime:{disconnect(){disconnects++}},auth:{onAuthStateChange:fn=>{onAuth=fn;return{data:{subscription:{unsubscribe(){}}}}}},channel:()=>({on:(_type,filter,wake)=>{assert.equal(filter.filter,'user_id=eq.'+session.user.id);return{subscribe:cb=>{channels++;const channel={id};signals.set(channel,wake);queueMicrotask(()=>cb('SUBSCRIBED'));return channel}}}}),removeChannel:channel=>{signals.delete(channel);channels--;return cleanupHang?new Promise(()=>{}):Promise.resolve()}})}}[n])});
   const stop=exports.subscribeResource('room-operations',reason=>received.push(reason));
   return {received,doc,handlers,stop,holdUnsubscribe(){cleanupHang=true},get disconnects(){return disconnects},get requests(){return requests},pauseResponse(){hold=true},releaseResponse(){hold=false;release?.()},logout(){session=null;onAuth('SIGNED_OUT')},switchUser(next){session={user:{id:next},access_token:id+'-other-token'};onAuth('SIGNED_IN')}};
 }
 const a=realm('tab-a'),b=realm('iframe'),c=realm('tab-b');await flush();assert.equal(channels,1);for(const x of [a,b,c]){assert.ok(x.received.includes('initial'));x.received.length=0;}
 revision='import-b';for(const wake of signals.values())wake();await flush();for(const x of [a,b,c])assert.deepEqual(x.received,['change']);
 a.holdUnsubscribe();a.doc.hidden=true;a.handlers.get('visibilitychange')();await flush();assert.equal(a.disconnects,1,'freeze synchronously disconnects the retiring socket');assert.equal(channels,1,'pending unsubscribe ACK cannot hold leadership');const hiddenReads=a.requests;revision='import-c';for(const wake of signals.values())wake();await flush();assert.equal(a.requests,hiddenReads,'hidden peer does not query metadata');
 a.doc.hidden=false;a.handlers.get('visibilitychange')();await flush();assert.deepEqual(a.received,['change','change']);
 b.received.length=0;b.pauseResponse();revision='import-d';for(const wake of signals.values())wake();await flush();b.logout();b.releaseResponse();await flush();assert.ok(b.received.includes('reset'));assert.equal(b.received.includes('change'),false,'in-flight old account response discarded');
 c.switchUser('bob');await flush();assert.equal(channels,2,'different users never share transport');const prior=c.requests;for(const [channel,wake]of signals)if(channel.id==='tab-a')wake();await flush();assert.equal(c.requests,prior,'old account bus cannot wake the new account');
 for(const message of infra.messages)assert.deepEqual(Object.keys(message),['type']);for(const x of [a,b,c])x.stop();await flush();assert.equal(channels,0);
});

test('blocked browser lock capability falls back without broadcasting data',async()=>{
 let starts=0,stops=0;const infra=infrastructure();
 const c=coordinateEventTransport({key:'blocked',openBus:infra.openBus,locks:{request:async()=>{throw new DOMException('blocked','SecurityError')}},wake:()=>{},failed:()=>assert.fail(),start:wake=>{starts++;wake();return()=>stops++}});
 c.setActive(true);await flush();assert.equal(starts,1);assert.deepEqual(infra.messages,[]);c.close();await flush();assert.equal(stops,1);
});
