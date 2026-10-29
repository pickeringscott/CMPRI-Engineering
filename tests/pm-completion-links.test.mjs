import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url);
function load(file,overrides={}){
 const exports={};file=path.resolve(file);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,require(name){
  if(name in overrides)return overrides[name];
  if(name.startsWith('.')||name.startsWith('@/')){let target=name.startsWith('@/')?path.resolve('src',name.slice(2)):path.resolve(path.dirname(file),name);if(target.endsWith('.json'))return JSON.parse(fs.readFileSync(target,'utf8'));if(!path.extname(target))target+=fs.existsSync(target+'.tsx')?'.tsx':'.ts';return load(target,overrides);}
  return require(name);
 },console,process,Buffer});return exports;
}

const base=path.resolve('../release-inputs');
const old=JSON.parse(fs.readFileSync(path.join(base,'pm-before-completion-batch.json'),'utf8'));
const plan=JSON.parse(fs.readFileSync(path.join(base,'pm-completion-links.json'),'utf8'));
const sql=fs.readFileSync(path.join(base,'pm-completion-links.sql'),'utf8');
const {pmRoutineChecked}=load('src/lib/pm/routine-responses.ts');
const catalog=load('src/lib/pm/catalog.ts');
test('completion transaction -> actual API -> monthly checkbox selector and counter, with replay and manual-edit protection',async()=>{
 const db=new PGlite();try{
 await db.exec(`create table cmpri_pm_proposals(id uuid primary key,hotel_id uuid,template_id text,period_start date,scope_key text,payload jsonb,proposed_cells jsonb,status text,submitted_by uuid,submitted_by_name text,reviewed_by uuid,reviewed_at timestamptz,review_note text,revision bigint default 1,updated_at timestamptz default now(),created_at timestamptz default now());`);
 for(const r of old.entries)await db.query('insert into cmpri_pm_proposals(id,hotel_id,template_id,period_start,scope_key,payload,status) values($1,$2,$3,$4,$5,$6,$7)',[r.id,'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',r.template_id,r.period_start,r.scope_key,JSON.stringify(r.payload),'approved']);
 await db.exec(sql);await db.exec(sql);
 const stored=(await db.query("select *,to_char(period_start,'YYYY-MM-DD') p from cmpri_pm_proposals")).rows.map(r=>({...r,period_start:r.p}));
 assert.equal(stored.length,61);
 await db.exec('create table cmpri_pm_source_evidence(hotel_id uuid,source_id text,pages jsonb)');
 await db.query('insert into cmpri_pm_source_evidence values($1,$2,$3)',['c81ad01a-7a9f-4880-ac1c-5e849f30bad6',old.source_id,JSON.stringify(old.expected_pages)]);
 await db.exec(fs.readFileSync(path.join(base,'pm-actual-entry-batch.sql'),'utf8'));
 assert.equal((await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,61);
 for(const before of old.entries){const after=stored.find(r=>r.id===before.id);assert.deepEqual(after.payload,{...before.payload,is_complete:plan.inspections.some(r=>r.id===before.id)});}
 const admin={from(table){let low,high;const chain={select:()=>chain,eq:()=>chain,gte:(_k,v)=>(low=v,chain),lte:(_k,v)=>(high=v,chain),order:()=>chain,limit:async()=>({data:table==='cmpri_pm_proposals'?stored.filter(r=>r.period_start>=low&&r.period_start<=high):[]})};return chain;}};
 const route=load('src/app/api/preventive-maintenance/route.ts',{'@/lib/server/auth':{requireUser:async()=>({admin,principal:{identity:{id:'actor'},profile:{role:'engineer'}}})},'@/lib/server/access':{allows:()=>true},'@/lib/server/roles':{profileHasRole:()=>false},'@/lib/constants':{HOTEL_ID:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}});
 const result=await(await route.GET({nextUrl:new URL('https://local.invalid/api/preventive-maintenance?week=2026-10-26')})).json();
 const counts={};
 for(const expected of plan.workbooks){const e=result.entries.find(r=>r.id===expected.id);const template=catalog.findPmTemplate(e.template_id);const selected=template.checklist.filter(i=>pmRoutineChecked(e,i.id,result.spreadsheet_sync_enabled,false));counts[e.period_start]=selected.length;assert.deepEqual(selected.map(i=>i.id).sort(),Object.keys(expected.payload.responses).sort());assert.equal(e.is_complete,false);}
 assert.deepEqual(counts,{'2026-01-01':5,'2026-02-01':7,'2026-03-01':4,'2026-04-01':5,'2026-05-01':4,'2026-06-01':5,'2026-07-01':5,'2026-08-01':6,'2026-09-01':6});
 const june=result.entries.find(r=>r.template_id==='workbook:monthly:june');assert.equal(pmRoutineChecked(june,'june-10',false,false),true);assert.equal(catalog.findPmTemplate(june.template_id).checklist.length,25);assert.equal(pmRoutineChecked(june,'june-9',false,false),false);
 assert.equal(pmRoutineChecked({...june,status:'pending',responses:{'june-10':false}},'june-10',false,true),false);
 assert.equal(pmRoutineChecked({...june,responses:{'june-10':false}},'june-10',false,true),false);
 const lights=result.entries.find(r=>r.template_id==='pdf:emergency-lighting-exit-sign-log-master'&&r.period_start==='2026-06-01');const rows=lights.form_data.logEntries.filter(r=>r.notes.startsWith('PM Scan.pdf p13,')&&r.deviceType==='Emergency light');assert.equal(rows.filter(r=>r.functional==='Yes').length,4);assert.equal(rows.filter(r=>r.functional==='No').length,5);
 const page=fs.readFileSync('src/app/engineering/preventive-maintenance/page.tsx','utf8');assert.match(page,/return pmRoutineChecked\(proposal, itemId/);assert.match(page,/const checked = routineStatus\(template, period, item.id\)/);assert.match(page,/template.checklist.filter\(\(item\) => routineStatus\(template, period, item.id\)\).length/);
 await db.query("update cmpri_pm_proposals set payload=jsonb_set(payload,'{responses,june-10}','false') where id=$1",[june.id]);await assert.rejects(db.exec(sql),/Workbook (edited|identity changed)/);await db.exec('rollback');assert.equal((await db.query("select payload->'responses'->'june-10' v from cmpri_pm_proposals where id=$1",[june.id])).rows[0].v,false);
 }finally{await db.close();}
});
