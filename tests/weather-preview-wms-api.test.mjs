import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs} from './helpers/load-ts.mjs';
import {readFileSync} from 'node:fs';

const velocity='https://opengeo.ncep.noaa.gov/geoserver/kilx/ows';
const precipitation='https://opengeo.ncep.noaa.gov/geoserver/conus/conus_pcpn_typ/ows';
const reflectivity='https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows';
const cloudCover='https://digital.weather.gov/ndfd.conus/wms';
// Real 2026-11-20 NDFD capability leaf excerpt; add the advertised request envelope omitted by the extraction.
const cloudXml=readFileSync(new URL('./fixtures/weather/ndfd-sky-capabilities-excerpt.xml', import.meta.url),'utf8')
 .replace('<Capability>','<Capability><Request><GetCapabilities><Format>application/vnd.ogc.wms_xml</Format></GetCapabilities><GetMap><Format>image/png</Format><Format>image/jpeg</Format></GetMap></Request>');
// Deliberately different from conventional guessed names: only metadata counts.
const actualLayer='kilx:ACTUAL_SOURCE_VELOCITY';
const actualStyle='SourceVelocityStyle';
const start='2026-11-19T06:00:00Z';
const latest='2026-11-19T06:10:00Z';
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const xml=`<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink">
 <Service><Title>Official fixture service</Title></Service><Capability><Request>
 <GetMap><Format>image/png</Format><Format>image/jpeg</Format></GetMap>
 <GetLegendGraphic><Format>image/png</Format></GetLegendGraphic></Request>
 <Layer><Title>Root &amp; inheritance</Title><CRS>EPSG:4326</CRS><CRS>EPSG:3857</CRS>
 <Dimension name="time" units="ISO8601" default="${latest}" current="1">${start}/${latest}/PT5M</Dimension>
 <Style><Name>${actualStyle}</Name><Title>Source &amp; legend</Title>
 <LegendURL><Format>image/png</Format><OnlineResource xlink:href="${velocity}?service=WMS&amp;request=GetLegendGraphic&amp;layer=${actualLayer}"/></LegendURL></Style>
 <Layer queryable="1"><Name>${actualLayer}</Name><Title>Actual source radial velocity</Title></Layer>
 <Layer><Name>kilx:OTHER_PRODUCT</Name><Title>Other source product</Title>
 <Dimension name="time" units="ISO8601" default="${start}">${start},${latest}</Dimension>
 </Layer></Layer></Capability></WMS_Capabilities>`;
const request=(parameters,extra={})=>new Request('https://preview.cmpri.example/api/weather-preview/wms?'+new URLSearchParams(parameters),extra);
const base={product:'velocity',op:'map',layer:actualLayer,bbox:'-10000000,4700000,-9700000,5000000',width:'900',height:'600'};
const xmlResponse=(body=xml,headers={})=>new Response(body,{headers:{'Content-Type':'text/xml; charset=utf-8',...headers}});
function fixture(fetch,env={VERCEL_ENV:'preview'}) {
 return loadTs('src/app/api/weather-preview/wms/route.ts',{}, {
  process:{env},fetch,Request,Response,URL,URLSearchParams,Uint8Array,TextDecoder,AbortController,setTimeout,clearTimeout,Buffer,
 });
}

test('released WMS reads retain fixed sources and validation in production and local builds',async()=>{
 for(const env of [{VERCEL_ENV:'production'},{VERCEL_ENV:'production',NODE_ENV:'development'},{NODE_ENV:'production'},{}]) {
  let calls=0;
  const api=fixture(async(url,options)=>{
   calls++;const source=new URL(url);
   assert.equal(source.origin+source.pathname,velocity);assert.equal(source.searchParams.get('request'),'GetCapabilities');
   assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
   assert.equal(options.headers.Authorization,undefined);assert.equal(options.cache,'no-store');
   return xmlResponse();
  },env);
  const response=await api.GET(request({product:'velocity',op:'capabilities'}));
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await response.json()).layers[0].name,actualLayer);
  assert.equal((await api.GET(request({product:'https://evil.example',op:'capabilities'}))).status,400);
  assert.equal((await api.GET(request({product:'velocity',op:'capabilities'},{method:'POST'}))).status,405);
  assert.equal(calls,1);
 }
});

test('fixed products/operations and bounded map parameters reject arbitrary input before fetch',async()=>{
 let calls=0;const api=fixture(()=>{calls++;throw Error('must not fetch');});
 for(const params of [
  {product:'anything',op:'capabilities'},{product:'velocity',op:'delete'},
  {product:'velocity',op:'capabilities',layer:actualLayer},
  {product:'reflectivity',op:'capabilities',format:'json'},
  {...base,format:'text'},{...base,format:'image/png'},
  {...base,bbox:'-1,2,-3,4'},{...base,bbox:'-1,,2,4'},{...base,bbox:'-1,2,30000000,4'},
  {...base,width:'1501'},{...base,height:'0'},{...base,width:'1.5'},
  {...base,layer:''},{product:'velocity',op:'legend',layer:actualLayer,time:latest},
 ])assert.equal((await api.GET(request(params))).status,400,JSON.stringify(params));
 const duplicate=new Request('https://preview.cmpri.example/api/weather-preview/wms?product=velocity&op=capabilities&product=precipitation');
 assert.equal((await api.GET(duplicate)).status,400);
 assert.equal((await api.GET(request({product:'velocity',op:'capabilities'},{method:'POST'}))).status,405);
 assert.equal(calls,0);
});

test('station and regional mosaic selection use the NOAA allowlist and fixed upstream paths', async () => {
  const calls = [];
  const api = fixture(async (url) => { calls.push(new URL(url).pathname); return xmlResponse(); });
  const catalog = await api.GET(request({ product: 'station', op: 'stations' }));
  assert.equal(catalog.status, 200);
  const { stations } = await catalog.json();
  assert.ok(stations.some(({ id, lat, lon }) => id === 'KDVN' && lat === 41.61166 && lon === -90.58083));
  for (const params of [
    { product: 'station', op: 'capabilities', station: 'https://example.com' },
    { product: 'station', op: 'capabilities', station: 'KZZZ' },
    { product: 'station', op: 'capabilities', station: 'KDVN', region: 'alaska' },
    { product: 'velocity', op: 'capabilities', region: 'alaska' },
    { product: 'reflectivity', op: 'capabilities', region: 'unknown' },
  ]) assert.equal((await api.GET(request(params))).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await api.GET(request({ product: 'station', station: 'KDVN', op: 'capabilities' }))).status, 200);
  assert.equal((await api.GET(request({ product: 'reflectivity', region: 'alaska', op: 'capabilities' }))).status, 200);
  assert.deepEqual(calls, ['/geoserver/kdvn/ows', '/geoserver/alaska/alaska_bref_qcd/ows']);
});

test('capabilities preserve source XML and exact advertised names, inherited CRS/time/styles',async()=>{
 const calls=[];
 const api=fixture(async(url,options)=>{
  calls.push(url);const parsed=new URL(url);
  assert.equal(parsed.origin+parsed.pathname,velocity);
  assert.equal(parsed.searchParams.get('request'),'GetCapabilities');
  assert.equal(parsed.searchParams.get('version'),'1.3.0');
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.cache,'no-store');assert.equal(options.method,'GET');
  assert.equal(options.headers.Authorization,undefined);
  return xmlResponse();
 });
 const response=await api.GET(request({product:'velocity',op:'capabilities'}));
 assert.equal(response.status,200);const data=await response.json();
 assert.equal(data.xml,xml);assert.equal(data.version,'1.3.0');
 assert.equal(new URL(data.source).origin+new URL(data.source).pathname,velocity);
 assert.equal(data.layers[0].name,actualLayer);assert.equal(data.layers[0].title,'Actual source radial velocity');
 assert.deepEqual(data.layers[0].crs,['EPSG:4326','EPSG:3857']);
 assert.equal(data.layers[0].time.default,latest);assert.equal(data.layers[0].time.current,true);
 assert.equal(data.layers[0].time.values,`${start}/${latest}/PT5M`);
 assert.equal(data.layers[0].styles[0].name,actualStyle);
 assert.equal(data.layers[0].styles[0].title,'Source & legend');
 assert.ok(data.layers[0].styles[0].legendUrl.includes('&request=GetLegendGraphic'));
 assert.equal(data.layers[1].time.values,`${start},${latest}`);
 assert.deepEqual(data.mapFormats,['image/png','image/jpeg']);assert.equal(data.legendSupported,true);
 assert.ok(Number.isFinite(Date.parse(data.checkedAt)));assert.equal(calls.length,1);
});

test('other products use their own fixed official services without guessed layer names',async()=>{
 for(const [product,source,name] of [
  ['precipitation',precipitation,'conus:SOURCE_PRECIPITATION_TYPE'],
  ['reflectivity',reflectivity,'conus:SOURCE_REFLECTIVITY'],
 ]) {
  let seen;
  const response=await fixture(async(url)=>{seen=url;return xmlResponse(xml.replaceAll(actualLayer,name));})
   .GET(request({product,op:'capabilities'}));
  assert.equal(response.status,200);assert.equal(new URL(seen).origin+new URL(seen).pathname,source);
  assert.equal((await response.json()).layers[0].name,name);
 }
});

test('cloud-cover discovery uses only documented fixed NDFD capabilities and preserves VTIT metadata',async()=>{
 const name='ndfd.conus.sky',valid='2026-11-20T15:00';
 const advertised=xml.replaceAll(actualLayer,name).replace('Actual source radial velocity','Sky Cover (%)')
  .replace('<Title>Actual source radial velocity</Title>', '<Title>Sky Cover (%)</Title>')
  .replace('<Layer queryable="1">', `<Layer queryable="1"><Abstract>Forecast opaque cloud percentage</Abstract><Dimension name="VTIT" units="ISO8601" default="${valid}">${valid}</Dimension>`);
 let calls=0;
 const api=fixture(async(url)=>{
  calls++;const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,cloudCover);
  assert.deepEqual([...parsed.searchParams.keys()].sort(),['request','service','version']);
  return xmlResponse(advertised);
 });
 const response=await api.GET(request({product:'cloudCover',op:'capabilities'}));
 assert.equal(response.status,200);const metadata=await response.json();
 assert.equal(metadata.layers[0].name,name);assert.equal(metadata.layers[0].abstract,'Forecast opaque cloud percentage');
 assert.deepEqual(metadata.layers[0].dimensions.VTIT,{units:'ISO8601',default:valid,current:false,values:valid});
 assert.equal(metadata.xml,advertised);
 const blocked=await api.GET(request({product:'cloudCover',op:'legend',layer:name}));
 assert.equal(blocked.status,502);assert.match((await blocked.json()).error.message,/does not advertise.*legend/);
 assert.equal(calls,1,'Unverified cloud imagery must not be requested');
 for(const product of ['satellite','lightning']) assert.equal((await api.GET(request({product,op:'capabilities'}))).status,400);
});

test('map requests require advertised layer/style/time and fix WMS PNG Web Mercator parameters',async()=>{
 const calls=[];
 const api=fixture(async(url,options)=>{
  calls.push(url);const query=new URL(url).searchParams;
  if(query.get('request')==='GetCapabilities')return xmlResponse();
  assert.equal(query.get('SERVICE'),'WMS');assert.equal(query.get('VERSION'),'1.3.0');
  assert.equal(query.get('REQUEST'),'GetMap');assert.equal(query.get('LAYERS'),actualLayer);
  assert.equal(query.get('STYLES'),actualStyle);assert.equal(query.get('TIME'),'2026-11-19T06:05:00Z');
  assert.equal(query.get('CRS'),'EPSG:3857');assert.equal(query.get('FORMAT'),'image/png');
  assert.equal(query.get('BBOX'),base.bbox);assert.equal(query.get('WIDTH'),'900');assert.equal(query.get('HEIGHT'),'600');
  assert.equal(query.get('TRANSPARENT'),'TRUE');assert.equal(options.headers.Accept,'image/png');
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 });
 const response=await api.GET(request({...base,style:actualStyle,time:'2026-11-19T06:05:00Z'}));
 assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');
 assert.equal(response.headers.get('X-Weather-Time'),'2026-11-19T06:05:00Z');
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
 for(const params of [{...base,layer:'kilx_sr_bvel'},{...base,style:'guessed-style'},
  {...base,time:'2026-11-19T06:03:00Z'},{...base,time:'2026-11-20T06:05:00Z'},
  {...base,time:'NaN'},{...base,time:'2026-11-19T06:00:00Z/2026-11-19T06:10:00Z'}]) {
  assert.equal((await api.GET(request(params))).status,400,JSON.stringify(params));
 }
 assert.equal(calls.length,2,'invalid selectors must not produce image requests; successful metadata is reused in memory');
});

test('omitted time uses official latest default without inventing an image scan timestamp',async()=>{
 const api=fixture(async(url)=>{
  const query=new URL(url).searchParams;
  if(query.get('request')==='GetCapabilities')return xmlResponse();
  assert.equal(query.has('TIME'),false);assert.equal(query.get('STYLES'),'');
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 });
 const response=await api.GET(request(base));
 assert.equal(response.status,200);assert.equal(response.headers.get('X-Weather-Time'),'source-default');
});

test('legend uses fixed official endpoint rather than following capabilities URL',async()=>{
 const calls=[];
 const api=fixture(async(url)=>{
  calls.push(url);const parsed=new URL(url),query=parsed.searchParams;
  assert.equal(parsed.origin+parsed.pathname,velocity);
  if(query.get('request')==='GetCapabilities')return xmlResponse(xml.replace('xlink:href="'+velocity,'xlink:href="https://untrusted.example/ows'));
  assert.equal(query.get('REQUEST'),'GetLegendGraphic');assert.equal(query.get('LAYER'),actualLayer);
  assert.equal(query.get('STYLE'),actualStyle);assert.equal(query.get('FORMAT'),'image/png');
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 });
 const response=await api.GET(request({product:'velocity',op:'legend',layer:actualLayer,style:actualStyle}));
 assert.equal(response.status,200);assert.equal(calls.length,2);
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
});

test('JSON inspection preserves exact validated PNG bytes and source time without changing upstream parameters',async()=>{
 for(const operation of ['map','legend']) {
  const parameters=operation==='map'?{...base,style:actualStyle,time:latest}:{product:'velocity',op:'legend',layer:actualLayer,style:actualStyle};
  const api=fixture(async(url)=>{
   const query=new URL(url).searchParams;
   if(query.get('request')==='GetCapabilities')return xmlResponse();
   assert.equal(query.get('FORMAT'),'image/png');assert.equal(query.get('format'),null);
   assert.equal(query.get('REQUEST'),operation==='map'?'GetMap':'GetLegendGraphic');
   return new Response(png,{headers:{'Content-Type':'image/png'}});
  });
  const response=await api.GET(request({...parameters,format:'json'}));
  const body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(body.contentType,'image/png');assert.equal(body.bytes,png.byteLength);
  assert.deepEqual(new Uint8Array(Buffer.from(body.base64,'base64')),png);
  assert.equal(body.time,operation==='map'?latest:'source-default');
  assert.equal(new URL(body.source).origin+new URL(body.source).pathname,velocity);
 }
 const invalid=await fixture(async(url)=>new URL(url).searchParams.get('request')==='GetCapabilities'?xmlResponse():new Response('not PNG',{headers:{'Content-Type':'image/png'}}))
  .GET(request({...base,format:'json'}));
 assert.equal(invalid.status,502);
});

test('unsupported projection/format/legend fail without producing an image request',async()=>{
 for(const [change,operation] of [
  [body=>body.replace('<CRS>EPSG:3857</CRS>',''),'map'],
  [body=>body.replace('<Format>image/png</Format><Format>image/jpeg</Format>','<Format>image/jpeg</Format>'),'map'],
  [body=>body.replace(/<GetLegendGraphic>[\s\S]*?<\/GetLegendGraphic>/,'').replace(/<LegendURL>[\s\S]*?<\/LegendURL>/,''),'legend'],
 ]) {
  let calls=0;const api=fixture(async()=>{calls++;return xmlResponse(change(xml));});
  const response=await api.GET(request(operation==='map'?base:{product:'velocity',op:'legend',layer:actualLayer}));
  assert.equal(response.status,502);assert.equal(calls,1);
 }
});

test('HTML, malformed XML and entity declarations fail as unavailable',async()=>{
 for(const body of ['<html>not capabilities</html>',xml.replace('</WMS_Capabilities>',''),
  '<!DOCTYPE WMS_Capabilities [<!ENTITY evil SYSTEM "https://example.com/secret">]>'+xml,
  xml.replace('version="1.3.0"','version="1.1.1"')]) {
  const response=await fixture(async()=>xmlResponse(body)).GET(request({product:'velocity',op:'capabilities'}));
  assert.equal(response.status,502);assert.equal((await response.json()).unavailable,true);
 }
});

test('wrong PNG content/signature, oversized responses and WMS exceptions fail closed',async()=>{
 for(const image of [
  ()=>new Response('<ServiceException>no data</ServiceException>',{headers:{'Content-Type':'text/xml'}}),
  ()=>new Response('wrong',{headers:{'Content-Type':'image/png'}}),
  ()=>new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(3*1024*1024)}}),
 ]) {
  const api=fixture(async(url)=>new URL(url).searchParams.get('request')==='GetCapabilities'?xmlResponse():image());
  const response=await api.GET(request(base));assert.equal(response.status,502);assert.equal((await response.json()).unavailable,true);
 }
 const metadata=await fixture(async()=>xmlResponse(xml,{'Content-Length':String(3*1024*1024)})).GET(request({product:'velocity',op:'capabilities'}));
 assert.equal(metadata.status,502);
});

test('network failure and cancellation remain unavailable and do not retry',async()=>{
 let calls=0;
 const failed=await fixture(async()=>{calls++;throw Error('network unavailable');}).GET(request({product:'velocity',op:'capabilities'}));
 assert.equal(failed.status,502);assert.equal(calls,1);assert.equal((await failed.json()).unavailable,true);
 const controller=new AbortController();controller.abort();
 const canceled=await fixture(async()=>{calls++;throw Error('must not fetch');}).GET(request({product:'velocity',op:'capabilities'},{signal:controller.signal}));
 assert.equal(canceled.status,504);assert.equal(calls,1);
});

test('unknown outer sharing parameters are ignored and never forwarded to official WMS',async()=>{
 let calls=0;
 const response=await fixture(async(url)=>{
  calls++;const query=new URL(url).searchParams;
  assert.deepEqual([...query.keys()].sort(),['request','service','version']);
  assert.equal(query.get('request'),'GetCapabilities');
  assert.equal(new URL(url).origin+new URL(url).pathname,velocity);
  return xmlResponse();
 }).GET(new Request('https://preview.cmpri.example/api/weather-preview/wms?product=velocity&op=capabilities'
  +'&previewShareMetadata=review-context&connectorSharingToken=outer-only&url=https%3A%2F%2Fexample.com%2Fprivate'
  +'&REQUEST=delete&FORMAT=text%2Fhtml&unknown=first&unknown=second'));
 assert.equal(response.status,200);assert.equal(calls,1);
 const api=fixture(()=>{throw Error('duplicate meaningful parameter must not fetch');});
 for(const key of ['product','op','layer','style','time','bbox','width','height','format']) {
  const query=new URLSearchParams({...base});query.append(key,'duplicate');
  if(!new URLSearchParams(base).has(key))query.append(key,'another');
  const duplicate=await api.GET(new Request('https://preview.cmpri.example/api/weather-preview/wms?'+query));
  assert.equal(duplicate.status,400,key);
 }
});


test('unparsed NDFD capabilities remain bounded JSON diagnostics without resolving declarations',async()=>{
 const raw='<!DOCTYPE WMT_MS_Capabilities SYSTEM "https://untrusted.example/never-fetch.dtd">'+
  '<WMT_MS_Capabilities version="1.1.1"><Service><Title>Source diagnostic</Title></Service></WMT_MS_Capabilities>';
 let calls=0;
 const api=fixture(async(url)=>{ calls++;assert.equal(new URL(url).origin+new URL(url).pathname,cloudCover);return xmlResponse(raw); });
 const response=await api.GET(request({product:'cloudCover',op:'capabilities'}));
 assert.equal(response.status,502);assert.match(response.headers.get('Content-Type'),/application\/json/);
 const data=await response.json();assert.equal(data.unavailable,true);assert.equal(data.diagnostic.xml,raw);
 assert.equal(data.diagnostic.parsed,false);assert.equal(data.diagnostic.entityResolution,false);
 assert.equal(calls,1,'Diagnostic XML never follows a DTD or changes the fixed service');
 assert.match(data.error.message,/unsupported XML declarations/);
});


test('actual NDFD 1.1.1 contract parses only the known DOCTYPE and requests exact advertised VTIT with SRS',async()=>{
 const calls=[];
 const api=fixture(async(url)=>{
  const query=new URL(url).searchParams;calls.push(url);
  if(query.get('request')==='GetCapabilities') {
   assert.equal(query.get('version'),'1.1.1');return xmlResponse(cloudXml);
  }
  assert.equal(query.get('VERSION'),'1.1.1');assert.equal(query.get('LAYERS'),'ndfd.conus.sky');
  assert.equal(query.get('STYLES'),'');assert.equal(query.get('VTIT'),'2026-11-20T20:00');
  assert.equal(query.get('SRS'),'EPSG:3857');assert.equal(query.has('CRS'),false);assert.equal(query.has('TIME'),false);
  assert.equal(query.get('EXCEPTIONS'),'application/vnd.ogc.se_xml','Service exceptions must be XML, never a PNG error panel');
  assert.equal(query.get('FORMAT'),'image/png');assert.equal(query.get('TRANSPARENT'),'TRUE');
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 });
 const capability=await api.GET(request({product:'cloudCover',op:'capabilities'}));
 assert.equal(capability.status,200);const metadata=await capability.json();
 assert.equal(metadata.version,'1.1.1');assert.equal(metadata.legendSupported,false);
 const layer=metadata.layers.find(value=>value.name==='ndfd.conus.sky');
 assert.deepEqual(layer.crs,['EPSG:3857','EPSG:900913']);assert.deepEqual(layer.styles,[]);
 assert.equal(layer.dimensions.vtit.default,'1970-01-01T00:00');
 assert.match(layer.abstract,/most recently issued forecast/);
 const params={...base,product:'cloudCover',layer:layer.name,style:'',time:'2026-11-20T20:00'};
 for(const invalid of [
  {...params,time:''},{...params,time:'1970-01-01T00:00'},{...params,time:'current'},
  {...params,time:'2026-11-20T20:00Z'},{...params,time:'2026-11-20T20:01'},
  {...params,layer:'ndfd.conus.sky.points'},{...params,style:'invented'},
 ]) assert.equal((await api.GET(request(invalid))).status,400,JSON.stringify(invalid));
 assert.equal(calls.length,1,'Unsupported defaults, times, style or point layers cannot request an image');
 const map=await api.GET(request(params));assert.equal(map.status,200);
 assert.equal(map.headers.get('X-Weather-Time'),params.time);assert.equal(calls.length,2);
});

test('NDFD declaration exceptions never allow entities or unrecognized DTDs',async()=>{
 for(const body of [
  cloudXml.replace('<!ELEMENT VendorSpecificCapabilities EMPTY>','<!ENTITY test SYSTEM "https://untrusted.example/secret">'),
  cloudXml.replace('http://schemas.opengis.net/wms/1.1.0/capabilities_1_1_0.dtd','https://untrusted.example/custom.dtd'),
  cloudXml.replace('VendorSpecificCapabilities EMPTY','UnexpectedElement EMPTY'),
 ]) {
  let calls=0;const api=fixture(async()=>{calls++;return xmlResponse(body);});
  const response=await api.GET(request({product:'cloudCover',op:'capabilities'}));
  assert.equal(response.status,502);assert.equal((await response.json()).diagnostic.parsed,false);assert.equal(calls,1);
 }
});


test('large real NDFD catalog exposes only the exact verified sky-cover raster while other products retain the layer limit',async()=>{
 const unrelated=Array.from({length:240},(_,index)=>`<Layer><Name>ndfd.conus.UNRELATED_${index}</Name><Title>Unrelated source layer</Title></Layer>`).join('');
 const body=cloudXml.replace('<Capability>','<Capability>').replace('</Capability>',unrelated+'</Capability>');
 const response=await fixture(async()=>xmlResponse(body)).GET(request({product:'cloudCover',op:'capabilities'}));
 assert.equal(response.status,200);const data=await response.json();
 assert.deepEqual(data.layers.map(layer=>layer.name),['ndfd.conus.sky']);
 assert.equal(data.xml,body,'Bounded raw capabilities remain inspectable for source verification');
 const other=xml.replace('</Capability>',unrelated+'</Capability>');
 const limited=await fixture(async()=>xmlResponse(other)).GET(request({product:'velocity',op:'capabilities'}));
 assert.equal(limited.status,502);assert.match((await limited.json()).error.message,/too many named layers/);
});
