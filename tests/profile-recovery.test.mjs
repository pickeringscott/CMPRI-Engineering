import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React, {act} from 'react';
import * as jsx from 'react/jsx-runtime';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import * as recovery from '../src/lib/profile-recovery.ts';
import {DEFAULT_PROFILE_PREFERENCES as prefs, normalizeProfilePreferences, resolveProfileTimeFormat} from '../src/lib/profile-preferences.ts';
import * as accountDisplay from '../src/lib/account-display.ts';
import * as notificationSchedule from '../src/lib/notifications/schedule.ts';
import * as roles from '../src/lib/server/roles.ts';
import * as time from '../src/lib/ui/time-format.ts';
import {loadTs} from './helpers/load-ts.mjs';
import {uiLanguageDependency} from './helpers/ui-language.mjs';
const scope={hotelId:'property-a',userId:'person-a'};
const baseline={name:'Alex',preferences:prefs};
const changed={name:'Alex Morgan',preferences:{...prefs,appearance:'light'}};
function storage(){const rows=new Map();return {getItem:k=>rows.get(k)||null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k),rows};}
test('profile draft survives a new reader with exact name/preferences and an explicit server baseline',()=>{
 const disk=storage();assert.equal(recovery.saveProfileRecovery(disk,scope,changed,baseline),true);
 const saved=recovery.readProfileRecovery(disk,scope);assert.deepEqual(saved.fields,changed);assert.equal(recovery.canRestoreProfileRecovery(saved,baseline),true);
 assert.equal(recovery.canRestoreProfileRecovery(saved,{...baseline,name:'Newer server name'}),false);
 assert.equal(recovery.canRestoreProfileRecovery(saved,{...baseline,preferences:{...prefs,language:'es'}}),false);
 for(const other of [{...scope,userId:'other'},{...scope,hotelId:'other'}])assert.equal(recovery.readProfileRecovery(disk,other),null);
 // A copied payload cannot defeat account/property scoping.
 disk.setItem(recovery.profileRecoveryKey({...scope,userId:'other'}),disk.getItem(recovery.profileRecoveryKey(scope)));
 assert.equal(recovery.readProfileRecovery(disk,{...scope,userId:'other'}),null);
});
test('profile recovery whitelists fields and fails visibly to callers when browser storage rejects writes',()=>{
 const disk=storage();recovery.saveProfileRecovery(disk,scope,{...changed,access_token:'secret',preferences:{...prefs,session:'secret'}},baseline);
 assert.doesNotMatch(disk.getItem(recovery.profileRecoveryKey(scope)),/secret|access_token|session/);
 assert.equal(recovery.saveProfileRecovery({getItem:()=>null,setItem(){throw Error('quota')}},scope,changed,baseline),false);
 disk.setItem('other-editor','kept');assert.equal(recovery.clearProfileRecovery(disk,scope),true);assert.equal(disk.getItem('other-editor'),'kept');
});
test('unfinished notification schedules preserve typed timezone and their own baseline without storing push credentials',()=>{
 const disk=storage(),schedule=Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day=>[day,{enabled:false,start:'09:00',end:'17:00'}]));
 const before={timezone:'America/Chicago',schedule};const after={timezone:'America/Chic',schedule:{...schedule,monday:{...schedule.monday,enabled:true}}};
 assert.equal(recovery.savePhoneScheduleRecovery(disk,{version:1,...scope,fields:{...after,endpoint:'https://secret'},baseline:before,configured:true,subscription:'secret'}),true);
 const saved=recovery.readPhoneScheduleRecovery(disk,scope);assert.deepEqual(saved.fields,after);assert.deepEqual(saved.baseline,before);
 assert.doesNotMatch(disk.getItem(recovery.phoneScheduleRecoveryKey(scope)),/secret|endpoint|subscription/);
 recovery.clearPhoneScheduleRecovery(disk,scope);assert.equal(recovery.readPhoneScheduleRecovery(disk,scope),null);
});

function routeFixture({before=baseline,race=false,authorized=true}={}){
 let row={id:'person-a',full_name:before.name,preferences:before.preferences,role:'chief_engineer',email:null},writes=0,attempts=0;
 class Query{
  constructor(table){this.table=table;this.filters=[];this.values=null;}
  select(){return this} update(values){this.values=values;return this} eq(k,v){this.filters.push([k,v]);return this} is(k,v){return this.eq(k,v)} gt(){return this}
  async maybeSingle(){
   if(this.table!=='profiles')return {data:[],error:null};
   if(!this.values)return {data:{...row},error:null};
   attempts++;if(race)row={...row,full_name:'Concurrent server update'};
   const match=this.filters.every(([k,v])=>k==='preferences'?JSON.stringify(row[k])===v:row[k]===v);
   if(!match)return {data:null,error:null};writes++;row={...row,...this.values};return {data:{...row},error:null};
  }
  single(){return this.maybeSingle()} then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject)}
 }
 const context={exports:{},require(name){
  if(name==='next/server')return {NextResponse:{json:(body,options={})=>({body,status:options.status||200})}};
  if(name.includes('server/auth'))return {requireUser:async()=>authorized?{principal:{identity:{id:'person-a'},profile:{role:'chief_engineer'}},admin:{from:table=>new Query(table)}}:null};
  if(name.includes('server/access'))return {allows:()=>true};
  if(name.includes('profile-preferences'))return {DEFAULT_PROFILE_PREFERENCES:prefs,normalizeProfilePreferences};
  if(name.includes('server/roles'))return {isSubmitOnlyRole:()=>false};
  if(name.includes('cmpri-mcp'))return {connectionFromActiveTokens:()=>({connected:false})};
  throw Error(name);
 }};
 vm.createContext(context);vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/app/api/profile/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {patch:body=>context.exports.PATCH({json:async()=>body}),get row(){return row},get writes(){return writes},get attempts(){return attempts}};
}
test('profile save compares the recovered baseline and atomically rejects a server edit between read and update',async()=>{
 for(const fixture of [routeFixture({before:{...baseline,name:'Already changed'}}),routeFixture({race:true})]){
  const response=await fixture.patch({full_name:changed.name,preferences:changed.preferences,baseline});
  assert.equal(response.status,409);assert.equal(fixture.writes,0);assert.ok(fixture.attempts<=1,'no unconditional fallback can bypass comparison');
 }
});
test('profile CAS acknowledgement and existing caller behavior remain compatible and authorized',async()=>{
 const fixture=routeFixture();const ack=await fixture.patch({full_name:changed.name,preferences:changed.preferences,baseline});
 assert.equal(ack.status,200);assert.equal(ack.body.profile.full_name,changed.name);assert.equal(fixture.writes,1);
 const legacy=routeFixture();assert.equal((await legacy.patch({full_name:changed.name})).status,200);assert.equal(legacy.writes,1);
 const denied=routeFixture({authorized:false});assert.equal((await denied.patch({full_name:changed.name,baseline})).status,401);assert.equal(denied.writes,0);
});

test('time defaults respect authorized Chief assignment and preferences round-trip explicitly', async () => {
 const chief = { role: 'chief_engineer' };
 const scott = { id:'750f77bf-7d5d-4ca6-8421-e025edea87ba', email:'maint.cmpri@hawkeyehotels.com', role:'system_admin', secondary_roles:['engineer'] };
 assert.equal(resolveProfileTimeFormat({}, chief), '24h');
 assert.equal(resolveProfileTimeFormat({}, scott), '24h');
 assert.equal(resolveProfileTimeFormat({}, {...scott,id:'different'}), '12h');
 assert.equal(resolveProfileTimeFormat({time_format:'invalid'}, {role:'engineer'}), '12h');
 assert.equal(resolveProfileTimeFormat({time_format:'12h'}, chief), '12h');
 assert.equal(resolveProfileTimeFormat({time_format:'24h'}, {role:'technician'}), '24h');
 assert.equal(Object.hasOwn(normalizeProfilePreferences({}), 'time_format'), false);
 const fixture = routeFixture(), selection = {...prefs,time_format:'12h'};
 const ack = await fixture.patch({preferences:selection,baseline});
 assert.equal(ack.status, 200);
 assert.equal(ack.body.preferences.time_format, '12h');
 assert.equal(fixture.row.preferences.time_format, '12h');
 const oldClient = await fixture.patch({preferences:{...prefs,appearance:'light'}});
 assert.equal(oldClient.status, 200);
 assert.equal(fixture.row.preferences.time_format, '12h');
 assert.equal(fixture.row.preferences.appearance, 'light');
});

test('Manage Profile previews the draft clock format without rewriting notification schedule values', async () => {
 const dom = new JSDOM('<div id="root"></div>', {url:'https://fixture.invalid/profile'});
 const globals = {window:dom.window, document:dom.window.document, IS_REACT_ACT_ENVIRONMENT:true};
 const previous = Object.fromEntries(Object.keys(globals).map(key=>[key,globalThis[key]]));
 Object.assign(globalThis, globals);
 const root = createRoot(document.querySelector('#root'));
 const profile = {id:scope.userId, role:'chief_engineer', full_name:baseline.name};
 const session = {access_token:'fixture', user:{id:scope.userId}};
 const writes = [];
 const schedule = notificationSchedule.defaultNotificationSchedule();
 schedule.monday = {enabled:true, start:'17:07', end:'23:45'};
 const Profile = loadTs('src/app/profile/page.tsx', {
   react:React, 'react/jsx-runtime':jsx, '@/components/UiLanguageProvider':uiLanguageDependency,
   '@/lib/account-display':accountDisplay, '@/lib/server/roles':roles, '@/lib/notifications/schedule':notificationSchedule,
   '@/lib/ui/time-format':time, '@/lib/profile-recovery':recovery, '@/lib/profile-preferences':{resolveProfileTimeFormat},
   '@/lib/auth/client-session':{loadCmpriSession:async()=>({hotelId:scope.hotelId,user:profile})},
   '@/lib/supabase/client':{
     getValidSession:async()=>session, signOutDevice:async()=>{},
     createClient:()=>({auth:{onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}}),
   },
   '@/components/ModalDashboardLink':{default:()=>null}, '@/components/ModalNavigationButton':{default:()=>null},
   '@/components/PhoneNotificationRow':{default:()=>null}, '@/components/use-embedded-modal':{default:()=>false},
 }, {
   ...globals, localStorage:dom.window.localStorage, navigator:dom.window.navigator,
   fetch:async (url, init)=>{
     if (init?.method && init.method!=='GET') writes.push({url,method:init.method});
     if (url==='/api/profile/phone-notifications') return Response.json({
       configured:true, public_key:'', subscribed_on_this_device:false, settings:{timezone:'America/Chicago',schedule},
     });
     return Response.json({profile,preferences:prefs,profile_settings_available:true,chatgpt_connection:null});
   },
 }).default;
 const selectByLabel = text => [...document.querySelectorAll('label')]
   .find(label=>label.firstChild?.textContent?.trim()===text)?.querySelector('select');
 const selectedLabel = select => select.selectedOptions[0].textContent;
 try {
   await act(async()=>{root.render(React.createElement(Profile));});
   const format=selectByLabel('Time Format'), start=selectByLabel('Start'), end=selectByLabel('End');
   assert.equal(format.value,'24h');
   assert.equal(selectedLabel(start),'17:07 (current)');
   assert.equal(selectedLabel(end),'23:45');
   await act(async()=>{
     format.value='12h';
     format.dispatchEvent(new window.Event('change',{bubbles:true}));
   });
   assert.match(selectedLabel(start), /^5:07\s+PM \(current\)$/);
   assert.match(selectedLabel(end), /^11:45\s+PM$/);
   assert.equal(start.value,'17:07');
   assert.equal(end.value,'23:45');
   assert.deepEqual(writes,[]);
 } finally {
   await act(async()=>{root.unmount();});
   dom.window.close();
   for(const [key,value] of Object.entries(previous)) {
     if(value===undefined) delete globalThis[key]; else globalThis[key]=value;
   }
 }
});

const phoneSchedule={timezone:'America/Chicago',schedule:Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day=>[day,{enabled:false,start:'09:00',end:'17:00'}]))};
function scheduleFixture({exists=true,race=false}={}){
 let row=exists?{hotel_id:'hotel-a',user_id:'person-a',...phoneSchedule}:null,writes=0;
 class Query{
  constructor(){this.filters=[];this.values=null}
  select(){return this}eq(k,v){this.filters.push([k,v]);return this} update(v){this.values=v;return this}
  async maybeSingle(){
   if(!this.values)return {data:row&&{...row},error:null};
   if(race)row={...row,timezone:'America/New_York'};
   const match=row&&this.filters.every(([k,v])=>k==='schedule'?JSON.stringify(row[k])===v:row[k]===v);
   if(!match)return {data:null,error:null};writes++;row={...row,...this.values};return {data:row,error:null};
  }
  async insert(v){if(race)row={...v,timezone:'America/New_York'};if(row)return {error:{code:'23505'}};writes++;row=v;return {error:null}}
  async upsert(v){writes++;row=v;return {error:null}}
 }
 const context={exports:{},require(name){
  if(name==='next/server')return {NextResponse:{json:(body,options={})=>({body,status:options.status||200})}};
  if(name.includes('constants'))return {HOTEL_ID:'hotel-a'};
  if(name.includes('server/auth'))return {requireUser:async()=>({principal:{identity:{id:'person-a'},profile:{role:'chief_engineer'}},admin:{from:()=>new Query()}})};
  if(name.includes('notifications/schedule'))return {isNotificationScheduleEligibleProfile:()=>true,normalizeNotificationSettings:value=>value?.timezone&&value?.schedule?{timezone:value.timezone,schedule:value.schedule}:null};
  if(name.includes('web-push'))return {webPushPublicKey:()=>''};
  throw Error(name);
 }};vm.createContext(context);vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/app/api/profile/phone-notifications/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {post:body=>context.exports.POST({json:async()=>body}),get writes(){return writes},get row(){return row}};
}
test('notification schedule uses a conditional update and rejects races for both existing and newly configured schedules',async()=>{
 const changed={...phoneSchedule,timezone:'America/Denver'};
 for(const exists of [true,false]){
  const concurrent=scheduleFixture({exists,race:true});
  const response=await concurrent.post({action:'schedule',...changed,baseline:{configured:exists,settings:phoneSchedule}});
  assert.equal(response.status,409);assert.equal(concurrent.writes,0);
  const clean=scheduleFixture({exists});assert.equal((await clean.post({action:'schedule',...changed,baseline:{configured:exists,settings:phoneSchedule}})).status,200);
  assert.equal(clean.writes,1);assert.equal(clean.row.timezone,'America/Denver');
 }
 const legacy=scheduleFixture();assert.equal((await legacy.post({action:'schedule',...changed})).status,200);assert.equal(legacy.writes,1);
});
