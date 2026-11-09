import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import * as roles from '../src/lib/server/roles.ts';

const root = new URL('../', import.meta.url);
function moduleAt(path, dependencies, suffix = '') {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, root), 'utf8') + suffix, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, process, console, Date, require(name) {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return exports;
}
const policy = moduleAt('src/lib/notifications/event-eligibility.ts', { '@/lib/server/roles': roles });

test('event push policy follows existing recipient lists, including secondary roles', () => {
  for (const role of ['Chief Engineer','Maintenance Technician','Front Desk Manager','General Manager','Assistant General Manager','Engineering Manager','Front Desk','Housekeeping','system_admin']) {
    for (const secondary_roles of [[], ['engineer'], ['technician']]) {
      const profile = { role, secondary_roles };
      assert.equal(policy.receivesEventPush(profile, { id:'pool-closed:fixture' }), roles.receivesPoolClosedNotifications(profile));
      assert.equal(policy.receivesEventPush(profile, { id:'room-operations:fixture' }), roles.profileHasRole(profile, 'engineer'));
      assert.equal(policy.receivesEventPush(profile, { id:'room-rank-change:fixture', work_order_id:null }), true);
      assert.equal(policy.receivesEventPush(profile, { id:'new-order:fixture' }), roles.receivesWorkOrderNotifications(profile));
      assert.equal(policy.receivesEventPush(profile, { id:'uuid-history', work_order_id:'fixture' }), roles.receivesWorkOrderNotifications(profile));
      assert.equal(policy.receivesEventPush(profile, { id:'unrecognized' }), false);
    }
  }
  assert.equal(policy.receivesEventPush({role:'Front Desk Manager'}, {id:'new-order:fixture'}), false);
});

const hotel = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const device = '00000000-0000-4000-8000-000000000003';
async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table profiles(id uuid primary key, active boolean);
    create table hotel_members(hotel_id uuid, user_id uuid, active boolean);
    create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(), hotel_id uuid, recipient_user_id uuid,
      notification_key text, recorded_at timestamptz, read_at timestamptz, cleared_at timestamptz,
      unique(hotel_id,recipient_user_id,notification_key));
    create table cmpri_web_push_subscriptions(id uuid primary key, hotel_id uuid, recipient_user_id uuid, enabled boolean);
    create table cmpri_web_push_deliveries(id uuid primary key default gen_random_uuid(), hotel_id uuid, recipient_user_id uuid,
      subscription_id uuid, notification_key text, status text, unique(hotel_id,recipient_user_id,subscription_id,notification_key));
    insert into profiles values ('${user}',true);
    insert into hotel_members values ('${hotel}','${user}',true);
    insert into cmpri_web_push_subscriptions values ('${device}','${hotel}','${user}',true);
    insert into cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,recorded_at)
      values ('${hotel}','${user}','existing-before-migration',now());
    -- Model the pre-existing INSERT resolution trigger and exercise trigger order.
    create function resolve_fixture() returns trigger language plpgsql as $$ begin
      if new.notification_key = 'resolved-by-existing-trigger' then
        update cmpri_dashboard_notifications set read_at=now() where id=new.id;
      end if; return new; end $$;
    create trigger cmpri_resolve_late_technician_notification_reads after insert on cmpri_dashboard_notifications
      for each row execute function resolve_fixture();
  `);
  await db.exec(readFileSync(new URL('supabase/migrations/20261013145012_cmpri_prospective_event_push.sql',root),'utf8'));
  return db;
}
async function insert(db,key,{ requested=true, old=false, read=false }={}) {
  return db.query(`insert into cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,recorded_at,push_requested,read_at)
    values ($1,$2,$3,clock_timestamp() + interval '${old ? '-1 day' : '1 second'}',$4,${read?'now()':'null'})
    on conflict (hotel_id,recipient_user_id,notification_key) do nothing returning id`,[hotel,user,key,requested]);
}

test('actual migration queues atomically once, excludes old/imported/resolved events, and survives desktop reads', async()=>{
  const db=await database();
  try {
    assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,0);
    await insert(db,'old-scanned-event',{old:true});
    await insert(db,'legacy-import',{requested:false});
    await insert(db,'already-read',{read:true});
    await insert(db,'resolved-by-existing-trigger');
    assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,0);
    const added=await insert(db,'room-operations:new');
    await insert(db,'room-operations:new');
    await db.query('update cmpri_dashboard_notifications set read_at=now(),cleared_at=now() where id=$1',[added.rows[0].id]);
    const rows=(await db.query('select * from cmpri_web_push_deliveries')).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].status,'pending'); assert.equal(rows[0].inbox_id,added.rows[0].id);
    await db.exec('begin'); await insert(db,'rolled-back'); await db.exec('rollback');
    assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,1);
    await db.query('update cmpri_dashboard_notifications set push_requested=true where notification_key=$1',['legacy-import']);
    assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,1);
  } finally { await db.close(); }
});

test('intent captures enabled devices and active hotel membership, with no later subscription backfill', async()=>{
  const db=await database();
  try {
    await db.exec('update cmpri_web_push_subscriptions set enabled=false'); await insert(db,'disabled');
    await db.exec('update cmpri_web_push_subscriptions set enabled=true; update profiles set active=false'); await insert(db,'inactive-profile');
    await db.exec('update profiles set active=true; update hotel_members set active=false'); await insert(db,'inactive-member');
    await db.exec('update hotel_members set active=true'); await insert(db,'enabled');
    const second='00000000-0000-4000-8000-000000000004';
    await db.query('insert into cmpri_web_push_subscriptions values ($1,$2,$3,true)',[second,hotel,user]);
    await insert(db,'enabled');
    assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,1);
    await insert(db,'next-event');
    assert.equal((await db.query('select * from cmpri_web_push_deliveries')).rows.length,3);
    const privileges=(await db.query(`select has_table_privilege('authenticated','cmpri_event_push_rollout','SELECT') as browser,
      has_function_privilege('authenticated','cmpri_queue_dashboard_event_push()','EXECUTE') as trigger,
      has_table_privilege('service_role','cmpri_event_push_rollout','SELECT') as service`)).rows[0];
    assert.deepEqual(privileges,{browser:false,trigger:false,service:true});
  } finally { await db.close(); }
});

function recoveryHarness() {
  const deliveries=[
    {notification_key:'room-operations:read',inbox_id:'new-intent',status:'pending'},
    {notification_key:'legacy-read',inbox_id:null,status:'pending'},
    {notification_key:'legacy-unread',inbox_id:null,status:'pending'},
    {notification_key:'already-sent',inbox_id:'accepted-intent',status:'sent'},
  ];
  const inbox=[
    {notification_key:'room-operations:read',read_at:'today',cleared_at:'today'},
    {notification_key:'legacy-read',read_at:'today'},
    {notification_key:'legacy-unread'},
    {notification_key:'already-sent'},
    {notification_key:'historical-no-intent'},
  ];
  const sent=[];
  const admin={from(table){let filters=[];const q={select(){return q},eq(){return q},order(){return q},range(){return q},
    in(k,v){filters.push(row=>v.includes(row[k]));return q},then(resolve){return Promise.resolve({data:(table==='cmpri_web_push_deliveries'?deliveries:inbox).filter(row=>filters.every(f=>f(row))),error:null}).then(resolve)}};return q}};
  const route=moduleAt('src/app/api/notifications/dispatch/route.ts',{
    'next/server':{},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/supabase-admin':{},'@/lib/server/roles':roles,
    '@/lib/notifications/web-push':{dispatchWebPushNotifications:async(_a,_u,_p,notifications)=>sent.push(...notifications)},
    '@/lib/server/phone-notification-tests':{},'@/lib/dashboard/work-order-notifications':{},
  },'\nexport { dispatchPendingInboxNotifications };');
  return {admin,sent,route};
}
test('cron recovers captured intent after desktop read/clear without replaying legacy read or unqueued history',async()=>{
  const h=recoveryHarness(); await h.route.dispatchPendingInboxNotifications(h.admin,{id:user,role:'Chief Engineer'});
  assert.deepEqual(h.sent.map(n=>n.id),['room-operations:read','legacy-unread']);
});


test('report correction push is limited to Chief Engineer and the established legacy Chief account',()=>{
 for(const role of ['Engineer','Engineering Manager','Technician','system_admin','Front Desk Manager']) assert.equal(policy.receivesEventPush({role},{id:'report-correction:1',work_order_id:'ticket'}),false,role);
 assert.equal(policy.receivesEventPush({role:'Chief Engineer'},{id:'report-correction:1'}),true);
 assert.equal(policy.receivesEventPush({role:'manager',secondary_roles:['Chief Engineer']},{id:'report-correction:1'}),true);
 assert.equal(policy.receivesEventPush({id:'750f77bf-7d5d-4ca6-8421-e025edea87ba',email:'maint.cmpri@hawkeyehotels.com',role:'system_admin',secondary_roles:['engineer']},{id:'report-correction:1'}),true);
});
