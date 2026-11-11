import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const require=createRequire(import.meta.url);
let routeDeps={};
function load(path,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:(name)=>name in deps?deps[name]:name in routeDeps?routeDeps[name]:require(name),console,TextDecoder,TextEncoder,Uint8Array,File,FormData});return exports;}
const sourceModule=load('../src/lib/manual-source.ts',{'./manual-document-match':load('../src/lib/manual-document-match.ts')});
const pdfModule=load('../src/lib/manual-pdf-knowledge.ts',{'@/lib/manual-document-match':{}});
test('real PDF extraction preserves upload bytes and SHA, including a second read',async()=>{
 const bytes=new Uint8Array(readFileSync(new URL('../public/guides/dormakaba.pdf',import.meta.url)));
 const hash=()=>createHash('sha256').update(bytes).digest('hex');const before=hash(),length=bytes.byteLength;
 const text=await pdfModule.extractManualPdfText(bytes);
 assert.ok(text.length>5000);assert.equal(bytes.byteLength,length);assert.equal(hash(),before);
 assert.equal(await pdfModule.extractManualPdfText(bytes),text);assert.equal(hash(),before);
});
const unexpectedLegacy=()=>{throw Error('Canonical route test must not invoke the legacy route');};
routeDeps={
 '@/lib/server/pre-consolidation/assets-route':{GET:unexpectedLegacy,PATCH:unexpectedLegacy},
 '@/lib/server/pre-consolidation/documentation-route':{GET:unexpectedLegacy,POST:unexpectedLegacy},
 '@/lib/server/consolidation-stage':{dispatchConsolidation:async()=>null},
 '@/lib/server/asset-file-register':load('../src/lib/server/asset-file-register.ts'),
 '@/lib/equipment-pdf-suggestions':load('../src/lib/equipment-pdf-suggestions.ts'),'@/lib/server/pdf-direct-upload':{},'@/lib/server/stored-pdf-import':{inspectStoredPdf:()=>{throw Error('Upload/retry fixture must not enter stored-import branch');}},
 '@/lib/stored-pdf-link':load('../src/lib/stored-pdf-link.ts'),
};
const hotel='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',asset='00000000-0000-4000-8000-000000000003';
async function database(){const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create function auth.role() returns text language sql as $$select current_setting('test.role',true)$$;
 create schema storage;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now());
 create table profiles(id uuid primary key,role text,active boolean);create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
 create table assets(id uuid primary key,hotel_id uuid,name text,documentation_verified_at timestamptz,documentation_verified_by uuid,updated_at timestamptz default now());
 create function refresh_asset_time() returns trigger language plpgsql as $$begin new.updated_at=clock_timestamp(); return new; end$$;
 create trigger refresh_asset_time before update on assets for each row execute function refresh_asset_time();
 insert into profiles values('${actor}','system_admin',true);insert into hotel_members values('${hotel}','${actor}',true);
 insert into assets(id,hotel_id,name,documentation_verified_at,documentation_verified_by) values('${asset}','${hotel}','Original',now(),'${actor}');
 insert into storage.objects(bucket_id,name,metadata) values('asset-documentation','${hotel}/${asset}/empty-original.pdf','{"size":0}');
 grant usage on schema public,auth to service_role;grant execute on function auth.role() to service_role;grant select,update on assets to service_role;
 select set_config('test.role','service_role',false);
 `);await db.exec(readFileSync(new URL('../supabase/migrations/20261013200800_cmpri_equipment_document_revisions.sql',import.meta.url),'utf8'));await db.exec('create trigger cmpri_protect_verified_asset before update on assets for each row execute function cmpri_protect_verified_asset();');return db;}
async function open(db,who=actor,expected=null){const at=expected||(await db.query('select updated_at from assets')).rows[0].updated_at;return db.query('select cmpri_begin_equipment_revision($1,$2,$3,$4,$5) id',[asset,hotel,at,who,'Correct documented equipment identity']);}
test('revision archives verified snapshot and files; ordinary edits stay locked until authorized opening; reverify locks again',async()=>{
 const db=await database();try{
 await db.exec('set role service_role');
 await assert.rejects(db.exec("update assets set name='forbidden'"),/locked/);
 const {rows}=await open(db);assert.ok(rows[0].id);
 const audit=(await db.query('select * from cmpri_equipment_document_revisions')).rows[0];
 assert.equal(audit.prior_asset.name,'Original');assert.ok(audit.prior_asset.documentation_verified_at);assert.equal(audit.prior_documents[0].metadata.size,0);
 await db.exec("update assets set name='Corrected'");
 await assert.rejects(db.exec("update assets set documentation_revision_id=null"),/verification procedure/);
 const at=(await db.query('select updated_at from assets')).rows[0].updated_at;
 await db.query('select cmpri_verify_asset_documentation($1,$2,$3,$4)',[asset,hotel,at,actor]);
 await assert.rejects(db.exec("update assets set name='forbidden again'"),/locked/);
 const closed=(await db.query('select * from cmpri_equipment_document_revisions')).rows[0];assert.ok(closed.closed_at);assert.equal(closed.verified_asset.name,'Corrected');assert.equal(closed.prior_asset.name,'Original');
 await assert.rejects(db.exec('delete from cmpri_equipment_document_revisions'),/permission denied/);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n,1);
 }finally{await db.close();}
});
test('revision rejects browser RPC access, stale snapshots, ineligible/inactive actors and duplicate requests without mutation',async()=>{
 const db=await database();try{
 assert.equal((await db.query("select has_function_privilege('authenticated','cmpri_begin_equipment_revision(uuid,uuid,timestamp with time zone,uuid,text)','EXECUTE') as allowed")).rows[0].allowed,false);
 await assert.rejects(open(db,actor,'2000-01-01T00:00:00Z'),/changed/);
 for(const change of ["update profiles set role='technician'","update profiles set role='system_admin',active=false","update profiles set active=true;update hotel_members set active=false"]){await db.exec(change);await assert.rejects(open(db),/Active equipment editor/);}
 assert.equal((await db.query('select count(*)::int n from cmpri_equipment_document_revisions')).rows[0].n,0);
 await db.exec('update hotel_members set active=true');await open(db);await assert.rejects(open(db),/changed/);
 assert.equal((await db.query('select count(*)::int n from cmpri_equipment_document_revisions')).rows[0].n,1);
 }finally{await db.close();}
});
function routeFixture({files=[],body={},role='system_admin',verified=false,revision=false}={}){
 const row={id:asset,hotel_id:hotel,documentation_revision_id:revision?'fixture-revision':null,updated_at:'2026-10-13T00:00:00Z',documentation_verified_at:verified?'2026-10-12T00:00:00Z':null};const rpc=[];
 const admin={from(){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:row,error:null})};return q;},storage:{from(){return {list:async()=>({data:files.map((f,i)=>({name:`${i}.pdf`})),error:null}),download:async(path)=>({data:files[Number(path.split('/').pop().split('.')[0])],error:null})}}},rpc:async(name,args)=>{if(name==='cmpri_list_asset_files'){assert.equal(args.p_asset_id,asset);return {data:files.map((f,i)=>({name:`${i}.pdf`,storage_path:`${hotel}/${asset}/${i}.pdf`})),error:null};}rpc.push({name,args});return {data:'fixture-revision',error:null}}};
 const auth={admin,principal:{profile:{role},identity:{id:actor}}};
 const mod=load('../src/app/api/assets/route.ts',{'next/server':{NextResponse:Response},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/asset-install-year':{},'@/lib/server/access':{},'@/lib/server/auth':{requireCapability:async()=>auth},'@/lib/server/roles':{canEditEquipment:r=>r==='system_admin'},'@/lib/equipment-selection':{},'@/lib/manual-pdf-knowledge':pdfModule});
 return {rpc,run:()=>mod.PATCH({json:async()=>({id:asset,verify_with_documentation:true,expected_updated_at:row.updated_at,...body})})};
}
test('verification rejects empty PDFs, non-PDFs, unsaved combined changes and stale versions without RPC',async()=>{
 for(const options of [{files:[new Blob([])]},{files:[new Blob(['not a pdf'])]},{body:{name:'unsaved'},files:[new Blob([])]},{body:{expected_updated_at:'stale'},files:[new Blob([])]},{role:'technician',files:[new Blob([])]}]){const f=routeFixture(options);const response=await f.run();assert.ok(response.status>=400);assert.equal(f.rpc.length,0);}
});
test('verification accepts a saved readable replacement while retaining an old empty artifact',async()=>{
 const f=routeFixture({files:[new Blob([]),new Blob([readFileSync(new URL('../public/guides/dormakaba.pdf',import.meta.url))])]});
 assert.equal((await f.run()).status,200);assert.equal(f.rpc[0].name,'cmpri_verify_asset_documentation');
});

test('normal upload stores the original PDF bytes after real extraction; Retry uses the saved object',async()=>{
 const original=new Uint8Array(readFileSync(new URL('../public/guides/dormakaba.pdf',import.meta.url)));let saved;const registered=new Set();const catalogWrites=[];
 const admin={rpc:async(name,args)=>{assert.equal(args.p_asset_id,asset);if(name==='cmpri_upsert_asset_catalog'){catalogWrites.push(args.p_record);return {error:null};}if(name==='cmpri_register_asset_file'){registered.add(args.p_storage_path);return {error:null};}assert.equal(name,'cmpri_list_asset_files');return {data:[...registered].map(storage_path=>({storage_path,name:storage_path.split('/').pop()})),error:null};},from(){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{id:asset},error:null}),upsert:async()=>({error:null})};return q},storage:{getBucket:async()=>({data:{id:'asset-documentation'},error:null}),from(){return {upload:async(path,bytes)=>{saved={path,bytes:bytes.slice()};return {error:null}},download:async()=>({data:new Blob([saved.bytes]),error:null}),createSignedUrl:async()=>({data:{signedUrl:'https://fixture.invalid/manual.pdf'},error:null})}}}};
 const route=load('../src/app/api/assets/documentation/route.ts',{'next/server':{NextResponse:Response},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/auth':{requireCapability:async()=>({admin,principal:{profile:{role:'system_admin'},identity:{id:actor}}})},'@/lib/server/roles':{canEditEquipment:()=>true},'@/lib/manual-pdf-knowledge':pdfModule,'@/lib/manual-source':sourceModule,'@/lib/manual-document-catalog':{},'@/lib/server/verified-manual-catalog':{}});
 const form=new FormData();form.set('asset_id',asset);form.set('file',new File([original],'fixture.pdf',{type:'application/pdf'}));
 const response=await route.POST({formData:async()=>form});assert.equal(response.status,200);assert.equal((await response.json()).processing_status,'pending_guidance');assert.deepEqual(saved.bytes,original);assert.deepEqual([...registered],[saved.path]);assert.equal(catalogWrites.length,1);assert.equal(catalogWrites[0].storage_path,saved.path);assert.equal(catalogWrites[0].ingestion_status,'complete');
 const retry=new FormData();retry.set('asset_id',asset);retry.set('storage_path',saved.path);
 const second=await route.POST({formData:async()=>retry});assert.equal((await second.json()).processing_status,'pending_guidance');assert.deepEqual(saved.bytes,original);
 saved.bytes=new Uint8Array();const emptyRetry=await route.POST({formData:async()=>retry});assert.equal(emptyRetry.status,422);assert.equal(saved.bytes.byteLength,0);
});

test('saving an open revision requires the current record version',async()=>{
 const f=routeFixture({revision:true,body:{verify_with_documentation:false,expected_updated_at:'stale',name:'Correction'}});
 assert.equal((await f.run()).status,409);assert.equal(f.rpc.length,0);
});

test('an image-only asset PDF is registered and queued for the installed OCR',async()=>{
 const original=new Uint8Array(Buffer.from('%PDF-scanned-fixture'));let saved,queued;const registered=new Set();
 const admin={rpc:async(name,args)=>{if(name==='cmpri_upsert_asset_catalog')return {error:null};if(name==='cmpri_register_asset_file'){registered.add(args.p_storage_path);return {error:null};}if(name==='cmpri_list_asset_files')return {data:[...registered].map(storage_path=>({storage_path,name:'scan.pdf'})),error:null};throw Error(name);},from(){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{id:asset},error:null}),upsert:async()=>({error:null})};return q},storage:{getBucket:async()=>({data:{id:'asset-documentation'},error:null}),from(){return {upload:async(path,bytes)=>{saved={path,bytes:bytes.slice()};return {error:null}},createSignedUrl:async()=>({data:{signedUrl:'https://fixture.invalid/manual.pdf'},error:null})}}}};
 const pdf={...pdfModule,extractManualPdfText:async()=>'',manualPdfSha256:bytes=>createHash('sha256').update(bytes).digest('hex')};
 const route=load('../src/app/api/assets/documentation/route.ts',{'next/server':{NextResponse:Response},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/auth':{requireCapability:async()=>({admin,principal:{profile:{role:'system_admin'},identity:{id:actor}}})},'@/lib/server/roles':{canEditEquipment:()=>true},'@/lib/manual-pdf-knowledge':pdf,'@/lib/manual-source':sourceModule,'@/lib/manual-document-catalog':{},'@/lib/server/verified-manual-catalog':{},'@/lib/server/manual-ocr-queue':{enqueueManualOcr:async(_admin,source)=>{queued=source;assert.ok(registered.has(source.path));}}});
 const form=new FormData();form.set('asset_id',asset);form.set('file',new File([original],'scan.pdf',{type:'application/pdf'}));const response=await route.POST({formData:async()=>form});assert.equal(response.status,200);assert.equal((await response.json()).processing_status,'pending_guidance');assert.equal(queued.assetId,asset);assert.equal(queued.sha256,createHash('sha256').update(original).digest('hex'));assert.deepEqual(saved.bytes,original);
});
