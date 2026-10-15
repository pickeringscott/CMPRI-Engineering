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
for(const [kind,manufacturer,model] of [['washer','Alliance','UW65'],['dryer','Alliance','UT120N'],['RTU','Trane','YSC060'],['lock','Schlage','CO-100']]) {
 test(`${kind}: upload associates exact source and exposes literal troubleshooting beyond page 40`,()=>{
  const text=`PAGE 1\n${manufacturer} ${model} service manual\n\nPAGE 75\nTroubleshooting\nError code E1: source table entry.\nCheck the source component.`;
  const result=source.prepareUploadedGuide(text,{manufacturer,model_number:model,model_family:null},`${kind}.pdf`,'hash');
  assert.equal(result.state,'ready');assert.equal(result.knowledge.source.verified,true);
  assert.equal(result.knowledge.source_passages[0].page,75);
  assert.ok(text.includes(result.knowledge.source_passages[0].text));
  assert.equal(result.knowledge.error_codes.length,0); // No invented table interpretation.
  assert.equal(source.prepareUploadedGuide(text,{manufacturer,model_number:'OTHER',model_family:null},'manual.pdf','hash').state,'pending_identity');
 });
}
test('unknown identity, scanned text, and manual without diagnostics have distinct states',()=>{
 const known={manufacturer:'Alliance',model_number:'UW65',model_family:null};
 assert.equal(source.prepareUploadedGuide('',known,'scan.pdf','hash').state,'failed');
 assert.equal(source.prepareUploadedGuide('PAGE 1\nAlliance UW65',known,'parts.pdf','hash').state,'pending_guidance');
 assert.equal(source.prepareUploadedGuide('PAGE 1\nAlliance UW65 Troubleshooting',{...known,model_number:null},'manual.pdf','hash').state,'pending_identity');
});
test('temperature, import IDs, model numbers do not become codes',()=>{
 for(const text of ['it is 77','AC-6131','IMP-0006','UT120N needs service','room 410 loud HVAC'])assert.equal(source.reportedDiagnosticCode(text),null);
 assert.equal(source.reportedDiagnosticCode('error code F1'),'F1');assert.equal(source.reportedDiagnosticCode('fault 15'),'15');
});
function uploadFixture({model='UW65', failTable=null, readable=true}={}) {
 const writes=[];const bytes=new Uint8Array(Buffer.from('%PDF-test-original-bytes'));let saved;
 const asset={id:'asset',manufacturer:'Alliance',model_family:null,model_number:model};
 const admin={from(table){const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:asset,error:null}),upsert:async(row,options)=>{writes.push({table,row,options});return {error:table===failTable?{message:'test write failed'}:null};}};return q;},storage:{getBucket:async()=>({data:{id:'asset-documentation'},error:null}),from:()=>({upload:async(path,data)=>{saved={path,bytes:Array.from(data)};return {error:null};},createSignedUrl:async()=>({data:{signedUrl:'https://example.invalid/manual.pdf'}})})}};
 const route=compile('src/app/api/assets/documentation/route.ts',{
 'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},'@/lib/constants':{HOTEL_ID:'hotel'},
 '@/lib/server/auth':{requireCapability:async()=>({admin,principal:{profile:{role:'engineer',full_name:'Test'},identity:{id:'test'}}})},
 '@/lib/server/roles':{canEditEquipment:()=>true},'@/lib/manual-source':source,
 '@/lib/manual-pdf-knowledge':{extractManualPdfText:async()=>readable?'PAGE 1\nAlliance UW65\n\nPAGE 50\nTroubleshooting\nNo fill: check source diagram.':'',manualPdfSha256:data=>createHash('sha256').update(data).digest('hex')},
 '@/lib/manual-document-catalog':{},'@/lib/server/verified-manual-catalog':{},
 });
 return {writes,saved:()=>saved,bytes,run:async()=>{const form=new FormData();form.set('asset_id','asset');form.set('file',new File([bytes],'washer.pdf',{type:'application/pdf'}));return route.POST({formData:async()=>form});}};
}
test('upload route stores original bytes and links existing catalog/cache without changing assets',async()=>{
 const f=uploadFixture();const r=await f.run();assert.equal(r.status,200);assert.equal(r.body.processing_status,'ready');
 assert.deepEqual(f.saved().bytes,Array.from(f.bytes));assert.deepEqual(f.writes.map(w=>w.table),['troubleshooting_cache','maintenance_documents']);
 const [cache,catalog]=f.writes;assert.equal(catalog.row.storage_path,f.saved().path);assert.equal(catalog.row.troubleshooting_cache_key,cache.row.cache_key);assert.equal(cache.row.payload.source_passages[0].page,50);
});
test('unknown model stays pending without changing physical identity',async()=>{
 const f=uploadFixture({model:null});const r=await f.run();assert.equal(r.body.processing_status,'pending_identity');assert.equal(f.writes[1].row.ingestion_status,'pending');assert.equal(f.writes[0].row.payload.source.verified,false);
});
for(const failTable of ['troubleshooting_cache','maintenance_documents'])test(`${failTable} failure preserves PDF and reports retryable failure`,async()=>{
 const f=uploadFixture({failTable});const r=await f.run();assert.equal(r.status,503);assert.equal(r.body.processing_status,'failed');assert.ok(r.body.storage_path);assert.deepEqual(f.saved().bytes,Array.from(f.bytes));
});
