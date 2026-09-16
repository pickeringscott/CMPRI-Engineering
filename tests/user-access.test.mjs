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
    const m={'engineer':'engineer','technician':'engineer','chiefengineer':'engineer','engineering':'engineer','frontdesk':'front_desk','housekeeping':'housekeeping','systemadmin':'system_admin'};
    return m[k]||'unknown';
  };

  const rolesModule={
    roleAllows:(r,c)=>{if(c==='manage_users')return r==='system_admin'||r==='Engineer';return false},
    roleKey,
    ASSIGNABLE_ROLE_LABELS:['Engineer','Front Desk','Housekeeping'],
    assignableRoleLabels:()=>['Engineer','Front Desk','Housekeeping'],
    canChangeAccount:(c,t)=>{
      if(!c||!c.active)return false;
      const ck=roleKey(c.role);const tk=roleKey(t.role);
      if(ck==='system_admin')return tk!=='system_admin';
      if(ck==='engineer')return tk!=='system_admin'&&tk!=='unknown';
      return false;
    },
    canManageTargetRole:(c,r)=>{
      const ck=roleKey(c);const tk=roleKey(r);
      if(tk==='system_admin')return false;
      if(ck==='system_admin')return true;
      if(ck==='engineer')return tk!=='system_admin'&&tk!=='unknown';
      return false;
    },
  };

  const client={auth:{getUser:async()=>({data:{user:{id:'caller'}},error:config.authError?{message:'failed'}:null}),admin:{
    inviteUserByEmail:async()=>{writes.push('invite');return {data:{user:{id:'invited'}},error:null};},
  }},from(table){
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
            return {principal:{identity:u.data.user,profile:p.data,membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:client};
          },
          requireCapability:async()=>{
            const u=await client.auth.getUser();
            if(u.error||!u.data?.user)return null;
            const p=await client.from('profiles').select().eq('id',u.data.user.id).maybeSingle();
            if(p.error||!p.data||p.data.active!==true)return null;
            const perm=await client.from('role_permissions').select().eq('role',p.data.role).maybeSingle();
            if(perm.error||!perm.data)return null;
            return {principal:{identity:u.data.user,profile:p.data,membership:{hotel_id:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'}},admin:client};
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
  ['front desk is not an account manager',{caller:{role:'Front Desk',active:true}}],
  ['housekeeping is not an account manager',{caller:{role:'Housekeeping',active:true}}],
  ['role substring is not authority',{caller:{role:'not-an-admin',active:true}}],
  ['inactive caller',{caller:{role:'Engineer',active:false}}],
  ['missing active flag',{caller:{role:'Engineer'}}],
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
test('engineer can deactivate a front desk user without deleting history',async()=>{
  const f=fixture();
  const r=await f.handlers.PATCH(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.user.active,false);
  assert.deepEqual(f.writes,['update']);
});
test('engineer can deactivate another engineer (flat hierarchy)',async()=>{
  const f=fixture({caller:{role:'Engineer',active:true},target:{id:'target',role:'Engineer',active:true}});
  assert.equal((await f.handlers.PATCH(f.request)).status,200);
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
test('list exposes subordinate editing and assignable roles',async()=>{
  const f=fixture();
  const r=await f.handlers.GET(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.users.find(u=>u.id==='caller').can_manage,false);
  assert.equal(r.body.users.find(u=>u.id==='target').can_manage,true);
  assert.equal(r.body.assignable_roles.includes('Engineer'),true);
  assert.equal(r.body.assignable_roles.includes('Front Desk'),true);
  assert.equal(r.body.assignable_roles.includes('Housekeeping'),true);
});
test('a changed target role prevents applying a stale authorized edit',async()=>{
  const f=fixture({changedRole:'system_admin'});
  const r=await f.handlers.PATCH(f.request);
  assert.notEqual(r.status,200);
  assert.ok(r.body.error);
});
test('engineer can invite front desk with a validated role',async()=>{
  const f=fixture({body:{email:'test@example.invalid',full_name:'Test Front Desk',role:'Front Desk'}});
  const r=await f.handlers.POST(f.request);
  assert.equal(r.status,200);
  assert.equal(r.body.user.role,'Front Desk');
  assert.deepEqual(f.writes,['invite','upsert']);
});
test('engineer can deactivate a housekeeping user',async()=>{
  const f=fixture({caller:{role:'Engineer',active:true},target:{id:'target',role:'Housekeeping',active:true}});
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
