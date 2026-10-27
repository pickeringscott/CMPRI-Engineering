import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPeriod, leaveBalanceDetails, leaveBalance, hawkeyeHourlyTerms, hoursWorkWeekStart, validateLeaveConfiguration } from '../src/lib/hours-tracker.ts';

const evidence = { earnedMinutes:null, carriedInMinutes:null, usedMinutes:null, benefitYearStart:null };
const pto = (patch={}) => ({kind:'company-pto',policy:'hawkeye-hourly',date:'2026-10-02',coveredThrough:'2026-10-01',statementDate:'2026-10-02',minutes:600,earnedMinutesPerWorkedHour:null,note:'Synthetic test',evidence:{...evidence},hawkeye:{hireDate:'2025-09-18',hourlyFullTime:true},...patch});
const illinois = (patch={}) => ({...pto(),kind:'illinois-sick',policy:'illinois-accrual',hawkeye:undefined,provisionalYearStart:true,evidence:{...evidence,benefitYearStart:'2026-01-01',earnedMinutes:1200},...patch});
const work = minutes => ({state:'work',start:0,end:minutes+(minutes>=300?30:0),nextDay:false});
const day = (date,minutes=0,leave=[]) => ({date,attendance:minutes?work(minutes):{state:'off'},leave});
const close = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);

test('per-person service anniversary tiers, including month-end, are explicit',()=>{
  for(const [date,rate,cap] of [['2026-04-29',0,2400],['2026-04-30',.019305,2400],['2029-01-30',.019305,2400],['2029-01-31',.023077,2880],['2032-01-31',.038461,4800]]) assert.deepEqual(hawkeyeHourlyTerms('2026-01-31',date),{rate,cap});
  assert.equal(hawkeyeHourlyTerms('2025-09-18','2026-10-02').rate,.019305);
  assert.equal(hawkeyeHourlyTerms('2020-09-18','2026-10-02').rate,.038461);
  assert.equal(hoursWorkWeekStart('2026-10-08'),'2026-10-02');
  assert.equal(hoursWorkWeekStart('2026-10-09'),'2026-10-09');
});

test('two weeks have separate 40-hour allowances, not pooled 80; Illinois counts overtime',()=>{
  const days=emptyPeriod('2026-10-02');
  for(let i=0;i<6;i++) days[i].attendance=work(600); // 60 hours
  for(let i=7;i<9;i++) days[i].attendance=work(600); // 20 hours
  const before=JSON.stringify(days);
  close(leaveBalanceDetails('company-pto',pto(),days,'2026-10-15').earned,60*60*.019305);
  close(leaveBalanceDetails('illinois-sick',illinois({evidence:{...evidence,benefitYearStart:'2026-01-01',earnedMinutes:0}}),days,'2026-10-15').earned,120);
  assert.equal(JSON.stringify(days),before);
});

test('company cap pauses, usage resumes earning, and missed credits never catch up',()=>{
  const days=[day('2026-10-02',480),day('2026-10-03',480),day('2026-10-04',0,[{kind:'company-pto',minutes:120}]),day('2026-10-05',480)];
  const result=leaveBalanceDetails('company-pto',pto({minutes:2399}),days,'2026-10-05');
  close(result.earned,1+480*.019305);
  close(result.available,2400-120+480*.019305);
  assert.equal(result.used,120);
  close(leaveBalance('company-pto',pto({minutes:2500}),[day('2026-10-02',480)],'2026-10-02'),2500);
});

test('baseline cutoff excludes old earnings/usage but pre-cutoff work consumes weekly allowance',()=>{
  const baseline=pto({date:'2026-10-07',coveredThrough:'2026-10-06',statementDate:'2026-10-08'});
  const days=Array.from({length:7},(_,i)=>day(`2026-10-0${i+2}`,i<5?480:240));
  const result=leaveBalanceDetails('company-pto',baseline,days,'2026-10-08');
  assert.equal(result.earned,0);assert.equal(result.available,600);
  assert.match(leaveBalanceDetails('company-pto',baseline,days.slice(1),'2026-10-08').issue,/worked\/off/);
});

test('same-day cap timing and future borrowing are reported, not guessed',()=>{
  assert.match(leaveBalanceDetails('company-pto',pto({minutes:2400}),[day('2026-10-02',480,[{kind:'company-pto',minutes:120}])],'2026-10-02').issue,/order/);
  const result=leaveBalanceDetails('company-pto',pto({minutes:60}),[day('2026-10-02',0,[{kind:'company-pto',minutes:120}])],'2026-10-02');
  assert.equal(result.available,null);assert.match(result.issue,/cannot borrow/);
});

test('paid leave and unentered days earn nothing; reading repeatedly never posts credits',()=>{
  const days=emptyPeriod('2026-10-02');days[0].leave=[{kind:'company-pto',minutes:120}];days[1].attendance=work(480);
  const baseline=pto();const before=JSON.stringify({baseline,days});
  const first=leaveBalanceDetails('company-pto',baseline,days,'2026-10-15');
  close(first.earned,480*.019305);assert.equal(first.used,120);
  assert.deepEqual(first,leaveBalanceDetails('company-pto',baseline,days,'2026-10-15'));
  assert.equal(JSON.stringify({baseline,days}),before);
});

test('Illinois annual earning cap does not cap the bank or reopen after usage',()=>{
  const baseline=illinois({minutes:3000,evidence:{...evidence,benefitYearStart:'2026-01-01',earnedMinutes:2399}});
  const days=[day('2026-10-02',480),day('2026-10-03',480,[{kind:'illinois-sick',minutes:120}])];
  const result=leaveBalanceDetails('illinois-sick',baseline,days,'2026-10-03');
  assert.equal(result.earned,1);assert.equal(result.available,2881);assert.equal(result.used,120);
});

test('provisional Jan 1 renews only earning allowance, carries balance, and deducts usage once',()=>{
  const baseline=illinois({date:'2026-12-31',coveredThrough:'2026-12-30',statementDate:'2026-12-31',minutes:2700,evidence:{...evidence,benefitYearStart:'2026-01-01',earnedMinutes:2400}});
  const days=[day('2026-12-31',480),day('2027-01-01',480,[{kind:'illinois-sick',minutes:120}]),day('2027-01-02',480)];
  assert.equal(leaveBalance('illinois-sick',baseline,days,'2026-12-31'),2700);
  const result=leaveBalanceDetails('illinois-sick',baseline,days,'2027-01-02');
  assert.equal(result.earned,24);assert.equal(result.available,2604);
  assert.equal(leaveBalance('illinois-sick',baseline,[...days].reverse(),'2027-01-02'),2604);
});

test('unknown annual counters remain unknown; settings require bank-specific valid evidence',()=>{
  assert.throws(()=>validateLeaveConfiguration(illinois({evidence:{...evidence}})));
  assert.throws(()=>validateLeaveConfiguration(illinois({evidence:{...evidence,benefitYearStart:'2026-01-01'}})));
  assert.throws(()=>validateLeaveConfiguration(illinois({evidence:{...evidence,benefitYearStart:'2025-01-01',earnedMinutes:0}})));
  assert.throws(()=>validateLeaveConfiguration(pto({hawkeye:{hireDate:'2025-01-01',hourlyFullTime:false}})));
  assert.throws(()=>validateLeaveConfiguration(pto({kind:'illinois-sick'})));
  assert.equal(validateLeaveConfiguration(illinois()).provisionalYearStart,true);
  assert.equal(leaveBalance('illinois-sick',illinois({evidence:{...evidence}}),[],'2026-10-03'),null);
});

test('fresh dated baseline excludes earlier activity without adding earned/carryover evidence twice',()=>{
  const old=illinois();
  const days=[day('2026-10-02',480),day('2026-10-03',480)];
  const oldValue=leaveBalance('illinois-sick',old,days,'2026-10-02');
  const next=illinois({date:'2026-10-03',coveredThrough:'2026-10-02',statementDate:'2026-10-03',minutes:oldValue,evidence:{...evidence,benefitYearStart:'2026-02-01',earnedMinutes:1212,carriedInMinutes:300,usedMinutes:120}});
  assert.equal(leaveBalance('illinois-sick',next,days,'2026-10-03'),oldValue+12);
  assert.equal(leaveBalance('illinois-sick',old,days,'2026-10-02'),oldValue);
  assert.throws(()=>leaveBalance('illinois-sick',next,[...days,days[0]],'2026-10-03'));
});
