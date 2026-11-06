import * as targetPolicy from '../src/lib/staff-note-targets.ts';
import * as workOrderReferences from '../src/lib/work-order-reference.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import * as roles from '../src/lib/server/roles.ts';
import {canReadWorkOrder} from '../src/lib/work-order-read-policy.ts';
import {defaultNotificationSchedule,isWithinNotificationSchedule,isStaffNotesPushEligibleProfile} from '../src/lib/notifications/schedule.ts';
function load(path,deps) {
 const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require(name){if(name in deps)return deps[name];throw Error(name);},console,Date,Set,Map});return exports;
}
const policy=load('../src/lib/staff-notes.ts',{'./server/roles':roles,'./work-order-reference.js':workOrderReferences,'./staff-note-targets':targetPolicy});
const push=load('../src/lib/notifications/event-eligibility.ts',{'@/lib/server/roles':roles});
const management=['Chief Engineer','Maintenance Technician','General Manager','Assistant General Manager','Front Desk Manager'];
const profiles=[...management.map((role,i)=>({id:`m${i}`,role,full_name:`Manager${i}`})),{id:'fd',role:'Front Desk',full_name:'Front Desk'},{id:'h1',role:'Lead Housekeeper',full_name:'Deon Housekeeper'},{id:'h2',role:'Lead Housekeeper',full_name:'Pat Housekeeper'}];
test('all five management roles receive ordinary posts; submit-only requires exact mentions and longest role wins',()=>{
 assert.deepEqual(Array.from(policy.staffRecipients('Ordinary post',profiles),r=>r.user_id),profiles.slice(0,5).map(p=>p.id));
 assert.deepEqual(Array.from(policy.staffRecipients('@LEAD HOUSEKEEPER and @Housekeeping @Deon 😀',profiles),r=>r.user_id),[...profiles.slice(0,5).map(p=>p.id),'h1','h2']);
 assert.equal(policy.staffRecipients('@Front Desk Manager',profiles).some(r=>r.user_id==='fd'),false);
 assert.equal(policy.staffRecipients('person@Deon @Deonn',profiles).some(r=>r.user_id==='h1'),false);
 assert.equal(policy.staffRecipients('@Deon',profiles).some(r=>r.user_id==='h2'),false);
 const fd=policy.staffRecipients('@Front Desk',profiles).find(r=>r.user_id==='fd');assert.equal(fd.push,false);
 for(const p of profiles) assert.equal(push.receivesEventPush(p,{id:'staff-note:fixture'}),p.id!=='fd');
 assert.equal(push.receivesEventPush({role:'Front Desk',secondary_roles:['engineer']},{id:'staff-note:fixture'}),false);
});
test('two lead housekeepers use independent schedules; no Front Desk phone enrollment',()=>{
 const first=defaultNotificationSchedule(),second=defaultNotificationSchedule();
 first.monday={enabled:true,start:'09:00',end:'12:00'};second.monday={enabled:true,start:'13:00',end:'17:00'};
 const date=new Date('2026-01-05T10:00:00Z');
 assert.equal(isWithinNotificationSchedule({timezone:'UTC',schedule:first},date),true);
 assert.equal(isWithinNotificationSchedule({timezone:'UTC',schedule:second},date),false);
 assert.equal(isStaffNotesPushEligibleProfile({role:'Lead Housekeeper'}),true);
 assert.equal(isStaffNotesPushEligibleProfile({role:'Front Desk'}),false);
});
test('ticket references share all-state read access and retain hotel isolation',()=>{
 assert.deepEqual(Array.from(policy.staffTicketNumbers('😀 #105 @work order 106 #105')),['105','106']);
 const reader={userId:'self',hotelId:'h',canRead:true,canViewAllStatuses:false,technician:false,technicianName:''};
 for(const status of ['Draft','Pending Verification','Completed','Closed']) {
  assert.equal(canReadWorkOrder(reader,{hotel_id:'h',status,created_by:'other'}),true);
  assert.equal(canReadWorkOrder(reader,{hotel_id:'other',status,created_by:'other'}),false);
 }
 assert.equal(canReadWorkOrder(reader,{hotel_id:'h',status:'Open'}),true);
 assert.equal(canReadWorkOrder(reader,{hotel_id:'other',status:'Open'}),false);
 assert.equal(canReadWorkOrder(reader,{hotel_id:'h',status:'Closed',created_by:'self'}),true);
});
test('actual SQL post transaction, duplicates, parent hotel isolation, RLS, and unchanged unrelated data',async()=>{
 const db=new PGlite();
 const hotel='00000000-0000-4000-8000-000000000001',otherHotel='00000000-0000-4000-8000-000000000002',author='00000000-0000-4000-8000-000000000003',recipient='00000000-0000-4000-8000-000000000004',request='00000000-0000-4000-8000-000000000005';
 try {
 await db.exec(`create role authenticated;create role anon;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table hotels(id uuid primary key);create table profiles(id uuid primary key,active boolean);create table hotel_members(user_id uuid,hotel_id uuid,active boolean);
 create function public.is_hotel_member(h uuid) returns boolean language sql security definer set search_path='' as $$select exists(select 1 from public.hotel_members m join public.profiles p on p.id=m.user_id where m.hotel_id=h and m.user_id=auth.uid() and m.active and p.active)$$;
 create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(),hotel_id uuid,recipient_user_id uuid,notification_key text,target_path text,message text,recorded_at timestamptz,push_requested boolean,unique(hotel_id,recipient_user_id,notification_key));
 insert into hotels values('${hotel}'),('${otherHotel}');insert into profiles values('${author}',true),('${recipient}',true);insert into hotel_members values('${author}','${hotel}',true),('${author}','${otherHotel}',true),('${recipient}','${hotel}',true);
 create table untouched(value text);insert into untouched values('original');`);
 await db.exec(readFileSync(new URL('../supabase/migrations/20261015090000_cmpri_staff_notes.sql',import.meta.url),'utf8'));
 const post=async(h,b,req=request,parent=null,recipients=[{user_id:recipient,push:true}])=>(await db.query('select public.cmpri_post_staff_note($1,$2,$3,$4,$5,$6,$7) id',[h,author,'Scott',b,parent,req,JSON.stringify(recipients)])).rows[0].id;
 const id=await post(hotel,'😀 @Deon #105');assert.equal(await post(hotel,'😀 @Deon #105'),id);
 assert.equal((await db.query('select count(*)::int n from cmpri_staff_notes')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from cmpri_dashboard_notifications')).rows[0].n,1);
 await assert.rejects(post(hotel,'changed'),/Request already used/);
 await assert.rejects(post(otherHotel,'bad reply','00000000-0000-4000-8000-000000000006',id),/foreign key/);
 assert.equal((await db.query('select count(*)::int n from cmpri_staff_notes')).rows[0].n,1);
 await post(hotel,'reply','00000000-0000-4000-8000-000000000007',id);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[recipient]);await db.exec('set role authenticated');
 assert.equal((await db.query('select * from cmpri_staff_notes')).rows.length,2);
 await assert.rejects(db.exec("insert into cmpri_staff_notes default values"),/permission denied/);
 await assert.rejects(post(hotel,'forged','00000000-0000-4000-8000-000000000008'),/permission denied/);
 await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[recipient]);await db.exec('set role authenticated');
 assert.equal((await db.query('select * from cmpri_staff_notes')).rows.length,0);await db.exec('reset role');
 await db.exec('set role anon');await assert.rejects(db.query('select * from cmpri_staff_notes'),/permission denied/);await db.exec('reset role');
 assert.equal((await db.query('select value from untouched')).rows[0].value,'original');
 } finally {await db.close();}
});

test('personal completion chooses the first-name alias while ambiguous people require selection',()=>{
 const directory=policy.staffMentionDirectory([{id:'scott',role:'engineer',full_name:'Scott Reed'},{id:'matt',role:'technician',full_name:'Matt Jones'},{id:'mary',role:'manager',full_name:'Mary Smith'}]);
 assert.equal(policy.staffMentionCompletion('@Sc',3,directory).mention.label,'Scott');
 assert.deepEqual(Array.from(policy.staffMentionCompletion('@Sc',3,directory).mention.userIds),['scott']);
 assert.equal(policy.staffMentionCompletion('@ma',3,directory),null);
 assert.equal(policy.staffMentionMatches('@Scott Reed',directory)[0].mention.userIds[0],'scott');
 const repeated=policy.staffMentionDirectory([{id:'one',role:'technician',full_name:'Matt Jones'},{id:'two',role:'technician',full_name:'Matt Smith'}]);
 assert.equal(policy.staffMentionCompletion('@Matt',5,repeated),null);
});
test('Staff Notes ticket tags use the actual shared number without changing stored text',()=>{
 const body='Room 311: #261016001 and @work order 261015002, WO#261014003';
 const refs=policy.staffTicketReferences(body);
 assert.deepEqual(Array.from(refs,r=>r.label),['WO#261016001','WO#261015002','WO#261014003']);
 assert.deepEqual(Array.from(policy.staffTicketNumbers(body)),['261016001','261015002','261014003']);
 assert.equal(body,'Room 311: #261016001 and @work order 261015002, WO#261014003');
});
