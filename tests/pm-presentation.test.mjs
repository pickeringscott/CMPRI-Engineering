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


const catalog=load('src/lib/pm/catalog.ts');
const {pmFieldGroups,pmRecordSummary}=load('src/lib/pm/presentation.ts');
const page=fs.readFileSync('src/app/engineering/preventive-maintenance/page.tsx','utf8');
const before=fs.readFileSync('../pm-modal-preview/before-eight-page.tsx','utf8');
test('all 55 templates retain each exact field and option once after grouping',()=>{
 assert.equal(catalog.PM_TEMPLATES.length,55);
 for(const template of catalog.PM_TEMPLATES){
  const fields=pmFieldGroups(template.fields).flatMap(g=>g.fields);
  assert.equal(fields.length,template.fields.length,template.id);
  for(const field of template.fields)assert.equal(fields.filter(f=>f===field).length,1,template.id+field.id);
 }
});
test('every repeatable schema exposes populated values without converting failures or zero',()=>{
 for(const template of catalog.PM_TEMPLATES.filter(t=>t.repeatableFields)){
  const row=Object.fromEntries(template.repeatableFields.map(f=>[f.id,f.type==='yes-no'?'No':f.type==='number'?'0':f.id+' saved']));
  const summary=pmRecordSummary(template.repeatableFields,row,0);
  for(const field of template.repeatableFields.filter(f=>f.type!=='textarea'))assert.ok(summary.includes(field.label+': '+row[field.id]),template.id+field.id);
  assert.equal(pmRecordSummary(template.repeatableFields,{},1),'Record 2 — no details entered');
 }
});
test('business logic and repaired exact-record navigation unchanged from pre-batch source',()=>{
 function functions(source){const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const result={};function walk(node){if(ts.isFunctionDeclaration(node)&&node.name)result[node.name.text]=node.getText(ast);ts.forEachChild(node,walk);}walk(ast);return result;}
 const old=functions(before),now=functions(page);
 for(const name of Object.keys(old).filter(n=>!['PreventiveMaintenancePage','inspectionCard'].includes(n))){
  if(old[name].includes('data-pm-mobile'))continue;
  assert.equal(now[name],old[name],name);
 }
 assert.ok(page.includes('openForm(selectedPhoneForm, entry.period_start, entry.scope_key)'));
 assert.ok(page.indexOf('Maintenance notes and follow-up')<page.indexOf('Prior maintenance history'));
 assert.ok(page.includes('label: "Form inspection notes"'));
 assert.equal((page.match(/className="pm-phone-stack/g)||[]).length,2);
});
