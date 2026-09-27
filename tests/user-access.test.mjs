import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(config={}) {
  const writes=[];
  const caller=config.caller===undefined?{id:'caller',role:'Engineer',active:true}:config.caller;
  const target=config.target===undefined?{id:'target',role:'Front Desk',active:true}:config.target;

  const roleKey=(r)=>{
    if(typeof r!=='string')return 'unknown';
    const k=r.trim().toLowerCase().replace(/[\s_-]+/g,'');
    const m={
      engineer:'engineer',chiefengineer:'engineer',engineering:'engineer',engineeringmanager:'engineer',regionalmaintenance:'engineer',regionalengineer:'engineer',
      manager:'manager',generalmanager:'manager',gm:'manager',
      seniormanagement:'senior_management',uppermanagement:'senior_management',vpfacilities:'senior_management',regionaldirectoroperations:'senior_management',districtmanager:'senior_management',
      technician:'technician',maintenancetechnician:'technician',
      frontdesk:'front_desk',assistantgm:'front_desk',assistantgeneralmanager:'front_desk',assistantmanager:'front_desk',salesmanager:'front_desk',
      housekeeping:'housekeeping',leadhousekeeper:'housekeeping',executivehousekeeper:'housekeeping',
      systemadmin:'system_admin',systemadministrator:'system_admin',administrator:'system_admin',admin:'system_admin',
    };
    return m[k]||'unknown';
  };
  const canManageTargetRole=(callerRole,targetRole)=>{
    const ck=roleKey(callerRole),tk=roleKey(targetRole);
    if(tk==='unknown'||tk==='system_admin')return false;
    if(ck==='system_admin')return true;
    if(ck==='engineer'||ck==='manager')return ['technician','front_desk','housekeeping'].includes(tk);
    return false;
  };
  const allLabels=['Engineer','Chief Engineer','General Manager','Senior Management','Maintenance Technician','Front Desk','Assistant GM','Sales Manager','Housekeeping','Lead Housekeeper'];
  const rolesModule={
    roleAllows:(r,c)=>c==='manage_users'&&['engineer','manager','system_admin'].includes(roleKey(r)),
    roleKey,
    ASSIGNABLE_ROLE_LABELS:allLabels,
    assignableRoleLabels:(r)=>allLabels.filter(label=>canManageTargetRole(r,label)),
    canChangeAccount:(c,t)=>Boolean(c?.id&&t?.id&&c.id!==t.id&&canManageTargetRole(c.role,t.role)),
    canManageTargetRole,
    membershipRole:(r)=>{
      const k=roleKey(r);
      if(k==='system_admin'||k==='engineer')return 'admin';
      if(k==='manager')return 'manager';
      if(k==='technician')return 'technician';
      return 'viewer';
    },
  };

  const client={auth:{getUser:async()=>({data:{user:{id:'caller'}},error:config.authError?{message:'failed'}:null}),
    signUp:async()=>({data:{user:{id:'created-via-signup'}},error:null}),
    admin:{
      inviteUserByEmail:async()=>{writes.push('invite');return {data:{user:{id:'invited'}},error:null};},
      createUser:async()=>{writes.push('createUser');return {data:{user:{id:'created'}},error:null};},
    }
  },from(table){
    const filters={};let update;
    const q={select(){return q;},eq(k,v){filters[k]=v;return q;},
      maybeSingle:async()=> table==='role_permissions'
        ? {data:config.permission===false?null:{allowed:true},error:config.permissionError?{message:'failed'}:null}
        : {data:filters.id==='caller'?caller:target,error:(filters.id==='caller'?config.profileError:config.targetError)?{message:'failed'}:null},
      order:async()=>({data:[caller,target].filter(Boolean),error:null}),
      update(value){writes.push('update');update=value;return q;},
      single:async()=>config.changedRole && filters.role!==config.changedRole
        ? {data:null,error:{message:'Account changed while saving'}}
        : {data:{...target,...update},error:null},
      upsert:async()=>{writes.push('upsert');return {error:null};},
    };return q;
  }};

  function compile(path){
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
      exports,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},
      require(name){
        if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
        if(name==='@supabase/supabase-js')return {createClient:()=>client};
        if(name==='@/lib/supabase/config')return {SUPABASE_URL:'https://test.invalid',SUPABASE_PUBLISHABLE_KEY:'fake'};
        if(name==='@/lib/user-policy')return compile('../src/lib/user-policy.ts');
        if(name==='server-only')return {};
        if(name==='@/lib/constants')return {HOTEL_ID:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'};
        if(name==='@/lib/server/access')return {allows:()=>true};
        if(name==='@/lib/server/roles')return rolesModule;
        if(name==='@/lib/server/auth')return {
          requireUser:async()=>{
            const u=await client.auth.getUser();
            if(u.error||!u.data?.user)return null;
            const p=await client.from('profiles').select().eq('id',u.data.user.id).maybeSingle();
            if(p.error||!p.data||p.data.active!==true)return null;
            return {principal:{identity:u.data.user,profile:p.data,membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:config.noAdmin?null:client};
          },
          requireCapability:async()=>{
            const u=await client.auth.getUser();
            if(u.error||!u.data?.user)return null;
            const p=await client.from('profiles').select().eq('id',u.data.user.id).maybeSingle();
            if(p.error||!p.data||p.data.active!==true)return null;
            const perm=await client.from('role_permissions').select().eq('role',p.data.role).maybeSingle();
            if(perm.error||!perm.data)return null;
            return {principal:{identity:u.data.user,profile:p.data,membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:config.noAdmin?null:client};
          },
        };
        throw new Error(name);
      },
    });
    return exports;
  }
  return {
    handlers:compile('../src/app/api/users/route.ts'),
    writes,
    request:{
      url:'https://test.invalid/api/users?id=target&confirm_name=Test%20User',
      headers:new Headers({authorization:'Bearer fake'}),
      json:async()=>{
        if(config.badJson)throw new SyntaxError('bad JSON');
        return config.body===undefined?{id:'target',active:false}:config.body;
      },
    },
  };
}

const denied=[
  ['self edit',{body:{id:'caller',active:false}}],
  ['invented role',{body:{id:'target',role:'superadmin'}}],
  ['front desk is not an account manager',{caller:{id:'caller',role:'Front Desk',active:true}}],
  ['housekeeping is not an account manager',{caller:{id:'caller',role:'Housekeeping',active:true}}],
  ['role substring is not authority',{caller:{id:'caller',role:'not-an-admin',active:true}}],
  ['inactive caller',{caller:{id:'caller',role:'Engineer',active:false}}],
  ['missing active flag',{caller:{id:'caller',role:'Engineer'}}],
  ['missing profile',{caller:null}],
  ['auth lookup failure',{authError:true}],
  ['profile lookup failure',{profileError:true}],
  ['permission denied',{permission:false}],
  ['permission lookup fails',{permissionError:true}],
];
for(const [name,config] of denied)test(`users PATCH denies ${name} without writes`,async()=>{
  const f=fixture(config);
  assert.equal((await f.handlers.PATCH(f.request)).status,403);
  assert.deepEqual(f.writes,[]);
});
for(const method of ['POST','PATCH'])for(const config of [{badJson:true},{body:null},{body:[]}])test(`users ${method} rejects invalid body ${JSON.stringify(config)}`,async()=>{
  const f=fixture(config);
  assert.equal((await f.handlers[method](f.request)).status,400);
  assert.deepEqual(f.writes,[]);
});
test('engineer cannot invite with an unknown role',async()=>{
  const f=fixture({body:{email:'test@example.invalid',full_name:'Test',role:'Superadmin'}});
  assert.equal((await f.handlers.POST(f.request)).status,403);
  assert.deepEqual(f.writes,[]);
});
test('engineer can deactivate a front desk user while preserving history and revoking membership',async()=>{
  const f=fixture();
  const r=await f.handlers.PATCH(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.user.active,false);
  assert.deepEqual(f.writes,['update','update']);
});
test('engineer cannot deactivate an equal engineer',async()=>{
  const f=fixture({caller:{id:'caller',role:'Engineer',active:true},target:{id:'target',role:'Engineer',active:true}});
  assert.equal((await f.handlers.PATCH(f.request)).status,403);
  assert.deepEqual(f.writes,[]);
});
test('target lookup failure fails closed',async()=>{
  const f=fixture({targetError:true});
  assert.equal((await f.handlers.PATCH(f.request)).status,503);
  assert.deepEqual(f.writes,[]);
});
test('missing target returns 404',async()=>{
  const f=fixture({target:null});
  assert.equal((await f.handlers.PATCH(f.request)).status,404);
  assert.deepEqual(f.writes,[]);
});
test('list exposes subordinate editing and only subordinate assignable roles',async()=>{
  const f=fixture();
  const r=await f.handlers.GET(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.users.find(u=>u.id==='caller').can_manage,false);
  assert.equal(r.body.users.find(u=>u.id==='target').can_manage,true);
  assert.equal(r.body.assignable_roles.includes('Engineer'),false);
  assert.equal(r.body.assignable_roles.includes('Front Desk'),true);
  assert.equal(r.body.assignable_roles.includes('Housekeeping'),true);
  assert.equal(r.body.assignable_roles.includes('Maintenance Technician'),true);
});
test('a changed target role prevents applying a stale authorized edit',async()=>{
  const f=fixture({changedRole:'system_admin'});
  const r=await f.handlers.PATCH(f.request);
  assert.notEqual(r.status,200);
  assert.ok(r.body.error);
});
test('engineer can invite front desk with validated role and property membership',async()=>{
  const f=fixture({body:{email:'test@example.invalid',full_name:'Test Front Desk',role:'Front Desk'}});
  const r=await f.handlers.POST(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.user.role,'front_desk');
  assert.deepEqual(f.writes,['invite','upsert','upsert']);
});
test('system_admin can create a manager profile when role label is Manager',async()=>{
  const f=fixture({caller:{id:'caller',role:'system_admin',active:true}, body:{email:'manager@example.invalid',full_name:'Test Manager',role:'Manager'}});
  const r=await f.handlers.POST(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.user.role,'manager');
  assert.deepEqual(f.writes,['invite','upsert','upsert']);
});
test('POST fails clearly when no server admin is configured for user creation',async()=>{
  const f=fixture({noAdmin:true, body:{email:'test@example.invalid',full_name:'Test Front Desk',role:'Front Desk',password:'temporary123'}});
  const r=await f.handlers.POST(f.request);
  assert.equal(r.status,500);
  assert.match(String(r.body.error), /SUPABASE_SERVICE_ROLE_KEY/i);
  assert.deepEqual(f.writes,[]);
});
test('engineer can deactivate a housekeeping user',async()=>{
  const f=fixture({caller:{id:'caller',role:'Engineer',active:true},target:{id:'target',role:'Housekeeping',active:true}});
  assert.equal((await f.handlers.PATCH(f.request)).status,200);
});
for(const body of [{id:'target'},{id:'target',full_name:'  '},{id:'target',active:'false'}])test(`invalid account change is rejected ${JSON.stringify(body)}`,async()=>{
  const f=fixture({body});
  assert.equal((await f.handlers.PATCH(f.request)).status,400);
  assert.deepEqual(f.writes,[]);
});
test('invalid invitation email is rejected before sending',async()=>{
  const f=fixture({body:{email:'not-an-email',full_name:'Test',role:'Front Desk'}});
  assert.equal((await f.handlers.POST(f.request)).status,400);
  assert.deepEqual(f.writes,[]);
});
test('observed system_admin manages a subordinate with manage_users permission',async()=>{
  const f=fixture({caller:{id:'caller',role:'system_admin',active:true}});
  assert.equal((await f.handlers.PATCH(f.request)).status,200);
});
test('system_admin access policy bypasses empty permission rows for bootstrap management',()=>{
  const rolesCode = readFileSync(new URL('../src/lib/server/roles.ts', import.meta.url), 'utf8');
  const rolesExports = {};
  vm.runInNewContext(ts.transpileModule(rolesCode,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports: rolesExports,
    require: () => ({}),
    process: { env: {} },
  });

  const accessCode = readFileSync(new URL('../src/lib/server/access.ts', import.meta.url), 'utf8');
  const accessExports = {};
  vm.runInNewContext(ts.transpileModule(accessCode,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    exports: accessExports,
    require(name) {
      if (name === './roles') return rolesExports;
      throw new Error(`Missing mock for ${name}`);
    },
    process: { env: {} },
  });

  const principal = {
    identity: { id: 'admin', email: 'pickering.scott@gmail.com' },
    profile: { id: 'admin', email: 'pickering.scott@gmail.com', role: 'system_admin', active: true, full_name: 'Scott Pickering' },
    hotelId: 'hotel-1',
    membership: { user_id: 'admin', hotel_id: 'hotel-1', role: 'admin', active: true },
    permissions: [],
  };

  assert.equal(accessExports.allows(principal, 'manage_users'), true);
  assert.equal(accessExports.allows(principal, 'view_dashboard'), true);
});
