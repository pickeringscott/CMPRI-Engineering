import assert from 'node:assert/strict';
import { poolHours, effectivePoolStatus } from '../src/lib/pool-status.ts';

for (const [utc, closed] of [
  ['2026-10-22T02:59:00Z', false], ['2026-10-22T03:00:00Z', true],
  ['2026-10-22T11:59:00Z', true], ['2026-10-22T12:00:00Z', false],
  ['2026-11-01T06:30:00Z', true], ['2026-11-01T07:30:00Z', true],
  ['2026-11-01T12:59:00Z', true], ['2026-11-01T13:00:00Z', false],
  ['2026-03-08T07:59:00Z', true], ['2026-03-08T08:00:00Z', true],
]) assert.equal(poolHours(new Date(utc)).closed, closed, utc);
const state = { pool: {closed:false,reason:'',revision:1}, poolLog: {
  ph_am:7.4, sanitizer_am:4, closure_condition:false, manual_closure:false,
}};
const night = new Date('2026-10-22T03:00:00Z');
const day = new Date('2026-10-22T12:00:00Z');
assert.equal(effectivePoolStatus(state, night).reason, 'Closed 10 PM–7 AM');
assert.equal(effectivePoolStatus(state, night).closed, true);
assert.equal(effectivePoolStatus(state, day).closed, false);
assert.equal(effectivePoolStatus({...state,poolLog:null}, day).reason, 'Closed pending pool testing.');
assert.equal(effectivePoolStatus({...state,pool:{...state.pool,closed:true,reason:'Maintenance'}}, night).reason, 'Maintenance');
const chemical = effectivePoolStatus({...state,poolLog:{...state.poolLog,ph_am:8.0}}, night);
assert.equal(chemical.closed, true);
assert.match(chemical.reason, /pH/i);
assert.doesNotMatch(chemical.reason, /10 PM/);
assert.equal(effectivePoolStatus({...state,pool:{...state.pool,reopen_pending:true}}, day).closed,true);
assert.equal(poolHours(new Date('2026-10-22T03:00:00Z')).key,poolHours(new Date('2026-10-22T11:59:00Z')).key);
console.log('PASS Pool hours boundaries, DST, chemical priority, manual hold, testing and explicit reopening hold');
