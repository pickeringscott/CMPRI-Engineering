import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg=new Uint8Array([255,216,255,224,0,0,0,0]);
const request=(query='dataset=topo&z=12&x=1043&y=1548',options={})=>new Request('https://review.example/api/weather-preview/basemap?'+query,options);
function fixture(fetch,env={VERCEL_ENV:'preview'}) {
  return loadTs('src/app/api/weather-preview/basemap/route.ts',{},
    {fetch,process:{env},Request,Response,URL,Uint8Array,AbortController,setTimeout,clearTimeout,Buffer});
}

test('production is404 before any upstream access',async()=>{
  let calls=0;
  for(const env of [{VERCEL_ENV:'production'},{VERCEL_ENV:'production',NODE_ENV:'development'},{NODE_ENV:'production'},{}]) {
    const response=await fixture(()=>{calls++;throw Error('unexpected fetch');},env).GET(request());
    assert.equal(response.status,404);assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  assert.equal(calls,0);
});

test('only fixed datasets and bounded canonical tile integers are accepted',async()=>{
  let calls=0;const api=fixture(()=>{calls++;throw Error('unexpected fetch');});
  for(const query of [
    'dataset=https://example.com&z=12&x=1043&y=1548','dataset=__proto__&z=12&x=1043&y=1548',
    'dataset=other&z=12&x=1043&y=1548','dataset=topo&z=17&x=0&y=0','dataset=topo&z=-1&x=0&y=0',
    'dataset=topo&z=12.5&x=1&y=1','dataset=topo&z=01&x=0&y=0','dataset=topo&z=0&x=1&y=0',
    'dataset=topo&z=12&x=4096&y=1548','dataset=topo&z=12&x=1043&y=4096',
    'dataset=topo&z=12&x=1e3&y=1548','dataset=topo&dataset=imagery&z=12&x=1043&y=1548',
    'dataset=topo&z=12&x=1043&y=1548&format=html','dataset=topo&z=12&x=1043&y=1548&format=json&format=json',
  ]) assert.equal((await api.GET(request(query))).status,400,query);
  assert.equal((await api.GET(request(undefined,{method:'POST'}))).status,405);
  assert.equal(calls,0);
});

test('the three enums construct only their official USGS tile URLs; sharing metadata stays local',async()=>{
  for(const [dataset,service] of [['topo','USGSTopo'],['imagery','USGSImageryOnly'],['relief','USGSShadedReliefOnly']]) {
    const api=fixture(async(url,options)=>{
      assert.equal(url,`https://basemap.nationalmap.gov/arcgis/rest/services/${service}/MapServer/tile/12/1548/1043`);
      assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);
      return new Response(png,{headers:{'Content-Type':'image/png'}});
    });
    const response=await api.GET(request(`dataset=${dataset}&z=12&x=1043&y=1548&previewShare=review&url=https://example.com`));
    assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');
    assert.equal(response.headers.get('Cache-Control'),'public, max-age=3600, s-maxage=86400');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
  }
});

test('PNG and JPEG signatures are required, and optional JSON round-trips actual tile bytes',async()=>{
  const api=fixture(async()=>new Response(jpeg,{headers:{'Content-Type':'image/jpeg'}}));
  const image=await api.GET(request());assert.equal(image.headers.get('Content-Type'),'image/jpeg');
  const json=await api.GET(request('dataset=imagery&z=12&x=1043&y=1548&format=json'));
  const body=await json.json();assert.equal(body.contentType,'image/jpeg');assert.equal(body.bytes,jpeg.byteLength);
  assert.deepEqual(new Uint8Array(Buffer.from(body.base64,'base64')),jpeg);
  assert.match(body.source,/\/USGSImageryOnly\/MapServer\/tile\/12\/1548\/1043$/);
  assert.match(body.attribution,/USDA/);
  const invalid=await fixture(async()=>new Response('<html>bad</html>',{headers:{'Content-Type':'image/png'}})).GET(request());
  assert.equal(invalid.status,502);assert.equal((await invalid.json()).unavailable,true);
});

test('oversized, failed and canceled upstream tiles stay unavailable',async()=>{
  const huge=await fixture(async()=>new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(3*1024*1024)}})).GET(request());
  assert.equal(huge.status,502);
  const failed=await fixture(async()=>new Response('Unavailable',{status:503})).GET(request());assert.equal(failed.status,503);
  const aborted=new AbortController();aborted.abort();
  const canceled=await fixture(async(_url,options)=>{options.signal.throwIfAborted();}).GET(request(undefined,{signal:aborted.signal}));
  assert.equal(canceled.status,504);
});
