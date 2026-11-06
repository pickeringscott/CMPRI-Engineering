import './helpers/resolve-ts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {roomsFromGuestReports,projectGuestRoom,nextGuestDisplayChange} from '../src/lib/room-guest-reports.ts';
const date='2026-11-06';
const report=(kind,rows)=>({kind,name:kind,date,time:'10:00:00',rows});
const guest=(room='101',arrival=date)=>({'ROOM NUMBER':room,'GUEST NAME':'Test Guest',ARRIVAL:arrival,DEPARTURE:'2026-11-08',NIGHTS:'2'});
const arrival=(name='Test Guest',tier='Gold Elite')=>({'ROOM NUMBER':'101','GUEST NAME':name,'ARRIVAL DATE':date,'LOYALTY TIER':tier});
const rooms=(guests,arrivals=[],previous=[])=>roomsFromGuestReports({guests:report('guests',guests),arrivals:report('arrivals',arrivals)},['101','102'],previous);
test('late tier capture persists through missing report fields and a room move for the same stay',()=>{
 const first=rooms([guest()],[arrival()]);assert.equal(first[0].loyalty_tier,'Gold');
 const next=rooms([guest('102')],[],first);assert.equal(next[1].loyalty_tier,'Gold');assert.equal(next[0].loyalty_tier,undefined);
});
test('a new stay with the same name does not inherit a previous stay tier',()=>{
 const previous=rooms([guest('101','2026-11-05')],[{...arrival(), 'ARRIVAL DATE':'2026-11-05'}]);
 assert.equal(previous[0].loyalty_tier,'Gold');assert.equal(rooms([guest()],[],previous)[0].loyalty_tier,undefined);
});
test('incoming tier survives missing values and transfers at 3 pm without mutating source',()=>{
 const first=rooms([], [arrival('Next Guest','Titanium Elite')]);
 const source=rooms([], [arrival('Next Guest','')],first)[0];assert.equal(source.incoming_loyalty_tier,'Titanium');
 assert.equal(projectGuestRoom(source,new Date(date+'T14:59:59Z'),'UTC').guest_name,'');
 const active=projectGuestRoom(source,new Date(date+'T15:00:00Z'),'UTC');assert.equal(active.guest_name,'Next Guest');assert.equal(active.loyalty_tier,'Titanium');assert.equal(active.incoming_name,'');assert.equal(source.incoming_name,'Next Guest');
 assert.equal(nextGuestDisplayChange([source],new Date(date+'T14:59:00Z'),'UTC'),Date.parse(date+'T15:00:00Z'));
});
test('late checkout preserves both stays until checkout, then clears current tier',()=>{
 const source={...rooms([guest()],[arrival()])[0],checkout_date:date,checkout_time:'17:00:00',incoming_name:'Next Guest',incoming_loyalty_tier:'Silver',arrival_date:date,arrival_time:'15:00:00',incoming_reserved:true};
 const overlap=projectGuestRoom(source,new Date(date+'T16:00:00Z'),'UTC');assert.equal(overlap.loyalty_tier,'Gold');assert.equal(overlap.incoming_loyalty_tier,'Silver');
 const next=projectGuestRoom(source,new Date(date+'T17:00:00Z'),'UTC');assert.equal(next.guest_name,'Next Guest');assert.equal(next.loyalty_tier,'Silver');
});
