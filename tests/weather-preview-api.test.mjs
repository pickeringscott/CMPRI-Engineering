import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';

const API='https://api.weather.gov', POINT='40.138080,-88.251416';
const LOOKUP_POINT='40.1381,-88.2514';
const now=new Date().toISOString();
function payloads(overrides={}) {
  return {
    ['/points/'+LOOKUP_POINT]:{properties:{forecast:API+'/gridpoints/ILX/95,71/forecast',forecastHourly:API+'/gridpoints/ILX/95,71/forecast/hourly',forecastGridData:API+'/gridpoints/ILX/95,71',observationStations:API+'/gridpoints/ILX/95,71/stations'}},
    '/gridpoints/ILX/95,71/forecast':{properties:{updateTime:now,periods:[{name:'Tonight',detailedForecast:'Official forecast text.',temperature:35}]}},
    '/gridpoints/ILX/95,71/forecast/hourly':{properties:{updateTime:now,periods:[{startTime:now,probabilityOfPrecipitation:{unitCode:'wmoUnit:percent',value:null}}]}},
    '/gridpoints/ILX/95,71':{properties:{updateTime:now,snowfallAmount:{uom:'wmoUnit:mm',values:[{validTime:now+'/PT6H',value:null}]},iceAccumulation:{uom:'wmoUnit:mm',values:[]}}},
    '/gridpoints/ILX/95,71/stations':{features:[{properties:{stationIdentifier:'KFAR',name:'Farther report'},geometry:{type:'Point',coordinates:[-90,41]}},{properties:{stationIdentifier:'KCMI',name:'University of Illinois Willard Airport'},geometry:{type:'Point',coordinates:[-88.278,40.034]}}]},
    '/stations/KCMI/observations/latest':{geometry:{type:'Point',coordinates:[-88.28,40.03]},properties:{timestamp:now,textDescription:'Cloudy',temperature:{unitCode:'wmoUnit:degC',value:4},windChill:{unitCode:'wmoUnit:degC',value:0},windGust:{unitCode:'wmoUnit:km_h-1',value:null}}},
    ['/alerts/active?point='+POINT]:{type:'FeatureCollection',features:[{id:'urn:oid:official-alert',geometry:null,properties:{event:'Winter Weather Advisory',effective:now,expires:'2099-01-01T00:00:00Z',description:'Official bulletin text.',areaDesc:'Champaign'}}]},
    ...overrides,
  };
}
function fixture(options={}) {
  const calls=[],sources=options.sources||payloads();
  const read=options.fetch||(async(url,init)=>{
    const parsed=new URL(url), key=parsed.pathname+parsed.search;
    calls.push({url,init});
    if(!(key in sources))throw new Error('Unexpected NWS request: '+key);
    if(sources[key] instanceof Error)throw sources[key];
    return Response.json(sources[key]);
  });
  const route=loadTs('src/app/api/weather-preview/route.ts',{}, {
    process:{env:{VERCEL_ENV:options.environment===null?undefined:options.environment||'preview',NODE_ENV:options.nodeEnv||'production'}},
    Request,Response,URL,Error,AbortSignal:options.AbortSignal||AbortSignal,fetch:read,
  });
  return {route,calls,get:(part,init={})=>route.GET(new Request('https://branch.example/api/weather-preview?url=https://evil.example&point=0,0'
    +(part===undefined?'':'&part='+encodeURIComponent(part)),init))};
}

test('production returns404 before any NWS request',async()=>{
  const {get,calls}=fixture({environment:'production'});
  const response=await get();
  assert.equal(response.status,404);assert.equal(calls.length,0);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('only explicit branch previews and local development enable NWS reads',async()=>{
  for(const [environment,nodeEnv,expected] of [
    [null,'production',404],['development','production',404],
    ['production','development',404],[null,'development',200],['preview','production',200],
  ]) {
    const {get,calls}=fixture({environment,nodeEnv});
    const response=await get();
    assert.equal(response.status,expected,`${environment}/${nodeEnv}`);
    assert.equal(calls.length,expected===404?0:7);
  }
});

test('live property resources preserve official text, times, null amounts and polygonless alerts',async()=>{
  const {get,calls}=fixture();
  const response=await get(), body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(body.location.latitude,40.138080);assert.equal(body.location.longitude,-88.251416);
  assert.equal(body.resources.points.source,API+'/points/'+LOOKUP_POINT);
  assert.ok(calls.some(call=>call.url===API+'/alerts/active?point='+POINT));
  assert.ok(!calls.some(call=>call.url===API+'/points/'+POINT),'Use the official canonical point directly rather than its301 alias');
  assert.equal(calls.length,7);assert.equal(new Set(calls.map(call=>call.url)).size,7);
  for(const resource of Object.values(body.resources)) {
    assert.equal(resource.status,'live');assert.equal(resource.error,null);assert.ok(resource.receivedAt);
    assert.equal(new URL(resource.source).origin,API);
  }
  assert.equal(body.resources.forecast.data.properties.periods[0].detailedForecast,'Official forecast text.');
  assert.equal(body.resources.grid.data.properties.snowfallAmount.values[0].value,null);
  assert.deepEqual(body.resources.grid.data.properties.iceAccumulation.values,[]);
  assert.equal(body.resources.observation.station.id,'KCMI');
  assert.equal(body.resources.observation.data.properties.windChill.value,0);
  assert.equal(body.resources.observation.data.properties.windChill.unitCode,'wmoUnit:degC');
  assert.equal(body.resources.observation.data.properties.windGust.value,null);
  assert.equal(body.resources.alerts.data.features[0].geometry,null);
  assert.equal(body.resources.alerts.data.features[0].properties.description,'Official bulletin text.');
  for(const call of calls) {
    assert.equal(call.init.redirect,'manual');assert.equal(call.init.credentials,'omit');assert.equal(call.init.cache,'no-store');
    assert.ok(call.init.headers['User-Agent'].includes('CMPRI'));
  }
});

test('point discovery failure leaves alerts independent and never fabricates forecasts',async()=>{
  const {get,calls}=fixture({sources:payloads({['/points/'+LOOKUP_POINT]:new Error('NWS temporarily unavailable')})});
  const {resources}=await(await get()).json();
  assert.equal(calls.length,3);assert.equal(resources.points.status,'unavailable');
  assert.equal(resources.forecast.status,'unavailable');assert.equal(resources.forecast.data,null);
  assert.equal(resources.observation.status,'live');assert.equal(resources.observation.station.id,'KCMI');assert.equal(resources.alerts.status,'live');
  assert.equal(resources.alerts.data.features[0].geometry,null);
});

test('one failed product does not erase successful conditions or alerts',async()=>{
  const {get}=fixture({sources:payloads({'/gridpoints/ILX/95,71/forecast/hourly':new Error('Hourly unavailable')})});
  const {resources}=await(await get()).json();
  assert.equal(resources.hourly.status,'unavailable');assert.equal(resources.hourly.data,null);
  assert.equal(resources.forecast.status,'live');assert.equal(resources.observation.status,'live');
  assert.equal(resources.alerts.status,'live');
});

test('malformed alert collections remain unavailable rather than an empty all-clear',async()=>{
  const {get}=fixture({sources:payloads({['/alerts/active?point='+POINT]:{features:null}})});
  const {resources}=await(await get()).json();
  assert.equal(resources.alerts.status,'unavailable');assert.equal(resources.alerts.data,null);
  assert.match(resources.alerts.error,/verifiable feature collection/);
  assert.equal(resources.forecast.status,'live');
});

test('discovered URLs cannot redirect requests to user URLs or unrelated official endpoints',async()=>{
  const points={properties:{forecast:'https://evil.example/forecast',forecastHourly:API+'/alerts',forecastGridData:API+'/gridpoints/ILX/95,71?url=https://evil.example',observationStations:'https://api.weather.gov.evil.example/stations'}};
  const {get,calls}=fixture({sources:payloads({['/points/'+LOOKUP_POINT]:points})});
  const {resources}=await(await get()).json();
  assert.equal(calls.length,3);
  for(const key of ['forecast','hourly','grid','stations'])assert.equal(resources[key].status,'unavailable');
  assert.equal(resources.observation.status,'live');
});

test('NWS redirects are refused rather than followed',async()=>{
  const calls=[];
  const {get}=fixture({fetch:async(url,init)=>{
    calls.push({url,init});return new Response(null,{status:302,headers:{Location:'https://evil.example'}});
  }});
  const {resources}=await(await get()).json();
  assert.equal(calls.length,3);assert.equal(resources.points.status,'unavailable');
  assert.match(resources.points.error,/redirects are not followed/);
  assert.equal(resources.alerts.status,'unavailable');
});

test('known old source timestamps are stale; absent forecast issue time is not invented',async()=>{
  const old=new Date(Date.now()-8*3600000).toISOString();
  const {get}=fixture({sources:payloads({
    '/gridpoints/ILX/95,71/forecast':{properties:{periods:[]}},
    '/gridpoints/ILX/95,71/forecast/hourly':{properties:{updateTime:old,periods:[]}},
    '/stations/KCMI/observations/latest':{properties:{timestamp:old,temperature:{value:null}}},
  })});
  const {resources}=await(await get()).json();
  assert.equal(resources.forecast.status,'live');assert.equal(resources.forecast.sourceTimestamp,null);
  assert.equal(resources.hourly.status,'stale');assert.equal(resources.observation.status,'stale');
  assert.equal(resources.observation.data.properties.temperature.value,null);
});

test('unknown observation time stays unavailable while preserving the raw report',async()=>{
  const {get}=fixture({sources:payloads({'/stations/KCMI/observations/latest':{properties:{temperature:{value:null}}}})});
  const {resources}=await(await get()).json();
  assert.equal(resources.observation.status,'unavailable');assert.equal(resources.observation.sourceTimestamp,null);
  assert.equal(resources.observation.data.properties.temperature.value,null);
});

test('every official read has a12-second deadline and timeout remains unavailable',async()=>{
  const deadlines=[];
  const {get}=fixture({AbortSignal:{any:AbortSignal.any,timeout:(milliseconds)=>{deadlines.push(milliseconds);return AbortSignal.abort(new DOMException('Request timed out','TimeoutError'));}},
    fetch:async(_url,init)=>{init.signal.throwIfAborted();throw new Error('Expected abort');}});
  const {resources}=await(await get()).json();
  assert.deepEqual(deadlines,[12000,12000,12000]);
  assert.equal(resources.points.status,'unavailable');assert.equal(resources.alerts.status,'unavailable');
  assert.match(resources.alerts.error,/timed out/);
});

test('observation part reads fixed KCMI immediately without discovery or any forecast dependency',async()=>{
  const {get,calls}=fixture({sources:payloads({['/points/'+LOOKUP_POINT]:new Error('Points unavailable'),
    '/gridpoints/ILX/95,71/forecast':new Error('Slow or failed forecast')})});
  const response=await get('observation'),body=await response.json();
  assert.equal(response.status,200);assert.deepEqual(Object.keys(body.resources),['observation']);
  assert.equal(calls.length,1);assert.equal(calls[0].url,API+'/stations/KCMI/observations/latest');
  const observation=body.resources.observation;
  assert.equal(observation.status,'live');assert.equal(observation.station.id,'KCMI');
  assert.equal(observation.station.name,'University of Illinois - Willard');
  assert.equal(observation.station.latitude,40.03);assert.equal(observation.station.longitude,-88.28);
  assert.ok(observation.station.distanceMeters>0);assert.equal(observation.sourceTimestamp,new Date(now).toISOString());
  assert.equal(observation.data.properties.windChill.value,0,'A reported zero Celsius wind chill is a valid raw value');
  assert.equal(observation.data.properties.windGust.value,null,'Missing observed gusts must remain null');
});

test('independent observation response completes while the forecast part is still pending',async()=>{
  const sources=payloads(),seen=[];
  let releaseForecast,forecastStarted;
  const forecastGate=new Promise(resolve=>{releaseForecast=resolve;});
  const started=new Promise(resolve=>{forecastStarted=resolve;});
  const {get}=fixture({fetch:async(url)=>{
    const parsed=new URL(url),key=parsed.pathname+parsed.search;seen.push(key);
    if(key==='/gridpoints/ILX/95,71/forecast') {forecastStarted();await forecastGate;}
    if(!(key in sources))throw Error('Unexpected '+key);
    return Response.json(sources[key]);
  }});
  let forecastDone=false;
  const forecast=get('forecast').then(response=>{forecastDone=true;return response;});
  await started;
  try {
    const observation=await(await get('observation')).json();
    assert.equal(observation.resources.observation.status,'live');assert.equal(forecastDone,false);
    assert.equal(seen.filter(key=>key==='/stations/KCMI/observations/latest').length,1);
    assert.ok(!seen.some(key=>key.endsWith('/stations')),'Forecast part does not discover observation stations');
    assert.ok(!seen.some(key=>key.startsWith('/alerts')),'Forecast/observation parts do not request alerts');
  } finally {releaseForecast();}
  const body=await(await forecast).json();
  assert.deepEqual(Object.keys(body.resources).sort(),['forecast','grid','hourly','points']);
  assert.equal(seen.length,5,'Four forecast reads plus exactly one independent KCMI observation');
});

test('full compatibility endpoint starts KCMI before pending discovery and fetches its observation only once',async()=>{
  const sources=payloads(),seen=[];
  let releasePoints,pointsStarted;
  const pointsGate=new Promise(resolve=>{releasePoints=resolve;});
  const started=new Promise(resolve=>{pointsStarted=resolve;});
  const {get}=fixture({fetch:async(url)=>{
    const parsed=new URL(url),key=parsed.pathname+parsed.search;seen.push(key);
    if(key==='/points/'+LOOKUP_POINT) {pointsStarted();await pointsGate;}
    return Response.json(sources[key]);
  }});
  const response=get();await started;
  try {
    assert.ok(seen.includes('/stations/KCMI/observations/latest'),'KCMI starts before point discovery finishes');
    assert.ok(seen.includes('/alerts/active?point='+POINT),'Property alerts start before point discovery finishes');
  } finally {releasePoints();}
  const body=await(await response).json();
  assert.deepEqual(Object.keys(body.resources).sort(),['alerts','forecast','grid','hourly','observation','points','stations']);
  assert.equal(seen.length,7);assert.equal(seen.filter(key=>key==='/stations/KCMI/observations/latest').length,1);
});

test('alerts part remains an independent point query and retains polygonless alerts',async()=>{
  const {get,calls}=fixture({sources:payloads({['/points/'+LOOKUP_POINT]:new Error('Points failed')})});
  const response=await get('alerts'),body=await response.json();
  assert.equal(response.status,200);assert.deepEqual(Object.keys(body.resources),['alerts']);
  assert.equal(calls.length,1);assert.equal(calls[0].url,API+'/alerts/active?point='+POINT);
  assert.equal(body.resources.alerts.status,'live');assert.equal(body.resources.alerts.data.features[0].geometry,null);
});

test('raw available wind chill, observed gust units, and missing values are preserved in observation part',async()=>{
  for(const [windChill,windGust] of [
    [{unitCode:'wmoUnit:degF',value:28.5,qualityControl:'V'},{unitCode:'wmoUnit:m_s-1',value:12.3}],
    [{unitCode:'wmoUnit:degC',value:null,qualityControl:'V'},{unitCode:'wmoUnit:km_h-1',value:null,qualityControl:'Z'}],
  ]) {
    const source={properties:{timestamp:now,temperature:{unitCode:'wmoUnit:degC',value:19},windChill,windGust}};
    const {get,calls}=fixture({sources:payloads({'/stations/KCMI/observations/latest':source})});
    const {resources}=await(await get('observation')).json();
    assert.deepEqual(resources.observation.data,source);assert.deepEqual(resources.observation.data.properties.windChill,windChill);
    assert.deepEqual(resources.observation.data.properties.windGust,windGust);assert.equal(calls.length,1);
    assert.equal(resources.observation.station.latitude,null,'Do not invent station coordinates when geometry is missing');
  }
});

test('unsupported or duplicate part selectors reject before reads; outer connector metadata is never forwarded',async()=>{
  const {route,get,calls}=fixture();
  for(const part of ['', 'anything', '__proto__'])assert.equal((await get(part)).status,400);
  const duplicate=new Request('https://branch.example/api/weather-preview?part=observation&part=forecast');
  assert.equal((await route.GET(duplicate)).status,400);
  assert.equal((await get('observation',{method:'POST'})).status,405);assert.equal(calls.length,0);
  const shared=new Request('https://branch.example/api/weather-preview?part=observation&previewShareMetadata=review&unknown=a&unknown=b&url=https%3A%2F%2Fevil.example&point=0,0');
  assert.equal((await route.GET(shared)).status,200);assert.equal(calls.length,1);
  assert.equal(calls[0].url,API+'/stations/KCMI/observations/latest');
});
