import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { File } from 'node:buffer';

const source = ts.transpileModule(readFileSync(new URL('../src/app/api/assets/photo/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
const id = '00000000-0000-4000-8000-000000000001';
function fixture({ allowed=true, exists=true }={}) {
 const uploads=[];
 const auth={principal:{profile:{role:allowed?'engineer':'visitor'}},admin:{from(){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:exists?{id}:null,error:null})};return q;},storage:{from:()=>({upload:async(path,data,options)=>{uploads.push({path,data,options});return {error:null};}})}}};
 const exports={};
 const NextResponse=class extends Response { static json(body,init){return Response.json(body,init);} };
 vm.runInNewContext(source,{exports,Buffer,File,require(name){if(name==='next/server')return {NextResponse};if(name==='sharp')return sharp;if(name==='@/lib/constants')return {HOTEL_ID:'hotel'};if(name==='@/lib/server/auth')return {requireUser:async()=>auth,requireCapability:async()=>auth};if(name==='@/lib/server/roles')return {canEditEquipment:()=>allowed,canReadEquipment:()=>allowed};if(name==='@/lib/uuid')return {isUuid:v=>v===id};throw Error(name);}});
 return {route:exports,uploads};
}
const request=file=>({formData:async()=>({get:key=>key==='asset_id'?id:file})});
test('only an authorized equipment editor can upload an asset photo',async()=>{const f=fixture({allowed:false});const result=await f.route.PUT(request(new File(['x'],'x.png',{type:'image/png'})));assert.equal(result.status,403);assert.equal(f.uploads.length,0);});
test('rejects invalid image bytes without storing a file',async()=>{const f=fixture();const result=await f.route.PUT(request(new File(['not an image'],'x.png',{type:'image/png'})));assert.equal(result.status,400);assert.equal(f.uploads.length,0);});
test('stores a converted image under the stable asset identity',async()=>{const f=fixture();const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();const result=await f.route.PUT(request(new File([bytes],'x.png',{type:'image/png'})));assert.equal(result.status,200);assert.equal(f.uploads[0].path,`hotel/_asset-photos/${id}.webp`);assert.equal((await sharp(f.uploads[0].data).metadata()).format,'webp');});
