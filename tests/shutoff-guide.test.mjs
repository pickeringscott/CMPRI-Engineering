import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as roles from '../src/lib/server/roles.ts';
function load(file,deps,extra={}) {
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,require:n=>{if(n in deps)return deps[n];throw Error(n)},Response,Uint8Array,process,...extra});
 return exports;
}
const policy=load('src/lib/room-ranker-access.ts',{'@/lib/server/roles':roles});
test('shutoff images enforce existing audience before file access, reject traversal, and never cache',async()=>{
 let auth={ok:false},reads=0;
 const route=load('src/app/api/guides/shutoff/[image]/route.ts',{
  'node:fs/promises':{readFile:async file=>{reads++;return readFileSync(file)}},'node:path':path,
  '@/lib/server/auth':{requireUserAttempt:async()=>auth},'@/lib/room-ranker-access':policy,
 });
 const get=(image='water')=>route.GET({}, {params:Promise.resolve({image})});
 assert.equal((await get()).status,401);assert.equal(reads,0);
 for(const role of ['engineer','technician','housekeeper']) {
  auth={ok:true,principal:{profile:{role}}};assert.equal((await get()).status,403);
 }
 assert.equal(reads,0);
 for(const role of ['front_desk_manager','assistant_manager','manager']) {
  auth={ok:true,principal:{profile:{role}}};
  for(const name of ['water','gas','risers']) {
   const response=await get(name);assert.equal(response.status,200);
   assert.equal(response.headers.get('Cache-Control'),'private, no-store');
   assert.equal(response.headers.get('Content-Type'),'image/png');
   assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(`src/server-assets/shutoff/${name}.png`));
  }
 }
 const before=reads;assert.equal((await get('../water')).status,404);assert.equal(reads,before);
 auth={ok:true,principal:{profile:{role:'manager',secondary_roles:['technician']}}};assert.equal((await get()).status,403);
});
