import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadTs } from './helpers/load-ts.mjs';

const locationManagement = loadTs('src/lib/location-management.ts');
const { groupLocations } = locationManagement;
const pagination = loadTs('src/lib/server/paginated-query.ts');
test('location types group case-insensitively and locations sort naturally within each type', () => {
 const input=[{id:'10',name:'Room 10',room_number:'10',location_type:'Guest Room'},{id:'lobby',name:'Lobby',room_number:null,location_type:'Public Area'},{id:'2',name:'Room 2',room_number:'2',location_type:' guest room '},{id:'unknown',name:'Other',room_number:null,location_type:null}];
 const groups=groupLocations(input);
 assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g=>[g.type,g.locations.map(l=>l.id)]))),[['Guest Room',['2','10']],['Public Area',['lobby']],['Unclassified',['unknown']]]);
 assert.deepEqual(input.map(x=>x.id),['10','lobby','2','unknown']);
});

test('location viewers can read all associated tickets without gaining new PM reads or edit access', async () => {
 const roles=loadTs('src/lib/server/roles.ts');
 const access=loadTs('src/lib/server/access.ts');
 const hotel='test-hotel';
 const user='test-user';
 const principal={identity:{id:user},profile:{id:user,role:'Front Desk Manager',active:true},hotelId:hotel,
  membership:{user_id:user,hotel_id:hotel,role:'technician',active:true},permissions:[]};
 const reads=[];
 const rows={locations:[{id:'lobby',name:'Lobby',room_number:null},{id:'room',name:'Room 201',room_number:'201'},
  {id:'suite',name:'Suite',room_number:'A-01'},{id:'left',name:'Utility Closet'},{id:'right',name:'Utility Closet'}],work_orders:[
  {id:'linked',location_id:'lobby'}, {id:'legacy',location_id:null,room:'Room 201'},
  {id:'unrelated',location_id:'inactive',room:'Room 201'}, {id:'unlinked',location_id:null,room:'Unknown'},
  {id:'named',location_id:null,room:' lobby '}, {id:'suite',location_id:null,room:'RM #a-01'},
  {id:'ambiguous',location_id:null,room:'Utility Closet'}, {id:'other-suite',location_id:null,room:'A-201'},
  ...Array.from({length:992},(_,index)=>({id:`unlinked-${index}`,location_id:null,room:'Unknown'})),
  {id:'previously-omitted',location_id:'room',status:'Closed',technician_name:'Other Technician'},
 ]};
 const orderPages=[];
 const admin={from(table){
  reads.push(table);
  let data=rows[table]||[];
  const query={select:()=>query,eq(key,value){if (key==='hotel_id') assert.equal(value,hotel); return query;},order:()=>query,limit:()=>query,
   range(from,to){if(table==='work_orders')orderPages.push([from,to]);data=data.slice(from,to+1);return query;},
   then(resolve,reject){return Promise.resolve({data,error:null}).then(resolve,reject);}};
  return query;
 }};
 const route=loadTs('src/app/api/rooms/route.ts',{
  'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/constants':{HOTEL_ID:hotel},
  '@/lib/server/access':access,'@/lib/server/roles':roles,'@/lib/server/room-availability':{},
  '@/lib/location-management':locationManagement,'@/lib/server/paginated-query':pagination,
  '@/lib/server/auth':{requireUser:async()=>({admin,principal}),requireCapability:async(_request,cap)=>access.allows(principal,cap)?{admin,principal}:null},
 });
 const request={nextUrl:new URL('http://local/api/rooms')};
 const response=await route.GET(request);
 assert.equal(response.status,200);
 const result=await response.json();
 const expectedTickets=['linked','legacy','named','suite','previously-omitted'];
 assert.deepEqual(result.work_orders.map(order=>order.id),expectedTickets);
 assert.deepEqual(orderPages,[[0,999],[1000,1999]]);
 assert.equal(result.can_edit,false);
 assert.equal(result.can_view_pm,false);
 assert.deepEqual(reads,['locations','work_orders','work_orders']);
 assert.equal((await route.PATCH(request)).status,403);
 assert.equal((await route.POST(request)).status,403);
 principal.profile.role='Front Desk';
 assert.equal((await route.GET(request)).status,403);
 assert.deepEqual(reads,['locations','work_orders','work_orders']);
 for (const role of ['General Manager','Assistant General Manager','Maintenance Technician','Chief Engineer','Senior Management','Engineer','System Administrator']) {
  principal.profile.role=role;
  principal.membership.role=roles.membershipRole(role);
  const response=await route.GET(request);
  assert.equal(response.status,200,role);
  const result=await response.json();
  assert.deepEqual(result.work_orders.map(order=>order.id),expectedTickets,role);
  assert.equal(result.can_edit,['Chief Engineer','Senior Management','Engineer','System Administrator'].includes(role),role);
 }
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
 const route=loadTs('src/app/api/rooms/route.ts',{'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/access':{allows:()=>allowed},'@/lib/server/auth':{requireCapability:async(_request,cap)=>{assert.equal(cap,'edit_locations');return allowed?{admin}:null;},requireUser:async()=>null},'@/lib/server/roles':{roleKey:x=>x},'@/lib/server/room-availability':{loadCurrentRoomStatuses:()=>{},currentRoomStatus:()=>{}},'@/lib/location-management':locationManagement,'@/lib/server/paginated-query':pagination});
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
