import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// Execute the actual normalization functions without mounting the page.
const source=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(['objectRecord','pageNumbers','normalizeManualKnowledge']);
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(ast)).join('\n');
assert.equal(ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).length,3);
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
test('null code and rule entries do not crash the ticket',()=>{
  const result=normalize({error_codes:[null,{},7],symptom_rules:[null,{},'Inspect model label']});
  assert.equal(result.error_codes.length,0);assert.equal(result.symptom_rules.length,1);
});
