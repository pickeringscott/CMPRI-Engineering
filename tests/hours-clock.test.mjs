import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import * as core from '../src/lib/hours-tracker.ts';
const load=(file,deps={},extra={})=>{const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,structuredClone,Response,Error,Intl,Date,...extra,require:n=>{assert.ok(n in deps,n);return deps[n];}});return exports;};
const roles=load('../src/lib/server/roles.ts');
const store=load('../src/lib/server/hours-tracker-store.ts',{'./roles':roles,'../hours-tracker':core});
const clock=load('../src/lib/server/hours-clock.ts',{'./hours-tracker-store':store,'../hours-tracker':core});
const owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002';
const principal=id=>({identity:{id},profile:{id,role:'Chief Engineer',active:true},membership:{user_id:id,hotel_id:'hotel',active:true},hotelId:'hotel'});
const blank=()=>({version:1,anchor:core.PAYROLL_ANCHOR,periods:[],leaveConfigurations:[]});
const start={action:'clock_in',request_id:'request-clock-in-0001'};
const stop={action:'clock_out',request_id:'request-clock-out-001',shift_id:start.request_id};
const at=iso=>new Date(iso);
test('open shifts count nothing; close applies five-hour break once and stable retries add nothing',()=>{
 const open=clock.transitionClock(blank(),start,at('2026-10-16T14:00:38Z'));
 assert.equal(open.document.periods.length,0);assert.equal(open.document.clock.open.minute,540);assert.equal(open.result.workedMinutes,null);
 const retry=clock.transitionClock(open.document,start,at('2026-10-16T15:00:00Z'));assert.equal(retry.duplicate,true);assert.equal(retry.result.at,open.result.at);
 assert.throws(()=>clock.transitionClock(open.document,{...start,request_id:'different-clock-in-01'},at('2026-10-16T15:00:00Z')),e=>e.status===409);
 const end=clock.transitionClock(open.document,stop,at('2026-10-16T19:00:59Z'));assert.equal(end.result.workedMinutes,270);assert.equal(end.document.clock.open,null);
 assert.equal(end.document.periods[0].days[0].attendance.end,840);
 assert.equal(clock.transitionClock(end.document,stop,at('2026-10-17T19:00:00Z')).duplicate,true);
 assert.throws(()=>clock.transitionClock(end.document,{...stop,shift_id:'another-shift'},at('2026-10-16T19:01:00Z')),e=>e.status===409);
});
test('Chicago midnight/period boundary requires explicit overnight and attributes hours to start day',()=>{
 const open=clock.transitionClock(blank(),start,at('2026-10-16T04:30:00Z'));
 assert.equal(open.result.workDate,'2026-10-15');assert.equal(open.document.clock.open.periodStart,'2026-10-02');
 assert.throws(()=>clock.transitionClock(open.document,stop,at('2026-10-16T06:00:00Z')),e=>e.status===409);
 const end=clock.transitionClock(open.document,{...stop,confirm_overnight:true},at('2026-10-16T06:00:00Z'));
 assert.equal(end.result.workedMinutes,90);assert.equal(end.document.periods[0].days[13].attendance.nextDay,true);
});
test('DST, reversed clocks, stale shifts and caller-supplied owner/timestamps fail safely',()=>{
 const open=clock.transitionClock(blank(),start,at('2026-11-01T05:30:00Z'));
 assert.throws(()=>clock.transitionClock(open.document,stop,at('2026-11-01T08:30:00Z')),/daylight-saving/);
 assert.throws(()=>clock.transitionClock(open.document,stop,at('2026-11-01T05:29:00Z')),e=>e.status===409);
 assert.throws(()=>clock.transitionClock(open.document,stop,at('2026-11-03T05:30:00Z')),e=>e.status===409);
 for(const field of ['owner_id','at','date','rateCents'])assert.throws(()=>clock.transitionClock(blank(),{...start,[field]:other},at('2026-10-16T14:00:00Z')),e=>e.status===400);
 assert.equal(open.document.clock.open.id,start.request_id);
});
test('manual attendance is never overwritten; mixed leave and period rate are preserved',()=>{
 const d=blank();d.periods=[{start:'2026-10-16',days:core.emptyPeriod('2026-10-16'),rateCents:1975,deductionPercent:13}];
 d.periods[0].days[0].attendance={state:'off'};assert.throws(()=>clock.transitionClock(d,start,at('2026-10-16T14:00:00Z')),e=>e.status===409);
 d.periods[0].days[0].attendance={state:'blank'};d.periods[0].days[0].leave=[{kind:'company-pto',minutes:60}];
 const opened=clock.transitionClock(d,start,at('2026-10-16T14:00:00Z'));
 const closed=clock.transitionClock(opened.document,stop,at('2026-10-16T18:00:00Z'));
 assert.equal(closed.document.periods[0].rateCents,1975);assert.equal(closed.document.periods[0].days[0].leave[0].minutes,60);assert.equal(closed.result.workedMinutes,240);
});
test('activation is off by default, exact-owner gated, and retains normal eligibility',()=>{
 const env={};const policy=load('../src/lib/server/hours-clock-policy.ts',{'./hours-tracker-store':store},{process:{env}});
 assert.equal(policy.hoursClockEnabled(principal(owner)),false);env.CMPRI_HOURS_CLOCK_ENABLED='true';assert.equal(policy.hoursClockEnabled(principal(owner)),false);
 env.CMPRI_HOURS_CLOCK_OWNER_IDS=owner;assert.equal(policy.hoursClockEnabled(principal(owner)),true);assert.equal(policy.hoursClockEnabled(principal(other)),false);
 assert.equal(policy.hoursClockEnabled({...principal(owner),profile:{...principal(owner).profile,role:'General Manager'}}),false);
});
test('PostgreSQL concurrent saves, owner isolation, manual draft guard and durable duplicate recovery',async()=>{
 const db=new PGlite();try{
 await db.exec(`create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;insert into auth.users values('${owner}'),('${other}');`);
 await db.exec(readFileSync(new URL('../docs/hours-tracker-schema.sql',import.meta.url),'utf8'));
 const client={from(name){assert.equal(name,'cmpri_personal_hours');let action='read',value;const filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},insert(v){action='insert';value=v;return q;},update(v){action='update';value=v;return q;},async maybeSingle(){try{let r;if(action==='insert')r=await db.query('insert into cmpri_personal_hours values($1,$2,$3) returning revision',[value.owner_id,value.revision,JSON.stringify(value.document)]);else if(action==='update')r=await db.query('update cmpri_personal_hours set document=$1,revision=$2 where owner_id=$3 and revision=$4 returning revision',[JSON.stringify(value.document),value.revision,filters[0][1],filters[1][1]]);else r=await db.query('select document,revision from cmpri_personal_hours where owner_id=$1',[filters[0][1]]);return {data:r.rows[0]??null,error:null};}catch(error){return {data:null,error};}}};return q;}};
 const outcomes=await Promise.allSettled([clock.clockHours(client,principal(owner),start,at('2026-10-16T14:00:00Z')),clock.clockHours(client,principal(owner),start,at('2026-10-16T14:00:00Z'))]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 const retry=await clock.clockHours(client,principal(owner),start,at('2026-10-16T14:01:00Z'));assert.equal(retry.duplicate,true);
 assert.equal(await store.readHours(client,principal(other)),null);
 const period={start:'2026-10-16',days:core.emptyPeriod('2026-10-16'),rateCents:2100,deductionPercent:15};period.days[0].attendance={...core.NEW_WORK};
 await assert.rejects(()=>store.saveHours(client,principal(owner),{period,revision:1}),e=>e.status===409);
 period.days[0].attendance={state:'blank'};await store.saveHours(client,principal(owner),{period,revision:1});
 assert.equal((await store.readHours(client,principal(owner))).document.clock.open.id,start.request_id);
 await clock.clockHours(client,principal(owner),stop,at('2026-10-16T19:00:00Z'));
 await assert.rejects(()=>store.saveHours(client,principal(owner),{period,revision:2}),e=>e.status===409);
 const saved=await store.readHours(client,principal(owner));assert.equal(saved.document.periods[0].rateCents,2100);assert.equal(saved.document.clock.receipts.length,2);
 await assert.rejects(()=>clock.clockHours(client,principal(other),{...start,owner_id:owner},at('2026-10-16T14:00:00Z')),e=>e.status===400);
 await assert.rejects(()=>store.readHours(client,principal(owner),true),e=>e.status===403);
 }finally{await db.close();}
});

test('clock API denies unauthenticated and unactivated requests before storage; returns only scoped receipt',async()=>{
 let calls=0;
 const make=(auth,enabled)=>load('../src/app/api/hours-tracker/clock/route.ts',{'@/lib/server/auth':{requireUserAttempt:async()=>auth},'@/lib/server/hours-clock-policy':{hoursClockEnabled:()=>enabled},'@/lib/server/hours-clock':{clockHours:async(_client,p,body)=>{calls++;assert.equal(p.identity.id,owner);assert.equal(body.action,'clock_in');return {shiftId:body.request_id,workedMinutes:null};}},'@/lib/server/hours-tracker-store':store});
 const req=()=>new Request('http://localhost/api/hours-tracker/clock',{method:'POST',body:JSON.stringify(start)});
 assert.equal((await make({ok:false},true).POST(req())).status,401);
 assert.equal((await make({ok:true,principal:principal(owner)},false).POST(req())).status,403);assert.equal(calls,0);
 const response=await make({ok:true,mcp:true,principal:principal(owner),admin:{}},true).POST(req());
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.deepEqual(await response.json(),{shiftId:start.request_id,workedMinutes:null});assert.equal(calls,1);
});

test('confirmed fall/spring DST elapsed time reconciles without guessing ambiguous wall hours',()=>{
 for(const [begin,end,elapsed] of [['2026-11-01T05:30:00Z','2026-11-01T02:30:00-06:00',180],['2026-03-08T06:30:00Z','2026-03-08T03:30:00-05:00',120]]){
  const opened=clock.transitionClock(blank(),start,at(begin));
  const request={...stop,reconciliation:{resolution:'finish',confirmed:true,reason:'User confirmed exact offset and duration',end_at:end,elapsed_minutes:elapsed}};
  const done=clock.transitionClock(opened.document,request,at('2026-11-02T12:00:00Z'));
  assert.equal(done.result.workedMinutes,elapsed);assert.equal(done.result.reconciliation.elapsedMinutes,elapsed);
  const p=done.document.periods[0],day=p.days.find(d=>d.attendance.state==='work');
  assert.equal(core.dayTotals(day).worked,elapsed);store.parseHoursPeriod(p);
  assert.equal(clock.transitionClock(done.document,request,at('2026-11-03T12:00:00Z')).duplicate,true);
  assert.equal(done.document.clock.open,null);
 }
});
test('forgotten timers require a confirmed end or explicit discard; neither fabricates attendance',()=>{
 const opened=clock.transitionClock(blank(),start,at('2026-10-16T14:00:00Z'));
 const request={...stop,reconciliation:{resolution:'finish',confirmed:true,reason:'User states work ended at 17:00 that day',end_at:'2026-10-16T17:00:00-05:00',elapsed_minutes:480}};
 const done=clock.transitionClock(opened.document,request,at('2026-10-19T14:00:00Z'));assert.equal(done.result.workedMinutes,450);
 for(const change of [{confirmed:false},{elapsed_minutes:479},{end_at:'2026-10-16T17:00:00'},{end_at:'2026-10-16T17:00:00-06:00'},{end_at:'2026-10-20T17:00:00-05:00'}])assert.throws(()=>clock.transitionClock(opened.document,{...request,reconciliation:{...request.reconciliation,...change}},at('2026-10-19T14:00:00Z')));
 const discard={...stop,reconciliation:{resolution:'discard',confirmed:true,reason:'User explicitly confirms accidental open timer'}};
 const cleared=clock.transitionClock(opened.document,discard,at('2026-10-19T14:00:00Z'));
 assert.equal(cleared.document.periods.length,0);assert.equal(cleared.result.workedMinutes,null);assert.equal(cleared.result.reconciliation.originalStartAt,opened.result.at);
 assert.equal(cleared.document.clock.open,null);assert.equal(clock.transitionClock(cleared.document,discard,at('2026-10-20T00:00:00Z')).duplicate,true);
});
test('confirmed timestamps cannot be reused with different dates or displayed times',()=>{
 const attendance={state:'work',start:30,end:150,nextDay:false,clockSpan:{startAt:'2026-11-01T05:30:00.000Z',endAt:'2026-11-01T08:30:00.000Z'}};
 assert.equal(core.dayTotals({date:'2026-11-01',attendance,leave:[]}).worked,180);
 assert.throws(()=>core.dayTotals({date:'2026-11-02',attendance,leave:[]}));
 assert.throws(()=>core.workedMinutes({...attendance,end:151}));
});
