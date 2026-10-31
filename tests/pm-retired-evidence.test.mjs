import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
test('retired evidence routes authenticate, return uncached 410 and cannot reach database',async()=>{
 for(const [file,methods] of [['source-evidence',['GET','POST']],['history/answers',['POST']]]){
  let signedIn=false;
  const exports={};
  const source=fs.readFileSync(`src/app/api/preventive-maintenance/${file}/route.ts`,'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(code,{exports,require:name=>{
   if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,...options})}};
   if(name==='@/lib/server/auth')return {requireUser:async()=>signedIn?{id:'fixture-user'}:null};
   throw new Error(`Unexpected dependency: ${name}`);
  }});
  for(const method of methods){
   signedIn=false;assert.equal((await exports[method]({})).status,401);
   signedIn=true;const response=await exports[method]({});assert.equal(response.status,410);
   assert.equal(response.headers['Cache-Control'],'no-store');
  }
 }
});
test('replacement history route requires sign-in and returns all 80 retained views without cache',async()=>{
 let signedIn=false;const exports={};
 const history=JSON.parse(fs.readFileSync('src/lib/pm/retained-maintenance-history.json'));
 const source=fs.readFileSync('src/app/api/preventive-maintenance/maintenance-history/route.ts','utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,{exports,require:name=>{
  if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,...options})}};
  if(name==='@/lib/server/auth')return {requireUser:async()=>signedIn?{id:'fixture-user'}:null};
  if(name==='@/lib/pm/retained-maintenance-history.json')return history;
  throw new Error(`Unexpected dependency: ${name}`);
 }});
 assert.equal((await exports.GET({})).status,401);signedIn=true;
 const response=await exports.GET({});assert.deepEqual(response.body,history);
 assert.equal(response.body.groups.reduce((n,g)=>n+g.forms.length,0),80);
 assert.equal(response.headers['Cache-Control'],'no-store');
});
