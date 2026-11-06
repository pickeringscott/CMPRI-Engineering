// Generate browser fixtures from current policy, never hand-maintained grants.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function compile(path, dependencies={}) {
 const exports={};
 const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:name=>{if(name in dependencies)return dependencies[name];throw Error('Unexpected dependency: '+name)}});
 return exports;
}
const roles=compile('../../src/lib/server/roles.ts'),{allows}=compile('../../src/lib/server/access.ts',{'./roles':roles});
const route=readFileSync(new URL('../../src/app/api/session/route.ts',import.meta.url),'utf8');
const capabilities=JSON.parse('['+route.match(/const capabilities: Capability\[\] = \[([\s\S]*?)\];/)[1].replace(/,\s*$/,'')+']');
const names=['chief_engineer','system_admin','technician','manager','assistant_manager','front_desk_manager','front_desk','housekeeping','senior_management'];
const grantNames=['manage_work_orders','edit_work_orders','update_work_orders','approve_work_orders','review_work_orders','close_work_orders','manage_assets','manage_rooms','manage_users','manage_pm','manage_integrations'];
const fixtures=Object.fromEntries(names.map(role=>{
 const user='00000000-0000-4000-8000-000000000001',hotel='00000000-0000-4000-8000-000000000002';
 const principal={identity:{id:user,email:'fixture@example.invalid'},profile:{id:user,role,active:true,full_name:'Alex Morgan',secondary_roles:[]},hotelId:hotel,membership:{user_id:user,hotel_id:hotel,active:true,role:roles.membershipRole(role)},permissions:grantNames.map(permission=>({role,permission,allowed:true}))};
 return [role,capabilities.filter(capability=>allows(principal,capability))];
}));
writeFileSync(new URL('./role-capabilities.json',import.meta.url),JSON.stringify(fixtures,null,2)+'\n');
