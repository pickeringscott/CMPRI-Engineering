import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('all action families suppress the actor before inbox and push creation while other and system recipients remain',async()=>{
 const db=new PGlite();
 try {
  await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
  const dir=new URL('../supabase/migrations/',import.meta.url);
  const file=readdirSync(dir).find(name=>name.endsWith('_suppress_self_notifications.sql'));
  assert.ok(file);
  const migration=readFileSync(new URL(file,dir),'utf8');
  const captureAt=migration.indexOf('CREATE OR REPLACE FUNCTION public.cmpri_capture_work_order_history_actor');
  const poolAt=migration.indexOf('CREATE OR REPLACE FUNCTION public.cmpri_pool_action',captureAt);
  const logAt=migration.indexOf('CREATE OR REPLACE FUNCTION public.cmpri_pool_status_changed',poolAt);
  const cleanupAt=migration.indexOf('-- Clear only previously materialized',logAt);
  const sections={
   __HELPERS__:migration.slice(migration.indexOf('create function cmpri_private.notification_event_actor'),captureAt),
   __CAPTURE__:migration.slice(captureAt,poolAt),
   __POOL_ACTION__:migration.slice(poolAt,logAt),
   __POOL_LOG__:migration.slice(logAt,cleanupAt),
  };
  const queue=readFileSync(new URL('20261013145012_cmpri_prospective_event_push.sql',dir),'utf8').match(/create function public\.cmpri_queue_dashboard_event_push\(\)[\s\S]*?\n\$\$;/i)?.[0];
  assert.ok(queue);
  sections.__QUEUE__=queue;
  let sql=readFileSync(new URL('fixtures/self-notifications.sql',import.meta.url),'utf8');
  for(const [token,body]of Object.entries(sections)){
   assert.ok(body.length>100,token);
   sql=sql.replace(token,()=>body.replaceAll('cmpri_private.','cmpri_self_notification_validation.').replaceAll('public.','cmpri_self_notification_validation.'));
  }
  const result=await db.exec(sql);
  assert.match(result.at(-1).rows[0].verification,/PASS:/);
  assert.equal((await db.query("select to_regnamespace('cmpri_self_notification_validation') value")).rows[0].value,null);
 } finally {await db.close();}
});
