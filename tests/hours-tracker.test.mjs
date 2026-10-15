import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_WORK, emptyPeriod, periodDates, workedMinutes, dayTotals, summarizePeriod, leaveBalance, validateLeaveConfiguration } from '../src/lib/hours-tracker.ts';
test('statement date does not omit intervening work or replay covered history', () => {
  const config=validateLeaveConfiguration({kind:'illinois-sick',date:'2026-10-02',coveredThrough:'2026-10-01',statementDate:'2026-10-08',minutes:17.61*60,earnedMinutesPerWorkedHour:null,policy:'unconfigured',note:'Historical fixture only',evidence:{earnedMinutes:40*60,carriedInMinutes:4.61*60,usedMinutes:27*60,benefitYearStart:null}});
  const days=[...emptyPeriod('2026-09-18'),...emptyPeriod('2026-10-02')];
  days[13].attendance={...NEW_WORK}; days[14].attendance={...NEW_WORK};
  assert.equal(leaveBalance('illinois-sick',config,days,'2026-10-08'),null);
  // Synthetic rate tests date mechanics only; it is not Illinois policy.
  const synthetic={...config,earnedMinutesPerWorkedHour:1};
  assert.equal(leaveBalance('illinois-sick',synthetic,days,'2026-10-08'),17.61*60+8);
  days[13].attendance={state:'off'};
  assert.equal(leaveBalance('illinois-sick',synthetic,days,'2026-10-08'),17.61*60+8);
  assert.equal(config.evidence.earnedMinutes,2400);
  assert.throws(()=>validateLeaveConfiguration({...config,date:'2026-10-08'}));
});
test('five-hour threshold and explicit overnight', () => {
  assert.equal(workedMinutes({state:'work',start:0,end:299,nextDay:false}),299);
  assert.equal(workedMinutes({state:'work',start:0,end:300,nextDay:false}),270);
  assert.equal(workedMinutes({state:'work',start:1320,end:360,nextDay:true}),450);
  assert.throws(()=>workedMinutes({state:'work',start:1320,end:360,nextDay:false}));
});
test('blank, off and new-work defaults remain distinct', () => {
  const days=emptyPeriod('2026-10-02');
  assert.ok(days.every(day=>day.attendance.state==='blank'));
  assert.equal(workedMinutes(days[0].attendance),0);
  assert.equal(workedMinutes({state:'off'}),0);
  assert.equal(workedMinutes(NEW_WORK),480);
  assert.equal(days[0].attendance.state,'blank');
});
test('historical dates and following Thursday payday stay fixed', () => {
  assert.equal(periodDates('2025-12-12').end,'2025-12-25');
  assert.equal(periodDates('2025-12-12').payday,'2026-01-01');
  assert.equal(periodDates('2026-09-18').payday,'2026-10-08');
  assert.equal(periodDates('2026-09-04').payday,'2026-09-24');
  assert.equal(periodDates('2026-10-02').payday,'2026-10-22');
  assert.throws(()=>periodDates('2026-10-09'));
  assert.throws(()=>periodDates('2026-02-30'));
  assert.throws(()=>periodDates('2026-10-03'));
});
test('weekly overtime, mixed leave and uncapped numeric goals', () => {
  const days=emptyPeriod('2026-10-02');
  for(let i=0;i<5;i++) days[i].attendance={...NEW_WORK};
  days[5].attendance={state:'work',start:540,end:780,nextDay:false};
  days[5].leave=[{kind:'company-pto',minutes:120}];
  const result=summarizePeriod('2026-10-02',days,2000,22);
  assert.equal(result.weeks[0].worked,2640);
  assert.equal(result.weeks[0].overtime,240);
  assert.equal(result.weeks[1].overtime,0);
  assert.equal(result.weeks[0].percent,110);
  assert.equal(result.weeks[0].barPercent,100);
  assert.equal(result.weeks[0].goalMet,true);
  assert.equal(result.weeks[1].goalMet,false);
  assert.equal(result.grossCents,96000);
  assert.equal(result.takeHomeCents,74880);
  assert.deepEqual(dayTotals(days[5]),{worked:240,leave:120,paid:360});
  const original=JSON.stringify(days);
  summarizePeriod('2026-10-02',days,2229,22);
  assert.equal(JSON.stringify(days),original);
  days[0].date='2026-10-03';
  assert.throws(()=>summarizePeriod('2026-10-02',days,2000,22));
});
test('configured dated leave derives once from saved work only', () => {
  const days=emptyPeriod('2026-10-02'); days[0].attendance={...NEW_WORK};
  days[1].leave=[{kind:'company-pto',minutes:60}];
  const baseline={date:'2026-10-02',minutes:120,earnedMinutesPerWorkedHour:2};
  assert.equal(leaveBalance('company-pto',null,days,'2026-10-15'),null);
  assert.equal(leaveBalance('company-pto',{...baseline,earnedMinutesPerWorkedHour:null},days,'2026-10-15'),null);
  assert.equal(leaveBalance('company-pto',baseline,days,'2026-10-15'),76);
  assert.equal(leaveBalance('company-pto',baseline,days,'2026-10-15'),76);
  assert.equal(leaveBalance('illinois-sick',baseline,days,'2026-10-15'),136);
  assert.throws(()=>leaveBalance('company-pto',baseline,[...days,days[0]],'2026-10-15'));
  days[0].attendance={state:'off'};
  assert.equal(leaveBalance('company-pto',baseline,days,'2026-10-15'),60);
});
