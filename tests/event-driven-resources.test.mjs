import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { eventRefresh } from '../src/lib/events/refresh.ts';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('refresh coalesces bursts, retains an in-flight invalidation, and stops on cleanup', async () => {
 let calls=0, release;
 const refresh=eventRefresh(async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);});
 refresh.request();refresh.request();await new Promise(setImmediate);assert.equal(calls,1);
 refresh.request();refresh.request();release();await new Promise(setImmediate);assert.equal(calls,2);
 refresh.stop();refresh.request();await new Promise(setImmediate);assert.equal(calls,2);
});
test('Postgres materializes role-correct inbox entries transactionally; private signals enforce user/hotel/activity boundaries', async () => {
 const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;
 create table profiles(id uuid primary key,role text,secondary_roles text[] default '{}',full_name text,active boolean);
 create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
 create table work_orders(id uuid primary key,hotel_id uuid,display_id text,room text,issue text,status text,created_at timestamptz default now());
 create table cmpri_dashboard_notifications(id uuid default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,message text check(length(message)<=500),recorded_at timestamptz,push_requested boolean,read_at timestamptz,cleared_at timestamptz,unique(hotel_id,recipient_user_id,notification_key));
 create table cmpri_pool_control(hotel_id uuid,revision bigint);
 create table room_operations(hotel_id uuid,room text);
 create table cmpri_room_operation_imports(hotel_id uuid);
 create table user_feedback(hotel_id uuid);
 create table cmpri_work_order_drafts(hotel_id uuid);
 create table cmpri_work_order_history(id uuid,hotel_id uuid,work_order_id uuid,actor_user_id uuid,actor_name text,event_type text,old_status text,new_status text,changed_fields jsonb,snapshot jsonb,recorded_at timestamptz default now());
 create table cmpri_work_order_technician_views(id uuid,hotel_id uuid,work_order_id uuid,work_order_display_id text,viewed_at timestamptz default now());`);
 await db.exec(readFileSync('supabase/migrations/20261106064638_event_driven_resources.sql','utf8'));
 const roles=['chief_engineer','technician','front_desk','manager','housekeeping','engineer','system_admin'];
 for(let n=0;n<roles.length;n++) {
  await db.query('insert into profiles values($1,$2,$3,$4,true)',[id(n+10),roles[n],[],`Staff ${n}`]);
  await db.query('insert into hotel_members values($1,$2,true)',[id(1),id(n+10)]);
 }
 await db.query('insert into profiles values($1,$2,$3,$4,true)',[id(30),'technician',[],'Other hotel']);
 await db.query('insert into hotel_members values($1,$2,true)',[id(2),id(30)]);
 await db.query('insert into work_orders(id,hotel_id,display_id,room,issue,status) values($1,$2,$3,$4,$5,$6)',[id(3),id(1),'123','307','Air conditioner','Open']);
 let inbox=(await db.query('select * from cmpri_dashboard_notifications order by recipient_user_id')).rows;
 assert.deepEqual(inbox.map(r=>r.recipient_user_id),[id(10),id(11),id(16)]);
 assert.ok(inbox.every(r=>r.message==='New 123: 307 — Air conditioner · Open'&&r.push_requested));
 await db.query('insert into cmpri_work_order_history(id,hotel_id,work_order_id,actor_user_id,actor_name,event_type,old_status,new_status,changed_fields,snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id(4),id(1),id(3),id(11),'Staff 1','closed','In Progress','Closed',{actor_role:'technician'},{display_id:'123',room:'307',issue:'Air conditioner'}]);
 inbox=(await db.query("select * from cmpri_dashboard_notifications where notification_key like 'history:%'")).rows;
 assert.deepEqual(inbox.map(r=>r.recipient_user_id).sort(),[id(10),id(16)]);
 assert.match(inbox[0].message,/status changed: In Progress → Closed/);
 // Updates produce signals, never re-create the original notification.
 await db.query('update work_orders set issue=$1 where id=$2',['Changed',id(3)]);
 assert.equal((await db.query("select count(*)::int n from cmpri_dashboard_notifications where notification_key like 'new-order:%'")).rows[0].n,3);
 // Atomic failure: reject inbox insert, and the source insert must roll back too.
 await db.exec(`create function reject_notification() returns trigger language plpgsql as $$begin raise exception 'Inbox unavailable';end$$;create trigger reject_notification before insert on cmpri_dashboard_notifications for each row execute function reject_notification();`);
 await assert.rejects(db.query('insert into work_orders(id,hotel_id) values($1,$2)',[id(5),id(1)]),/Inbox unavailable/);
 assert.equal((await db.query('select count(*)::int n from work_orders where id=$1',[id(5)])).rows[0].n,0);
 await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${id(11)}',false);`);
 const signals=(await db.query('select * from cmpri_resource_signals')).rows;
 assert.ok(signals.length>0);assert.ok(signals.every(r=>r.recipient_user_id===id(11)&&r.hotel_id===id(1)));
 await assert.rejects(db.exec(`update cmpri_resource_signals set revision=999`),/permission denied/);
 await assert.rejects(db.exec(`select cmpri_private.notification_roles('admin','{}')`),/permission denied/);
 await db.exec(`reset role;update hotel_members set active=false where user_id='${id(11)}';set role authenticated;`);
 assert.equal((await db.query('select * from cmpri_resource_signals')).rows.length,0);
 await db.exec(`reset role;set role anon;`);await assert.rejects(db.query('select * from cmpri_resource_signals'),/permission denied/);
 } finally { await db.close(); }
});

test('browser subscribers share one channel, route only relevant signals, catch up on reconnect and clean up on logout/unmount', async () => {
 const vm=await import('node:vm');const ts=await import('typescript');
 const handlers=new Map(),documentHandlers=new Map(),channels=[];let authCallback,unsubscribed=0,removed=0;
 const client={auth:{onAuthStateChange(callback){authCallback=callback;return {data:{subscription:{unsubscribe(){unsubscribed++;}}}};}},
 channel(){const channel={on(_type,_filter,callback){channel.change=callback;return channel;},subscribe(callback){channel.status=callback;return channel;}};channels.push(channel);return channel;},removeChannel(){removed++;return Promise.resolve();}};
 const exports={};vm.runInNewContext(ts.default.transpileModule(readFileSync('src/lib/events/browser.ts','utf8'),{compilerOptions:{module:ts.default.ModuleKind.CommonJS,target:ts.default.ScriptTarget.ES2022}}).outputText,{
 exports,require(name){if(name.includes('supabase/client'))return {createClient:()=>client};if(name==='./refresh')return {eventRefresh};if(name==='./visibility')return {resourceViewVisible:()=>true,watchResourceVisibility:()=>()=>{}};throw Error(name);},queueMicrotask,crypto:{randomUUID:()=>String(channels.length)},document:{hidden:false,addEventListener:(key,value)=>documentHandlers.set(key,value),removeEventListener:key=>documentHandlers.delete(key)},window:{addEventListener:(key,value)=>handlers.set(key,value),removeEventListener:key=>handlers.delete(key)}});
 let orders=0,inbox=0;const stopOrders=exports.subscribeResources(['orders'],async()=>orders++),stopInbox=exports.subscribeResources(['inbox'],async()=>inbox++);
 await new Promise(setImmediate);assert.equal(orders,1);assert.equal(inbox,1);
 authCallback('INITIAL_SESSION',{user:{id:'one'}});await new Promise(setImmediate);assert.equal(channels.length,1);
 const before=orders;channels[0].change({new:{topic:'inbox'}});await new Promise(setImmediate);assert.equal(orders,before);assert.equal(inbox,3);
 channels[0].status('SUBSCRIBED');await new Promise(setImmediate);assert.equal(orders,before+1);
 authCallback('SIGNED_IN',{user:{id:'two'}});await new Promise(setImmediate);assert.equal(removed,1);assert.equal(channels.length,2);
 const previous=inbox;channels[0].change({new:{topic:'inbox'}});await new Promise(setImmediate);assert.equal(inbox,previous,'retired identity cannot invalidate current session');
 stopOrders();assert.equal(removed,1);stopInbox();assert.equal(removed,2);assert.equal(unsubscribed,1);assert.equal(handlers.size,0);assert.equal(documentHandlers.size,0);
});

test('embedded mention inboxes do not allocate redundant Realtime subscriptions', async () => {
 const vm=await import('node:vm'),ts=await import('typescript');let subscriptions=0,cleanup;
 const window={self:{},top:{}};
 const exports={};vm.runInNewContext(ts.default.transpileModule(readFileSync('src/components/WorkOrderMentionsInbox.tsx','utf8'),{compilerOptions:{module:ts.default.ModuleKind.CommonJS,target:ts.default.ScriptTarget.ES2022,jsx:ts.default.JsxEmit.ReactJSX}}).outputText,{
 exports,window,require(name){
  if(name==='react')return {useState:value=>[value,()=>{}],useCallback:fn=>fn,useEffect:fn=>{cleanup=fn();}};
  if(name==='@/lib/events/browser')return {subscribeResources:()=>{subscriptions++;return ()=>subscriptions--;}};
  if(name==='react/jsx-runtime')return {jsx:()=>null,jsxs:()=>null};
  return {};
 }});
 exports.default();assert.equal(subscriptions,0);assert.equal(cleanup,undefined);
 window.self=window.top;exports.default();assert.equal(subscriptions,1);cleanup();assert.equal(subscriptions,0);
});
