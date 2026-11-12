import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/server/import-upload.ts',import.meta.url),'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Uint8Array,require(name){if(name==='node:crypto')return {createHash};if(name==='../uuid')return {isUuid:v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)};throw Error(name)}});
const bytes = new TextEncoder().encode('%PDF-fixture');
const descriptor = {kind:'po-pdf',id:'00000000-0000-4000-8000-000000000001',name:'invoice.pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
function storage({size=bytes.length,type='application/pdf',data=bytes,bucketPublic=false,bucketLimit=100*1024*1024}={}) {
 const paths=[];
 const api={
  list:async()=>({data:[]}),
  info:async path=>{paths.push(path);return {data:{size,contentType:type}}},
  download:async path=>{paths.push(path);return {data:new Blob([data])}},
  createSignedUploadUrl:async(path,options)=>{paths.push(path);assert.equal(options.upsert,false);return {data:{signedUrl:'https://storage.example/upload'}}}
 };
 return {paths,admin:{storage:{getBucket:async()=>({data:{public:bucketPublic,file_size_limit:bucketLimit}}),from(bucket){assert.equal(bucket,'import-upload-staging');return api}}}};
}
test('100 MiB boundary accepts exact limit and rejects oversized/empty/noninteger descriptors',()=>{assert.equal(exports.importDescriptor({...descriptor,size:100*1024*1024}).size,100*1024*1024);for(const size of [0,-1,1.5,100*1024*1024+1])assert.throws(()=>exports.importDescriptor({...descriptor,size}));});
test('rejects purpose confusion, path injection, wrong extension and malformed hash',()=>{for(const update of [{kind:'unknown'},{name:'../invoice.pdf'},{name:'invoice.csv'},{sha256:'z'.repeat(64)},{id:'../other'}])assert.throws(()=>exports.importDescriptor({...descriptor,...update}));assert.throws(()=>exports.importDescriptor(descriptor,'guest-report'));});
test('signed upload derives actor/hotel path and refuses public or wrong-limit bucket',async()=>{const s=storage();await exports.prepareImportUpload(s.admin,'hotel','actor',descriptor);assert.match(s.paths[0],/^hotel\/actor\/po-pdf\//);for(const opts of [{bucketPublic:true},{bucketLimit:50*1024*1024}])await assert.rejects(exports.prepareImportUpload(storage(opts).admin,'hotel','actor',descriptor));});
test('read validates exact owner-scoped object metadata and hash before returning bytes',async()=>{const s=storage();const result=await exports.readImportUpload(s.admin,'hotel','actor',descriptor,'po-pdf');assert.equal(result.bytes.length,bytes.length);assert.ok(s.paths.every(p=>p.startsWith('hotel/actor/po-pdf/')));for(const opts of [{size:bytes.length+1},{type:'text/plain'},{data:new TextEncoder().encode('%PDF-changed')}])await assert.rejects(exports.readImportUpload(storage(opts).admin,'hotel','actor',descriptor,'po-pdf'));});
test('client uses direct storage transport with no bearer token on storage request',()=>{const source=readFileSync(new URL('../src/lib/import-upload.ts',import.meta.url),'utf8');assert.match(source,/fetch\(result.signedUrl/);assert.match(source,/credentials: 'omit'/);assert.match(source,/referrerPolicy: 'no-referrer'/);assert.match(source,/redirect: 'error'/);});
test('asset manuals have separate PDF purpose and cannot be replayed as PO reviews',()=>{const d={...descriptor,kind:'asset-documentation'};assert.equal(exports.importDescriptor(d,'asset-documentation').kind,'asset-documentation');assert.throws(()=>exports.importDescriptor(d,'po-pdf'));});
test('prepare route preserves per-purpose capability, equipment role and purchasing flag gates',async()=>{
 const routeSource=readFileSync(new URL('../src/app/api/import-uploads/route.ts',import.meta.url),'utf8');
 for(const kind of ['po-pdf','guest-report','purchasing-history','asset-documentation']){
  for(const allowed of [false,true])for(const enabled of [false,true]){
   let writes=0,checked='';const route={};
   vm.runInNewContext(ts.transpileModule(routeSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:route,process:{env:{CMPRI_PO_ENABLED:String(enabled)}},require(name){
    if(name==='@/lib/uuid')return {isUuid:()=>true};
    if(name==='next/server')return {NextResponse:{json:(body,{status=200}={})=>({body,status})}};
    if(name==='@/lib/server/roles')return {canEditEquipment:()=>allowed};
    if(name==='@/lib/server/auth')return {requireCapability:async(_request,cap)=>{checked=cap;return allowed?{admin:{},principal:{hotelId:'hotel',identity:{id:'actor'},profile:{role:'chief'}}}:null}};
    if(name==='@/lib/server/import-upload')return {importDescriptor:()=>({...descriptor,kind}),prepareImportUpload:async()=>{writes++;return {signedUrl:'test'}}};throw Error(name);
   }});
   const result=await route.POST({text:async()=>JSON.stringify({...descriptor,kind})});
   assert.equal(checked,kind==='guest-report'?'edit_tickets':kind==='purchasing-history'?'operate_integrations':'manage_assets');
   const gated=(kind==='po-pdf'||kind==='purchasing-history')&&!enabled;
   assert.equal(result.status,!allowed?403:gated?409:200);assert.equal(writes,allowed&&!gated?1:0);
  }
 }
});
