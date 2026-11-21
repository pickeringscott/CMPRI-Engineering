import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as roles from '../src/lib/server/roles.ts';
import * as schedule from '../src/lib/notifications/schedule.ts';
import * as preferences from '../src/lib/profile-preferences.ts';
import {allows,resolvePrincipal} from '../src/lib/server/access.ts';

const HOTEL='property-fixture',USER='housekeeper-fixture',OTHER='other-fixture';
const clone=value=>JSON.parse(JSON.stringify(value));
const settings={timezone:'America/Chicago',schedule:schedule.defaultNotificationSchedule()};
const subscription={endpoint:'https://push.example.invalid/housekeeping-device',expirationTime:null,keys:{p256dh:'fixture-public-key',auth:'fixture-secret'}};
function principal(role='Lead Housekeeper',active=true){
 return resolvePrincipal({id:USER,email:'housekeeping@example.invalid'},HOTEL,
  {id:USER,email:'housekeeping@example.invalid',role,active,full_name:'Fixture Housekeeper'},
  {user_id:USER,hotel_id:HOTEL,role:'technician',active},
  [{role,permission:'manage_users',allowed:true},{role,permission:'manage_work_orders',allowed:true}]);
}
function fixture({role='Lead Housekeeper',authorized=true,configured=true}={}){
 const tables={
  profiles:[{id:USER,full_name:'Fixture Housekeeper',email:'housekeeping@example.invalid',role,preferences:clone(preferences.DEFAULT_PROFILE_PREFERENCES)},
   {id:OTHER,full_name:'Other person',email:'other@example.invalid',role:'system_admin',preferences:clone(preferences.DEFAULT_PROFILE_PREFERENCES)}],
  cmpri_user_notification_schedules:[],cmpri_web_push_subscriptions:[],cmpri_dashboard_notification_cursors:[],
 };
 const writes=[];let failTable='';
 class Query{
  constructor(table){this.table=table;this.filters=[];this.operation='select';this.value=null}
  select(){return this}eq(k,v){this.filters.push([k,v]);return this}is(k,v){return this.eq(k,v)}gt(){return this}
  update(v){this.operation='update';this.value=v;return this}upsert(v){this.operation='upsert';this.value=v;return this}
  insert(v){this.operation='insert';this.value=v;return this}delete(){this.operation='delete';return this}
  matches(row){return this.filters.every(([k,v])=>k==='preferences'||k==='schedule'?JSON.stringify(row[k])===v:row[k]===v)}
  result(single=false){
   const rows=tables[this.table]||[];
   if(this.operation==='select'){const data=rows.filter(row=>this.matches(row));return {data:single?data[0]||null:data,error:null}}
   if(failTable===this.table)return {data:null,error:{code:'fixture_failure'}};
   writes.push({table:this.table,operation:this.operation,filters:clone(this.filters),value:clone(this.value)});
   if(this.operation==='delete'){tables[this.table]=rows.filter(row=>!this.matches(row));return {data:null,error:null}}
   if(this.operation==='update'){
    const data=rows.filter(row=>this.matches(row));for(const row of data)Object.assign(row,clone(this.value));
    return {data:single?data[0]||null:data,error:null};
   }
   const key=this.table==='profiles'?'id':this.table==='cmpri_web_push_subscriptions'?'endpoint':this.table==='cmpri_user_notification_schedules'?'user_id':'recipient_user_id';
   const existing=rows.find(row=>row[key]===this.value[key]&&row.hotel_id===this.value.hotel_id);
   if(existing&&this.operation==='upsert')Object.assign(existing,clone(this.value));
   else rows.push({id:'fixture-'+rows.length,...clone(this.value)});
   tables[this.table]=rows;return {data:single?existing||rows.at(-1):rows,error:null};
  }
  async maybeSingle(){return this.result(true)}single(){return this.maybeSingle()}
  then(yes,no){return Promise.resolve(this.result()).then(yes,no)}
 }
 const p=principal(role),admin={from:table=>new Query(table)};
 const load=path=>{
  const context={exports:{},URL,require(name){
   if(name==='next/server')return {NextResponse:{json:(body,opts={})=>({body:clone(body),status:opts.status||200})}};
   if(name.includes('server/auth'))return {requireUser:async()=>authorized?{principal:p,admin}:null};
   if(name.includes('server/access'))return {allows};
   if(name.includes('server/roles'))return roles;
   if(name.includes('profile-preferences'))return preferences;
   if(name.includes('notifications/schedule'))return schedule;
   if(name.includes('notifications/web-push'))return {webPushPublicKey:()=>configured?'fixture-vapid-key':''};
   if(name.includes('constants'))return {HOTEL_ID:HOTEL};
   if(name.includes('cmpri-mcp'))return {connectionFromActiveTokens:()=>({connected:false})};
   throw Error('Unexpected dependency '+name);
  }};
  vm.createContext(context);vm.runInContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  return context.exports;
 };
 const profile=load('../src/app/api/profile/route.ts'),phone=load('../src/app/api/profile/phone-notifications/route.ts');
 const request=body=>({json:async()=>body,nextUrl:new URL('https://cmpri.example.invalid/api/profile/phone-notifications')});
 return {tables,writes,profileGet:()=>profile.GET(request()),profilePatch:body=>profile.PATCH(request(body)),
  phoneGet:endpoint=>phone.GET({nextUrl:new URL('https://cmpri.example.invalid/api/profile/phone-notifications'+(endpoint?'?endpoint='+encodeURIComponent(endpoint):''))}),
  phonePost:body=>phone.POST(request(body)),fail:table=>{failTable=table}};
}

test('Lead Housekeeper language survives save/reopen in both directions without changing role or other profiles',async()=>{
 const f=fixture();
 for(const language of ['es','en']){
  const before=await f.profileGet();assert.equal(before.body.can_manage_users,false);
  const changed={...before.body.preferences,language};
  const ack=await f.profilePatch({full_name:'Fixture Housekeeper',preferences:changed,role:'system_admin',baseline:{name:'Fixture Housekeeper',preferences:before.body.preferences}});
  assert.equal(ack.status,200);assert.equal(ack.body.preferences.language,language);
  const reopened=await f.profileGet();assert.equal(reopened.body.preferences.language,language);
  assert.equal(reopened.body.profile.role,'Lead Housekeeper');assert.equal(reopened.body.can_manage_users,false);
  assert.equal(reopened.body.preferences.notification_mode,'in_app');
  assert.ok(Object.values(reopened.body.preferences.notifications).every(value=>value===false));
 }
 assert.equal(f.tables.profiles.find(row=>row.id===OTHER).preferences.language,'en');
 assert.ok(f.writes.filter(row=>row.table==='profiles').every(row=>row.filters.some(([key,value])=>key==='id'&&value===USER)));
});

test('Lead Housekeeper phone toggle and weekday schedule persist after fresh reads; another owner remains untouched',async()=>{
 const f=fixture();
 f.tables.cmpri_web_push_subscriptions.push({id:'other-device',hotel_id:HOTEL,recipient_user_id:OTHER,endpoint:'https://push.example.invalid/other',enabled:true});
 const monday={...clone(settings),schedule:{...clone(settings.schedule),monday:{enabled:true,start:'07:00',end:'15:30'}}};
 assert.equal((await f.phonePost({action:'schedule',...monday,baseline:{configured:false,settings}})).status,200);
 assert.equal((await f.phonePost({action:'subscribe',subscription,recipient_user_id:OTHER})).body.ok,true);
 let reopened=await f.phoneGet(subscription.endpoint);
 assert.equal(reopened.body.subscribed_on_this_device,true);assert.deepEqual(reopened.body.settings,monday);
 assert.equal(f.tables.cmpri_web_push_subscriptions.find(row=>row.endpoint===subscription.endpoint).recipient_user_id,USER);
 assert.equal((await f.phonePost({action:'unsubscribe',endpoint:subscription.endpoint,recipient_user_id:OTHER})).body.ok,true);
 reopened=await f.phoneGet(subscription.endpoint);assert.equal(reopened.body.subscribed_on_this_device,false);
 assert.deepEqual(reopened.body.settings,monday);
 assert.equal(f.tables.cmpri_web_push_subscriptions.find(row=>row.recipient_user_id===OTHER).enabled,true);
 assert.equal((await f.phonePost({action:'unsubscribe',endpoint:'https://push.example.invalid/other'})).body.ok,true);
 assert.equal(f.tables.cmpri_web_push_subscriptions.find(row=>row.recipient_user_id===OTHER).enabled,true);
});

test('failed phone save/unsubscribe retains prior enabled state and unsupported configuration rejects enrollment',async()=>{
 const f=fixture();await f.phonePost({action:'subscribe',subscription});f.fail('cmpri_web_push_subscriptions');
 assert.equal((await f.phonePost({action:'unsubscribe',endpoint:subscription.endpoint})).status,503);
 assert.equal((await f.phoneGet(subscription.endpoint)).body.subscribed_on_this_device,true);
 const missing=fixture({configured:false});assert.equal((await missing.phonePost({action:'subscribe',subscription})).status,503);assert.equal(missing.writes.length,0);
 const bad=fixture();assert.equal((await bad.phonePost({action:'subscribe',subscription:{...subscription,endpoint:'http://untrusted.example.invalid'}})).status,400);assert.equal(bad.writes.length,0);
});

test('Lead Housekeeping aliases keep explicit role/access and Staff Notes push policy; inactive accounts fail closed',()=>{
 for(const role of ['housekeeping','Housekeeping','Lead Housekeeper','Executive Housekeeper']){
  const p=principal(role);assert.equal(roles.roleKey(role),'housekeeping');assert.equal(allows(p,'manage_users'),false);
  assert.equal(allows(p,'edit_tickets'),false);assert.equal(allows(p,'submit'),true);
  assert.equal(roles.canManageTargetRole(role,'Front Desk'),false);
  assert.equal(roles.canManageTargetRole('Engineer',role),true);
  assert.equal(schedule.isNotificationScheduleEligibleProfile(p.profile),true);
  assert.equal(schedule.isStaffNotesPushEligibleProfile(p.profile),true);
  assert.equal(schedule.isWebPushEligibleProfile(p.profile),false);
 }
 assert.equal(principal('Lead Housekeeper',false),null);
});

test('anonymous and ordinary Front Desk notification calls fail without writes',async()=>{
 const anonymous=fixture({authorized:false});assert.equal((await anonymous.phonePost({action:'subscribe',subscription})).status,401);assert.equal(anonymous.writes.length,0);
 const frontDesk=fixture({role:'Front Desk'});assert.equal((await frontDesk.phonePost({action:'schedule',...settings})).status,403);assert.equal(frontDesk.writes.length,0);
});
