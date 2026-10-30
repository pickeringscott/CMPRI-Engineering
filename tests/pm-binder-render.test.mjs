import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),cache=new Map();
function load(file,overrides={}){
 file=path.resolve(file);if(cache.has(file)&&!Object.keys(overrides).length)return cache.get(file);
 const module={exports:{}};const local=name=>{
  if(name in overrides)return overrides[name];
  if(name==='server-only')return {};
  if(name.startsWith('.')||name.startsWith('@/')){
   let target=name.startsWith('@/')?path.resolve('src',name.slice(2)):path.resolve(path.dirname(file),name);
   if(target.endsWith('.json'))return JSON.parse(fs.readFileSync(target,'utf8'));
   if(!path.extname(target))target+=fs.existsSync(target+'.tsx')?'.tsx':'.ts';
   return load(target,overrides);
  }return require(name);
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{module,exports:module.exports,require:local,console,process,Buffer});
 if(!Object.keys(overrides).length)cache.set(file,module.exports);return module.exports;
}

const root=path.resolve('../release-inputs');
const source=JSON.parse(fs.readFileSync(path.join(root,'pm-stored-nonroom-source.json'),'utf8'))[0];
const rooms=JSON.parse(fs.readFileSync(path.join(root,'room-item-evidence-final.json'),'utf8'));
const batch=JSON.parse(fs.readFileSync(path.join(root,'pm-reviewed-answer-batch.json'),'utf8'));
const catalog=load('src/lib/pm/catalog.ts');
const Field=load('src/components/PmFieldInput.tsx').default;
const Controls=load('src/components/PmAnswerControls.tsx').default;
test('all 150 actual binder pages and every imported room answer reconcile without blank or header inference',()=>{
 assert.deepEqual([...source.pages,...rooms.pages].map(p=>p.page).sort((a,b)=>a-b),Array.from({length:150},(_,i)=>i+1));
 const template=catalog.findPmTemplate('pdf:room-pm-checklist');let count=0,follow=0;
 for(const record of batch.rows)for(const [id,answer] of Object.entries(record.answers)){
  const page=rooms.pages.find(p=>p.page===answer.sourcePage);assert.equal(page.room,record.room);
  const quarter=Math.floor((Number(record.periodStart.slice(5,7))-1)/3)+1;
  const evidence=page.quarters.find(q=>q.quarter===quarter);assert.ok(evidence);
  const row=id.replace('room-pm-scan-','').toUpperCase();assert.ok(rooms.item_catalog[row]);
  assert.ok(template.checklist.some(item=>item.id===id));
  assert.ok((answer.value==='complete'?evidence.X:answer.value==='follow-up'?evidence.slash:[]).includes(row),JSON.stringify(answer));
  count++;if(answer.value==='follow-up')follow++;
 }
 assert.equal(count,15800);assert.equal(follow,32);assert.equal(batch.rows.length,183);
 assert.equal(rooms.pages.reduce((n,p)=>n+p.quarters.reduce((m,q)=>m+q.X.length+q.slash.length,0),0),count);
});
test('all six supplemental forms render actual production fields and controls, with No and follow-up selected independently',()=>{
 const forms=JSON.parse(fs.readFileSync('src/lib/pm/supplemental-forms.json','utf8'));assert.equal(forms.length,6);
 for(const form of forms){
  const live=catalog.findPmTemplate(form.id);assert.ok(live,form.id);
  for(const field of [...live.fields,...(live.repeatableFields||[])]){
   const value=field.type==='yes-no'?'No':field.type==='select'?field.options[0]:field.type==='date'?'2026-06-01':field.type==='number'?'3':'Recorded source';
   const dom=new JSDOM(renderToStaticMarkup(React.createElement(Field,{field,value,disabled:false,onChange:()=>{}})));
   assert.ok(dom.window.document.querySelector('label').textContent.includes(field.label));
   assert.equal(dom.window.document.querySelector('input,select,textarea').value,value,form.id+' '+field.id);dom.window.close();
  }
  for(const item of live.checklist){
   const dom=new JSDOM(renderToStaticMarkup(React.createElement(Controls,{label:item.label,value:'follow-up',onChange:()=>{}})));
   const selected=dom.window.document.querySelectorAll('[aria-pressed=true]');assert.equal(selected.length,1);assert.match(selected[0].textContent,/follow-up/i);dom.window.close();
  }
 }
});
test('every imported device condition hydrates the real field renderer, including the four Yes and five No example',()=>{
 const imported=JSON.parse(fs.readFileSync(path.join(root,'pm-actual-entry-batch.json'),'utf8'));
 let count=0,yes=0,no=0;
 for(const entry of imported.entries){
  const template=catalog.findPmTemplate(entry.template_id);
  for(const row of entry.payload.form_data.logEntries||[])for(const field of template.repeatableFields||[]){
   const value=String(row[field.id]??'');
   const dom=new JSDOM(renderToStaticMarkup(React.createElement(Field,{field,value,disabled:true,onChange:()=>{}})));
   assert.equal(dom.window.document.querySelector('input,select,textarea').value,value);dom.window.close();count++;
   if(field.id==='functional'&&row.notes?.startsWith('PM Scan.pdf p13,')&&row.deviceType==='Emergency light'){
    if(value==='Yes')yes++;if(value==='No')no++;
   }
  }
 }
 assert.ok(count>1000);assert.equal(yes,4);assert.equal(no,5);
});

test('historical completion review is bound to exact evidence, preserves failures, and rejects changed or other-scope payloads',()=>{
 const snapshot=JSON.parse(fs.readFileSync('../pm-corporate-review/scoped-snapshot-20261030.json','utf8'));
 const {sourceCompletionReview}=load('src/lib/server/pm-source-completion-review.ts');
 let complete=0,unverified=0;
 for(const p of snapshot.proposals){
  const verdict=sourceCompletionReview(p);if(!verdict)continue;
  if(verdict.inspection_complete)complete++;
  unverified+=verdict.unverified_items.length;
  assert.equal(sourceCompletionReview({...p,scope_key:'different-scope'}),null);
  assert.equal(sourceCompletionReview({...p,payload:{...p.payload,notes:'manual edit'}}),null);
 }
 assert.equal(complete,29);assert.equal(unverified,13);
});

test('pool date heading is a field and wrapped drain-cover instruction remains one preserved answer ID',()=>{
 const pool=catalog.findPmTemplate('pdf:pool');
 assert.ok(pool.fields.some(f=>f.id==='drainCoverExpiration'));
 assert.ok(!pool.checklist.some(i=>['pool-item-1','pool-item-27'].includes(i.id)));
 assert.match(pool.checklist.find(i=>i.id==='pool-item-26').label,/manufacture date on the drain cover/);
});
