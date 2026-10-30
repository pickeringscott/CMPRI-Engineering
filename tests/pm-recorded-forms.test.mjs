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
const fixturePath=process.env.CMPRI_PM_SOURCE_FIXTURE;
assert.ok(fixturePath,'The reviewed complete binder fixture is required, not a synthetic replacement.');
const rawFixture=JSON.parse(fs.readFileSync(fixturePath,'utf8').replace(/^\uFEFF/,''));
const sourceFixture=Array.isArray(rawFixture)?{sourceId:rawFixture[0].source_id,sourceName:'PM Scan.pdf nonroom pages 1-42',pageCount:42,pages:rawFixture[0].pages}:rawFixture;
const fixture=load('src/lib/pm/source-evidence.ts').validatePmSource(sourceFixture,[...new Set(sourceFixture.pages.map(p=>p.templateId).filter(Boolean))]);
const {projectRecordedPmForms}=load('src/lib/server/pm-recorded-forms.ts');
const projection=projectRecordedPmForms(fixture.sourceId,fixture.pages);
test('verified nonroom binder segment projects all30 marked nonroom pages, preserves source and detects conflicts',()=>{
 assert.equal(projection.length,sourceFixture.pageCount);
 assert.equal(projection.filter(p=>p.recordedForms?.length).length,30);
 assert.equal(projection.filter(p=>p.recordedFormsConflict).length,0);
 const forms=projection.flatMap(p=>p.recordedForms||[]);
 assert.equal(forms.length,80);
 assert.equal(forms.flatMap(f=>f.rows).filter(r=>r.value).length,570);
 assert.equal(forms.flatMap(f=>f.rows).filter(r=>r.value==='follow-up').length,2);
 assert.equal(forms.flatMap(f=>f.rows).filter(r=>r.value==='na').length,2);
 assert.equal(projectRecordedPmForms('different-source',fixture.pages),fixture.pages);
 const changed=structuredClone(fixture.pages);changed[22].evidence+=' amended';
 assert.equal(projectRecordedPmForms(fixture.sourceId,changed)[22].recordedFormsConflict,true);
 assert.equal(projectRecordedPmForms(fixture.sourceId,changed)[22].recordedForms,undefined);
 for(let i=0;i<sourceFixture.pageCount;i++)for(const key of Object.keys(fixture.pages[i]))assert.deepEqual(projection[i][key],fixture.pages[i][key]);
});
test('specific adverse and ambiguous findings remain attached to selected actual controls',()=>{
 const p=n=>projection[n-1].recordedForms;
 assert.equal(p(23)[0].rows[5].value,'follow-up');
 assert.equal(p(37)[0].rows[1].value,'follow-up');
 assert.equal(p(14)[0].rows[0].value,'');
 assert.match(p(14)[0].rows[0].notes,/None of the lights/);
 assert.equal(p(18)[0].rows[1].value,'YES');assert.match(p(18)[0].rows[1].notes,/does not close/);
 assert.equal(p(29)[0].rows[2].rawDate,'2026-09-16');assert.match(p(29)[0].rows[2].notes,/No handle/);
 assert.equal(p(20)[0].rows[1].rawDate,'');
 assert.equal(p(28)[0].rows[18].rawDate,'');
 assert.equal(p(36)[0].rows[1].value,'');
 assert.equal(p(24)[4].rows[0].value,'na');assert.match(p(24)[4].period,/unspecified/);
 assert.ok(p(42)[3].rows.every(r=>r.value===''));
});
test('rendered source controls really select their answers and cannot overwrite current entries',()=>{
 const Forms=load('src/components/PmRecordedForms.tsx').default;
 const dom=new JSDOM(renderToStaticMarkup(React.createElement(Forms,{page:23,forms:projection[22].recordedForms})));
 const pressed=[...dom.window.document.querySelectorAll('button[aria-pressed="true"]')];
 assert.equal(pressed.length,22);assert.equal(pressed.filter(b=>b.textContent.includes('Follow-up')).length,1);
 assert.ok([...dom.window.document.querySelectorAll('button')].every(b=>b.disabled));
 assert.equal(dom.window.document.querySelectorAll('input[type=date]').length,0);
 dom.window.close();
});
test('actual source API retains authentication and returns projections without writing data',async()=>{
 let signedIn=false,writes=0;
 const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:async()=>({data:[{source_id:fixture.sourceId,pages:fixture.pages}]})};
 const route=load('src/app/api/preventive-maintenance/source-evidence/route.ts',{
  '@/lib/server/auth':{requireUser:async()=>signedIn?{admin:{from:()=>chain,rpc:()=>{writes++;throw Error('Unexpected write');}}}:null},
  '@/lib/server/pm-recorded-forms':{projectRecordedPmForms},
  '@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/pm/catalog':{PM_TEMPLATES:[]},
 });
 assert.equal((await route.GET({})).status,401);signedIn=true;
 const response=await route.GET({});assert.equal(response.status,200);
 assert.equal((await response.json()).sources[0].pages.filter(p=>p.recordedForms?.length).length,30);
 assert.equal(writes,0);
});
