import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';

const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg=new Uint8Array([255,216,255,224,0,0,0,0]);
const request=(query='dataset=topo&z=12&x=1043&y=1548',options={})=>new Request('https://review.example/api/weather-preview/basemap?'+query,options);
function fixture(fetch,env={VERCEL_ENV:'preview'}) {
  return loadTs('src/app/api/weather-preview/basemap/route.ts',{},
    {fetch,process:{env},Request,Response,URL,URLSearchParams,Uint8Array,AbortController,setTimeout,clearTimeout,Buffer,TextDecoder});
}

test('fixed metadata probes preserve official layer records without forwarding outer URLs',async()=>{
  for(const [dataset,source] of [
    ['roads','https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer?f=json'],
    ['places','https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer?f=json'],
    ['imagery','https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=json'],
  ]) {
    const metadata={layers:[{id:1,name:'Actual official layer'}],copyrightText:'Metadata refresh is not imagery acquisition'};
    const api=fixture(async(url,options)=>{assert.equal(url,source);assert.equal(options.redirect,'error');return Response.json(metadata);});
    const response=await api.GET(request(`op=metadata&dataset=${dataset}&url=https://evil.example&previewShare=review`));
    const body=await response.json();
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(body.source,source);assert.deepEqual(body.data,metadata);assert.equal(body.error,null);assert.ok(body.receivedAt);
  }
});

test('transparent reference exports use only fixed layer selections and exact bounded EPSG3857 extents',async()=>{
  for(const [dataset,service,layers] of [
    ['roads','transportation','show:8,9,29,30'],['places','geonames','show:1,2'],
  ]) {
    const api=fixture(async(source,options)=>{
      const url=new URL(source);
      assert.equal(url.origin,'https://carto.nationalmap.gov');assert.equal(url.pathname,`/arcgis/rest/services/${service}/MapServer/export`);
      assert.equal(url.searchParams.get('layers'),layers);assert.equal(url.searchParams.get('bbox'),'-10025000,4735000,-9625000,5035000');
      assert.equal(url.searchParams.get('bboxSR'),'3857');assert.equal(url.searchParams.get('imageSR'),'3857');
      assert.equal(url.searchParams.get('size'),'800,600');assert.equal(url.searchParams.get('format'),'png32');
      assert.equal(url.searchParams.get('transparent'),'true');assert.equal(url.searchParams.get('f'),'image');
      assert.equal(url.searchParams.get('url'),null);assert.equal(options.redirect,'error');
      return new Response(png,{headers:{'Content-Type':'image/png'}});
    });
    const response=await api.GET(request(`op=reference&dataset=${dataset}&bbox=-10025000,4735000,-9625000,5035000&width=800&height=600&format=json&url=https://evil.example`));
    const body=await response.json();assert.equal(response.status,200);assert.equal(body.contentType,'image/png');
    assert.deepEqual(new Uint8Array(Buffer.from(body.base64,'base64')),png);assert.match(body.attribution,/USGS/);
  }
});

test('metadata and reference probes reject arbitrary or oversized geometry before fetching',async()=>{
  let calls=0;const api=fixture(async()=>{calls++;throw Error('unexpected fetch');});
  for(const query of [
    'op=metadata&dataset=topo','op=metadata&dataset=roads&z=1','op=metadata&dataset=roads&format=image',
    'op=reference&dataset=imagery&bbox=0,0,1,1&width=100&height=100',
    'op=reference&dataset=roads&bbox=0,0,1,1&width=1501&height=100',
    'op=reference&dataset=roads&bbox=0,0,Infinity,1&width=100&height=100',
    'op=reference&dataset=roads&bbox=0,0,1,1&width=100&height=100&bbox=0,0,1,1',
    'op=reference&dataset=roads&bbox=0,0,20037510,1&width=100&height=100',
    'op=reference&dataset=roads&bbox=1,0,0,1&width=100&height=100','op=unknown&dataset=roads',
  ])assert.equal((await api.GET(request(query))).status,400,query);
  assert.equal(calls,0);
});

test('reference exports require PNG and metadata error objects remain unavailable',async()=>{
  const ref=await fixture(async()=>new Response(jpeg,{headers:{'Content-Type':'image/jpeg'}})).GET(request('op=reference&dataset=roads&bbox=0,0,1,1&width=100&height=100'));
  assert.equal(ref.status,502);
  const meta=await fixture(async()=>Response.json({error:{message:'Service unavailable'}})).GET(request('op=metadata&dataset=roads'));
  assert.equal(meta.status,502);
});

test('incorporated-place labels use one fixed GNIS layer and preserve official names and geometry',async()=>{
  const data={type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'MultiPoint',coordinates:[[-88.25,40.13],[-88.2,40.1]]},properties:{gaz_name:'City of Champaign',gaz_id:123,OBJECTID:456}}]};
  const api=fixture(async(source,options)=>{
    const url=new URL(source);assert.equal(url.origin,'https://carto.nationalmap.gov');
    assert.equal(url.pathname,'/arcgis/rest/services/geonames/MapServer/1/query');
    assert.equal(url.searchParams.get('f'),'geojson');assert.equal(url.searchParams.get('where'),'1=1');
    assert.equal(url.searchParams.get('outFields'),'*');assert.equal(url.searchParams.get('returnGeometry'),'true');
    assert.equal(url.searchParams.get('inSR'),'3857');assert.equal(url.searchParams.get('outSR'),'4326');
    assert.equal(url.searchParams.get('resultRecordCount'),'1000');assert.equal(url.searchParams.get('spatialRel'),'esriSpatialRelIntersects');
    assert.deepEqual(JSON.parse(url.searchParams.get('geometry')),{xmin:-10025000,ymin:4735000,xmax:-9625000,ymax:5035000,spatialReference:{wkid:3857}});
    assert.equal(url.searchParams.get('layer'),null);assert.equal(url.searchParams.get('url'),null);assert.equal(options.redirect,'error');
    return Response.json(data);
  });
  const response=await api.GET(request('op=place-labels&dataset=places&bbox=-10025000,4735000,-9625000,5035000&where=otherSQL&layer=99&url=https://evil.example'));
  const body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.data,data);assert.equal(body.error,null);assert.ok(body.receivedAt);
  assert.match(body.source,/\/geonames\/MapServer\/1\/query/);
});

test('place-label requests reject unsupported datasets and invalid extents before fetching',async()=>{
  let calls=0;const api=fixture(async()=>{calls++;throw Error('unexpected fetch');});
  for(const query of [
    'op=place-labels&dataset=roads&bbox=0,0,1,1','op=place-labels&dataset=places&bbox=0,0,1,1&width=100',
    'op=place-labels&dataset=places&bbox=0,0,1,1&format=image','op=place-labels&dataset=places&bbox=0,0,1,1&bbox=0,0,1,1',
    'op=place-labels&dataset=places&bbox=0,0,Infinity,1','op=place-labels&dataset=places&bbox=0,0,20037510,1','op=place-labels&dataset=places&bbox=1,0,0,1',
  ])assert.equal((await api.GET(request(query))).status,400,query);
  assert.equal(calls,0);
  const incomplete=await fixture(async()=>Response.json({type:'FeatureCollection',features:[],exceededTransferLimit:true})).GET(request('op=place-labels&dataset=places&bbox=0,0,1,1'));
  assert.equal(incomplete.status,502);
});

test('wide-view shields use actual generalized route attributes and WGS84 polylines from one fixed USGS layer',async()=>{
  const data={type:'FeatureCollection',features:[{type:'Feature',id:4,geometry:{type:'LineString',coordinates:[[-88.3,40.1],[-88.2,40.2]]},properties:{OBJECTID:4,INTERSTATE:'57',US_ROUTE:null,ST_ROUTE:null,NAME:'Official source name'}}]};
  const api=fixture(async(source,options)=>{
    const url=new URL(source);
    assert.equal(url.origin,'https://carto.nationalmap.gov');assert.equal(url.pathname,'/arcgis/rest/services/transportation/MapServer/9/query');
    assert.equal(url.searchParams.get('f'),'geojson');assert.equal(url.searchParams.get('outSR'),'4326');assert.equal(url.searchParams.get('inSR'),'3857');
    assert.equal(url.searchParams.get('returnGeometry'),'true');assert.equal(url.searchParams.get('returnM'),'false');assert.equal(url.searchParams.get('resultRecordCount'),'2000');
    assert.equal(url.searchParams.get('outFields'),'OBJECTID,INTERSTATE,US_ROUTE,ST_ROUTE,NAME');
    assert.equal(url.searchParams.get('where'),"(INTERSTATE IS NOT NULL AND INTERSTATE <> '') OR (US_ROUTE IS NOT NULL AND US_ROUTE <> '') OR (ST_ROUTE IS NOT NULL AND ST_ROUTE <> '')");
    assert.deepEqual(JSON.parse(url.searchParams.get('geometry')),{xmin:-10025000,ymin:4735000,xmax:-9625000,ymax:5035000,spatialReference:{wkid:3857}});
    assert.equal(url.searchParams.get('layer'),null);assert.equal(url.searchParams.get('url'),null);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    return Response.json(data);
  });
  const response=await api.GET(request('op=route-features&dataset=roads&z=9&bbox=-10025000,4735000,-9625000,5035000&where=otherSQL&layer=99&url=https://evil.example'));
  const body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.data,data);assert.equal(body.error,null);
  assert.deepEqual(body.sources,[body.source]);assert.ok(body.receivedAt);assert.match(body.attribution,/National Transportation Dataset/);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('detailed shields query separate fixed Interstate, US and State route sources without inventing or merging attributes',async()=>{
  const seen=[];
  const features=[
    {type:'Feature',id:1,geometry:{type:'LineString',coordinates:[[-88.3,40.1],[-88.2,40.2]]},properties:{OBJECTID:1,permanent_identifier:'official-a',interstate:'57',interstate_a:'57',us_route:null,state_route:null}},
    {type:'Feature',id:2,geometry:{type:'MultiLineString',coordinates:[[[-88.3,40.1],[-88.2,40.2]]]},properties:{OBJECTID:2,permanent_identifier:'official-b',interstate:null,us_route:'150',us_route_a:'150',state_route:null}},
    {type:'Feature',id:3,geometry:{type:'LineString',coordinates:[[-88.3,40.1],[-88.2,40.2]]},properties:{OBJECTID:3,permanent_identifier:'official-c',interstate:null,us_route:null,state_route:'10',state_route_a:'10'}},
  ];
  const api=fixture(async(source,options)=>{
    const url=new URL(source),layer=Number(url.pathname.split('/').at(-2));seen.push(layer);
    assert.equal(url.origin,'https://carto.nationalmap.gov');assert.ok([16,17,18].includes(layer));
    const field={16:'interstate',17:'us_route',18:'state_route'}[layer];
    assert.equal(url.searchParams.get('where'),[field,field+'_a',field+'_b',field+'_c'].map(key=>`(${key} IS NOT NULL AND ${key} <> '')`).join(' OR '));
    assert.match(url.searchParams.get('outFields'),/permanent_identifier,interstate,us_route,state_route/);
    assert.match(url.searchParams.get('outFields'),/state_route_a,state_route_b,state_route_c,name$/);
    assert.equal(url.searchParams.get('outSR'),'4326');assert.equal(options.cache,'no-store');
    return Response.json({type:'FeatureCollection',features:[features[layer-16]]});
  });
  const response=await api.GET(request('op=route-features&dataset=roads&z=10&bbox=-10025000,4735000,-9625000,5035000'));
  const body=await response.json();assert.equal(response.status,200);assert.deepEqual(seen.sort(),[16,17,18]);
  assert.equal(body.sources.length,3);assert.equal(body.source,body.sources[0]);assert.deepEqual(body.data,{type:'FeatureCollection',features});
});

test('route-feature requests reject arbitrary, duplicate, oversized or noncanonical viewport parameters before fetching',async()=>{
  let calls=0;const api=fixture(async()=>{calls++;throw Error('unexpected fetch');});
  for(const query of [
    'op=route-features&dataset=places&z=9&bbox=0,0,1,1','op=route-features&dataset=roads&bbox=0,0,1,1',
    'op=route-features&dataset=roads&z=17&bbox=0,0,1,1','op=route-features&dataset=roads&z=09&bbox=0,0,1,1',
    'op=route-features&dataset=roads&z=9&z=9&bbox=0,0,1,1','op=route-features&dataset=roads&z=9&bbox=0,0,1,1&bbox=0,0,1,1',
    'op=route-features&dataset=roads&z=9&bbox=0,0,1,1&format=image','op=route-features&dataset=roads&z=9&bbox=0,0,1,1&width=100',
    'op=route-features&dataset=roads&z=9&bbox=0,0,1,1&x=1','op=route-features&dataset=roads&z=9&bbox=0,0,Infinity,1',
    'op=route-features&dataset=roads&z=9&bbox=0,0,20037510,1','op=route-features&dataset=roads&z=9&bbox=1,0,0,1',
    'op=route-features&dataset=roads&z=9&bbox=0,0,4000001,1','op=route-features&dataset=roads&z=9&bbox=0,0,1,4000001',
  ])assert.equal((await api.GET(request(query))).status,400,query);
  assert.equal(calls,0);
});

test('route-feature errors, truncated results, unsupported geometry and a combined oversized response remain unavailable',async()=>{
  const query='op=route-features&dataset=roads&z=10&bbox=0,0,1,1';
  for(const data of [
    {error:{message:'Unavailable'}},{type:'FeatureCollection',features:[],exceededTransferLimit:true},
    {type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[0,0]},properties:{interstate:'1'}}]},
  ])assert.equal((await fixture(async()=>Response.json(data)).GET(request(query))).status,502);
  const oversized={type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'LineString',coordinates:[[0,0],[1,1]]},properties:{interstate:'1',sourceDescription:'a'.repeat(800000)}}]};
  assert.equal((await fixture(async()=>Response.json(oversized)).GET(request(query))).status,502);
  const canceled=new AbortController();canceled.abort();
  const response=await fixture(async(_url,options)=>{options.signal.throwIfAborted();}).GET(request(query,{signal:canceled.signal}));
  assert.equal(response.status,504);
});

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
