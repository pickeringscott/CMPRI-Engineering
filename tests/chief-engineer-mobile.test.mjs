import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(path, dependencies={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>dependencies[name]});
  return exports;
}
const roles=load('../src/lib/server/roles.ts');
const {usesChiefEngineerMobileLayout: matches}=load('../src/lib/dashboard/chief-engineer-mobile.ts',{'../server/roles':roles,'../account-display':load('../src/lib/account-display.ts')});
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

test('central account title distinguishes maintenance from personal administrator without mutating authorization', () => {
 const display=load('../src/lib/account-display.ts');
 for(const [profile,expected] of [
  [{email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:['engineer']},'Chief Engineer'],
  [{email:' MAINT.CMPRI@HAWKEYEHOTELS.COM ',role:'System Administrator',secondary_roles:['engineer']},'Chief Engineer'],
  [{email:'pickering.scott@gmail.com',role:'system_admin'},'System Administrator'],
  [{email:'other@example.invalid',role:'system_admin',secondary_roles:['engineer']},'System Administrator + Engineer'],
  [{email:'maint.cmpri@hawkeyehotels.com',role:'front_desk'},'Front Desk'],
  [{email:'maint.cmpri@hawkeyehotels.com',role:'system_admin'},'System Administrator'],
 ]) {
  const original=JSON.stringify(profile);
  assert.equal(display.accountRoleDisplayName(profile),expected);
  assert.equal(JSON.stringify(profile),original);
 }
});
