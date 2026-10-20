import {readFileSync} from 'node:fs';
import {plainTextParts} from '../src/lib/plain-text-links.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
const roles=loadTs('src/lib/server/roles.ts');
const policy=loadTs('src/lib/work-order-mentions.ts',{'./plain-text-links':{plainTextParts}});
const server=loadTs('src/lib/server/work-order-mentions.ts',{'@/lib/work-order-mentions':policy});
const user='00000000-0000-4000-8000-000000000010',hotel='hotel';
const key='work-order-mention:00000000-0000-4000-8000-000000000001:2';
function fixture(role='Front Desk',authenticated=true){
 const queries=[],writes=[];const data={hotel_members:[{user_id:user,hotel_id:hotel,active:true},{user_id:'foreign',hotel_id:'another-hotel',active:true},{user_id:'inactive',hotel_id:hotel,active:false}],profiles:[{id:user,full_name:'Scott Pickering',role:'Chief Engineer',active:true},{id:'foreign',full_name:'Private Other',role:'Manager',active:true},{id:'inactive',full_name:'Inactive Staff',role:'Technician',active:true}],cmpri_dashboard_notifications:[{notification_key:key,recipient_user_id:user,hotel_id:hotel,read_at:null,cleared_at:null},{notification_key:key,recipient_user_id:'foreign',hotel_id:'another-hotel',read_at:null,cleared_at:null},{notification_key:'staff-note:unrelated',recipient_user_id:user,hotel_id:hotel,read_at:null,cleared_at:null}]};
 const admin={from(table){const filters=[];const q={select(){return q},eq(k,v){queries.push([table,k,v]);filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},like(k,v){filters.push(r=>r[k].startsWith(v.slice(0,-1)));return q},is(k,v){filters.push(r=>r[k]===v);return q},order(){return q},limit(){return q},update(v){writes.push({table,values:v,filters});return q},then(resolve,reject){return Promise.resolve({data:data[table].filter(r=>filters.every(f=>f(r))),error:null}).then(resolve,reject)}};return q}};
 const principal={hotelId:hotel,identity:{id:user},profile:{role}};
 const route=loadTs('src/app/api/work-orders/mentions/route.ts',{'next/server':{NextResponse:{json:(body,init={})=>({body,status:init.status||200})}},'@/lib/server/auth':{requireUser:async()=>authenticated?{principal,admin}:null},'@/lib/server/access':{allows:(_,cap)=>roles.profileAllows(principal.profile,cap)},'@/lib/server/work-order-mentions':server});
 return {route,writes,queries,get:directory=>route.GET({nextUrl:new URL('https://local/api/work-orders/mentions'+(directory?'?directory=1':''))}),patch:ids=>route.PATCH({json:async()=>({ids})})};
}
for(const role of ['Chief Engineer','Maintenance Technician','General Manager','Assistant General Manager','Front Desk Manager','Front Desk','Lead Housekeeper','Senior Management','System Administrator'])test(`${role} can create/view mentions for all roles and staff without full-name or foreign-hotel exposure`,async()=>{
 const f=fixture(role);const directory=await f.get(true);assert.equal(directory.status,200);
 assert.ok(directory.body.mentions.some(m=>m.label==='Scott'));assert.ok(directory.body.mentions.some(m=>m.label==='Front Desk Manager'));
 assert.ok(!JSON.stringify(directory.body).match(/Pickering|Private|Inactive|userIds|email/));
 const inbox=await f.get(false);assert.equal(inbox.body.notifications.length,1);assert.equal(inbox.body.notifications[0].notification_key,key);
 assert.equal((await f.patch([key])).status,200);
 assert.ok(f.writes[0].filters.every(filter=>filter({notification_key:key,hotel_id:hotel,recipient_user_id:user,read_at:null})));
 assert.ok(!f.writes[0].filters.every(filter=>filter({notification_key:key,hotel_id:'another-hotel',recipient_user_id:'foreign',read_at:null})));
});
test('anonymous/unknown roles are denied and notification writes cannot touch Staff Notes',async()=>{
 for(const f of [fixture('unknown'),fixture('Front Desk',false)]){assert.equal((await f.get(true)).status,403);assert.equal((await f.patch([key])).status,403);assert.equal(f.writes.length,0)}
 const f=fixture();assert.equal((await f.patch(['staff-note:unrelated'])).status,400);assert.equal(f.writes.length,0);
});


test('read-only release gate requires the atomic mention RPC before deploying the app',async()=>{
 const source=readFileSync(new URL('../scripts/check-release-schema.mjs',import.meta.url),'utf8').replace(/^#![^\n]*\n/,'');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const available of [false,true]){
  const process={env:{NEXT_PUBLIC_SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'},exitCode:undefined};let report;
  const schema={definitions:new Proxy({},{get:()=>({properties:new Proxy({},{get:()=>({})})})}),paths:available?{'/rpc/cmpri_save_mentioned_work_order':{post:{}}}:{}};
  await new AsyncFunction('fetch','process','console','AbortSignal',source)(async()=>({ok:true,json:async()=>schema}),process,{log:value=>report=JSON.parse(value),error:message=>{throw Error(message)}},{timeout:()=>undefined});
  assert.equal(report.passed,available);assert.equal(process.exitCode,available?0:1);
  assert.equal(report.missing.includes('Function: cmpri_save_mentioned_work_order'),!available);
 }
});
