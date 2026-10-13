import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import * as reports from '../src/lib/room-operations-reports.ts';

const source = readFileSync(new URL('../src/app/api/room-operations/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(latest = { report_date: '2026-10-09', source_type: 'legacy' }, notify = false) {
  const calls = [], inbox = [], pushes = [];
  const profiles = [{id:'engineer',role:'Chief Engineer',active:true},{id:'fdm',role:'Front Desk Manager',active:true}];
  const admin = {
    from(table) {
      const filters = [], orders = [];
      const query = {
        upsert(rows) { inbox.push(...rows); return this; },
        select() { return this; }, in(k,v) { filters.push(r => v.includes(r[k])); return this; }, eq(k,v) { if(k !== 'hotel_id') filters.push(r => r[k] === v); return this; },
        neq(k,v) { filters.push(r => r[k] !== v); return this; },
        not(k,_,v) { filters.push(r => r[k] != v); return this; },
        order(k,options) { orders.push([k, options]); return this; }, limit() { return this; },
        then(resolve) {
          const rows = table === 'locations' ? [{room_number:'101', active:true},{room_number:'102', active:true}]
            : table === 'profiles' ? profiles
            : table === 'hotel_members' ? [{user_id:'engineer',active:true},{user_id:'fdm',active:true}]
            : table === 'cmpri_dashboard_notifications' ? inbox
            : table === 'cmpri_room_operation_imports' && latest ? [latest] : [];
          return Promise.resolve({ data: rows.filter(r=>filters.every(f=>f(r))), error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name,args) { calls.push({name,args}); return { data: 'fixture-import', error: null }; },
  };
  const exports = {};
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-11T19:27:00Z'])); } }
  vm.runInNewContext(compiled, { exports, Date: FixedDate, require(name) {
    if(name === '@/lib/notifications/web-push') return { dispatchWebPushNotifications: async(_admin,id,profile,notifications)=>{ assert.ok(inbox.some(row=>row.recipient_user_id===id && row.push_requested)); pushes.push({id,profile,notifications}); } };
    if(name === 'next/server') return { NextResponse: Response };
    if(name === 'node:crypto') return { createHash };
    if(name === '@/lib/constants') return { HOTEL_ID:'fixture-hotel', HOTEL_TIME_ZONE:'America/Chicago' };
    if(name === '@/lib/server/auth') return { requireCapability: async()=>({ admin, principal:{ profile:{full_name:'Fixture'}, identity:{id:'fixture-actor'} } }) };
    if(name === '@/lib/room-operations-reports') return reports;
    if(name === '@/lib/room-operations') return { detectRoomMoves:(_, rows)=>rows };
    if(name === '@/lib/dashboard/room-operations-notifications') return { roomOperationsNotification:()=>notify ? {id:'room-operations:fixture-import',message:'Fixture room move',target_path:'/engineering/room-operations',recorded_at:'2026-10-11T19:27:00Z'} : null };
    if(name === '@/lib/server/roles') return { profileHasRole:(profile)=>profile.role==='Chief Engineer' };
    if(name === '@/lib/server/cmpri-room-operations-snapshot') return {};
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return { calls, inbox, pushes, async post(body) { const response = await exports.POST(new Request('https://fixture.invalid/api/room-operations', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) })); return {status:response.status, body:await response.json()}; } };
}
function fixture() {
  return { report_data: { room_status: { printed_date:'2026-10-10', printed_time:'01:17 PM', pages:[1], rows:[
    {room:'101', room_status:'Occupied', room_type:'KING', guest_name:'Synthetic Current', guest_code:'REG', guest_arrival_date:'09Oct26', checkout_date:'12Oct26', stay_nights:3, incoming_name:'Synthetic Incoming', incoming_type:'QUEEN', incoming_arrival_date:'12Oct26', incoming_reserved:true, source_page:1},
    {room:'102', room_status:'OOO', source_page:1},
  ] }, expected_departures:null } };
}
test('October 10 structured report validates over October 9 legacy source on October 11 without saving', async()=>{
  const h=harness(); const result=await h.post({...fixture(), validate_only:true});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.date,'2026-10-10');
  assert.equal(result.body.report_metadata.room_status.printed_time,'13:17:00');
  assert.equal(result.body.rows[0].guest_name,'Synthetic Current');
  assert.equal(result.body.rows[0].incoming_name,'Synthetic Incoming');
  assert.equal(result.body.rows[0].checkout_date,'2026-10-12');
  assert.equal(result.body.rows[0].checkout_time,'11:00:00');
  assert.equal(result.body.rows[0].checkout_time_explicit,false);
  assert.equal(result.body.rows[1].room_status,'OOO');
  assert.equal(h.calls.length,0);
});
test('saving older-than-today report sends its actual source date to one atomic replacement',async()=>{
  const h=harness(); const result=await h.post(fixture());
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,'cmpri_replace_room_operations');
  assert.equal(h.calls[0].args.p_report_date,'2026-10-10');
  assert.equal(h.calls[0].args.p_rows[0].source_report_date,'2026-10-10');
});
test('stale, same-date legacy, future, substituted and mismatched report dates never save',async()=>{
  for(const latest of [{report_date:'2026-10-11',source_type:'legacy'},{report_date:'2026-10-10',source_type:'legacy'}]) {
    const h=harness(latest); assert.equal((await h.post(fixture())).status,409); assert.equal(h.calls.length,0);
  }
  for(const change of [b=>b.report_data.room_status.printed_date='2026-10-12', b=>b.report_date='2026-10-11', b=>b.report_data.expected_departures={printed_date:'2026-10-11',pages:[1],rows:[]}]) {
    const h=harness(), b=fixture(); change(b); assert.equal((await h.post(b)).status,422); assert.equal(h.calls.length,0);
  }
});
test('each missing occupied field, missing room, or unreadable incoming guest rejects the whole snapshot',async()=>{
  const changes=['guest_name','guest_code','room_type','guest_arrival_date','checkout_date','stay_nights'].map(field=>b=>delete b.report_data.room_status.rows[0][field]);
  changes.push(b=>b.report_data.room_status.rows.pop(), b=>b.report_data.room_status.rows[0].incoming_name='[UNREADABLE]');
  for(const change of changes) { const h=harness(),b=fixture(); change(b); const result=await h.post(b); assert.equal(result.status,422,JSON.stringify(result.body)); assert.equal(h.calls.length,0); }
});
test('same-source-date departures carry forward with original provenance on a later upload day',async()=>{
  const h=harness({report_date:'2026-10-10',source_type:'file',status_printed_time:'08:00:00',status_fingerprint:'old',expected_departures_printed_date:'2026-10-10',expected_departures_printed_time:'08:00:00',expected_departures_uploaded_at:'2026-10-10T13:00:00Z',departures_fingerprint:'departures',departures_rows:[{room:'101',checkout_date:'2026-10-10',checkout_time:'10:30 AM'}]});
  const result=await h.post(fixture()); assert.equal(result.status,200,JSON.stringify(result.body));
  const row=h.calls[0].args.p_rows[0]; assert.equal(row.checkout_date,'2026-10-10'); assert.equal(row.checkout_time,'10:30:00'); assert.equal(row.checkout_source_uploaded_at,'2026-10-10T13:00:00Z');
});
test('source chronology and same-date printed-time ordering are independent of calendar today',()=>{
  const latest={printed_date:'2026-10-10',printed_time:'08:00:00',fingerprint:'old'};
  for(const [time,fingerprint,error] of [['08:01:00','new',false],['08:00:00','new',true],[null,'new',true],['08:00:00','old',false]]) {
    assert.equal(Boolean(reports.reportReplacementError('Room Status',{printed_date:'2026-10-10',printed_time:time},latest,'2026-10-11',fingerprint)),error);
  }
});

test('room import persists prospective intent and dispatches promptly only to existing engineer recipients',async()=>{
  const h=harness(undefined,true); const result=await h.post(fixture());
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.notifications_recorded,true);
  assert.deepEqual(h.inbox.map(row=>row.recipient_user_id),['engineer']);
  assert.deepEqual(h.pushes.map(row=>row.id),['engineer']);
  assert.equal(h.pushes[0].notifications[0].id,'room-operations:fixture-import');
});
