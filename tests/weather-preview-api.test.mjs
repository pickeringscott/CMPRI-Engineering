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
    '/stations/KCMI/observations/latest':{properties:{timestamp:now,textDescription:'Cloudy',temperature:{unitCode:'wmoUnit:degC',value:4},windGust:{value:null}}},
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
  return {route,calls,get:()=>route.GET(new Request('https://branch.example/api/weather-preview?url=https://evil.example&point=0,0'))};
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
  assert.equal(calls.length,2);assert.equal(resources.points.status,'unavailable');
  assert.equal(resources.forecast.status,'unavailable');assert.equal(resources.forecast.data,null);
  assert.equal(resources.observation.status,'unavailable');assert.equal(resources.alerts.status,'live');
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
  assert.equal(calls.length,2);
  for(const key of ['forecast','hourly','grid','stations','observation'])assert.equal(resources[key].status,'unavailable');
});

test('NWS redirects are refused rather than followed',async()=>{
  const calls=[];
  const {get}=fixture({fetch:async(url,init)=>{
    calls.push({url,init});return new Response(null,{status:302,headers:{Location:'https://evil.example'}});
  }});
  const {resources}=await(await get()).json();
  assert.equal(calls.length,2);assert.equal(resources.points.status,'unavailable');
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
  assert.deepEqual(deadlines,[12000,12000]);
  assert.equal(resources.points.status,'unavailable');assert.equal(resources.alerts.status,'unavailable');
  assert.match(resources.alerts.error,/timed out/);
});
