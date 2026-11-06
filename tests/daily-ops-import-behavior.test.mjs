import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGuestReport,roomsFromGuestReports,projectGuestRoom,nextGuestDisplayChange} from '../src/lib/room-guest-reports.ts';
import * as guestReports from '../src/lib/room-guest-reports.ts';
import * as printedReports from '../src/lib/room-operations-reports.ts';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const {hotelDateAt}=printedReports;
const compiled={};
const dependencies={'@/lib/room-guest-reports':guestReports,'@/lib/room-operations-reports':printedReports,'@/lib/constants':{HOTEL_ID:'test-hotel',HOTEL_TIME_ZONE:'America/Chicago'}};
vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/server/cmpri-room-operations-snapshot.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:compiled,require:name=>{assert.ok(Object.hasOwn(dependencies,name),name);return dependencies[name]}});
const {loadEffectiveRoomOperationsSnapshot}=compiled;
const day='2026-11-06';
const report=(kind,rows)=>({kind,name:kind,date:day,time:'10:00:00',rows});
const guests=report('guests',[{'ROOM NUMBER':'101','GUEST NAME':'Current Guest',ARRIVAL:'2026-11-04',DEPARTURE:day,NIGHTS:'2'}]);
const arrival={'ROOM NUMBER':'101','GUEST NAME':'Next Guest',ARRIVAL:day,'ARRIVAL TIME':'15:00',DEPARTURE:'2026-11-08','DEPARTURE TIME':'13:00',NIGHTS:'2','LOYALTY TIER':'Gold Elite'};
const bundle={guests,arrivals:report('arrivals',[arrival])};

test('unassigned arrivals are skipped; preference-only repetitions produce one reservation',()=>{
 const arrivals=parseGuestReport(`Housekeeping Arrivals_CMPRI_${day}_10-00-00.csv`,'ROOM NUMBER,GUEST NAME,PREFERENCES,ARRIVAL,DEPARTURE\n,Unassigned Guest,High floor,2026-11-06,2026-11-08\n101,Next Guest,High floor,2026-11-06,2026-11-08\n101,Next Guest,Extra pillows,2026-11-06,2026-11-08');
 const rows=roomsFromGuestReports({guests,arrivals},['101','102'],[]);
 assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.incoming_name==='Next Guest').length,1);assert.equal(rows[0].incoming_checkout_date,'2026-11-08');
 assert.equal(arrivals.rows.length,3,'preserve original report evidence');
 assert.doesNotThrow(()=>roomsFromGuestReports({guests,arrivals:report('arrivals',[{'ROOM NUMBER':'','GUEST NAME':''}])},['101'],[]));
});
test('unknown assigned rooms, different incoming guests and duplicate in-house rooms still reject',()=>{
 assert.throws(()=>roomsFromGuestReports({...bundle,arrivals:report('arrivals',[{...arrival,'ROOM NUMBER':'999'}])},['101'],[]),/unknown room/);
 assert.throws(()=>roomsFromGuestReports({...bundle,arrivals:report('arrivals',[arrival,{...arrival,'GUEST NAME':'Another Guest'}])},['101'],[]),/multiple incoming/);
 assert.throws(()=>roomsFromGuestReports({...bundle,guests:report('guests',[...guests.rows,...guests.rows])},['101'],[]),/duplicated/);
});
test('one unchanged snapshot expires each recorded stay without a new upload or source mutation',()=>{
 const [source]=roomsFromGuestReports(bundle,['101'],[]),before=JSON.stringify(source);
 assert.equal(projectGuestRoom(source,new Date(day+'T10:59:59Z'),'UTC').guest_name,'Current Guest');
 assert.equal(projectGuestRoom(source,new Date(day+'T11:00:00Z'),'UTC').guest_name,'');
 const active=projectGuestRoom(source,new Date(day+'T15:00:00Z'),'UTC');
 assert.equal(active.guest_name,'Next Guest');assert.equal(active.checkout_date,'2026-11-08');assert.equal(active.checkout_time,'13:00:00');assert.equal(active.loyalty_tier,'Gold');
 assert.equal(projectGuestRoom(source,new Date('2026-11-08T12:59:59Z'),'UTC').guest_name,'Next Guest');
 for(const now of ['2026-11-08T13:00:00Z','2026-11-09T10:00:00Z','2026-11-20T10:00:00Z']){
  const row=projectGuestRoom(source,new Date(now),'UTC');assert.equal(row.guest_name,'');assert.equal(row.incoming_name,'');assert.equal(row.reserved,false);
 }
 assert.equal(JSON.stringify(source),before);
});
test('re-projecting an already promoted stay does not extend its recorded departure',()=>{
 const [source]=roomsFromGuestReports(bundle,['101'],[]);const active=projectGuestRoom(source,new Date(day+'T15:00:00Z'),'UTC');
 const tomorrow=projectGuestRoom(active,new Date('2026-11-07T23:00:00Z'),'UTC');assert.equal(tomorrow.checkout_date,'2026-11-08');assert.equal(tomorrow.checkout_time,'13:00:00');
 assert.equal(projectGuestRoom(tomorrow,new Date('2026-11-08T13:00:00Z'),'UTC').guest_name,'');
});
test('expired incoming reservation cannot replace or extend a still-current overlapping stay',()=>{
 const [source]=roomsFromGuestReports(bundle,['101'],[]);source.checkout_date='2026-11-09';
 const row=projectGuestRoom(source,new Date('2026-11-08T14:00:00Z'),'UTC');assert.equal(row.guest_name,'Current Guest');assert.equal(row.checkout_date,'2026-11-09');assert.equal(row.incoming_name,'');assert.equal(row.reserved,false);
});
test('recorded checkout times and hotel timezone remain authoritative',()=>{
 const list=report('guests',[{...guests.rows[0],'DEPARTURE TIME':'13:30'}]);
 const [source]=roomsFromGuestReports({guests:list},['101'],[]);assert.equal(source.checkout_time,'13:30:00');
 const departure=report('departures',[{'ROOM NUMBER':'101','GUEST NAME':'Current Guest','DEPARTURE TIME':'12:30'}]);
 assert.equal(roomsFromGuestReports({guests:list,departures:departure},['101'],[])[0].checkout_time,'12:30:00');
 assert.equal(projectGuestRoom(source,new Date(day+'T19:29:59Z'),'America/Chicago').guest_name,'Current Guest');
 assert.equal(projectGuestRoom(source,new Date(day+'T19:30:00Z'),'America/Chicago').guest_name,'');
});
test('the next boundary includes an incoming departure even while the current guest remains',()=>{
 const source={room:'101',guest_name:'Current',room_status:'Occupied',checkout_date:day,checkout_time:'22:00:00',incoming_name:'Next',arrival_date:day,arrival_time:'15:00:00',incoming_checkout_date:day,incoming_checkout_time:'20:00:00'};
 assert.equal(nextGuestDisplayChange([source],new Date(day+'T18:00:00Z'),'UTC'),Date.parse(day+'T20:00:00Z'));
});
test('older saved imports recover recorded incoming dates without a new import or database write',async()=>{
 const today=hotelDateAt(new Date(),'America/Chicago'),offset=n=>new Date(Date.parse(today+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
 const old=offset(-3),end=offset(-1),reports={guests:{...guests,date:old,rows:[{...guests.rows[0],ARRIVAL:offset(-4),DEPARTURE:offset(-2)}]},arrivals:report('arrivals',[{...arrival,ARRIVAL:offset(-2),DEPARTURE:end}])};
 const source={room:'101',guest_name:'Current Guest',guest_arrival_date:offset(-4),room_status:'Occupied',checkout_date:offset(-2),checkout_time:'11:00:00',incoming_name:'Next Guest',arrival_date:offset(-2),arrival_time:'15:00:00',incoming_reserved:true,reserved:true,guest_report_bundle:reports};
 const before=JSON.stringify(source),reads=[];
 const admin={from(name){reads.push(name);assert.equal(name,'cmpri_room_operation_imports');const q={select(){return q},eq(){return q},lte(){return q},order(){return q},limit:async()=>({data:[{id:'old',report_date:old,source_type:'file',source_rows:[source],uploaded_at:old+'T16:00:00Z'}],error:null})};return q},rpc(){throw Error('Projection must not write')}};
 const result=await loadEffectiveRoomOperationsSnapshot(admin,today);assert.equal(result.error,null);assert.equal(result.rows[0].guest_name,'');assert.equal(result.rows[0].incoming_name,'');assert.equal(result.carried_over,true);assert.equal(JSON.stringify(source),before);assert.equal(reads.length,1);
});
test('preserved explicit current departure time is recovered with departures-report precedence',()=>{
 const source={room:'101',guest_name:'Current Guest',guest_arrival_date:'2026-11-04',room_status:'Occupied',checkout_date:day,checkout_time:'11:00:00'};
 const reports={guests:report('guests',[{...guests.rows[0],'DEPARTURE TIME':'13:30'}])};
 assert.equal(projectGuestRoom(source,new Date(day+'T12:00:00Z'),'UTC',reports).guest_name,'Current Guest');
 const departures=report('departures',[{'ROOM NUMBER':'101','GUEST NAME':'Current Guest','DEPARTURE TIME':'11:30'}]);
 assert.equal(projectGuestRoom(source,new Date(day+'T12:00:00Z'),'UTC',{...reports,departures}).guest_name,'');
});
test('date recovery keeps an older vacant row with a null guest name readable',()=>{
 const source={room:'101',guest_name:null,room_status:'Vacant Ready',checkout_date:null,checkout_time:null};
 assert.equal(projectGuestRoom(source,new Date(day+'T12:00:00Z'),'UTC',bundle).room_status,'Vacant Ready');
});
