import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture(config={}) {
  const writes=[];
  const memberships=config.memberships??[
    {user_id:'caller',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',active:true},
    {user_id:'target',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',active:true},
  ];
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
      deleteUser:async()=>{writes.push('deleteUser');return {error:config.authDeleteError?{message:'Auth cleanup failed'}:null};},
    }
  },from(table){
    const filters={};let update;let includes;
    const filteredRows=()=>{
      if(table==='hotel_members')return memberships.filter((row)=>(filters.user_id===undefined||row.user_id===filters.user_id)&&(filters.hotel_id===undefined||row.hotel_id===filters.hotel_id)&&(!includes||includes.includes(row.user_id)));
      const rows=[caller,target].filter(Boolean);
      return rows.filter((row)=>(filters.id===undefined||row.id===filters.id)&&(!includes||includes.includes(row.id)));
    };
    const q={select(){return q;},eq(k,v){filters[k]=v;return q;},
      in(k,v){if(k==='user_id'||k==='id')includes=v;return q;},
      then(resolve){return Promise.resolve({data:filteredRows(),error:table==='hotel_members'&&config.membershipError?{message:'failed'}:null}).then(resolve);},
      maybeSingle:async()=> table==='role_permissions'
        ? {data:config.permission===false?null:{allowed:true},error:config.permissionError?{message:'failed'}:null}
        : {data:filters.id==='caller'?caller:target,error:(filters.id==='caller'?config.profileError:config.targetError)?{message:'failed'}:null},
      order:async()=>({data:filteredRows(),error:null}),
      update(value){writes.push('update');update=value;return q;},
      single:async()=>config.changedRole && filters.role!==config.changedRole
        ? {data:null,error:{message:'Account changed while saving'}}
        : {data:{...target,...update},error:null},
      delete(){writes.push(`delete:${table}`);return q;},
      limit(){return q;},
      upsert:async()=>{
        writes.push('upsert');
        const failed=table==='profiles'&&config.profileUpsertError||table==='hotel_members'&&config.membershipUpsertError;
        return {error:failed?{message:`${table} setup failed`}:null};
      },
    };return q;
  }};

  function compile(path){
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
      exports,URL,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},
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
test('user list excludes profiles without membership in this hotel',async()=>{
  const memberships=[
    {user_id:'caller',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',active:true},
    {user_id:'target',hotel_id:'another-hotel',active:true},
  ];
  const f=fixture({memberships});
  const r=await f.handlers.GET(f.request);
  assert.equal(r.status,200);
  assert.deepEqual(r.body.users.map(user=>user.id),['caller']);
});
test('shared-property users are visible but immutable from this hotel',async()=>{
  const memberships=[
    {user_id:'caller',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',active:true},
    {user_id:'target',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',active:true},
    {user_id:'target',hotel_id:'another-hotel',active:true},
  ];
  const f=fixture({memberships});
  const listed=await f.handlers.GET(f.request);
  assert.equal(listed.body.users.find(user=>user.id==='target').can_manage,false);
  const patched=await f.handlers.PATCH(f.request);
  assert.equal(patched.status,409);
  assert.deepEqual(f.writes,[]);
});
test('foreign-property profiles cannot be patched or deactivated',async()=>{
  const memberships=[
    {user_id:'caller',hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',active:true},
    {user_id:'target',hotel_id:'another-hotel',active:true},
  ];
  const f=fixture({memberships});
  assert.equal((await f.handlers.PATCH(f.request)).status,404);
  assert.equal((await f.handlers.DELETE(f.request)).status,404);
  assert.deepEqual(f.writes,[]);
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
for(const [mode,password] of [['invite',undefined],['temporary password','temporary123']]){
  test(`POST rolls back the ${mode} Auth account when profile setup fails`,async()=>{
    const f=fixture({profileUpsertError:true,body:{email:'test@example.invalid',full_name:'Test Front Desk',role:'Front Desk',...(password?{password}:{})}});
    const r=await f.handlers.POST(f.request);
    assert.equal(r.status,500);
    assert.match(r.body.error,/rolled back/i);
    assert.deepEqual(f.writes,[password?'createUser':'invite','upsert','delete:hotel_members','delete:profiles','deleteUser']);
  });
}
test('POST rolls back the profile and Auth account when property membership setup fails',async()=>{
  const f=fixture({membershipUpsertError:true,body:{email:'test@example.invalid',full_name:'Test Front Desk',role:'Front Desk'}});
  const r=await f.handlers.POST(f.request);
  assert.equal(r.status,500);
  assert.match(r.body.error,/rolled back/i);
  assert.deepEqual(f.writes,['invite','upsert','upsert','delete:hotel_members','delete:profiles','deleteUser']);
});
test('POST reports manual cleanup when Auth account deletion fails during rollback',async()=>{
  const f=fixture({profileUpsertError:true,authDeleteError:true,body:{email:'test@example.invalid',full_name:'Test Front Desk',role:'Front Desk'}});
  const r=await f.handlers.POST(f.request);
  assert.equal(r.status,500);
  assert.match(r.body.error,/remove this account manually/i);
  assert.match(r.body.error,/Auth login/i);
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

  const engineerWithoutGrants = {
    ...principal,
    identity: { id: 'engineer', email: 'engineer@example.invalid' },
    profile: { id: 'engineer', email: 'engineer@example.invalid', role: 'Chief Engineer', active: true, full_name: 'Engineer' },
    membership: { user_id: 'engineer', hotel_id: 'hotel-1', role: 'admin', active: true },
  };

  assert.equal(accessExports.allows(principal, 'manage_users'), true);
  assert.equal(accessExports.allows(principal, 'view_dashboard'), true);
  assert.equal(accessExports.allows(engineerWithoutGrants, 'manage_users'), false);
  assert.equal(accessExports.allows(engineerWithoutGrants, 'edit_tickets'), false);
  assert.equal(accessExports.allows(engineerWithoutGrants, 'view_dashboard'), true);
  assert.equal(accessExports.allows(engineerWithoutGrants, 'submit'), true);
});
