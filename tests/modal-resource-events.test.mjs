import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { PGlite } from '@electric-sql/pglite';
import { canApplyTicketRefresh } from '../src/lib/events/ticket-refresh.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function browserModule(view,client) {
 const cache=new Map();
 function load(path){if(cache.has(path))return cache.get(path);const exports={};cache.set(path,exports);
 vm.runInNewContext(ts.transpileModule(readFileSync(`src/lib/events/${path}.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,window:view,document:view.document,MutationObserver:view.MutationObserver,crypto:view.crypto,queueMicrotask,require:n=>n==='@/lib/supabase/client'?{createClient:()=>client}:load(n.slice(2))});return exports}return load('browser');
}
test('host and modal share one channel; hidden layer catches up, iframe removal and last listener release it',async()=>{
 const dom=new JSDOM('<div id="layer"><iframe></iframe></div>',{url:'https://cmpri.test',pretendToBeVisual:true});
 let auth,signal,subscribed,channels=0,removed=0,authStops=0;
 const client={auth:{onAuthStateChange(fn){auth=fn;return {data:{subscription:{unsubscribe(){authStops++}}}}}},channel(){channels++;return {on(_e,_f,fn){signal=fn;return this},subscribe(fn){subscribed=fn;return this}}},removeChannel(){removed++}};
 const host=browserModule(dom.window,client);let hostReads=0,childReads=0;
 const stopHost=host.subscribeResources(['orders'],async()=>{hostReads++});
 const frame=dom.window.document.querySelector('iframe');const child=browserModule(frame.contentWindow,client);
 const stopChild=child.subscribeResources(['orders'],async()=>{childReads++});
 auth('SIGNED_IN',{user:{id:'staff'}});await tick();subscribed('SUBSCRIBED');await tick();
 assert.equal(channels,1);assert.ok(hostReads>0&&childReads>0);
 const layer=dom.window.document.querySelector('#layer');layer.setAttribute('aria-hidden','true');await tick();let before=childReads;
 signal({new:{topic:'orders'}});await tick();assert.equal(childReads,before);
 layer.removeAttribute('aria-hidden');await tick();assert.equal(childReads,before+1);
 before=childReads;frame.remove();await tick();signal({new:{topic:'orders'}});await tick();assert.equal(childReads,before);
 stopChild();stopHost();assert.equal(removed,1);assert.equal(authStops,1);dom.window.close();
});
test('ticket event response cannot overwrite dirty edits, typing during fetch, or an in-flight save',()=>{
 assert.equal(canApplyTicketRefresh('a',{fingerprint:'a',dirty:false,saving:false}),true);
 for(const state of [{fingerprint:'a',dirty:true,saving:false},{fingerprint:'b',dirty:false,saving:false},{fingerprint:'a',dirty:false,saving:true}])assert.equal(canApplyTicketRefresh('a',state),false);
});
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('modal signals cover history/reference/activity/photos with tenant, recipient and staging boundaries',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create table profiles(id uuid primary key,role text,secondary_roles text[],full_name text,active boolean);
 create table hotel_members(hotel_id uuid,user_id uuid,active boolean);
 create table work_orders(id uuid primary key,hotel_id uuid,display_id text,room text,issue text,status text,created_at timestamptz default now());
 create table cmpri_dashboard_notifications(id uuid default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,work_order_id uuid,message text,recorded_at timestamptz,push_requested boolean,unique(hotel_id,recipient_user_id,notification_key));
 create table cmpri_work_order_history(id uuid,hotel_id uuid,work_order_id uuid,actor_user_id uuid,actor_name text,event_type text,old_status text,new_status text,changed_fields jsonb,snapshot jsonb,recorded_at timestamptz default now());
 create table cmpri_work_order_technician_views(id uuid,hotel_id uuid,work_order_id uuid,work_order_display_id text,viewed_at timestamptz default now());
 create schema storage;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
 create table cmpri_purchase_shipments(id uuid,purchase_id uuid,status text);
 create table cmpri_web_push_tests(id uuid,hotel_id uuid,recipient_user_id uuid,status text);`);
 for(const name of ['cmpri_pool_control','room_operations','cmpri_room_operation_imports','user_feedback','cmpri_work_order_drafts','cmpri_assets_and_pdfs','troubleshooting_cache','locations','cmpri_purchases','cmpri_enseo_tickets','cmpri_warranty_cases','cmpri_supplier_followups'])await db.exec(`create table ${name}(id uuid,hotel_id uuid);`);
 await db.exec('create view assets as select * from cmpri_assets_and_pdfs;create view maintenance_documents as select * from cmpri_assets_and_pdfs');
 await db.exec(readFileSync('supabase/migrations/20261106133302_event_driven_resources.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261106133511_modal_resource_events.sql','utf8'));
 await db.exec(`insert into profiles values('${id(2)}','housekeeping','{}','A',true),('${id(3)}','housekeeping','{}','B',true),('${id(4)}','housekeeping','{}','Inactive',false),('${id(5)}','housekeeping','{}','Other',true);
 insert into hotel_members values('${id(1)}','${id(2)}',true),('${id(1)}','${id(3)}',true),('${id(1)}','${id(4)}',true),('${id(9)}','${id(5)}',true);
 insert into work_orders(id,hotel_id)values('${id(6)}','${id(1)}');delete from cmpri_resource_signals;`);
 for(const name of ['cmpri_assets_and_pdfs','troubleshooting_cache','locations','cmpri_purchases','cmpri_enseo_tickets','cmpri_warranty_cases','cmpri_supplier_followups'])await db.exec(`insert into ${name} values('${id(7)}','${id(1)}')`);
 await db.exec(`insert into cmpri_purchase_shipments values('${id(8)}','${id(7)}','Shipped');insert into cmpri_web_push_tests values('${id(8)}','${id(1)}','${id(2)}','accepted')`);
 const signals=(await db.query('select * from cmpri_resource_signals')).rows;
 assert.ok(signals.every(r=>r.hotel_id===id(1)&&[id(2),id(3)].includes(r.recipient_user_id)));
 assert.deepEqual(signals.filter(r=>r.topic==='inbox').map(r=>r.recipient_user_id),[id(2)]);
 assert.ok(signals.some(r=>r.topic==='reference'));assert.ok(signals.some(r=>r.topic==='rooms'));
 await db.exec('delete from cmpri_resource_signals');
 for(const name of [`${id(1)}/work-orders/${id(6)}/staging/${id(8)}.jpg`,`invalid/work-orders/${id(6)}/${id(8)}.jpg`,`${id(9)}/work-orders/${id(6)}/${id(8)}.jpg`])await db.query('insert into storage.objects(bucket_id,name)values($1,$2)',['asset-documentation',name]);
 assert.equal((await db.query('select * from cmpri_resource_signals')).rows.length,0);
 await db.query('insert into storage.objects(bucket_id,name)values($1,$2)',['asset-documentation',`${id(1)}/work-orders/${id(6)}/${id(8)}.jpg`]);
 assert.equal((await db.query("select * from cmpri_resource_signals where topic='orders'")).rows.length,2);
 await db.exec('delete from storage.objects');assert.ok((await db.query('select revision from cmpri_resource_signals')).rows.every(r=>r.revision===2));
 await db.exec('set role authenticated');await assert.rejects(db.exec('select cmpri_private.signal_ticket_photo_resource()'),/permission denied/);
 }finally{await db.close()}
});
test('actual ticket loader preserves edits made during its read and ignores a closed modal response',async()=>{
 const source=readFileSync('src/app/work-orders/[id]/page.tsx','utf8');const ast=ts.createSourceFile('ticket.tsx',source,99,true,4);let fn;
 function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='loadTicket')fn=n.getText(ast);ts.forEachChild(n,walk)}walk(ast);
 for(const scenario of ['typing','saving','closed']){
  let finish;const payload=new Promise(resolve=>finish=resolve);const messages=[];
  const lifetime={active:true};const editState={current:{dirty:false,fingerprint:'original',revision:1,saving:false}};
  const exports={};vm.runInNewContext(ts.transpileModule(fn+'\nexports.load=loadTicket;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,id:'ticket',ticketLoadGeneration:{current:0},readLifetime:{current:lifetime},editState,canApplyTicketRefresh,setLoading(){},setMessage:m=>messages.push(m),getValidSession:async()=>({access_token:'fixture'}),fetch:async()=>({ok:true,json:()=>payload})});
  const running=exports.load(false,false,true);await tick();
  if(scenario==='typing')editState.current={...editState.current,dirty:true,fingerprint:'new note'};
  if(scenario==='saving')editState.current.saving=true;
  if(scenario==='closed')lifetime.active=false;
  finish({workOrder:{revision:2}});await running;
  if(scenario==='closed')assert.deepEqual(messages,[]);else assert.match(messages[0],/unsaved text is preserved/);
 }
});
