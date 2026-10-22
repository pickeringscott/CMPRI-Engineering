import { poolCurrentClosureReasons, sampleComplete } from './pool-log';

type PoolHold = { closed: boolean; reason: string; revision: number; reopen_pending?: boolean };
export type PoolStatusInput = { pool: PoolHold; poolLog: Record<string, unknown> | null };

/** Server time only in production callers. Clock injection is for isolated tests. */
export function poolHours(now: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  const hour = Number(parts.hour);
  const closed = hour >= 22 || hour < 7;
  const start = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1,
    Number(parts.day) - (hour < 7 ? 1 : 0))).toISOString().slice(0, 10);
  return { closed, key: closed ? `pool-hours:${start}` : null };
}

/** Projection of persisted holds and existing testing assessment; never changes a log. */
export function effectivePoolStatus(state: PoolStatusInput, now: Date) {
  const hours = poolHours(now);
  const log = state.poolLog;
  const testingMissing = !log || (!log.latest_test && !sampleComplete(log, 'am') && !sampleComplete(log, 'pm'));
  const failures = log ? poolCurrentClosureReasons(log) : [];
  const logHold = !!log && (log.closure_condition === true || log.manual_closure === true || log.manual_closure === null);
  const closed = hours.closed || testingMissing || failures.length > 0 || logHold || state.pool.closed || !!state.pool.reopen_pending;
  const manualReasons: string[] = [];
  if (state.pool.closed && state.pool.reason) manualReasons.push(state.pool.reason);
  if (log && (log.manual_closure === true || log.manual_closure === null || (log.closure_condition === true && !failures.length))
      && typeof log.closure_reason === 'string' && log.closure_reason) manualReasons.push(log.closure_reason);
  const detail = [...new Set([...failures, ...manualReasons])].join('\n');
  const reason = detail || (hours.closed ? 'Closed 10 PM–7 AM'
    : testingMissing || failures.length || logHold ? 'Closed pending pool testing.'
    : state.pool.reopen_pending ? 'Closed pending Engineering reopening.' : '');
  return { closed, reason, revision: state.pool.revision, manual_closed: state.pool.closed,
    hours_closed: hours.closed, hours_key: hours.key };
}
