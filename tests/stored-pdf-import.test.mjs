import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
const load=(file,deps={})=>{const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{if(name in deps)return deps[name];throw Error(name);},TextDecoder,Uint8Array,File,FormData,Response,crypto,console});return exports;};
const validation=load('../src/lib/stored-pdf-link.ts');
const bytes=new TextEncoder().encode('%PDF-fixture');
const file={object_id:'00000000-0000-4000-8000-000000000010',storage_path:'Asset Docs/fixture.pdf',object_version:'v1',etag:'etag1',size:bytes.length,title:'Original'};
const edited={title:'My corrected title',manufacturer:'GE',models:['AZ95E09DACK1','AZ95E12DACK1'],selected_model:'AZ95E12DACK1',applicability:'confirmed_model',notes:'User-selected model',reason:'Confirm exact model'};
test('file validation rejects empty, wrong-content, size mismatch and changed originals',()=>{
 assert.throws(()=>validation.validateStoredPdf(new Uint8Array(),file,null,'a'),/empty/);
 assert.throws(()=>validation.validateStoredPdf(new TextEncoder().encode('not a pdf'),file,null,'a'),/not a PDF/);
 assert.throws(()=>validation.validateStoredPdf(bytes,{...file,size:90},null,'a'),/size/);
 assert.throws(()=>validation.validateStoredPdf(bytes,file,'before','after'),/changed/);
 assert.doesNotThrow(()=>validation.validateStoredPdf(bytes,file,'same','same'));
});
test('multi-model selections are explicit and retained separately from suggestions',()=>{
 const result=validation.reviewPdfFields(edited);assert.equal(result.selected_model,'AZ95E12DACK1');assert.equal(result.models.length,2);
 assert.throws(()=>validation.reviewPdfFields({...edited,selected_model:'AZ999'}),/Choose the confirmed/);
 assert.throws(()=>validation.reviewPdfFields({...edited,models:'guess'}),/model list/);
 const reference=validation.reviewPdfFields({...edited,applicability:'reference',selected_model:'',manufacturer:''});assert.equal(reference.applicability,'reference');
 assert.equal(validation.preservePdfReview('one','one',edited,null,{...edited,title:'automatic'}),edited);
 assert.equal(validation.preservePdfReview(null,'one',{},edited,{...edited,title:'automatic'}).title,edited.title);
});
test('existing importer verifies stored bytes and opens original without upload or guide generation',async()=>{
 const calls=[];const service=load('../src/lib/server/stored-pdf-import.ts',{'@/lib/manual-pdf-knowledge':{extractManualPdfText:async()=>{calls.push('extract');return 'fixture model text';},manualPdfSha256:()=> 'a'.repeat(64)},'@/lib/stored-pdf-link':validation});
 const admin={rpc:async()=>({data:[file],error:null}),storage:{from:()=>({download:async p=>{calls.push(p);return {data:new Blob([bytes]),error:null};},createSignedUrl:async p=>({data:{signedUrl:'https://example.invalid/'+p},error:null}),upload:()=>{throw Error('duplicate upload');}})}};
 const r=await service.inspectStoredPdf(admin,file.object_id);assert.equal(r.file.storage_path,file.storage_path);assert.equal(r.sha256,'a'.repeat(64));assert.equal(calls.length,2);
 await assert.rejects(service.inspectStoredPdf(admin,'missing'),/missing/);
 await assert.rejects(service.inspectStoredPdf({...admin,storage:{from:()=>({download:async()=>({data:null,error:{}})})}},file.object_id),/could not be opened/);
});
function routeFixture({denied=false,readbackMismatch=false,changed=false}={}) {
 let links=[];const calls=[];
 const asset={id:'asset',updated_at:'2026-10-15T00:00:00Z',pdf_import_links:links};
 const admin={from:()=>{const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{...asset,pdf_import_links:links},error:null}),single:async()=>({data:{pdf_import_links:readbackMismatch?[]:links},error:null})};return q;},rpc:async(name,args)=>{calls.push(name);links=[args.p_link];return {data:{links},error:null};}};
 const auth={admin,principal:{profile:{role:'system_admin'},identity:{id:'actor'}}};
 const route=load('../src/app/api/assets/documentation/route.ts',{'@/lib/server/consolidation-stage':{dispatchConsolidation:async()=>null},'@/lib/server/pre-consolidation/documentation-route':{},'@/lib/server/asset-file-register':{},'next/server':{NextResponse:Response},'@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/server/auth':{requireCapability:async()=>denied?null:auth},'@/lib/server/roles':{canEditEquipment:()=>true},'@/lib/manual-source':{prepareUploadedGuide:()=>{throw Error('guide generation must not run');}},'@/lib/manual-pdf-knowledge':{},'@/lib/manual-document-catalog':{},'@/lib/server/verified-manual-catalog':{},'@/lib/stored-pdf-link':validation,'@/lib/server/pdf-direct-upload':{},'@/lib/server/stored-pdf-import':{inspectStoredPdf:async()=>{if(changed)throw Error('PDF changed since review');return {file,sha256:'a'.repeat(64),url:'https://example.invalid/original',text:'Manufacturer: GE Model: AZ95E12DACK1'};}}});
 return {calls,run:async(action='save',confirm=true)=>{const form=new FormData();form.set('import_action',action);form.set('asset_id','asset');form.set('object_id',file.object_id);form.set('sha256','a'.repeat(64));form.set('fields',JSON.stringify(edited));form.set('review_confirmed',String(confirm));form.set('expected_updated_at',asset.updated_at);return route.POST({formData:async()=>form});}};
}
test('existing route saves only explicitly confirmed links and independently verifies readback',async()=>{
 const ok=routeFixture();const response=await ok.run();assert.equal(response.status,200);assert.equal((await response.json()).association_verified,true);assert.deepEqual(ok.calls,['cmpri_save_import_pdf_link']);
 const unconfirmed=routeFixture();assert.equal((await unconfirmed.run('save',false)).status,422);assert.equal(unconfirmed.calls.length,0);
 const denied=routeFixture({denied:true});assert.equal((await denied.run()).status,403);assert.equal(denied.calls.length,0);
 const changed=routeFixture({changed:true});assert.equal((await changed.run()).status,422);assert.equal(changed.calls.length,0);
 assert.equal((await routeFixture({readbackMismatch:true}).run()).status,503);
 const review=routeFixture();assert.equal((await review.run('review')).status,200);assert.equal(review.calls.length,0);
});
test('single asset row stores multiple links, independent models and immutable edit history; originals remain intact',async()=>{
 const db=new PGlite();const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6',asset='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002';
 try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
 CREATE TABLE assets(id uuid PRIMARY KEY,hotel_id uuid,updated_at timestamptz DEFAULT now(),documentation_verified_at timestamptz);
 CREATE TABLE storage.objects(id uuid PRIMARY KEY,name text,bucket_id text,version text,metadata jsonb);
 CREATE TABLE maintenance_documents(storage_path text,hotel_id uuid,title text);
 CREATE FUNCTION touch_asset() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN new.updated_at=clock_timestamp();RETURN new;END$$;
 CREATE TRIGGER touch BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION touch_asset();
 INSERT INTO assets(id,hotel_id) VALUES('${asset}','${hotel}');
 GRANT USAGE ON SCHEMA public,auth,storage TO service_role;GRANT SELECT,UPDATE ON assets TO service_role;GRANT SELECT ON storage.objects,maintenance_documents TO service_role;
 INSERT INTO storage.objects VALUES('${file.object_id}','${file.storage_path}','asset-documentation','v1','{"eTag":"etag1","size":12}'),('00000000-0000-4000-8000-000000000011','Asset Docs/second.pdf','asset-documentation','v1','{"eTag":"etag1","size":12}');`);
 await db.exec(fs.readFileSync(new URL('../../importer-schema-candidate.sql',import.meta.url),'utf8'));
 assert.equal((await db.query("select has_function_privilege('authenticated','cmpri_save_import_pdf_link(uuid,timestamptz,uuid,jsonb,boolean)','EXECUTE') allowed")).rows[0].allowed,false);
 await db.exec("SET ROLE service_role;SET request.jwt.claim.role='service_role';");
 const timestamp=async()=>(await db.query('select updated_at from assets where id=$1',[asset])).rows[0].updated_at;
 const save=async(link,remove=false,at=null)=>db.query('select cmpri_save_import_pdf_link($1,$2,$3,$4,$5) result',[asset,at||await timestamp(),actor,link,remove]);
  const first={...file,...edited,preferred:true,sha256:'a'.repeat(64)};await save(first);
  const second={...first,object_id:'00000000-0000-4000-8000-000000000011',storage_path:'Asset Docs/second.pdf',selected_model:'AZ95E09DACK1'};await save(second);
  let row=(await db.query('select * from assets where id=$1',[asset])).rows[0];assert.equal(row.pdf_import_links.length,2);assert.equal(row.pdf_import_history.length,2);assert.equal(row.pdf_import_links.filter(l=>l.preferred).length,1);assert.equal(row.pdf_import_links.find(l=>l.preferred).object_id,second.object_id);
 await save({...first,title:'Another correction'});row=(await db.query('select * from assets where id=$1',[asset])).rows[0];assert.equal(row.pdf_import_links.length,2);assert.equal(row.pdf_import_history[2].before[0].title,'My corrected title');
 await assert.rejects(save({...first,object_version:'wrong'}),/changed since review/);
 await assert.rejects(save(first,false,'2000-01-01T00:00:00Z'),/Equipment changed/);
 await save({object_id:first.object_id,reason:'Wrong asset association'},true);row=(await db.query('select * from assets where id=$1',[asset])).rows[0];assert.equal(row.pdf_import_links.length,1);assert.equal(row.pdf_import_history.length,4);
 assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n,2);
 await db.exec('RESET ROLE;');await db.query('update assets set documentation_verified_at=now() where id=$1',[asset]);await db.exec("SET ROLE service_role;");await assert.rejects(save(second),/Open an equipment revision/);
 }finally{await db.close();}
});

