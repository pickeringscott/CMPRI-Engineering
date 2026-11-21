import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { File } from 'node:buffer';
import { canReadChiefModuleData } from '../src/lib/dashboard/chief-module-access.ts';

const source = ts.transpileModule(readFileSync(new URL('../src/app/api/assets/photo/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
const id = '00000000-0000-4000-8000-000000000001';
function fixture({ allowed=true, exists=true, role=allowed?'engineer':'visitor', mcp=false }={}) {
 const uploads=[],downloads=[],filters=[];
 const principal={identity:{id:'actor'},profile:{id:'actor',role,active:true},hotelId:'hotel',membership:{user_id:'actor',hotel_id:'hotel',active:true}};
 const auth={principal,admin:{from(){const q={select:()=>q,eq:(key,value)=>{filters.push([key,value]);return q;},maybeSingle:async()=>({data:exists?{id}:null,error:null})};return q;},storage:{from:()=>({upload:async(path,data,options)=>{uploads.push({path,data,options});return {error:null};},download:async(path)=>{downloads.push(path);return {data:new Blob(['test image']),error:null};}})}}};
 const exports={};
 const NextResponse=class extends Response { static json(body,init){return Response.json(body,init);} };
 vm.runInNewContext(source,{exports,Buffer,File,require(name){if(name==='next/server')return {NextResponse};if(name==='sharp')return sharp;if(name==='@/lib/constants')return {HOTEL_ID:'hotel'};if(name==='@/lib/dashboard/chief-module-access')return {canReadChiefModuleData};if(name==='@/lib/server/auth')return {requireUser:async()=>auth,requireUserAttempt:async()=>({ok:true,...auth,mcp}),requireCapability:async()=>auth};if(name==='@/lib/server/roles')return {canEditEquipment:()=>allowed,canReadEquipment:()=>allowed};if(name==='@/lib/uuid')return {isUuid:v=>v===id};throw Error(name);}});
 return {route:exports,uploads,downloads,filters};
}
const request=file=>({formData:async()=>({get:key=>key==='asset_id'?id:file})});
test('only an authorized equipment editor can upload an asset photo',async()=>{const f=fixture({allowed:false});const result=await f.route.PUT(request(new File(['x'],'x.png',{type:'image/png'})));assert.equal(result.status,403);assert.equal(f.uploads.length,0);});
test('rejects invalid image bytes without storing a file',async()=>{const f=fixture();const result=await f.route.PUT(request(new File(['not an image'],'x.png',{type:'image/png'})));assert.equal(result.status,400);assert.equal(f.uploads.length,0);});
test('stores a converted image under the stable asset identity',async()=>{const f=fixture();const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();const result=await f.route.PUT(request(new File([bytes],'x.png',{type:'image/png'})));assert.equal(result.status,200);assert.equal(f.uploads[0].path,`hotel/_asset-photos/${id}.webp`);assert.equal((await sharp(f.uploads[0].data).metadata()).format,'webp');});
test('Senior Management can read a property asset photo through the modal session only',async()=>{
 const read={nextUrl:new URL(`https://cmpri.test/api/assets/photo?asset_id=${id}`)};
 const session=fixture({allowed:false,role:'senior_management'});
 assert.equal((await session.route.GET(read)).status,200);
 assert.deepEqual(session.filters,[['hotel_id','hotel'],['id',id]]);
 assert.deepEqual(session.downloads,[`hotel/_asset-photos/${id}.webp`]);
 const mcp=fixture({allowed:false,role:'senior_management',mcp:true});
 assert.equal((await mcp.route.GET(read)).status,403);
 assert.deepEqual(mcp.downloads,[]);
});
