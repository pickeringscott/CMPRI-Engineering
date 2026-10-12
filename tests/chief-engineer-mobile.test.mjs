import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(path, dependencies={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>dependencies[name]});
  return exports;
}
const roles=load('../src/lib/server/roles.ts');
const {usesChiefEngineerMobileLayout: matches}=load('../src/lib/dashboard/chief-engineer-mobile.ts',{'../server/roles':roles});
test('verified maintenance identity selects presentation without changing its stored roles',()=>{
 const profile={email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:['engineer']};
 const before=JSON.stringify(profile);assert.equal(matches(profile),true);assert.equal(JSON.stringify(profile),before);
 assert.equal(roles.roleKey(profile.role),'system_admin');
});
test('email alone, generic engineers and the separate administrator do not qualify',()=>{
 for(const profile of [
 {email:'maint.cmpri@hawkeyehotels.com',role:'front_desk'},
 {email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:[]},
 {email:'pickering.scott@gmail.com',role:'system_admin',secondary_roles:['engineer']},
 {email:'other@example.invalid',role:'engineer'},
 {email:'other@example.invalid',role:'system_admin',secondary_roles:['engineer']},
 {role:'manager'}, {role:'technician'}, {role:'front_desk'}, {role:'housekeeping'}
 ])assert.equal(matches(profile),false,JSON.stringify(profile));
});
test('explicit Chief Engineer assignments retain existing identity semantics',()=>{
 for(const role of ['Chief Engineer','chief_engineer'])assert.equal(matches({role}),true);
 assert.equal(matches({role:'technician',secondary_roles:['chief_engineer']}),true);
});
