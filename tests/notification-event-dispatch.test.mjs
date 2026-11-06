import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {loadTs} from './helpers/load-ts.mjs';
test('delivery insertion queues one authenticated wake and failure retains the delivery for recovery',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema cmpri_private;create schema vault;create schema net;
 create table vault.decrypted_secrets(name text,decrypted_secret text);insert into vault.decrypted_secrets values('cmpri_notification_dispatch','synthetic-only');
 create table wakes(url text,headers jsonb,body jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin insert into public.wakes values(url,headers,body);return 1;end$$;
 create table cmpri_web_push_deliveries(id integer,status text);
 create function cmpri_pool_reconcile(p_hotel uuid,p_facility uuid,p_new_event boolean default false) returns jsonb language sql as $$select '{}'::jsonb$$;`);
 const name=readdirSync('supabase/migrations').find(n=>n.endsWith('_notification_event_dispatch.sql'));
 await db.exec(readFileSync('supabase/migrations/'+name,'utf8').replace('create extension if not exists pg_net with schema extensions;',''));
 await db.exec("insert into cmpri_web_push_deliveries values(1,'pending'),(2,'sent')");
 const wakes=(await db.query('select * from wakes')).rows;assert.equal(wakes.length,1);assert.equal(wakes[0].headers.Authorization,'Bearer synthetic-only');assert.equal(wakes[0].url,'https://www.cmpri-engineering.com/api/notifications/dispatch');
 await db.exec(`create or replace function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin raise exception 'queue offline';end$$;insert into cmpri_web_push_deliveries values(3,'pending');`);
 assert.equal((await db.query('select count(*)::int n from cmpri_web_push_deliveries')).rows[0].n,3);
 await db.exec('set role authenticated');await assert.rejects(db.exec('select cmpri_private.dispatch_notification_event()'),/permission denied/);
 }finally{await db.close()}
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
