import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs } from './helpers/load-ts.mjs';
import { plainTextParts } from '../src/lib/plain-text-links.ts';
import * as references from '../src/lib/work-order-reference.js';
const policy = loadTs('src/lib/work-order-read-policy.ts');
const {workOrderReader} = loadTs('src/lib/server/work-order-reader.ts');
const {workOrderReferenceTargets} = loadTs('src/lib/work-order-reference-targets.ts', {'./work-order-reference.js': references, './plain-text-links': {plainTextParts}});
const hotel = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const roles = ['Engineer','Chief Engineer','System Administrator','Maintenance Technician','General Manager','Senior Management','Front Desk Manager','Assistant General Manager','Front Desk','Housekeeping'];
function principal(role) {return {identity:{id:user},hotelId:hotel,profile:{id:user,role,active:true,full_name:'Reader'},membership:{hotel_id:hotel,user_id:user,active:true,role:'viewer'},permissions:[]};}
const target = {id:'abcdef12-0000-4000-8000-000000000001',hotel_id:hotel,display_id:'workorder_123',status:'Closed',created_by:'another-user',technician_name:'Another Technician'};
function fixture(p, rows=[target], fail=false) {
 let queried=0;
 const admin={from(table) {
  assert.equal(table,'work_orders');queried++;
  const filters=[];let limit=Infinity;
  const query={select(){return query;},eq(k,v){filters.push(r=>r[k]===v);return query;},in(k,v){filters.push(r=>v.includes(r[k]));return query;},gte(k,v){filters.push(r=>r[k]>=v);return query;},lte(k,v){filters.push(r=>r[k]<=v);return query;},limit(n){limit=n;return query;},then(resolve,reject){return Promise.resolve({data:rows.filter(r=>filters.every(f=>f(r))).slice(0,limit),error:fail?{message:'offline'}:null}).then(resolve,reject);}};
  return query;
 }};
 const route=loadTs('src/app/api/work-orders/references/route.ts',{
  'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200,headers:init.headers})}},
  '@/lib/server/auth':{requireUser:async()=>p?{principal:p,admin}:null},
  '@/lib/server/work-order-reader':{workOrderReader},'@/lib/work-order-read-policy':policy,
 });
 return {run:targets=>route.GET({nextUrl:new URL('https://local/api/work-orders/references?'+new URLSearchParams(targets.map(target=>['target',target])))}),queries:()=>queried};
}
for(const role of roles) test(`${role}: resolves another creator's older closed reference, without recent-list dependence`,async()=>{
 const rows=Array.from({length:350},(_,i)=>({...target,id:`new-${i}`,display_id:String(1000+i),status:'Open'}));
 rows.push(target,{...target,id:'other-hotel',hotel_id:'other-hotel'});
 const f=fixture(principal(role),rows);
 const response=await f.run(['number:123']);
 assert.equal(response.status,200);assert.deepEqual(Array.from(response.body.tickets,r=>r.id),[target.id]);
 assert.equal(response.headers['Cache-Control'],'private, no-store');
});
test('reference access rejects inactive, mismatched and missing memberships before querying',async()=>{
 for(const alter of [p=>{p.profile.active=false;},p=>{p.membership.active=false;},p=>{p.membership.hotel_id='elsewhere';},p=>{p.membership.user_id='elsewhere';}]) {
  const p=principal('Front Desk');alter(p);const f=fixture(p);assert.equal((await f.run(['number:123'])).status,403);assert.equal(f.queries(),0);
 }
 assert.equal((await fixture(null).run(['number:123'])).status,401);
});
test('specific references validate input, reject failures, and omit absent or cross-hotel targets',async()=>{
 assert.equal((await fixture(principal('Front Desk')).run(['number:123),hotel_id.neq.x'])).status,400);
 assert.equal((await fixture(principal('Front Desk')).run(Array.from({length:101},(_,i)=>`number:${i}`))).status,400);
 assert.equal((await fixture(principal('Front Desk'),[],true).run(['number:123'])).status,503);
 const result=await fixture(principal('Front Desk'),[{...target,hotel_id:'elsewhere'}]).run(['number:123','number:999']);
 assert.equal(result.body.tickets.length,0);
});
test('legacy UUID prefixes resolve uniquely and fail closed on ambiguity',async()=>{
 assert.equal((await fixture(principal('Front Desk')).run(['id:abcdef12'])).body.tickets[0].id,target.id);
 const duplicate={...target,id:'abcdef12-0000-4000-8000-000000000002',display_id:'124'};
 assert.equal((await fixture(principal('Front Desk'),[target,duplicate]).run(['id:abcdef12'])).body.tickets.length,0);
 const mixed=await fixture(principal('Front Desk'),[target,duplicate]).run(['number:123','id:abcdef12']);
 assert.equal(mixed.body.tickets.length,1);assert.equal(mixed.body.resolvedPrefixes.abcdef12,undefined);
});
test('history target extraction preserves external URLs and distinguishes room numbers',()=>{
 const targets=Array.from(workOrderReferenceTargets('WO#123, @WO-124 and @abcdef12; room #405; https://amazon.com/item/WO-999'));
 assert.deepEqual(targets,['number:123','number:124','id:abcdef12']);
 const page=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');
 assert.match(page,/workOrderReferenceTargets\(referenceText\)/);
 assert.match(page,/offset < targets.length; offset \+= 100/);
 assert.match(page,/referenceTickets.filter/);
 assert.match(page,/requestTicketNavigation\(`\/work-orders\/\$\{encodeURIComponent\(ticket\.id\)\}`\)/);
 assert.match(page,/targetWorkOrderId: ticket.id/);
});
