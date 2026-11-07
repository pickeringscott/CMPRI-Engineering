import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadTs } from './helpers/load-ts.mjs';

const { groupLocations } = loadTs('src/lib/location-management.ts');
test('location types group case-insensitively and locations sort naturally within each type', () => {
 const input=[{id:'10',name:'Room 10',room_number:'10',location_type:'Guest Room'},{id:'lobby',name:'Lobby',room_number:null,location_type:'Public Area'},{id:'2',name:'Room 2',room_number:'2',location_type:' guest room '},{id:'unknown',name:'Other',room_number:null,location_type:null}];
 const groups=groupLocations(input);
 assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g=>[g.type,g.locations.map(l=>l.id)]))),[['Guest Room',['2','10']],['Public Area',['lobby']],['Unclassified',['unknown']]]);
 assert.deepEqual(input.map(x=>x.id),['10','lobby','2','unknown']);
});

test('Add Location enforces permission, property scope and validation, and persists a unique normalized record', async () => {
 const db=new PGlite();
 const hotel='00000000-0000-4000-8000-000000000001';
 await db.exec('create table locations(id uuid default gen_random_uuid() primary key,hotel_id uuid not null,area text not null,name text not null,room_number text,location_type text not null default \'General\',active boolean not null default true,unique(hotel_id,area,name))');
 let allowed=true;let writes=0;
 const admin={from(table){
  assert.equal(table,'locations');let values;
  const query={
   insert(record){writes++;values=record;return query;},
   select(){return query;},
   async single(){
    try{
     const r=await db.query('insert into locations(hotel_id,area,name,room_number,location_type,active) values($1,$2,$3,$4,$5,$6) returning *',[values.hotel_id,values.area,values.name,values.room_number,values.location_type,values.active]);
     return {data:r.rows[0],error:null};
    }catch(error){return {data:null,error};}
   },
  };return query;
 }};
 const route=loadTs('src/app/api/rooms/route.ts',{'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/access':{allows:()=>allowed},'@/lib/server/auth':{requireCapability:async(_request,cap)=>{assert.equal(cap,'manage_rooms');return allowed?{admin}:null;},requireUser:async()=>null},'@/lib/server/roles':{roleKey:x=>x},'@/lib/server/room-availability':{loadCurrentRoomStatuses:()=>{},currentRoomStatus:()=>{}}});
 const post=body=>route.POST(new Request('http://local/api/rooms',{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}));
 try {
  allowed=false;assert.equal((await post({name:'Lobby',area:'Public'})).status,403);assert.equal(writes,0);allowed=true;
  for(const body of [null,[],{name:'',area:'Public'},{name:'Lobby',area:''},{name:'Lobby',area:'Public',hotel_id:'foreign'},{name:'Lobby',area:'Public',active:false},{name:'Lobby',area:'Public',room_number:'<script>'},{name:'Lobby',area:'Public',namex:'extra'},{name:'x'.repeat(201),area:'Public'}])assert.equal((await post(body)).status,400,JSON.stringify(body));
  assert.equal(writes,0);
  const response=await post({name:' Lobby ',area:' Public ',room_number:'',location_type:' Public Area '});assert.equal(response.status,201);
  const {location}=await response.json();assert.equal(location.hotel_id,hotel);assert.equal(location.active,true);assert.equal(location.name,'Lobby');assert.equal(location.area,'Public');assert.equal(location.room_number,null);assert.equal(location.location_type,'Public Area');
  assert.equal((await post({name:'Lobby',area:'Public'})).status,409);
  const fallback=await post({name:'Store',area:'Back of House'});assert.equal(fallback.status,201);assert.equal((await fallback.json()).location.location_type,'General');
  assert.equal((await db.query('select count(*)::int as count from locations')).rows[0].count,2);
 }finally{await db.close();}
});
