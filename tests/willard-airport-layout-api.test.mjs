import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const START=Date.parse('2026-11-20T18:00:00Z'),TTL=21600000;
const GEOMETRY={type:'Polygon',coordinates:[[[-88.29,40.03],[-88.28,40.03],[-88.28,40.04],[-88.29,40.03]]]};
function collection(overrides={}) {return {type:'FeatureCollection',features:[{type:'Feature',id:1,properties:{OBJECTID:1,ICAO_ID:'KCMI',FAA_ID:'CMI',DESIGNATOR:'14/32',SURFACE:1,RWY_OPER:2,TWY_OPER:2,APRON_OPER:2},geometry:GEOMETRY}],...overrides};}
function usgsCollection(codes=[20100,20101,20102]) {return {type:'FeatureCollection',features:codes.map((fcode,index)=>({type:'Feature',id:index+1,
  properties:{objectid:index+1,fcode,runway_id:index===0?'14/32':null,faa_airport_code:'CMI',city:'Champaign',state:'Illinois'},geometry:GEOMETRY}))};}
const isUSGS=url=>new URL(url).hostname==='cartowfs.nationalmap.gov';
function fixture(options={}) {
  let now=START;const calls=[],deadlines=[];
  class FakeDate extends Date {constructor(value){super(arguments.length?value:now);}static now(){return now;}}
  const route=loadTs('src/app/api/willard-airport-layout/route.ts',{}, {Date:FakeDate,Request,Response,URLSearchParams,TextDecoder,AbortController,
    AbortSignal:{any:AbortSignal.any,timeout:ms=>{deadlines.push(ms);return options.timeoutSignal||AbortSignal.timeout(ms);}},
    fetch:async(url,init)=>{calls.push({url,init});return options.fetch?options.fetch(url,init,calls.length):Response.json(collection());}});
  return {route,calls,deadlines,advance(ms){now+=ms;},get(init={},query=''){return route.GET(new Request('https://cmpri.test/api/willard-airport-layout'+query,init));}};
}

test('fixed official CMI queries return original WGS84 geometry, source editions and reference-only operational codes',async()=>{
  const f=fixture(),r=await f.get({},'?url=https://untrusted.test&airport=JFK&outSR=3857'),b=await r.json();
  assert.equal(r.status,200);assert.equal(b.status,'available');assert.equal(b.airport,'KCMI');assert.equal(b.collection.features.length,3);
  assert.deepEqual(b.collection.features.map(x=>x.properties.kind),['runway','taxiway','apron']);
  assert.deepEqual(b.collection.features[0].geometry,GEOMETRY);assert.equal(b.collection.features[0].properties.status,2);
  assert.equal(b.referenceOnly,true);assert.match(b.operationalStatusNote,/not current/);assert.equal(b.retrievedAt,new Date(START).toISOString());
  assert.equal(b.layers[0].effectivePeriod,'0901Z 7 August 2025–2 October 2025');assert.equal(b.layers[0].sourceDataEditedAt,'2026-10-29');
  assert.match(b.attribution,/FAA/);assert.doesNotMatch(b.license.name,/CC0/);assert.equal(b.cacheSeconds,21600);assert.deepEqual(f.deadlines,[10000]);
  assert.equal(b.layers[0].sourceCheck.httpStatus,200);assert.equal(b.layers[0].sourceCheck.failureStage,null);assert.equal(b.layers[0].sourceCheck.featureCount,1);
  for(const {url,init} of f.calls){const u=new URL(url);assert.equal(u.origin,'https://services6.arcgis.com');assert.match(u.pathname,/\/AM_(Runway|Taxiway|Apron)\/FeatureServer\/0\/query$/);
    assert.equal(u.searchParams.get('where'),"(ICAO_ID='KCMI' OR FAA_ID='CMI')");assert.equal(u.searchParams.get('outSR'),'4326');assert.equal(u.searchParams.get('f'),'geojson');
    assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.method,'GET');}
});

test('one failed layer preserves available siblings and reports partial coverage',async()=>{
  const f=fixture({fetch:async url=>url.includes('AM_Taxiway')?new Response('',{status:503}):Response.json(collection())}),b=await(await f.get()).json();
  assert.equal(b.status,'partial');assert.equal(b.collection.features.length,2);assert.equal(b.layers[1].status,'unavailable');assert.equal(b.layers[1].featureCount,null);
  assert.equal(f.calls.length,3,'a successful FAA sibling prevents a fallback query');
});

test('verified FAA identity supports CMI-only records without inventing an ICAO source value',async()=>{
  for(const icao of [null,'','CMI']) {
    const row=collection().features[0],body=collection({features:[{...row,properties:{...row.properties,ICAO_ID:icao,FAA_ID:'CMI'}}]});
    const f=fixture({fetch:async()=>Response.json(body)}),b=await(await f.get()).json();
    assert.equal(b.status,'available');assert.equal(f.calls.length,3);
    assert.equal(b.collection.features[0].properties.airportId,'KCMI');
    assert.equal(b.collection.features[0].properties.sourceICAOId,icao);
    assert.equal(b.collection.features[0].properties.faaId,'CMI');
  }
  for(const [icao,faa] of [['KORD','CMI'],['KCMI','JFK']]) {
    const row=collection().features[0],body=collection({features:[{...row,properties:{...row.properties,ICAO_ID:icao,FAA_ID:faa}}]});
    const f=fixture({fetch:async url=>Response.json(isUSGS(url)?usgsCollection([]):body)}),b=await(await f.get()).json();
    assert.equal(b.status,'unavailable');assert.equal(b.collection,null,'contradictory airport identifiers must not be displayed');
  }
});

test('the fixed official USGS fallback supplies genuine source-coded runway, taxiway and apron geometry only when FAA has none',async()=>{
  const f=fixture({fetch:async url=>Response.json(isUSGS(url)?usgsCollection([20100,20101,20102,20103]):collection({features:[]}))});
  const r=await f.get({},'?airport=JFK&source=https://untrusted.test'),b=await r.json();
  assert.equal(r.status,200);assert.equal(b.status,'available');assert.equal(f.calls.length,4);
  assert.deepEqual(f.deadlines,[10000],'the fallback shares the original whole-batch deadline');
  assert.ok(f.calls.every(call=>call.init.signal===f.calls[0].init.signal));
  assert.equal(b.sourceName,'USGS The National Map');assert.match(b.attribution,/USGS|U\.S\. Geological Survey/);
  assert.match(b.license.name,/public domain/i);assert.equal(b.collection.features.length,3,'stopways are not reclassified as a supported layer');
  assert.deepEqual(b.collection.features.map(x=>x.properties.kind),['runway','taxiway','apron']);
  assert.deepEqual(b.collection.features[0].geometry,GEOMETRY);assert.equal(b.collection.features[0].properties.airportId,'KCMI');
  for(const layer of b.layers){assert.equal(layer.effectivePeriod,null);assert.equal(layer.sourceDataEditedAt,null);assert.equal(layer.status,'available');}
  const upstream=new URL(f.calls[3].url);assert.equal(upstream.origin,'https://cartowfs.nationalmap.gov');
  assert.equal(upstream.pathname,'/arcgis/rest/services/transportation/MapServer/2/query');
  assert.equal(upstream.searchParams.get('where'),"faa_airport_code IN ('CMI','KCMI')");
  assert.equal(upstream.searchParams.get('outFields'),'objectid,fcode,runway_id,faa_airport_code,city,state');
  assert.equal(upstream.searchParams.get('outSR'),'4326');assert.equal(upstream.searchParams.get('f'),'geojson');
  assert.equal(f.calls[3].init.credentials,'omit');assert.equal(f.calls[3].init.redirect,'error');
});

test('USGS missing classes remain unknown and identifier mismatches cannot add airport features',async()=>{
  const onlyRunway=usgsCollection([20100]);
  onlyRunway.features.push({...onlyRunway.features[0],id:99,properties:{...onlyRunway.features[0].properties,fcode:20101,faa_airport_code:'ORD'}});
  const f=fixture({fetch:async url=>Response.json(isUSGS(url)?onlyRunway:collection({features:[]}))}),b=await(await f.get()).json();
  assert.equal(b.status,'partial');assert.equal(b.collection.features.length,1);assert.equal(b.collection.features[0].properties.kind,'runway');
  for(const kind of ['taxiway','apron']){const layer=b.layers.find(x=>x.kind===kind);assert.equal(layer.status,'unavailable');assert.equal(layer.featureCount,null);}
});

test('empty FAA and USGS coverage remains unavailable with no fabricated geometry or edition dates',async()=>{
  const f=fixture({fetch:async url=>Response.json(isUSGS(url)?usgsCollection([]):collection({features:[]}))}),r=await f.get(),b=await r.json();
  assert.equal(r.status,502);assert.equal(b.status,'unavailable');assert.equal(b.collection,null);assert.equal(f.calls.length,4);
  assert.equal(b.primarySourceChecks[0].sourceCheck.featureCount,0);assert.equal(b.primarySourceChecks[0].sourceCheck.failureStage,'empty');
  assert.equal(b.fallbackSourceCheck.featureCount,0);assert.equal(b.fallbackSourceCheck.failureStage,'empty');
  for(const layer of b.layers){assert.equal(layer.effectivePeriod,null);assert.equal(layer.sourceDataEditedAt,null);}
});

test('empty or invalid CMI coverage is unknown, not an empty complete layout',async()=>{
  for(const body of [collection({features:[]}),collection({features:[{...collection().features[0],properties:{ICAO_ID:'KORD'}}]}),
    collection({features:[{...collection().features[0],geometry:{type:'Point',coordinates:[-88,40]}}]}),{error:{code:400}},
    collection({exceededTransferLimit:true})]) {
    const f=fixture({fetch:async()=>Response.json(body)}),r=await f.get(),b=await r.json();
    assert.equal(r.status,502);assert.equal(b.status,'unavailable');assert.equal(b.collection,null);assert.equal(b.retrievedAt,null);
  }
});

test('projected or misdeclared reference systems, invalid coordinates and broken rings are rejected',async()=>{
  for(const body of [collection({crs:{type:'name',properties:{name:'EPSG:3857'}}}),collection({spatialReference:{wkid:3857}}),collection({spatialReference:{wkid:3857,latestWkid:4326}}),
    collection({features:[{...collection().features[0],geometry:{type:'Polygon',coordinates:[[[-9800000,4800000],[-9800010,4800000],[-9800010,4800010],[-9800000,4800000]]]}}]}),
    collection({features:[{...collection().features[0],geometry:{type:'Polygon',coordinates:[[[-88,40],[-88,41],[-89,41],[-89,40]]]}}]})]) {
    const f=fixture({fetch:async()=>Response.json(body)}),b=await(await f.get()).json();assert.equal(b.status,'unavailable');assert.equal(b.collection,null);
  }
  const multi={type:'MultiPolygon',coordinates:[GEOMETRY.coordinates]};
  const f=fixture({fetch:async()=>Response.json(collection({crs:{type:'name',properties:{name:'urn:ogc:def:crs:OGC:1.3:CRS84'}},features:[{...collection().features[0],geometry:multi}]}))});
  assert.deepEqual((await(await f.get()).json()).collection.features[0].geometry,multi);
  const uri=fixture({fetch:async()=>Response.json(collection({crs:{type:'name',properties:{name:'http://www.opengis.net/def/crs/OGC/1.3/CRS84'}}}))});
  assert.equal((await(await uri.get()).json()).status,'available');
});

test('bounded public-source diagnostics identify query, empty, CRS, geometry and response-format failures',async()=>{
  const cases=[
    [()=>Response.json({error:{code:400,message:'Invalid field '+ 'x'.repeat(400)}},{status:400}),'provider',400],
    [()=>Response.json(collection({features:[]})),'empty',null],
    [()=>Response.json(collection({crs:{type:'name',properties:{name:'EPSG:3857'}}})),'crs',null],
    [()=>Response.json(collection({features:[{...collection().features[0],geometry:{type:'Point',coordinates:[-88,40]}}]})),'geometry',null],
    [()=>new Response('not a source body',{status:403,headers:{'Content-Type':'text/html'}}),'http',null],
  ];
  for(const [make,stage,code] of cases){
    const f=fixture({fetch:async()=>make()}),b=await(await f.get()).json(),check=b.primarySourceChecks?.[0].sourceCheck||b.layers[0].sourceCheck;
    assert.equal(check.failureStage,stage);assert.equal(check.providerErrorCode,code);assert.ok(check.message.length<=200);
    assert.equal(typeof check.httpStatus,'number');assert.equal(typeof check.contentType,'string');
  }
});

test('valid geometry survives an invalid sibling feature but is not called complete',async()=>{
  const bad={...collection().features[0],geometry:{type:'Polygon',coordinates:[]}};
  const f=fixture({fetch:async()=>Response.json(collection({features:[collection().features[0],bad]}))}),b=await(await f.get()).json();
  assert.equal(b.status,'partial');assert.equal(b.collection.features.length,3);assert.equal(b.layers[0].invalidFeatureCount,1);
});

test('six-hour memory cache and pending coalescing avoid duplicate provider work; failed refresh retains old geometry',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const f=fixture({fetch:async(_url,_init,count)=>{if(count<=3){await gate;return Response.json(collection());}return new Response('',{status:503});}});
  const first=f.get(),second=f.get();assert.equal(f.calls.length,3);release();const initial=await(await first).json();await second;
  f.advance(TTL-1);await f.get();assert.equal(f.calls.length,3);f.advance(2);const stale=await(await f.get()).json();
  assert.equal(f.calls.length,7);assert.equal(stale.status,'stale');assert.deepEqual(stale.collection,initial.collection);assert.equal(stale.retrievedAt,initial.retrievedAt);
  assert.ok(stale.layers.every(x=>x.status==='stale'));await f.get();assert.equal(f.calls.length,7,'failed refresh has a short memory backoff');
});

test('combined two-MiB stream budget, formats, redirects and deadlines bound official reads',async()=>{
  for(const response of [()=>new Response('html',{headers:{'Content-Type':'text/html'}}),()=>new Response(null,{status:302}),
    ()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'2097153'}}),
    ()=>new Response('x'.repeat(2097153),{headers:{'Content-Type':'application/json'}})]) {
    const f=fixture({fetch:async()=>response()}),b=await(await f.get()).json();assert.equal(b.status,'unavailable');assert.equal(f.calls.length,4);
  }
  const large=JSON.stringify({...collection(),padding:'x'.repeat(800000)});
  const f=fixture({fetch:async()=>new Response(large,{headers:{'Content-Type':'application/geo+json'}})}),b=await(await f.get()).json();
  assert.equal(b.status,'partial');assert.ok(b.collection.features.length<3,'three individually valid bodies exceeding the combined budget cannot all be accepted');
  const emptyLarge=JSON.stringify({...collection({features:[]}),padding:'x'.repeat(600000)});
  const fallbackLarge=JSON.stringify({...usgsCollection(),padding:'x'.repeat(400000)});
  const sharedBudget=fixture({fetch:async url=>new Response(isUSGS(url)?fallbackLarge:emptyLarge,{headers:{'Content-Type':'application/geo+json'}})});
  const exhausted=await(await sharedBudget.get()).json();
  assert.equal(exhausted.status,'unavailable','the fallback cannot reset the combined FAA/USGS body budget');
  assert.equal(sharedBudget.calls.length,4);
  const timeout=fixture({timeoutSignal:AbortSignal.abort(),fetch:async(_url,init)=>{init.signal.throwIfAborted();throw Error('timeout');}});
  assert.equal((await(await timeout.get()).json()).status,'unavailable');assert.deepEqual(timeout.deadlines,[10000]);
});

test('unsupported methods and canceled callers do no work; shared cancellation only stops the final consumer',async()=>{
  const f=fixture();for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])assert.equal((await f.route[method](new Request('https://cmpri.test/api/willard-airport-layout',{method}))).status,405);
  const canceled=new AbortController();canceled.abort();assert.equal((await f.get({signal:canceled.signal})).status,499);assert.equal(f.calls.length,0);
  let release;const gate=new Promise(resolve=>{release=resolve;});const shared=fixture({fetch:async()=>{await gate;return Response.json(collection());}});
  const a=new AbortController(),b=new AbortController(),first=shared.get({signal:a.signal}),second=shared.get({signal:b.signal});
  a.abort();assert.equal((await first).status,499);assert.ok(shared.calls.every(x=>!x.init.signal.aborted));release();assert.equal((await second).status,200);
  let finish;const last=fixture({fetch:()=>new Promise(resolve=>{finish=resolve;})}),stop=new AbortController(),pending=last.get({signal:stop.signal});
  stop.abort();assert.equal((await pending).status,499);assert.ok(last.calls.every(x=>x.init.signal.aborted));
  finish(Response.json(collection()));
});
