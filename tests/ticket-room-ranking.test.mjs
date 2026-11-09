import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
const ranking = loadTs('src/lib/ticket-room-ranking.ts');
const location = (id, number) => ({id, room_number:number, name:'Room '+number, location_type:'Guest Room',active:true});
const ticket = (id, priority, status='Open', location_id='r1', room='Room 101') => ({id,priority,status,location_id,room,issue:id});

test('highest active priority derives room rank and sorts Urgent before High',()=>{
 const rooms=ranking.rankTicketRooms([location('r1','101'),location('r2','102')],[ticket('low','Low'),ticket('high','High'),ticket('urgent','Urgent'),ticket('medium','Medium')]);
 assert.equal(rooms[0].rank,'C'); assert.deepEqual(Array.from(rooms[0].issues,i=>i.priority),['Urgent','High','Medium','Low']);
 assert.equal(rooms[1].rank,'A'); assert.equal(rooms[1].issues.length,0);
});
test('priority and status changes recompute rather than preserve a corporate or stale rank',()=>{
 for(const [priority,expected]of [['Low','A'],['Medium','B'],['High','C'],['Urgent','C']])assert.equal(ranking.rankTicketRooms([location('r1','101')],[ticket('t',priority)])[0].rank,expected);
 for(const status of ['Completed','Closed','Will Not Do']){const r=ranking.rankTicketRooms([location('r1','101')],[ticket('high','Urgent',status),ticket('low','Low')])[0];assert.equal(r.rank,'A');assert.equal(r.issues.length,1)}
});
test('accumulated priorities raise the room rank at their own thresholds',()=>{
 const rank=(priorities)=>ranking.rankTicketRooms([location('r1','101')],priorities.map((priority,i)=>ticket(String(i),priority)))[0].rank;
 for(const [priorities,expected] of [
  [[], 'A'], [['Low','Low'],'A'], [['Low','Low','Low'],'B'], [['Low','Low','Low','Low'],'C'],
  [['Medium'],'B'], [['Medium','Medium'],'B'], [['Medium','Medium','Medium'],'C'],
  [['Low','Low','Medium'],'B'], [['Low','Low','Low','Medium'],'B'],
  [['Low','Low','Low','Low','Medium'],'C'], [['Low','Medium','Medium','Medium'],'C'],
  [['Low','High'],'C'], [['Low','Urgent'],'C'],
 ]) assert.equal(rank(priorities),expected,priorities.join(','));
});
test('auto-escalated tickets use original priorities and removed tickets no longer count',()=>{
 const rank=(tickets)=>ranking.rankTicketRooms([location('r1','101')],tickets)[0].rank;
 const escalated=(id,status='Open')=>({...ticket(id,'Urgent',status),ranker_base_priority:'Low'});
 assert.equal(rank([escalated('1'),escalated('2'),escalated('3'),escalated('4')]),'C');
 assert.equal(rank([escalated('1'),escalated('2'),escalated('3'),escalated('4','Completed')]),'B');
 assert.equal(rank([escalated('1'),escalated('2')]),'A');
});
test('inventory is authoritative; general hall room numbers never leak into a guest room',()=>{
 const inventory=[location('r1','101'),{...location('hall','101'),location_type:'General'},{...location('inactive','103'),active:false},location('r2','102')];
 const rooms=ranking.rankTicketRooms(inventory,[ticket('hall-ticket','Urgent','Open','hall'),ticket('fallback','Medium','Open',null,'Room 102'),ticket('unknown','High','Open',null,'Room 999')]);
 assert.equal(rooms.length,2);assert.equal(rooms[0].rank,'A');assert.equal(rooms[1].rank,'B');
});
test('fallback matching chooses the first location ID when names repeat, as the database does',()=>{
 const inventory=[{...location('z','102'),name:'Shared name'},{...location('a','101'),name:'Shared name'}];
 const rooms=ranking.rankTicketRooms(inventory,[ticket('fallback','Medium','Open',null,'Shared name')]);
 assert.equal(rooms.find(room=>room.id==='a').rank,'B');
 assert.equal(rooms.find(room=>room.id==='z').rank,'A');
});
test('zero/one/two/four issues expose only hidden extras after the lead',()=>{
 for(const count of [0,1,2,4]){const room=ranking.rankTicketRooms([location('r1','101')],Array.from({length:count},(_,i)=>ticket(String(i),'High')))[0];assert.equal(room.issues.slice(1).length,Math.max(0,count-1))}
});
test('invalid priority fails instead of labeling an unknown active issue A',()=>assert.throws(()=>ranking.rankTicketRooms([location('r1','101')],[ticket('x','Unknown')])));
test('floor persistence accepts only boolean floor choices; missing or malformed state is closed',()=>{
 for(const raw of [null,'bad','[]','null'])assert.deepEqual(Object.keys(ranking.readRankingFloorState(raw)),[]);
 const state=ranking.readRankingFloorState('{"1":true,"2":false,"3":"true","__proto__":true}');assert.equal(state['1'],true);assert.equal(state['2'],false);assert.equal(state['3'],undefined);assert.deepEqual(Object.keys(state),['1','2']);
});
