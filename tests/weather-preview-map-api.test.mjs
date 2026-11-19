import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';

const radar='https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer';
const wssi='https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer/4';
const request=(url,extra={})=>new Request('https://preview.cmpri.example/api/weather-preview/map?url='+encodeURIComponent(url),extra);
const jsonHeaders={'Content-Type':'application/json'};
function fixture(fetch,env={VERCEL_ENV:'preview'}) {
  return loadTs('src/app/api/weather-preview/map/route.ts',{}, {
    process:{env},fetch,Request,Response,URL,Uint8Array,TextDecoder,AbortController,setTimeout,clearTimeout,
  });
}

test('production and unflagged production builds return404 before upstream requests',async()=>{
  let calls=0;
  for(const env of [{VERCEL_ENV:'production'},{VERCEL_ENV:'production',NODE_ENV:'development'},{NODE_ENV:'production'},{}]) {
    const api=fixture(()=>{calls++;throw Error('must not fetch');},env);
    const response=await api.GET(request(radar+'?f=json'));
    assert.equal(response.status,404);assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  assert.equal(calls,0);
});

test('only exact official read-only map resources are accepted',async()=>{
  let calls=0;const api=fixture(()=>{calls++;throw Error('must not fetch');});
  for(const url of [
    'https://example.com/weather?f=json',radar.replace('https:','http:')+'?f=json',
    radar.replace('https://','https://person:password@')+'?f=json',
    radar.replace('weather.noaa.gov','weather.noaa.gov.example.com')+'?f=json',
    radar+'/delete?f=json',radar+'?f=html',radar+'?f=json&callback=x',radar+'?f=json&f=json',
    'https://mapservices.weather.noaa.gov/private/config.json',
    'https://mapservices.weather.noaa.gov/eventdriven/rest/directories/arcgisoutput/radar/not-image.txt',
    'https://mapservices.weather.noaa.gov/eventdriven/rest/directories/arcgisoutput/radar/map.png?token=anything',
    radar+'/query?f=json&resultRecordCount=100000',
    radar+'/exportImage?f=json&format=png32&bboxSR=3857&imageSR=3857&size=99999,99999',
  ]) assert.equal((await api.GET(request(url))).status,400,url);
  const double=new Request('https://preview.cmpri.example/api/weather-preview/map?url='+encodeURIComponent(radar+'?f=json')+'&url=duplicate');
  assert.equal((await api.GET(double)).status,400);
  assert.equal((await api.GET(request(radar+'?f=json',{method:'POST'}))).status,405);
  assert.equal(calls,0);
});

test('JSON metadata, catalog, WSSI and exact-raster exports retain upstream JSON/status',async()=>{
  const urls=[radar+'?f=json',radar+'/query?f=json&geometry=-88.251416,40.138080&resultRecordCount=200',
    wssi+'?f=json',wssi+'/query?f=json&where=1%3D1&resultRecordCount=1000',
    radar+'/exportImage?f=json&format=png32&bboxSR=3857&imageSR=3857&size=1200,700&mosaicRule='+encodeURIComponent(JSON.stringify({mosaicMethod:'esriMosaicLockRaster',lockRasterIds:[725]}))];
  const original='{"features":[{"attributes":{"objectid":725,"idp_validtime":1795000000000}}]}';
  for(const url of urls) {
    const api=fixture(async(input,options)=>{
      assert.equal(input,new URL(url).href);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
      assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,undefined);
      return new Response(original,{status:200,headers:jsonHeaders});
    });
    const response=await api.GET(request(url));
    assert.equal(response.status,200);assert.equal(await response.text(),original);assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  const error=await fixture(async()=>new Response('{"error":{"message":"No rasters"}}',{status:404,headers:jsonHeaders})).GET(request(radar+'?f=json'));
  assert.equal(error.status,404);assert.equal((await error.json()).error.message,'No rasters');
});

test('allowlisted generated PNGs pass through while non-images and oversized responses fail closed',async()=>{
  const image='https://mapservices.weather.noaa.gov/eventdriven/rest/directories/arcgisoutput/radar/radar_base_reflectivity_time_ImageServer/_ags_123.png';
  const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
  const response=await fixture(async()=>new Response(png,{headers:{'Content-Type':'image/png'}})).GET(request(image));
  assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
  const wrong=await fixture(async()=>new Response('not png',{headers:{'Content-Type':'image/png'}})).GET(request(image));
  assert.equal(wrong.status,502);
  const huge=await fixture(async()=>new Response('{}',{headers:{...jsonHeaders,'Content-Length':String(11*1024*1024)}})).GET(request(radar+'?f=json'));
  assert.equal(huge.status,502);
});

test('upstream HTML, network failure and cancellation remain unavailable',async()=>{
  const html=await fixture(async()=>new Response('<html>unavailable</html>',{status:503})).GET(request(radar+'?f=json'));
  assert.equal(html.status,503);assert.equal((await html.json()).unavailable,true);
  const network=await fixture(async()=>{throw Error('network restricted');}).GET(request(radar+'?f=json'));
  assert.equal(network.status,502);assert.equal((await network.json()).unavailable,true);
  const controller=new AbortController();controller.abort();
  const canceled=await fixture(async(_url,options)=>{options.signal.throwIfAborted();}).GET(request(radar+'?f=json',{signal:controller.signal}));
  assert.equal(canceled.status,504);
});
