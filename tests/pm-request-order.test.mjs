import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function functionSource(name) {
  const source=readFileSync(new URL('../src/app/engineering/preventive-maintenance/page.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(ast);
    if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name&&node.initializer&&ts.isCallExpression(node.initializer))found=`const ${name} = ${node.initializer.arguments[0].getText(ast)}`;
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.ok(found);return ts.transpileModule(found+`;exports.run=${name};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
}
function fixture(name='load',overrides={}) {
  const state={data:null,loading:false,error:'',message:''},pending=[];
  const exports={};
  vm.runInNewContext(functionSource(name),{exports,sheet:'FEB',data:{sheet:'JAN',can_edit:true},loading:false,savingCell:'',loadSequence:{current:0},saveInFlight:{current:false},
    token:async()=>'fake',fetch:async(url,init)=>new Promise(resolve=>pending.push({url,init,resolve})),
    setData:v=>state.data=v,setLoading:v=>state.loading=v,setError:v=>state.error=v,setMessage:v=>state.message=v,setSavingCell:()=>{},load:async()=>{},columnName:()=> 'B',...overrides,
  });
  return {state,pending,run:exports.run};
}
const response=sheet=>({ok:true,json:async()=>({sheet,can_edit:true,values:[['Task','FALSE']],formulas:[['','']]})});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('an older PM response cannot overwrite the newly selected month',async()=>{
  const f=fixture(),a=f.run('JAN'),b=f.run('FEB');await flush();
  f.pending[1].resolve(response('FEB'));await b;f.pending[0].resolve(response('JAN'));await a;
  assert.equal(f.state.data.sheet,'FEB');
});
test('an older request cannot clear loading while the current month is pending',async()=>{
  const f=fixture(),a=f.run('JAN'),b=f.run('FEB');await flush();
  f.pending[0].resolve(response('JAN'));await a;assert.equal(f.state.loading,true);
  f.pending[1].resolve(response('FEB'));await b;assert.equal(f.state.loading,false);
});
test('an old request failure cannot erase the current sheet',async()=>{
  const f=fixture(),a=f.run('JAN'),b=f.run('FEB');await flush();
  f.pending[1].resolve(response('FEB'));await b;
  f.pending[0].resolve({ok:false,json:async()=>({error:'Old failure'})});await a;
  assert.equal(f.state.data?.sheet,'FEB');assert.equal(f.state.error,'');
});
test('PM refuses data labelled for a different month',async()=>{
  const f=fixture(),p=f.run('FEB');await flush();f.pending[0].resolve(response('JAN'));await p;
  assert.equal(f.state.data,null);assert.ok(f.state.error);
});
test('a stale displayed sheet cannot write into a newly selected month',async()=>{
  let requests=0;const f=fixture('toggle',{fetch:async()=>{requests++;return {ok:true,json:async()=>({ok:true})};}});
  await f.run(1,2,true);assert.equal(requests,0);
});
test('two immediate PM clicks issue only one save',async()=>{
  const f=fixture('toggle',{data:{sheet:'FEB',can_edit:true,values:[['Task','FALSE']],formulas:[['','']]}});
  const first=f.run(1,2,true);await f.run(1,2,true);await flush();assert.equal(f.pending.length,1);
  assert.equal(JSON.parse(f.pending[0].init.body).sheet,'FEB');
  f.pending[0].resolve({ok:true,json:async()=>({ok:true})});await first;
});
