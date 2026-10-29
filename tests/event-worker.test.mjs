import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import * as roles from '../src/lib/server/roles.ts';
function moduleAt(path,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,console,require:n=>{if(n in deps)return deps[n];throw Error(n);}});return exports;}
const helpers=moduleAt('src/lib/dashboard/work-order-notifications.ts');
test('committed worker scopes recipients, respects seen state, acknowledges leases, and fails closed on another property',async()=>{
 const records=[],acks=[],profiles=[{id:'chief',role:'Chief Engineer',active:true},{id:'tech',role:'Maintenance Technician',active:true},{id:'other',role:'Chief Engineer',active:true}];
 const event={id:'event',kind:'history',source_id:'history',hotel_id:'hotel',lease_token:'lease',payload:{id:'history',work_order_id:'order',event_type:'created',new_status:'Open',recorded_at:'2026-10-27T10:00:00Z',snapshot:{display_id:'WO-1',room:'101',issue:'fixture'}}};
 const admin={rpc:async()=>({data:[event]}),from(table){let filters=[],update=null;const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},gte(){return q},limit(){return q},update(v){update=v;return q},then(resolve){let data=table==='hotel_members'?[{user_id:'chief',hotel_id:'hotel',active:true},{user_id:'tech',hotel_id:'hotel',active:true}]:table==='profiles'?profiles:table==='cmpri_work_order_technician_views'?[{id:'seen',hotel_id:'hotel',work_order_id:'order'}]:[];if(update)acks.push({table,update});return Promise.resolve({data:data.filter(r=>filters.every(f=>f(r))),error:null}).then(resolve)}};return q;}};
 const worker=moduleAt('src/lib/server/notification-events.ts',{'@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/server/roles':roles,'@/lib/dashboard/work-order-notifications':helpers,'@/lib/server/dashboard-notifications':{recordNotifications:async(_a,user,items)=>{records.push({user,items});return true}}});
 assert.equal(await worker.materializeNotificationEvents(admin),1);
 assert.deepEqual(records.map(r=>r.user),['chief','tech']);
 assert.equal(records.find(r=>r.user==='tech').items[0].is_read,true);
 assert.notEqual(records.find(r=>r.user==='chief').items[0].is_read,true);
 assert.equal(acks.length,1);
 event.hotel_id='foreign';await assert.rejects(()=>worker.materializeNotificationEvents(admin),/property mismatch/);assert.equal(acks.length,1);
});
test('current Daily Ops reader never projects clock-driven room mutations',async()=>{
 const rows=[{room:'101',room_status:'Occupied',guest_name:'Fixture',checkout_date:'2020-01-01',checkout_time:'11:00:00'}],tables=[];
 const admin={from(table){tables.push(table);const q={select(){return q},eq(){return q},lte(){return q},order(){return q},limit(){return Promise.resolve({data:[{id:'import',report_date:'2020-01-01',source_type:'file',source_rows:rows,uploaded_at:'2020-01-01T10:00:00Z'}],error:null})}};return q;}};
 const snapshot=moduleAt('src/lib/server/cmpri-room-operations-snapshot.ts',{'@/lib/constants':{HOTEL_ID:'hotel',HOTEL_TIME_ZONE:'America/Chicago'},'@/lib/room-operations-reports':{normalizePrintedTime:v=>v},'@/lib/room-operations':{},'@/lib/room-availability':{}});
 const result=await snapshot.loadEffectiveRoomOperationsSnapshot(admin,'2026-10-27');
 assert.equal(result.rows[0].room_status,'Occupied');assert.equal(result.rows[0].guest_name,'Fixture');assert.deepEqual(tables,['cmpri_room_operation_imports']);
});
