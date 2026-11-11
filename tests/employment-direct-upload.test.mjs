import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createHash,createHmac} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {cleanupExpiredEmploymentUploads} from '../src/lib/server/employment-resume-cleanup.ts';
import {validateEmployment} from '../src/lib/employment-validation.mjs';
const answers={department:'maintenance',name:'Local test',email:'fixture@example.invalid',phone:'',history:'Training',example:'Assisted',workingDays:['Mon'],skills:{hvac:'Assisted',plumbing:'Not done',electrical:'Not done',appliances:'Not done'},interview:{Tue:['AM']}};
const id='00000000-0000-4000-8000-000000000001',cap='a'.repeat(64),sha='b'.repeat(64);
const migration=readFileSync('supabase/migrations/20261111191352_employment_direct_resume_upload.sql','utf8');
async function database(){const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');await db.exec(readFileSync('scripts/employment-schema.sql','utf8'));await db.exec(readFileSync('tests/fixtures/employment-private-resume.sql','utf8'));await db.exec(migration);await db.exec('set role service_role');return db;}
const prepare=(db,i=id,email=answers.email,size=104857600,c=cap)=>db.query('select prepare_employment_resume_upload($1,$2,$3,$4,$5,$6,$7) result',[i,JSON.stringify({...answers,email}),'resume.pdf',size,sha,c,'c'.repeat(64)]);
test('100 MiB admission, immutable capability, idempotent atomic finalization and legacy PDFs',async()=>{const db=await database();try{
 assert.equal((await prepare(db)).rows[0].result,'pending');await prepare(db);
 await assert.rejects(prepare(db,id,answers.email,104857600,'d'.repeat(64)),/identity conflict/);
 await assert.rejects(db.query('select finalize_employment_resume_upload($1,$2)',[id,'d'.repeat(64)]),/capability/);
 await db.query('select finalize_employment_resume_upload($1,$2)',[id,cap]);await db.query('select finalize_employment_resume_upload($1,$2)',[id,cap]);
 assert.equal((await prepare(db)).rows[0].result,'complete');
 const row=(await db.query('select * from employment_resumes')).rows[0];assert.equal(row.storage_path,`${id}/${sha}.pdf`);assert.equal(row.original_pdf,null);assert.equal(Number(row.file_size),104857600);
 const legacy='00000000-0000-4000-8000-000000000099';await db.query('select submit_employment_with_resume($1,$2,$3,$4)',[legacy,JSON.stringify({...answers,email:'legacy@example.invalid'}),'legacy.pdf',Buffer.from('%PDF-legacy')]);
 assert.equal((await db.query('select count(*)::int n from employment_resumes')).rows[0].n,2);
 for(const role of ['anon','authenticated']){await db.exec('reset role;set role '+role);await assert.rejects(prepare(db),/permission denied/);await assert.rejects(db.query('select * from employment_resume_uploads'),/permission denied/);await assert.rejects(db.query('select finalize_employment_resume_upload($1,$2)',[id,cap]),/permission denied/);}
}finally{await db.close();}});
test('oversize, expiry and pre-upload quota fail before applications are stored',async()=>{const db=await database();try{
 await assert.rejects(prepare(db,id,answers.email,104857601),/check constraint/);
 for(let i=1;i<=3;i++)await prepare(db,`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
 await assert.rejects(prepare(db,'00000000-0000-4000-8000-000000000004'),/admission limit/);
 await db.query("update employment_resume_uploads set expires_at=now()-interval '1 second' where id=$1",[id]);
 await assert.rejects(db.query('select finalize_employment_resume_upload($1,$2)',[id,cap]),/expired/);
 assert.equal((await db.query('select count(*)::int n from employment_applications')).rows[0].n,0);
}finally{await db.close();}});
function handler(admin,env={NODE_ENV:'test',SUPABASE_SERVICE_ROLE_KEY:'fixture-not-a-real-secret'}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync('src/app/api/employment/uploads/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Response,Request,File,Buffer,URL,Date,Uint8Array,process:{env},require(name){if(name==='next/server')return {NextResponse:Response};if(name==='node:crypto')return {createHash,createHmac};if(name==='@/lib/server/supabase-admin')return {createSupabaseAdmin:()=>admin};if(name==='@/lib/employment-validation.mjs')return {validateEmployment};if(name==='@/lib/server/employment-resume-cleanup')return {cleanupExpiredEmploymentUploads};throw Error(name);}});return exports.PUT;}
const request=body=>new Request('https://example.invalid/api/employment/uploads',{method:'PUT',headers:{origin:'https://example.invalid',host:'example.invalid'},body:JSON.stringify(body)});
const descriptor={action:'prepare',id,answers,name:'resume.pdf',size:104857600,sha256:sha,capability:cap};
test('100 MiB prepare uses bounded handshake and private write-once object; oversize denied',async()=>{let calls=0;const admin={rpc:async(name,args)=>{calls++;assert.equal(name,'prepare_employment_resume_upload');assert.notEqual(args.p_capability_hash,cap);assert.equal(args.p_size,104857600);return {data:'pending'};},storage:{getBucket:async()=>({data:{public:false,file_size_limit:104857600}}),from:()=>({createSignedUploadUrl:async(path,options)=>{assert.equal(path,`${id}/${sha}.pdf`);assert.equal(options.upsert,false);return {data:{signedUrl:'https://storage.invalid/write-only'}};}})}};
 const put=handler(admin);assert.equal((await put(request(descriptor))).status,200);assert.equal(calls,1);
 assert.equal((await put(request({...descriptor,size:104857601}))).status,400);assert.equal(calls,1);
 assert.equal((await put(request({...descriptor,answers:{...answers,name:'x'.repeat(20000)}}))).status,413);
 assert.equal((await handler(admin,{NODE_ENV:'production',VERCEL:'1',SUPABASE_SERVICE_ROLE_KEY:'test'})(request(descriptor))).status,503);
});
test('finalize verifies capability before storage access, and hash before database mutation',async()=>{let download=0,finalized=0;const bytes=Buffer.from('%PDF-test');const digest=createHash('sha256').update(bytes).digest('hex');let item=null;
 const admin={rpc:async()=>{finalized++;return {data:id};},from:()=>{const query={select(){return query;},eq(){return query;},maybeSingle:async()=>({data:item})};return query;},storage:{from:()=>({info:async()=>({data:{size:bytes.length,contentType:'application/pdf'}}),download:async()=>{download++;return {data:new Blob([bytes])};}})}};
 const put=handler(admin),body={...descriptor,action:'finalize',size:bytes.length,sha256:digest};
 assert.equal((await put(request(body))).status,403);assert.equal(download,0);
 item={answers:Object.fromEntries(Object.entries(answers).reverse()),file_name:'resume.pdf',file_size:bytes.length,sha256:digest,expires_at:new Date(Date.now()+100000).toISOString(),completed_at:null};
 assert.equal((await put(request(body))).status,201);assert.equal(finalized,1);
 item.sha256=sha;assert.equal((await put(request({...body,sha256:sha}))).status,400);assert.equal(finalized,1);
});
test('pending count is bounded across hours and nullable storage metadata is rejected',async()=>{const db=await database();try{
 await db.query(`insert into employment_resume_uploads(id,answers,file_name,file_size,sha256,capability_hash,ip_hash,created_at,expires_at)
 select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1,'resume.pdf',5,$2,$3,$4,now()-interval '1 day',now()-interval '22 hours' from generate_series(1,100) n`,[JSON.stringify(answers),sha,cap,'c'.repeat(64)]);
 await assert.rejects(prepare(db,'00000000-0000-4000-8000-000000000101','fresh@example.invalid'),/admission limit/);
 await db.query('select submit_employment_with_resume($1,$2,null,null)',[id,JSON.stringify(answers)]);
 await assert.rejects(db.query('insert into employment_resumes(application_id,file_name,storage_path) values($1,$2,$3)',[id,'resume.pdf',id+'/missing.pdf']),/check constraint/);
}finally{await db.close();}});
test('private resume cleanup preserves completed applications and retries failed deletes',async()=>{
 let removed=0,deleted=0,cutoff;const row={id,sha256:sha};
 const admin={from(){const query={select(){return query;},is(key,value){assert.equal(key,'completed_at');assert.equal(value,null);return query;},lt(key,value){assert.equal(key,'expires_at');cutoff=value;return query;},order(){return query;},limit:async()=>({data:[row]}),delete(){deleted++;return query;},eq(){return query;},then(resolve){resolve({error:null});}};return query;},storage:{from(bucket){assert.equal(bucket,'employment-resumes');return {remove:async paths=>{removed++;assert.deepEqual(Array.from(paths),[id+'/'+sha+'.pdf']);return {error:null};}};}}};
 assert.equal(await cleanupExpiredEmploymentUploads(admin),1);assert.equal(removed,1);assert.equal(deleted,1);assert.ok(Date.parse(cutoff)<=Date.now()-3*60*60*1000);
 admin.storage.from=()=>({remove:async()=>({error:{message:'transient'}})});assert.equal(await cleanupExpiredEmploymentUploads(admin),0);assert.equal(deleted,1);
 assert.equal(await cleanupExpiredEmploymentUploads({from(){throw Error('unavailable');}}),0);
});
test('origin, admission and private-bucket failures never mint upload capabilities',async()=>{
 let signed=0,calls=0;let admissionError=null;let bucketPublic=true;
 const admin={rpc:async()=>{calls++;return {data:'pending',error:admissionError};},storage:{getBucket:async()=>({data:{public:bucketPublic,file_size_limit:104857600}}),from:()=>({createSignedUploadUrl:async()=>{signed++;return {data:{signedUrl:'https://storage.invalid'}};}})}};
 const put=handler(admin);const foreign=new Request('https://example.invalid',{method:'PUT',headers:{origin:'https://attacker.invalid',host:'example.invalid'},body:JSON.stringify(descriptor)});
 assert.equal((await put(foreign)).status,403);assert.equal(calls,0);
 assert.equal((await put(request(descriptor))).status,503);assert.equal(signed,0);
 bucketPublic=false;admissionError={code:'P0001'};assert.equal((await put(request(descriptor))).status,429);assert.equal(signed,0);
});
test('expired admissions and mismatched Storage metadata do not download or finalize',async()=>{
 let downloads=0,finalizes=0;const item={answers,file_name:'resume.pdf',file_size:104857600,sha256:sha,expires_at:new Date(Date.now()-1000).toISOString(),completed_at:null};
 const admin={rpc:async()=>{finalizes++;return {data:id};},from:()=>{const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:item})};return q;},storage:{from:()=>({info:async()=>({data:{size:5,contentType:'application/pdf'}}),download:async()=>{downloads++;return {data:new Blob(['%PDF-'])};}})}};
 const put=handler(admin);assert.equal((await put(request({...descriptor,action:'finalize'}))).status,410);
 item.expires_at=new Date(Date.now()+100000).toISOString();assert.equal((await put(request({...descriptor,action:'finalize'}))).status,400);assert.equal(downloads,0);assert.equal(finalizes,0);
});
test('employment HTML scripts remain valid and route attached files directly to Storage',()=>{
 const source=readFileSync('src/app/employment/document.ts','utf8');const html=JSON.parse(source.slice(source.indexOf('=')+1).trim().replace(/;$/,''));
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){if(match[0].startsWith('<script type="application/json"'))continue;new vm.Script(match[1]);}
 assert.match(html,/candidate\.size>100\*1024\*1024/);assert.match(html,/fetch\('\/api\/employment\/uploads'/);assert.match(html,/credentials:'omit',referrerPolicy:'no-referrer'/);assert.match(html,/const selectedFile=file/);
});
