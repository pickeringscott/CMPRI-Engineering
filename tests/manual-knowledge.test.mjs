import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { manualMatchesEquipment } from '../src/lib/manual-document-match.ts';

// Execute the shared manual normalizer used by the ticket page.
const source=readFileSync(new URL('../src/lib/manual-knowledge.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('manual-knowledge.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const names=new Set(['objectRecord','pageNumbers','stringList','normalizeManualKnowledge']);
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(ast)).join('\n');
assert.equal(ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).length,4);
const exports={};
vm.runInNewContext(ts.transpileModule(functions+'\nexports.normalize=normalizeManualKnowledge;',{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText,{exports});
const normalize=exports.normalize;

for(const input of [null,undefined,[],42,'manual'])test(`rejects non-record manual: ${String(input)}`,()=>assert.equal(normalize(input),null));
for(const verified of [undefined,false,'false','true',1])test(`does not invent verification from ${String(verified)}`,()=>{
  assert.equal(normalize({source:{verified}}).source.verified,false);
});
test('retains explicit verification and legacy code field names',()=>{
  const result=normalize({document:{verified:true,title:'Test manual'},diagnostic_codes:[{id:'3',meaning:'Test fault',solution:'Test action',pages:[2,0,-1,1.5,'4','invalid']}]});
  assert.equal(result.source.verified,true);assert.equal(result.source.title,'Test manual');
  assert.equal(JSON.stringify(result.error_codes),JSON.stringify([{code:'3',problem:'Test fault',action:'Test action',source_pages:[2,4]}]));
});
test('manufacturer documentation requires an exact manufacturer and model-family match',()=>{
  const asset={manufacturer:'Friedrich',model_family:'Verdepac VTAC'};
  assert.equal(manualMatchesEquipment(asset,{manufacturer:'Friedrich',model_family:'Verdepac VTAC'}),true);
  assert.equal(manualMatchesEquipment(asset,{manufacturer:'Friedrich',model_family:'Vert-I-Pak'}),false);
  assert.equal(manualMatchesEquipment(asset,{manufacturer:'Freedom',model_family:'Verdepac VTAC'}),false);
  assert.equal(manualMatchesEquipment(asset,{manufacturer:'Friedrich',equipment:'Verdepac VTAC'}),true);
  assert.equal(manualMatchesEquipment(asset,{manufacturer:'Friedrich',equipment:'Friedrich Verdepac VTAC'}),false);
  assert.equal(manualMatchesEquipment({manufacturer:'Friedrich',model_family:null},{manufacturer:'Friedrich',model_family:'Verdepac VTAC'}),false);
  assert.equal(manualMatchesEquipment(asset,{source:{manufacturer:' Friedrich ',model_family:'  Verdepac   VTAC '}}),true);
  assert.equal(manualMatchesEquipment(asset,{document:{manufacturer:'Friedrich',model_family:'Verdepac VTAC'}}),true);
  assert.equal(manualMatchesEquipment({manufacturer:'Friedrich',model_number:'VPAK-A'}, {manufacturer:'Friedrich',model_number:'VPAK-A'}),true);
  assert.equal(manualMatchesEquipment({manufacturer:'Friedrich',model_number:'VPAK-A'}, {manufacturer:'Friedrich',model_number:'VPAK-B'}),false);
});

test('verified PDFs must contain the exact manufacturer and family or model identifier',()=>{
  const source=readFileSync(new URL('../src/lib/manual-pdf-knowledge.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('manual-pdf-knowledge.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const names=new Set(['identityPhraseMatches','manualPdfMatchesEquipment']);
  const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(ast)).join('\n');
  const exports={};
  vm.runInNewContext(ts.transpileModule(`${functions}\nexports.matches=manualPdfMatchesEquipment;`,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText,{exports});
  const matches=exports.matches;
  assert.equal(matches('Friedrich Verdepac VTAC Service Manual',{manufacturer:'Friedrich',model_family:'Verdepac VTAC',model_number:null}),true);
  assert.equal(matches('Freedom Verdepac VTAC Service Manual',{manufacturer:'Friedrich',model_family:'Verdepac VTAC',model_number:null}),false);
  assert.equal(matches('Friedrich Vert-I-Pak Service Manual',{manufacturer:'Friedrich',model_family:'Verdepac VTAC',model_number:null}),false);
  assert.equal(matches('Friedrich VPAK-A Service Manual',{manufacturer:'Friedrich',model_family:null,model_number:'VPAK-A'}),true);
  assert.equal(matches('Friedrich VPAK-AB Service Manual',{manufacturer:'Friedrich',model_family:null,model_number:'VPAK-A'}),false);
});
test('exact PDF matches refresh structure without relying on a pre-existing cache entry',()=>{
  const route=readFileSync(new URL('../src/app/api/maintenance-reference/route.ts',import.meta.url),'utf8');
  assert.match(route,/if \(!matchingDocuments\.length\)/);
  assert.match(route,/\.from\("troubleshooting_cache"\)[\s\S]*?\.maybeSingle\(\)/);
  assert.match(route,/\.from\("troubleshooting_cache"\)\.upsert\(/);
  assert.match(route,/document_digest === documentDigest/);
});
test('null code and rule entries do not crash the ticket',()=>{
  const result=normalize({error_codes:[null,{},7],symptom_rules:[null,{},'Inspect model label']});
  assert.equal(result.error_codes.length,0);assert.equal(result.symptom_rules.length,1);
});

// Execute the server-side enrichment functions. These adapt structured verified
// knowledge to the existing ticket renderer without turning every manual test
// into an always-visible troubleshooting rule.
const apiSource=readFileSync(new URL('../src/app/api/maintenance-reference/route.ts',import.meta.url),'utf8');
const apiAst=ts.createSourceFile('route.ts',apiSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const enrichmentNames=new Set(['stringList','pageList','manualTestMatches','enrichManualKnowledge']);
const enrichmentFunctions=apiAst.statements
  .filter(node=>ts.isFunctionDeclaration(node)&&enrichmentNames.has(node.name?.text))
  .map(node=>node.getText(apiAst)).join('\n');
assert.equal(apiAst.statements.filter(node=>ts.isFunctionDeclaration(node)&&enrichmentNames.has(node.name?.text)).length,4);
const guidanceExports={};
vm.runInNewContext(ts.transpileModule(enrichmentFunctions+'\nexports.enrich=enrichManualKnowledge;exports.matches=manualTestMatches;',{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText,{exports:guidanceExports});
const enrich=guidanceExports.enrich;
const manualMatches=guidanceExports.matches;

test('general checks remain verified equipment guidance without inventing source verification',()=>{
  const result=enrich({source:{verified:true},symptom_rules:[],general_checks:['Verify power.','Inspect filter.']});
  assert.equal(result.source.verified,true);
  assert.equal(result.symptom_rules.length,1);
  assert.deepEqual(Array.from(result.symptom_rules[0].match),[]);
  assert.deepEqual(Array.from(result.symptom_rules[0].steps),['Verify power.','Inspect filter.']);
});

test('manual tests get symptom matches instead of becoming empty-match rules',()=>{
  const result=enrich({source:{verified:true},manual_tests:[{title:'Backwash trigger',test:'Backwash when filter pressure rises 8-10 PSI.',source_pages:[7]}]});
  assert.equal(result.symptom_rules.length,1);
  assert.ok(result.symptom_rules[0].match.length>0);
  assert.ok(result.symptom_rules[0].match.includes('backwash'));
  assert.deepEqual(Array.from(result.symptom_rules[0].source_pages),[7]);
});

test('unclassified technical tests are not forced onto every ticket',()=>{
  const result=enrich({source:{verified:true},manual_tests:[{title:'Special factory procedure',test:'Perform the manufacturer procedure exactly as written.'}]});
  assert.equal(result.symptom_rules.length,0);
});

test('work-order guide has no generic fallback when no verified manual is matched',()=>{
  const pageSource=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
  assert.match(pageSource,/const displayedSteps: ReturnType<typeof generalTroubleshootingFor> = \[\]/);
  assert.match(pageSource,/No generic troubleshooting fallback is shown/);
});

test('known manual-test topics map to expected issue language',()=>{
  assert.ok(manualMatches('Low-battery check','Observe the lock indicator.').includes('low battery'));
  assert.ok(manualMatches('Airflow check','Verify 1,400-1,600 CFM.').includes('humidity'));
  assert.ok(manualMatches('No motor rotation','Check drive wiring.').includes('drive fault'));
});

test('the work-order manual guide is driven only by verified manual knowledge',()=>{
  const pageSource=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
  assert.match(pageSource,/const matchingSymptomRules = trustedManualKnowledge/);
  assert.match(pageSource,/const manualSteps = Array\.from\(/);
  assert.match(pageSource,/const displayedSteps: ReturnType<typeof generalTroubleshootingFor> = \[\]/);
});

test('reported manufacturer code prefixes are preserved exactly',()=>{
  const pageSource=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
  const pageAst=ts.createSourceFile('page.tsx',pageSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const names=new Set(['normalizeDiagnosticCode','extractReportedErrorCode']);
  const functions=pageAst.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text));
  assert.equal(functions.length,2);
  const exports={};
  vm.runInNewContext(ts.transpileModule(`${functions.map(node=>node.getText(pageAst)).join('\n')}\nexports.normalize=normalizeDiagnosticCode;exports.extract=extractReportedErrorCode;`,{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText,{exports});
  assert.equal(exports.extract('Fault code F1 is displayed'),'F1');
  assert.equal(exports.extract('Error P1 is displayed'),'P1');
  assert.equal(exports.extract('Room 409 is not cooling'),null);
  assert.equal(exports.normalize('F1'), 'F1');
  assert.equal(exports.normalize('P1'), 'P1');
  assert.notEqual(exports.normalize('F1'), exports.normalize('1'));
});
