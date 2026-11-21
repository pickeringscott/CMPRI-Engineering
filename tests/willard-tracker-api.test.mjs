import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const SOURCE = 'https://api.adsb.lol/v2/point/40.03/-88.28/50';
const START = Date.parse('2026-11-20T15:50:52.001Z');
const AIRCRAFT = { hex:'a851f6',flight:'SKW5673 ',r:'N635SY',t:'E75L',lat:40.431829,lon:-89.200183,
  alt_baro:31450,gs:400.2,track:238.18,seen:0.1,seen_pos:0.205 };
function fixture(options={}) {
  let now=START;
  const calls=[],deadlines=[];
  class FakeDate extends Date { constructor(value){super(arguments.length?value:now);}static now(){return now;} }
  const route=loadTs('src/app/api/willard-tracker/route.ts',{}, {
    Date:FakeDate,Request,Response,URL,TextDecoder,AbortController,
    AbortSignal:{any:AbortSignal.any,timeout:ms=>{deadlines.push(ms);return options.timeoutSignal||AbortSignal.timeout(ms);}},
    fetch:async(url,init)=>{calls.push({url,init});return options.fetch?options.fetch(url,init,calls.length):Response.json({ac:[AIRCRAFT],msg:'No error',now});},
  });
  return {route,calls,deadlines,advance(ms){now+=ms;},get(init={},query=''){return route.GET(new Request('https://cmpri.test/api/willard-tracker'+query,init));}};
}

test('only fixed anonymous CMI point is read and verified jv2 milliseconds/position-age fields are preserved',async()=>{
  const f=fixture(),r=await f.get({},'?url=https://untrusted.test&lat=0&radius=999&sharing=review'),b=await r.json();
  assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,SOURCE);
  assert.equal(f.calls[0].init.credentials,'omit');assert.equal(f.calls[0].init.redirect,'error');assert.equal(f.calls[0].init.cache,'no-store');
  assert.deepEqual(f.deadlines,[10000]);assert.equal(b.airport,'KCMI');assert.equal(b.radiusNm,50);assert.equal(b.status,'live');
  assert.equal(b.observedAt,'2026-11-20T15:50:52.001Z');assert.equal(b.retrievedAt,b.observedAt);
  assert.deepEqual(b.aircraft,[{hex:'a851f6',callsign:'SKW5673',registration:'N635SY',type:'E75L',lat:40.431829,lon:-89.200183,
    altitudeFeet:31450,speedKnots:400.2,track:238.18,seenSeconds:0.1,positionAgeSeconds:0.205}]);
  assert.equal(b.license.name,'ODbL 1.0');assert.equal(b.source.url,SOURCE);assert.match(b.attribution,/ADSB.lol/);
});

test('shared cache and pending requests coalesce callers with no background refresh',async()=>{
  let release;
  const f=fixture({fetch:()=>new Promise(resolve=>{release=resolve;})});
  const first=f.get(),second=f.get();assert.equal(f.calls.length,1);
  release(Response.json({ac:[AIRCRAFT],now:START}));await Promise.all([first,second]);
  f.advance(179999);await f.get();assert.equal(f.calls.length,1);
  f.advance(2);const refreshed=f.get();assert.equal(f.calls.length,2);
  release(Response.json({ac:[],total:0,now:START+180001}));const b=await(await refreshed).json();assert.deepEqual(b.aircraft,[]);
});

test('empty verified collections are different from unknown, malformed, inconsistent, or invalid-position responses',async()=>{
  const empty=fixture({fetch:async()=>Response.json({ac:[],total:0,now:START,msg:'No error'})});
  const valid=await(await empty.get()).json();assert.equal(valid.status,'live');assert.deepEqual(valid.aircraft,[]);
  for(const body of [{now:START},{ac:null,now:START},{ac:[],total:3,now:START},{ac:[{...AIRCRAFT,lat:null}],now:START},
    {ac:[{...AIRCRAFT,lon:181}],now:START},{ac:[{...AIRCRAFT,hex:'bad'}],now:START},{ac:[],now:START,msg:'Error'},
    {ac:[],ctime:START},{ac:[],now:START/1000}]) {
    const f=fixture({fetch:async()=>Response.json(body)}),r=await f.get(),b=await r.json();
    assert.equal(r.status,502);assert.equal(b.status,'unavailable');assert.equal(b.aircraft,null);assert.equal(b.observedAt,null);
  }
});

test('invalid positions are omitted; unknown metrics stay null and ground/zero/old position ages retain their meaning',async()=>{
  const rows=[{...AIRCRAFT,hex:'a00001',lat:0,lon:0,alt_baro:'ground',gs:0,track:0,seen:0,seen_pos:600},
    {hex:'a00002',lat:40,lon:-88,alt_geom:1000,seen:0}, {...AIRCRAFT,hex:'a00003',lat:91}];
  const f=fixture({fetch:async()=>Response.json({ac:rows,now:START})}),b=await(await f.get()).json();
  assert.equal(b.aircraft.length,2);assert.equal(b.invalidAircraftCount,1);
  assert.equal(b.aircraft[0].altitudeFeet,'ground');assert.equal(b.aircraft[0].speedKnots,0);assert.equal(b.aircraft[0].track,0);
  assert.equal(b.aircraft[0].positionAgeSeconds,600);assert.equal(b.aircraft[1].positionAgeSeconds,null,'message age is not position age');
  for(const key of ['altitudeFeet','speedKnots','track','registration','callsign','type'])assert.equal(b.aircraft[1][key],null);
});

test('old source snapshots and failed refreshes retain original timestamps and aircraft with explicit stale status',async()=>{
  const old=fixture({fetch:async()=>Response.json({ac:[AIRCRAFT],now:START-180001})});
  assert.equal((await(await old.get()).json()).status,'stale');
  const f=fixture({fetch:async(_url,_init,count)=>count===1?Response.json({ac:[AIRCRAFT],now:START}):new Response('',{status:503})});
  const prior=await(await f.get()).json();f.advance(180001);const r=await f.get(),b=await r.json();
  assert.equal(r.status,200);assert.equal(b.status,'stale');assert.equal(b.observedAt,prior.observedAt);assert.equal(b.retrievedAt,prior.retrievedAt);
  assert.deepEqual(b.aircraft,prior.aircraft);assert.match(b.error,/could not be verified/);assert.equal(r.headers.get('Retry-After'),'180');
  await f.get();assert.equal(f.calls.length,2,'failure backoff prevents immediate repeat upstream reads');
});

test('429 Retry-After seconds/date are respected with bounded backoff and no repeated upstream requests',async()=>{
  for(const header of ['600',new Date(START+600000).toUTCString(),'999999999','invalid']) {
    const f=fixture({fetch:async()=>new Response('',{status:429,headers:{'Retry-After':header}})});
    const r=await f.get(),b=await r.json(),delay=header==='999999999'?86400:header==='invalid'?180:600;
    const until=header.includes('GMT')?Date.parse(header):START+delay*1000;
    assert.equal(r.status,502);assert.equal(r.headers.get('Retry-After'),String(delay));assert.equal(b.retryAt,new Date(until).toISOString());
    await f.get();f.advance(until-START-1);await f.get();assert.equal(f.calls.length,1);
    f.advance(2);await f.get();assert.equal(f.calls.length,2);
  }
});

test('bad formats, redirects, oversized buffers, malformed JSON and timeouts stay unavailable within read limits',async()=>{
  for(const response of [()=>new Response('<html>error</html>',{headers:{'Content-Type':'text/html'}}),
    ()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'2097153'}}),
    ()=>new Response('x'.repeat(2097153),{headers:{'Content-Type':'application/json'}}),
    ()=>new Response('{broken',{headers:{'Content-Type':'application/json'}}),
    ()=>new Response(null,{status:302,headers:{Location:'https://untrusted.test'}})]) {
    const f=fixture({fetch:async()=>response()}),b=await(await f.get()).json();
    assert.equal(b.status,'unavailable');assert.equal(b.aircraft,null);assert.equal(f.calls.length,1);
  }
  const f=fixture({timeoutSignal:AbortSignal.abort(),fetch:async(_url,init)=>{init.signal.throwIfAborted();throw Error('timeout');}});
  assert.equal((await(await f.get()).json()).status,'unavailable');assert.deepEqual(f.deadlines,[10000]);
});

test('unsupported methods or already-canceled requests perform no provider work',async()=>{
  const f=fixture();for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])assert.equal((await f.route[method](new Request('https://cmpri.test/api/willard-tracker',{method}))).status,405);
  const controller=new AbortController();controller.abort();assert.equal((await f.get({signal:controller.signal})).status,499);assert.equal(f.calls.length,0);
});

test('one canceled consumer cannot abort a shared read; canceling the last consumer stops it and cannot warm cache',async()=>{
  let release;
  const f=fixture({fetch:()=>new Promise(resolve=>{release=resolve;})});
  const a=new AbortController(),b=new AbortController();const first=f.get({signal:a.signal}),second=f.get({signal:b.signal});
  a.abort();assert.equal((await first).status,499);assert.equal(f.calls[0].init.signal.aborted,false);
  release(Response.json({ac:[AIRCRAFT],now:START}));assert.equal((await second).status,200);assert.equal(f.calls.length,1);
  const canceled=fixture({fetch:()=>new Promise(resolve=>{release=resolve;})}),last=new AbortController();
  const request=canceled.get({signal:last.signal});last.abort();assert.equal((await request).status,499);assert.equal(canceled.calls[0].init.signal.aborted,true);
  release(Response.json({ac:[AIRCRAFT],now:START}));await new Promise(resolve=>setImmediate(resolve));
  const retry=canceled.get();assert.equal(canceled.calls.length,2,'canceled source data never populates cache');
  release(Response.json({ac:[],now:START}));assert.equal((await retry).status,200);
});
