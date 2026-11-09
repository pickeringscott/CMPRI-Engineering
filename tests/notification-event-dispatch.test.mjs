import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {loadTs} from './helpers/load-ts.mjs';
test('batched delivery insertion queues one authenticated wake and failure retains delivery for recovery',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema cmpri_private;create schema vault;create schema net;
 create table vault.decrypted_secrets(name text,decrypted_secret text);insert into vault.decrypted_secrets values('cmpri_notification_dispatch','synthetic-only');
 create table wakes(url text,headers jsonb,body jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into public.wakes values(url,headers,body);return 1;end$$;
 create table cmpri_web_push_deliveries(id integer,status text,hotel_id uuid,recipient_user_id uuid);
 create table cmpri_web_push_subscriptions(hotel_id uuid,recipient_user_id uuid,enabled boolean);
 create function cmpri_pool_reconcile(p_hotel uuid,p_facility uuid,p_new_event boolean default false) returns jsonb language sql as $$select '{}'::jsonb$$;`);
 const name=readdirSync('supabase/migrations').find(n=>n.endsWith('_notification_event_dispatch.sql'));
 await db.exec(readFileSync('supabase/migrations/'+name,'utf8').replace('create extension if not exists pg_net with schema extensions;',''));
 await db.exec("insert into cmpri_web_push_deliveries(id,status) values(1,'pending'),(2,'sent')");
 const wakes=(await db.query('select * from wakes')).rows;assert.equal(wakes.length,1);assert.equal(wakes[0].headers.Authorization,'Bearer synthetic-only');assert.equal(wakes[0].url,'https://www.cmpri-engineering.com/api/notifications/dispatch');
 const optimized=readdirSync('supabase/migrations').find(n=>n.endsWith('_optimize_notification_dispatch.sql'));
 await db.exec(readFileSync('supabase/migrations/'+optimized,'utf8'));
 await db.exec(`delete from wakes;
 insert into cmpri_web_push_subscriptions values
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',true),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',false);
 insert into cmpri_web_push_deliveries values
 (3,'pending','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'),
 (4,'pending','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'),
 (5,'pending','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003'),
 (6,'sent','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004');`);
 const batched=(await db.query('select * from wakes')).rows;
 assert.equal(batched.length,1,'Multiple deliveries in one insert make one wake');
 assert.deepEqual(batched[0].body.recipient_user_ids.sort(),['00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003']);
 const recipients=(await db.query("select * from cmpri_pending_push_recipients('00000000-0000-4000-8000-000000000001',null,500)")).rows;
 assert.deepEqual(recipients,[{recipient_user_id:'00000000-0000-4000-8000-000000000002'}]);
 assert.deepEqual((await db.query("select * from cmpri_pending_push_recipients('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',500)")).rows,[]);
 await db.exec(`create or replace function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin raise exception 'queue offline';end$$;insert into cmpri_web_push_deliveries(id,status) values(7,'pending');`);
 assert.equal((await db.query('select count(*)::int n from cmpri_web_push_deliveries')).rows[0].n,7);
 await db.exec('set role authenticated');await assert.rejects(db.exec('select cmpri_private.dispatch_notification_event()'),/permission denied/);
 await assert.rejects(db.exec("select * from public.cmpri_pending_push_recipients('00000000-0000-4000-8000-000000000001',null,500)"),/permission denied/);
 }finally{await db.close()}
});
test('webhook targets only affected active members and old payloads retain cron recovery',async()=>{
 const wanted='00000000-0000-4000-8000-000000000002', other='00000000-0000-4000-8000-000000000003';
 const sent=[], reads=[]; let rpcCalls=0;
 const tables={
  profiles:[{id:wanted,active:true,role:'Chief Engineer'},{id:other,active:true,role:'Chief Engineer'}],
  hotel_members:[{user_id:wanted,hotel_id:'hotel',active:true},{user_id:other,hotel_id:'hotel',active:true}],
  cmpri_web_push_deliveries:[{recipient_user_id:wanted,hotel_id:'hotel',status:'pending',notification_key:'wanted',inbox_id:'1'},{recipient_user_id:other,hotel_id:'hotel',status:'pending',notification_key:'other',inbox_id:'2'}],
  cmpri_dashboard_notifications:[{recipient_user_id:wanted,hotel_id:'hotel',notification_key:'wanted',message:'wanted'},{recipient_user_id:other,hotel_id:'hotel',notification_key:'other',message:'other'}],
 };
 const admin={rpc:async()=>{rpcCalls++;return{data:[{recipient_user_id:other}],error:null}},from(table){
  const filters=[];let start=0,end=499;const q={
   select(){return q},eq(key,value){filters.push(row=>row[key]===value);return q},in(key,values){filters.push(row=>values.includes(row[key]));return q},order(){return q},range(a,b){start=a;end=b;return q},
   then(resolve,reject){reads.push(table);return Promise.resolve({data:tables[table].filter(row=>filters.every(fn=>fn(row))).slice(start,end+1),error:null}).then(resolve,reject)},
  };return q;
 }};
 const route=loadTs('src/app/api/notifications/dispatch/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},
  '@/lib/server/supabase-admin':{createSupabaseAdmin:()=>admin},
  '@/lib/notifications/web-push':{dispatchWebPushNotifications:async(_a,user,_p,items)=>sent.push({user,items})},
  '@/lib/server/phone-notification-tests':{dispatchDuePhoneNotificationTests:async()=>{}},
  '@/lib/constants':{HOTEL_ID:'hotel'},
 },{process:{env:{CMPRI_NOTIFICATION_WEBHOOK_SECRET:'fixture-secret'}}});
 const request=body=>({headers:new Headers({authorization:'Bearer fixture-secret'}),json:async()=>body});
 assert.equal((await route.POST(request({recipient_user_ids:[wanted,wanted]}))).status,200);
 assert.deepEqual(sent.map(row=>row.user),[wanted]);assert.equal(rpcCalls,0);
 assert.equal(reads.filter(name=>name==='cmpri_web_push_deliveries').length,1);
 await route.POST(request({event:'delivery_created'}));
 assert.deepEqual(sent.map(row=>row.user),[wanted,other]);assert.equal(rpcCalls,1);
});
test('webhook accepts only its dedicated secret and never treats a missing secret as authorization',async()=>{
 const route=loadTs('src/app/api/notifications/dispatch/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},
  '@/lib/server/supabase-admin':{createSupabaseAdmin:()=>{throw Error('Must not reach the database')}},
  '@/lib/notifications/web-push':{dispatchWebPushNotifications:async()=>{}},
  '@/lib/server/phone-notification-tests':{dispatchDuePhoneNotificationTests:async()=>{}},
  '@/lib/constants':{HOTEL_ID:'hotel'},
 },{process:{env:{}}});
 for(const value of [null,'Bearer wrong'])assert.equal((await route.POST({headers:new Headers(value?{authorization:value}:{})})).status,401);
});
