import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
function compile(file, deps={}) {
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,File,FormData,Uint8Array,TextDecoder,Date,require(name){if(name in deps)return deps[name];throw Error(name);}});return exports;
}
const identity=compile('src/lib/manual-document-match.ts');
const source=compile('src/lib/manual-source.ts',{'./manual-document-match':identity});
function uploadFixture({model='UW65', failTable=null, readable=true, direct=false, denied=false, locked=false, corrupt=false, canonical=false}={}) {
 const writes=[];const bytes=new Uint8Array(Buffer.from('%PDF-test-original-bytes'));let saved;
 let reads=0; const asset={documentation_verified_at:locked?'now':null,id:'asset',manufacturer:'Alliance',model_family:null,model_number:model};
 const admin={rpc:async()=>({error:null}),from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:asset,error:null}),upsert:async(row,options)=>{writes.push({table,row,options});return {error:table===failTable?{message:'test write failed'}:null};}};return q;},storage:{getBucket:async()=>({data:{id:'asset-documentation'},error:null}),from:()=>({upload:async(path,data)=>{saved={path,bytes:Array.from(data)};return {error:null};},createSignedUrl:async()=>({data:{signedUrl:'https://example.invalid/manual.pdf'}})})}};
 const route=compile(canonical?'src/app/api/assets/documentation/route.ts':'src/lib/server/pre-consolidation/documentation-route.ts',{
 '@/lib/manual-applicability':{},'@/lib/server/stored-pdf-status':{},'@/lib/equipment-pdf-suggestions':{extractEquipmentSuggestions:()=>null},'@/lib/server/pre-consolidation/documentation-route':{},'@/lib/server/consolidation-stage':{dispatchConsolidation:async()=>null},'@/lib/server/asset-file-register':{registerAssetFile:async()=>({error:null})},'@/lib/server/stored-pdf-import':{},'@/lib/server/pdf-direct-upload':{},'@/lib/stored-pdf-link':{},'@/lib/server/verified-manual-catalog':{},
 'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},'@/lib/constants':{HOTEL_ID:'hotel'},
 '@/lib/server/auth':{requireCapability:async()=>denied?null:({admin,principal:{profile:{role:'engineer',full_name:'Test'},identity:{id:'test'}}})},
 '@/lib/server/import-upload':{readImportUpload:async(a,h,u,d,k)=>{reads++;assert.equal(a,admin);assert.equal(h,'hotel');assert.equal(u,'test');assert.equal(k,'asset-documentation');assert.equal(d.id,'descriptor');if(corrupt)throw Error('changed');return {bytes,descriptor:{name:'washer.pdf'}};}},
 '@/lib/server/roles':{canEditEquipment:()=>true},'@/lib/manual-source':source,
 '@/lib/manual-pdf-knowledge':{extractManualPdfText:async()=>readable?'PAGE 1\nAlliance UW65\n\nPAGE 50\nTroubleshooting\nNo fill: check source diagram.':'',manualPdfSha256:data=>createHash('sha256').update(data).digest('hex')},
 '@/lib/manual-document-catalog':{},'@/lib/server/pre-consolidation/verified-manual-catalog':{},
 });
 return {writes,reads:()=>reads,saved:()=>saved,bytes,run:async()=>{const form=new FormData();form.set('asset_id','asset');if(direct)form.set('upload_descriptor',JSON.stringify({id:'descriptor'}));else form.set('file',new File([bytes],'washer.pdf',{type:'application/pdf'}));return route.POST({formData:async()=>form});}};
}
test('legacy manual descriptor transport preserves exact original bytes without a multipart file', async()=>{const f=uploadFixture({direct:true});const r=await f.run();assert.equal(r.status,200);assert.equal(f.reads(),1);assert.deepEqual(f.saved().bytes,Array.from(f.bytes));});
for(const option of ['denied','locked'])test(`${option} rejects staged PDF before download`,async()=>{const f=uploadFixture({direct:true,[option]:true});assert([403,409].includes((await f.run()).status));assert.equal(f.reads(),0);assert.equal(f.saved(),undefined);});
test('unverified staged PDF cannot create document records',async()=>{const f=uploadFixture({direct:true,corrupt:true});assert.equal((await f.run()).status,400);assert.equal(f.saved(),undefined);assert.equal(f.writes.length,0);});

test('canonical manual route consumes exact staged PDF after unchanged authorization',async()=>{const f=uploadFixture({direct:true,canonical:true});assert.equal((await f.run()).status,200);assert.equal(f.reads(),1);assert.deepEqual(f.saved().bytes,Array.from(f.bytes));});
for(const option of ['denied','locked','corrupt'])test(`canonical ${option} prevents staged PDF save`,async()=>{const f=uploadFixture({direct:true,canonical:true,[option]:true});assert([400,403,409].includes((await f.run()).status));assert.equal(f.saved(),undefined);});
