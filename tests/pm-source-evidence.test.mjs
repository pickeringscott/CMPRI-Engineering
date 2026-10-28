import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validatePmSource } from '../src/lib/pm/source-evidence.ts';
function catalog(code) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,require:()=>JSON.parse(readFileSync('src/lib/pm/source-catalog.json','utf8'))});
 return JSON.parse(JSON.stringify(exports.PM_TEMPLATES));
}
const baseline=catalog(execFileSync('git',['show','110a1c52:src/lib/pm/catalog.ts'],{encoding:'utf8'}));
const current=catalog(readFileSync('src/lib/pm/catalog.ts','utf8'));
for(const old of baseline){const next=current.find(t=>t.id===old.id);assert.ok(next);for(const item of old.checklist)assert.deepEqual(next.checklist.find(i=>i.id===item.id),item);assert.deepEqual(next.fields,old.fields);assert.deepEqual(next.repeatableFields,old.repeatableFields);}
assert.equal(current.find(t=>t.id==='pdf:kitchen').checklist.length,baseline.find(t=>t.id==='pdf:kitchen').checklist.length+3);
assert.equal(current.find(t=>t.id==='pdf:ice-machine-areas').checklist.length,baseline.find(t=>t.id==='pdf:ice-machine-areas').checklist.length+1);
const db = new PGlite();
const hotel='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002';
await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
await db.exec(readFileSync('supabase/migrations/20261028002857_cmpri_pm_source_evidence.sql','utf8'));
let signedIn=true,reviewer=true,rpcCalls=0;
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('src/app/api/preventive-maintenance/source-evidence/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require(name){
 if(name==='node:crypto')return crypto;
 if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status||200})}};
 if(name==='@/lib/constants')return {HOTEL_ID:hotel};
 if(name==='@/lib/pm/catalog')return {PM_TEMPLATES:[...current,{id:'pdf:lighting'}]};
 if(name==='@/lib/pm/source-evidence')return {validatePmSource};
 if(name==='@/lib/server/roles')return {profileHasRole:()=>reviewer};
 if(name==='@/lib/server/auth')return {requireUser:async()=>signedIn?{principal:{identity:{id:actor},profile:{full_name:'Reviewer'}},admin:{rpc:async(name,p)=>{rpcCalls++;try{return {data:(await db.query('select cmpri_import_pm_source_evidence($1,$2,$3,$4,$5,$6,$7) result',[p.p_hotel,p.p_actor,p.p_actor_name,p.p_input,p.p_digest,p.p_apply,p.p_expected])).rows[0].result,error:null};}catch(e){return {error:{message:e.message,code:e.code}};}}}}:null};
 throw new Error(name);
}});
const row={page:1,templateId:'pdf:lighting',category:'Emergency lighting',location:'4th floor',frequency:'monthly',kind:'observations',rawDate:'06/26',observedOn:null,evidence:'YES circled. Notes say none work when test button pushed.',findings:['Contradictory YES and failure note; no repair recorded.'],unresolved:['Exact date unknown.']};
const input={sourceId:'test-scan',sourceName:'Test scan',pageCount:2,pages:[row,{...row,page:2,kind:'blank-template',rawDate:'',evidence:'Blank template',findings:[],unresolved:[]}]};
const call=(input,action='preview',previewDigest)=>exports.POST({text:async()=>JSON.stringify({input,action,previewDigest})});
signedIn=false;assert.equal((await call(input)).status,401);signedIn=true;reviewer=false;assert.equal((await call(input)).status,403);assert.equal(rpcCalls,0);reviewer=true;
for(const invalid of [{...input,pages:[row]},{...input,pages:[row,row]},{...input,pages:[{...row,observedOn:'2026-02-30'},input.pages[1]]},{...input,pages:[{...row,completedOn:'2026-06-26'},input.pages[1]]},{...input,pages:[{...row,templateId:'unknown'},input.pages[1]]}])assert.equal((await call(invalid)).status,400);
await db.exec('set role service_role');
const preview=await call(input);assert.equal(preview.status,200);assert.equal(preview.body.action,'insert');
assert.equal((await db.query('select count(*)::int n from cmpri_pm_source_evidence')).rows[0].n,0);
assert.equal((await call(input,'apply','0'.repeat(32))).status,409);
const applied=await call(input,'apply',preview.body.previewDigest);assert.equal(applied.body.inserted,2);
const retry=await call(input,'apply',preview.body.previewDigest);assert.equal(retry.body.inserted,0);assert.equal(retry.body.skipped,2);
const saved=(await db.query('select * from cmpri_pm_source_evidence')).rows[0];assert.deepEqual(saved.pages,input.pages);assert.equal(saved.confirmed_by,actor);
const changed={...input,pages:[{...row,evidence:'different'},input.pages[1]]};assert.equal((await call(changed)).body.action,'conflict');assert.equal((await call(changed,'apply',preview.body.previewDigest)).status,409);
assert.deepEqual((await db.query('select pages from cmpri_pm_source_evidence')).rows[0].pages,input.pages);
await db.exec('reset role;set role authenticated');await assert.rejects(db.query('select * from cmpri_pm_source_evidence'),/permission denied/);
await assert.rejects(db.query('select cmpri_import_pm_source_evidence($1,$2,$3,$4,$5,$6,$7)',[hotel,actor,'Reviewer',input,'a'.repeat(64),false,null]),/permission denied/);
if(process.env.CMPRI_PM_SOURCE_FIXTURE){
 await db.exec('reset role;set role service_role');
 const real=JSON.parse(readFileSync(process.env.CMPRI_PM_SOURCE_FIXTURE,'utf8').replace(/^\uFEFF/,''));
 const preview=await call(real);assert.equal(preview.status,200);
 const imported=await call(real,'apply',preview.body.previewDigest);assert.equal(imported.status,200);assert.equal(imported.body.inserted,real.pageCount);
 const stored=(await db.query('select pages from cmpri_pm_source_evidence where source_id=$1',[real.sourceId])).rows[0].pages;
 assert.deepEqual(stored,validatePmSource(real,current.map(t=>t.id)).pages);
 console.log('PASS full reconciled source fixture: '+stored.length+' pages round-tripped through actual API and PostgreSQL without evidence changes.');
}
await db.close();console.log('PASS source coverage: authenticated route + real PostgreSQL; blank templates, raw ambiguous dates, contradictions retained; no inferred completions; full coverage validation, preview, stale rejection, idempotence, conflicts, role restrictions.');
