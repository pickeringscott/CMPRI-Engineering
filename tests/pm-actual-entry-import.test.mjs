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
const batchPath=process.env.CMPRI_PM_ENTRY_BATCH;assert.ok(batchPath,'Prepared reviewed batch required');
const batch=JSON.parse(fs.readFileSync(batchPath,'utf8'));
const sql=fs.readFileSync(batchPath.replace(/\.json$/,'.sql'),'utf8');
const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
const catalog=load('src/lib/pm/catalog.ts');
const {pmEntryForm}=load('src/lib/pm/entry-form.ts');
const Controls=load('src/components/PmAnswerControls.tsx').default;
test('actual SQL batch -> actual API entries -> actual form hydration/control selection, plus atomic conflicts',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create table cmpri_pm_source_evidence(hotel_id uuid,source_id text,pages jsonb);
 create table cmpri_pm_proposals(id uuid primary key,hotel_id uuid,template_id text,period_start date,scope_key text,payload jsonb,proposed_cells jsonb,status text,submitted_by uuid,submitted_by_name text,reviewed_by uuid,reviewed_at timestamptz,review_note text,revision bigint default 1,updated_at timestamptz default now(),created_at timestamptz default now());`);
 await db.query('insert into cmpri_pm_source_evidence values($1,$2,$3)',[hotel,batch.source_id,JSON.stringify(batch.expected_pages)]);
 for(const row of batch.entries){
  const template=catalog.findPmTemplate(row.template_id);assert.ok(template);assert.ok(catalog.validPmPeriod(template,row.period_start));
  for(const id of Object.keys(row.payload.responses))assert.ok(template.checklist.some(i=>i.id===id),id);
  assert.equal(row.payload.completed_on,null);assert.equal(row.payload.is_complete,false);
 }
 await db.exec(sql);assert.equal((await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,52);
 await db.exec(sql);assert.equal((await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,52);
 const stored=(await db.query("select *, to_char(period_start,'YYYY-MM-DD') source_period from cmpri_pm_proposals order by period_start")).rows.map(row=>({...row,period_start:row.source_period}));
 const admin={from(table){let low,high;const chain={select:()=>chain,eq:()=>chain,gte:(_k,v)=>(low=v,chain),lte:(_k,v)=>(high=v,chain),order:()=>chain,limit:async()=>({data:table==='cmpri_pm_proposals'?stored.filter(r=>r.period_start>=low&&r.period_start<=high):[]})};return chain;}};
 const route=load('src/app/api/preventive-maintenance/route.ts',{'@/lib/server/auth':{requireUser:async()=>({admin,principal:{identity:{id:'actor'},profile:{role:'engineer'}}})},'@/lib/server/access':{allows:()=>true},'@/lib/server/roles':{profileHasRole:()=>false},'@/lib/constants':{HOTEL_ID:hotel}});
 const response=await route.GET({nextUrl:new URL('https://local.invalid/api/preventive-maintenance?week=2026-10-26')});assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.entries.length,52);
 let selected=0,logs=0;
 for(const entry of result.entries){
  const form=pmEntryForm(entry);selected+=Object.keys(form.checklist).length;logs+=form.logEntries?.length||0;
  assert.equal(form.completedOn,'');
  for(const [id,value] of Object.entries(form.checklist)){
   const dom=new JSDOM(renderToStaticMarkup(React.createElement(Controls,{label:id,value,onChange:()=>{}})));
   assert.equal(dom.window.document.querySelectorAll('[aria-pressed="true"]').length,1);dom.window.close();
  }
 }
 assert.equal(selected,398);assert.equal(logs,181);
 // Confirm semantic crosswalks, not merely that target IDs exist.
 const pool=result.entries.filter(r=>r.template_id==='pdf:pool');
 assert.equal(pool.length,3);
 for(const r of pool){assert.equal(r.responses['pool-item-24'],'na');assert.equal(r.form_data.location,'Property Wide');}
 const kitchen=result.entries.filter(r=>r.template_id==='pdf:kitchen');
 for(const r of kitchen){assert.equal(r.responses['kitchen-scan-walk-in-cooler'],'na');if(r.period_start==='2026-03-01')assert.equal(r.responses['kitchen-item-8'],'complete');}
 const extinguisher=result.entries.find(r=>r.template_id==='pdf:monthly-fire-extinguisher-log'&&r.period_start==='2026-02-01');
 assert.ok(extinguisher);assert.ok(extinguisher.form_data.logEntries.every(r=>r.date===''));
 assert.deepEqual(Object.keys(batch.deferred_pages),[]);
 assert.ok(batch.expected_pages.some(p=>p.page===19));
 assert.ok(batch.entries.some(r=>r.period_start==='2026-06-01'&&r.payload.historical_source_import.pages.includes(19)));
 assert.ok(!result.entries.some(r=>r.template_id==='pdf:business-center'&&'business-center-item-11' in r.responses));
 const front=result.entries.find(r=>r.template_id==='pdf:front-office-desk');
 const changed={...front,responses:{...front.responses,'front-office-desk-item-4':'follow-up'}};
 assert.equal(pmEntryForm(changed).checklist['front-office-desk-item-4'],'follow-up');
 await db.query("update cmpri_pm_proposals set payload=jsonb_set(payload,'{notes}',to_jsonb('user-edited'::text)) where id=$1",[front.id]);
 await assert.rejects(db.exec(sql),/conflict|overwritten/);await db.exec('rollback');
 assert.equal((await db.query('select payload->>\'notes\' note from cmpri_pm_proposals where id=$1',[front.id])).rows[0].note,'user-edited');
 assert.equal((await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,52);
 }finally{await db.close();}
});
test('historical completion selects a neutral actual control without inventing or persisting condition',()=>{
 const form=pmEntryForm(undefined,{item_answers:{}});assert.deepEqual(Object.keys(form.checklist),[]);
 const dom=new JSDOM(renderToStaticMarkup(React.createElement(Controls,{label:'Unknown room condition',value:'',historicalCompleted:true,onChange:()=>{}})));
 const selected=dom.window.document.querySelectorAll('[aria-pressed="true"]');assert.equal(selected.length,1);assert.match(selected[0].textContent,/condition unrecorded/);assert.equal(selected[0].disabled,true);
 assert.equal([...dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='✓ OK').getAttribute('aria-pressed'),'false');dom.window.close();
});
