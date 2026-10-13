import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { isInstalledMobileApp } from '../src/lib/notifications/installed-mobile.ts';
import * as schedule from '../src/lib/notifications/schedule.ts';

const hotel = '00000000-0000-0000-0000-000000000001';
const user = '00000000-0000-0000-0000-000000000002';
const other = '00000000-0000-0000-0000-000000000003';
const device = '00000000-0000-0000-0000-000000000004';
const second = '00000000-0000-0000-0000-000000000005';
const jobId = '00000000-0000-0000-0000-000000000006';
const endpoint = 'https://push.example.invalid/current';
const db = new PGlite();
let sent = [], callbacks = [], auth, sendError;
const allDays = enabled => Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day => [day, { enabled, start:'00:00', end:'00:00' }]));

// Run the actual server code against real PostgreSQL semantics, with only
// authentication, after-response scheduling, and the external provider stubbed.
const admin = {
  from(table) {
    let columns='*', mutation, clauses=[], values=[], sort='', limit='', single=false;
    const add = (key, op, value) => { values.push(value); clauses.push(`${key} ${op} $${values.length}`); return q; };
    const q = {
      select(value) { columns=value; return q; },
      update(value) { mutation=value; return q; },
      eq: (key,value) => add(key,'=',value),
      lte: (key,value) => add(key,'<=',value),
      gte: (key,value) => add(key,'>=',value),
      gt: (key,value) => add(key,'>',value),
      order(key, options) { sort=` order by ${key} ${options?.ascending === false ? 'desc' : 'asc'}`; return q; },
      limit(count) { limit=` limit ${Number(count)}`; return q; },
      maybeSingle() { single=true; return q; },
      async then(resolve) {
        try {
          let sql;
          const where=clauses.length ? ` where ${clauses.join(' and ')}` : '';
          if (mutation) {
            const fields=Object.entries(mutation).map(([key,value])=> { values.push(value); return `${key}=$${values.length}`; });
            sql=`update ${table} set ${fields.join(',')}${where} returning ${columns}`;
          } else sql=`select ${columns} from ${table}${where}${sort}${limit}`;
          const result=await db.query(sql, values);
          resolve({data:single ? result.rows[0] || null : result.rows,error:null});
        } catch(error) { resolve({data:null,error:{message:error.message}}); }
      },
    };
    return q;
  },
  async rpc(name,args) {
    try {
      const result=await db.query(`select ${name}($1,$2,$3,$4,$5) as job`,Object.values(args));
      return {data:result.rows[0].job,error:null};
    } catch(error) { return {data:null,error:{message:error.message}}; }
  },
};
const modules=new Map();
function load(path) {
  if(modules.has(path)) return modules.get(path);
  const exports={}; modules.set(path,exports);
  const code=ts.transpileModule(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports,process,Date,console:{error(){}},require(name){
    if(name==='@/lib/constants') return {HOTEL_ID:hotel};
    if(name==='@/lib/notifications/schedule') return schedule;
    if(name==='@/lib/server/auth') return {requireUserAttempt:async()=>auth};
    if(name==='next/server') return {NextResponse:{json:(body,init)=>new Response(JSON.stringify(body),init)},after:callback=>callbacks.push(callback)};
    if(name==='node:timers/promises') return {setTimeout:async()=>{}};
    if(name==='web-push') return {default:{sendNotification:async(subscription,payload,options)=>{ sent.push({subscription,payload:JSON.parse(payload),options}); if(sendError) throw sendError; }}};
    if(name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
    throw new Error(name);
  }});
  return exports;
}
const server=load('src/lib/server/phone-notification-tests.ts');
const route=load('src/app/api/profile/phone-notifications/test/route.ts');
const post=async(body)=> {
  const response=await route.POST(new Request('https://cmpri.example.invalid/api/profile/phone-notifications/test',{method:'POST',body:JSON.stringify({endpoint,...body})}));
  return {status:response.status,body:await response.json()};
};
const enqueue=(id=jobId,delay=0)=>post({action:'send',id,delay_seconds:delay});
const status=async()=> (await db.query('select status from cmpri_web_push_tests where id=$1',[jobId])).rows[0]?.status;

before(async()=>{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table profiles (id uuid primary key,role text,secondary_roles text[],active boolean);
    create table hotel_members (hotel_id uuid,user_id uuid,active boolean);
    create table cmpri_user_notification_schedules (hotel_id uuid,user_id uuid,timezone text,schedule jsonb);
    create table cmpri_web_push_subscriptions (id uuid primary key,hotel_id uuid,recipient_user_id uuid,enabled boolean,endpoint text,subscription jsonb);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261013134405_cmpri_current_device_push_tests.sql',import.meta.url),'utf8'));
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY='fixture-public';process.env.WEB_PUSH_VAPID_PRIVATE_KEY='fixture-private';process.env.WEB_PUSH_VAPID_SUBJECT='mailto:test@example.invalid';
});
beforeEach(async()=>{
  await db.exec('truncate cmpri_web_push_tests,cmpri_web_push_subscriptions,profiles,hotel_members,cmpri_user_notification_schedules cascade');
  await db.query('insert into profiles values ($1,$2,$3,true),($4,$2,$3,true)',[user,'system_admin',['engineer'],other]);
  await db.query('insert into hotel_members values ($1,$2,true)',[hotel,user]);
  await db.query('insert into cmpri_user_notification_schedules values ($1,$2,$3,$4)',[hotel,user,'UTC',JSON.stringify(allDays(true))]);
  for(const [id,url] of [[device,endpoint],[second,'https://push.example.invalid/other-device']]) await db.query('insert into cmpri_web_push_subscriptions values ($1,$2,$3,true,$4,$5)',[id,hotel,user,url,JSON.stringify({endpoint:url})]);
  auth={ok:true,mcp:false,admin,principal:{identity:{id:user},profile:{role:'system_admin'}}};
  sent=[];callbacks=[];sendError=null;
});
after(()=>db.close());

test('send now uses only owned current subscription and fixed test payload; duplicate workers cannot resend',async()=>{
  const first=await enqueue(); assert.equal(first.status,202);
  assert.equal(sent.length,0);
  assert.equal((await enqueue()).status,202);
  assert.equal((await db.query('select count(*)::int as n from cmpri_web_push_tests')).rows[0].n,1);
  await Promise.all(callbacks.map(callback=>callback()));
  assert.equal(sent.length,1); assert.equal(sent[0].subscription.endpoint,endpoint);
  assert.equal(sent[0].payload.title,'CMPRI notification test');
  assert.match(sent[0].payload.body,/test notification/);
  assert.equal(sent[0].payload.url,'/profile'); assert.equal(sent[0].options.urgency,'high');
  assert.equal(sent[0].options.TTL,60); assert.equal(await status(),'accepted');
  await server.dispatchDuePhoneNotificationTests(admin); assert.equal(sent.length,1);
});

test('10-second request persists, waits until due, and runs server-side after browser departure',async()=>{
  const result=await enqueue(jobId,10); assert.equal(result.status,202);
  const row=(await db.query('select extract(epoch from due_at-created_at)::int as delay from cmpri_web_push_tests')).rows[0];
  assert.equal(row.delay,10);
  await server.dispatchPhoneNotificationTest(admin,jobId);assert.equal(sent.length,0);
  await db.exec("update cmpri_web_push_tests set due_at=now()-interval '1 second'");
  await callbacks[0](); assert.equal(sent.length,1);
});

test('cron recovers an unclaimed due test if the after-response worker stops',async()=>{
  await enqueue(jobId,10);
  await db.exec("update cmpri_web_push_tests set due_at=now()-interval '1 second'");
  callbacks=[]; await server.dispatchDuePhoneNotificationTests(admin);
  assert.equal(sent.length,1);assert.equal(await status(),'accepted');
});

test('cancel wins before claim; accepted tests cannot be falsely reported cancelled',async()=>{
  await enqueue(); assert.equal((await post({action:'cancel',id:jobId})).status,200);
  await callbacks[0]();assert.equal(sent.length,0);assert.equal(await status(),'cancelled');
  await db.exec("update cmpri_web_push_tests set status='accepted'");
  const result=await post({action:'cancel',id:jobId});assert.equal(result.status,409);assert.equal(result.body.test.status,'accepted');
});

test('disabling, removing, or reassigning a device cancels queued tests and preserves quota history',async()=>{
  await enqueue(jobId,10);
  await db.query('delete from cmpri_web_push_subscriptions where id=$1',[device]);
  assert.equal(await status(),'cancelled');
  assert.equal((await db.query('select count(*)::int as n from cmpri_web_push_tests')).rows[0].n,1);
  await server.dispatchDuePhoneNotificationTests(admin);assert.equal(sent.length,0);
});

test('ownership is enforced for send/status/cancel even with another device endpoint',async()=>{
  await enqueue();
  await db.query('update cmpri_web_push_subscriptions set recipient_user_id=$1 where id=$2',[other,device]);
  for(const action of ['send','status','cancel']) assert.equal((await post({action,id:jobId,delay_seconds:0})).status,409);
  await callbacks[0]();assert.equal(sent.length,0);
});

test('anonymous, MCP, and ineligible profiles cannot request tests',async()=>{
  auth={ok:false}; assert.equal((await enqueue()).status,401);
  auth={ok:true,mcp:true,admin,principal:{identity:{id:user},profile:{role:'system_admin'}}};assert.equal((await enqueue()).status,403);
  auth.mcp=false;auth.principal.profile.role='Front Desk Manager';assert.equal((await enqueue()).status,403);
  assert.equal(callbacks.length,0);
});

test('quiet hours reject new tests; changed schedule or revoked role blocks a queued test',async()=>{
  await db.query('update cmpri_user_notification_schedules set schedule=$1',[JSON.stringify(allDays(false))]);
  assert.equal((await enqueue()).status,409);
  await db.query('update cmpri_user_notification_schedules set schedule=$1',[JSON.stringify(allDays(true))]);
  await enqueue(); await db.query('update profiles set active=false where id=$1',[user]);
  await callbacks[0]();assert.equal(await status(),'blocked');assert.equal(sent.length,0);
});

test('changing notification hours after scheduling blocks the delayed test',async()=>{
  await enqueue(jobId,10);
  await db.exec("update cmpri_web_push_tests set due_at=now()-interval '1 second'");
  await db.query('update cmpri_user_notification_schedules set schedule=$1',[JSON.stringify(allDays(false))]);
  await callbacks[0]();assert.equal(await status(),'blocked');assert.equal(sent.length,0);
});

test('disabled subscription cancels tests and another owned device cannot read or cancel them',async()=>{
  await enqueue(jobId,10);
  const otherEndpoint='https://push.example.invalid/other-device';
  assert.equal((await post({action:'status',id:jobId,endpoint:otherEndpoint})).body.test,null);
  assert.equal((await post({action:'cancel',id:jobId,endpoint:otherEndpoint})).status,409);
  assert.equal(await status(),'pending');
  await db.query('update cmpri_web_push_subscriptions set enabled=false where id=$1',[device]);
  assert.equal(await status(),'cancelled');await callbacks[0]();assert.equal(sent.length,0);
});

test('parallel requests are rate limited and changed idempotent arguments are rejected',async()=>{
  const responses=await Promise.all([enqueue(),enqueue('00000000-0000-0000-0000-000000000007')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[202,429]);
  const id=responses.find(r=>r.status===202).body.test.id;
  assert.equal((await enqueue(id,10)).status,409);
});

test('request validation rejects unexpected delays and missing or malformed IDs',async()=>{
  for(const body of [{action:'send',delay_seconds:0},{action:'send',id:'invalid',delay_seconds:0},{action:'send',id:jobId,delay_seconds:9},{action:'cancel'},{action:'send',id:jobId,delay_seconds:0,endpoint:''}]) {
    assert.equal((await post(body)).status,400);
  }
  assert.equal(callbacks.length,0);
});

test('quota spans devices and cancelled jobs; idempotent retry remains permitted',async()=>{
  await enqueue();await post({action:'cancel',id:jobId});
  const secondId='00000000-0000-0000-0000-000000000007';
  assert.equal((await post({action:'send',endpoint:'https://push.example.invalid/other-device',id:secondId,delay_seconds:0})).status,429);
  assert.equal((await enqueue()).status,202);
  await db.exec("update cmpri_web_push_tests set created_at=now()-interval '1 minute'");
  for(let i=7;i<11;i++) {
    const id=`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`;
    assert.equal((await enqueue(id)).status,202);
    await db.exec("update cmpri_web_push_tests set created_at=now()-interval '1 minute'");
  }
  assert.equal((await enqueue('00000000-0000-0000-0000-000000000011')).status,429);
});

test('expired tests never send; interrupted claimed tests are unknown, not retried',async()=>{
  await enqueue();await db.exec("update cmpri_web_push_tests set expires_at=now()-interval '1 second'");
  await server.dispatchDuePhoneNotificationTests(admin);assert.equal(await status(),'expired');assert.equal(sent.length,0);
  await db.exec("update cmpri_web_push_tests set status='sending'");
  await server.dispatchDuePhoneNotificationTests(admin);assert.equal(sent.length,0);
  assert.equal((await post({action:'status'})).body.test.status,'unknown');
});

test('provider errors do not leak keys or trigger retries',async()=>{
  await enqueue();sendError=new Error('sensitive provider response');await callbacks[0]();
  assert.equal(await status(),'unknown');await server.dispatchDuePhoneNotificationTests(admin);assert.equal(sent.length,1);
  assert.doesNotMatch(JSON.stringify((await post({action:'status'})).body),/sensitive|endpoint|fixture-private/);
});

test('database access is denied to browser roles and RPC execution is restricted',async()=>{
  const rows=(await db.query("select has_table_privilege('authenticated','cmpri_web_push_tests','select') as table_access, has_function_privilege('anon','cmpri_enqueue_web_push_test(uuid,uuid,uuid,uuid,integer)','execute') as rpc_access")).rows;
  assert.equal(rows[0].table_access,false);assert.equal(rows[0].rpc_access,false);
});

test('installed mobile UX hides controls in desktop installed apps and ordinary phone browsers',()=>{
  assert.equal(isInstalledMobileApp({standalone:true,userAgent:'Android Chrome'}),true);
  assert.equal(isInstalledMobileApp({standalone:false,userAgent:'Android Chrome'}),false);
  assert.equal(isInstalledMobileApp({standalone:true,userAgent:'Windows Chrome',maxTouchPoints:10}),false);
  assert.equal(isInstalledMobileApp({standalone:false,iosStandalone:true,userAgent:'iPhone'}),true);
  assert.equal(isInstalledMobileApp({standalone:false,userAgent:'Macintosh',platform:'MacIntel',maxTouchPoints:5}),false);
});
