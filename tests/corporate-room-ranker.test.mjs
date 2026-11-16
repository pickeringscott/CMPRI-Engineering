import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {loadTs} from './helpers/load-ts.mjs';
const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
const ranking=loadTs('src/lib/ticket-room-ranking.ts');
const paginate=loadTs('src/lib/server/paginated-query.ts');
let writes=[], sheets=[], failure=false, claimed=true, calls=[];
const ranker=loadTs('src/lib/server/corporate-room-ranker.ts',{
 'server-only':{},'@/lib/constants':{HOTEL_ID:hotel},'@/lib/ticket-room-ranking':ranking,
 '@/lib/server/paginated-query':paginate,
 '@/lib/server/google-sheets':{googleSheetsRequest:async(id,path,init={})=>{
  calls.push(path);
  if(failure)throw Error('Synthetic provider failure');
  if(init.method==='POST'){
   const body=JSON.parse(init.body);writes.push(body);assert.equal(body.valueInputOption,'RAW');
   for(const update of body.data){const [,col,row]=update.range.match(/!([FG])(\d+)$/);sheets[0].data[0].rowData[Number(row)-1].values[col==='F'?5:6]={userEnteredValue:{stringValue:update.values[0][0]}};}
  }
  return {sheets};
 }},
}, {AbortSignal,Error});
const location={id:'r1',hotel_id:hotel,name:'Room 101',room_number:'101',active:true,location_type:'Guest Room'};
const ticket={id:'t1',display_id:'WO-0001',location_id:'r1',room:'Room 101',priority:'High',status:'Open',issue:'A/C not cooling'};
const cell=value=>({userEnteredValue:{stringValue:value}});
const fixture=()=>({properties:{sheetId:0,title:'Room Ranker',gridProperties:{rowCount:2,columnCount:27}},data:[{rowData:[{values:ranker.CORPORATE_RANKER_HEADERS.map(cell)},{values:['101','General Manager','checked','yes','no','A','Corporate note'].map(cell)}]}]});
function admin(){return {rpc:async(name,args)=>{
 calls.push([name,args]);return {data:name.endsWith('_claim')?(claimed?{owner:'owner',revision:1}:null):true,error:null};
},from:table=>{const q={};for(const name of ['select','eq','not','order'])q[name]=()=>q;q.range=async()=>({data:table==='locations'?[location]:[ticket],error:null});return q;}};}

test('maps all corporate headers; only F/G change and preserve inspector, checks, and replace legacy notes',()=>{
 const sheet=fixture(),before=structuredClone(sheet);
 const plan=ranker.planCorporateRankerUpdates(sheet,[location],[ticket]);
 assert.equal(plan.rooms,1);assert.deepEqual(Array.from(plan.updates,u=>u.range),["'Room Ranker'!F2","'Room Ranker'!G2"]);
 assert.equal(plan.updates[0].values[0][0],'C');assert.equal(plan.updates[1].values[0][0],'A/C not cooling');
 assert.equal(JSON.stringify(sheet),JSON.stringify(before));
});
test('current rank thresholds match CMPRI and completed tickets remove the managed notes',()=>{
 const sheet=fixture();const low=[1,2,3,4].map(id=>({...ticket,id:String(id),priority:'Low'}));
 for(const [count,expected] of [[1,'A'],[3,'B'],[4,'C']]){
  const plan=ranker.planCorporateRankerUpdates(sheet,[location],low.slice(0,count));
  assert.equal(plan.updates.find(u=>u.range.endsWith('F2'))?.values[0][0]??'A',expected);
 }
 assert.equal(ranker.corporateRankerNotes([ticket,{...ticket,id:'t2',issue:'  Broken light\n in bathroom  '}]),'A/C not cooling\nBroken light in bathroom');
 assert.equal(ranker.corporateRankerNotes([]),'');
 const completed=ranker.planCorporateRankerUpdates(sheet,[location],[{...ticket,status:'Completed'}]);
 assert.equal(completed.updates.length,1);
 assert.equal(completed.updates[0].values[0][0],'');
});
test('fails safely on missing rooms, duplicates, shifted headers, formulas, or incompatible validation',()=>{
 for(const change of [s=>s.data[0].rowData[1].values[0]=cell('102'),s=>s.data[0].rowData.push(s.data[0].rowData[1]),s=>s.data[0].rowData[0].values[1]=cell('Inspector'),s=>s.data[0].rowData[1].values[5]={userEnteredValue:{formulaValue:'=1'}},s=>s.data[0].rowData[1].values[5].dataValidation={condition:{type:'ONE_OF_LIST',values:[{userEnteredValue:'A'}]}}]){
  const sheet=fixture();change(sheet);assert.throws(()=>ranker.planCorporateRankerUpdates(sheet,[location],[ticket]));
 }
 assert.throws(()=>ranker.planCorporateRankerUpdates(fixture(),[],[]));
 const sheet=fixture();sheet.tables=[{range:{startRowIndex:0,endRowIndex:2,startColumnIndex:0,endColumnIndex:8},columnProperties:[{columnIndex:5,dataValidationRule:{condition:{type:'ONE_OF_LIST',values:[{userEnteredValue:'A'}]}}}]}];
 assert.throws(()=>ranker.planCorporateRankerUpdates(sheet,[location],[ticket]),/does not permit/);
 sheet.tables[0].columnProperties[0].dataValidationRule.condition.values.push({userEnteredValue:'C'});
 assert.equal(ranker.planCorporateRankerUpdates(sheet,[location],[ticket]).updates.length,2);
 assert.equal(ranker.corporateRankerNotes([{...ticket,issue:'=1+1'}]),'=1+1');
});
test('event delivery verifies its write; duplicate/unchanged deliveries make no Sheets writes',async()=>{
 process.env.CMPRI_CORPORATE_RANKER_ENABLED='true';process.env.CMPRI_ROOM_RANKER_SPREADSHEET_ID='corporate';process.env.CMPRI_ROOM_RANKER_SHEET_NAME='Room Ranker';
 sheets=[fixture()];writes=[];calls=[];
 assert.equal((await ranker.dispatchCorporateRoomRanker(admin())).changedCells,2);
 assert.equal(writes.length,1);
 assert.equal((await ranker.dispatchCorporateRoomRanker(admin())).changedCells,0);assert.equal(writes.length,1);
 claimed=false;calls=[];assert.equal((await ranker.dispatchCorporateRoomRanker(admin())).skipped,true);assert.equal(calls.length,1);claimed=true;
 failure=true;calls=[];await assert.rejects(()=>ranker.dispatchCorporateRoomRanker(admin()),/Synthetic/);failure=false;
 assert.equal(calls.at(-1)[0],'cmpri_corporate_ranker_finish');assert.match(calls.at(-1)[1].p_error,/Synthetic/);
 process.env.CMPRI_CORPORATE_RANKER_ENABLED='false';await assert.rejects(()=>ranker.dispatchCorporateRoomRanker(admin()),/disabled/);
});
test('POST requires dedicated secret and correct event; GET stays retired and no cron is registered',async()=>{
 let dispatched=0;
 const route=loadTs('src/app/api/integrations/room-ranker/sync/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status??200})}},
  '@/lib/constants':{HOTEL_ID:hotel},'@/lib/server/supabase-admin':{createSupabaseAdmin:()=>({})},
  '@/lib/server/corporate-room-ranker':{dispatchCorporateRoomRanker:async()=>{dispatched++;return {ok:true};}},
 });
 process.env.CMPRI_CORPORATE_RANKER_WEBHOOK_SECRET='synthetic';
 const req=(auth,body)=>({headers:new Headers({authorization:auth}),json:async()=>body});
 assert.equal((await route.POST(req('Bearer wrong',{}))).status,401);
 assert.equal((await route.POST(req('Bearer synthetic',{hotel_id:hotel}))).status,400);
 assert.equal((await route.POST(req('Bearer synthetic',{hotel_id:hotel,event:'corporate_ranker_changed'}))).status,200);assert.equal(dispatched,1);
 assert.equal(route.GET().status,410);assert.equal(route.PATCH().status,410);
 assert.ok(!JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url))).crons.some(c=>c.path.includes('room-ranker')));
});

test('database commits coalesce changes, rollback cancels intent, leases serialize, and concurrent revisions are continued without a timer',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema cmpri_private;create schema vault;create schema net;
   create table vault.decrypted_secrets(name text,decrypted_secret text);
   insert into vault.decrypted_secrets values('cmpri_corporate_ranker_dispatch','synthetic');
   create table public.calls(body jsonb);
   create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$ begin insert into public.calls values(body);return 1;end $$;
   create table public.locations(id uuid primary key,hotel_id uuid,name text,room_number text,location_type text,active boolean);
   create table public.work_orders(id uuid primary key,hotel_id uuid,location_id uuid,room text,display_id text,issue text,status text,priority text,ranker_base_priority text,notes text);
   insert into locations values('00000000-0000-0000-0000-000000000101','${hotel}','Room 101','101','Guest Room',true);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261116195025_reconnect_corporate_ranker_events.sql',import.meta.url),'utf8'));
  await db.exec(`begin;insert into work_orders values('00000000-0000-0000-0000-000000000001','${hotel}','00000000-0000-0000-0000-000000000101','Room 101','WO-1','Synthetic','Open','Low',null,null);update work_orders set priority='High';commit;`);
  const state=async()=> (await db.query('select * from cmpri_corporate_ranker_state')).rows[0];
  const count=async()=>Number((await db.query('select count(*) n from calls')).rows[0].n);
  assert.equal(Number((await state()).revision),1);assert.equal(await count(),1);
  await db.exec("update work_orders set notes='unrelated'");assert.equal(await count(),1);
  await db.exec("begin;update work_orders set issue='rolled back';rollback;");assert.equal(await count(),1);
  const claim=async()=> (await db.query(`select cmpri_corporate_ranker_claim('${hotel}') c`)).rows[0].c;
  const first=await claim();assert.ok(first.owner);assert.equal(await claim(),null);
  await db.exec("update work_orders set status='Completed'");assert.equal(Number((await state()).revision),2);
  await db.query(`select cmpri_corporate_ranker_finish($1,$2,$3,null)`,[hotel,first.owner,first.revision]);assert.equal(await count(),3); // new event + continuation
  const second=await claim();assert.equal(second.revision,2);
  await db.query(`select cmpri_corporate_ranker_finish($1,$2,$3,'Synthetic outage')`,[hotel,second.owner,second.revision]);
  assert.equal(Number((await state()).delivered_revision),1);assert.equal(await count(),3); // failure does not schedule anything
  const third=await claim();await db.query(`select cmpri_corporate_ranker_finish($1,$2,$3,null)`,[hotel,third.owner,third.revision]);assert.equal(await claim(),null);
  const permissions=(await db.query(`select has_table_privilege('authenticated','cmpri_corporate_ranker_state','select') can_read,has_function_privilege('anon','cmpri_corporate_ranker_request(uuid)','execute') can_request`)).rows[0];
  assert.deepEqual(permissions,{can_read:false,can_request:false});
 }finally{await db.close();}
});
