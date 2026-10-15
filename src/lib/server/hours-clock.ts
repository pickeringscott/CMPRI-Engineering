import type { SupabaseClient } from '@supabase/supabase-js';
import type { Principal } from './access';
import { emptyPeriod, PAYROLL_ANCHOR, dayTotals, clockLocalParts } from '../hours-tracker';
import { HoursStoreError, hoursOwner, readHours, type HoursDocument } from './hours-tracker-store';
export type ClockOpen = { id: string; at: string; date: string; minute: number; periodStart: string };
export type ClockResult = { action: 'clock_in' | 'clock_out'; shiftId: string; at: string; workDate: string; workedMinutes: number | null; overnight: boolean; timeZone: 'America/Chicago'; reconciliation?: { resolution: 'finish' | 'discard'; reason: string; originalStartAt: string; endAt?: string; elapsedMinutes?: number } };
export type HoursClock = { open: ClockOpen | null; receipts: { requestId: string; fingerprint: string; result: ClockResult }[] };
const DAY = 86400000;
export function clockInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HoursStoreError('Invalid clock request.', 400);
  const body = input as Record<string, unknown>;
  if (!['clock_in', 'clock_out'].includes(String(body.action)) || typeof body.request_id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.request_id)) throw new HoursStoreError('Use a unique request_id of 16-100 letters, digits, underscores or hyphens; reuse it for retries.', 400);
  const allowed = body.action === 'clock_in' ? ['action', 'request_id'] : ['action', 'request_id', 'shift_id', 'confirm_overnight', 'reconciliation'];
  if (Object.keys(body).some(key => !allowed.includes(key)) || (body.action === 'clock_out' && (typeof body.shift_id !== 'string' || (body.confirm_overnight !== undefined && typeof body.confirm_overnight !== 'boolean')))) throw new HoursStoreError('Only clock fields are allowed; no owner, times, rates or dates may be supplied.', 400);
  if (body.reconciliation !== undefined) {
    const r = body.reconciliation as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r) || !['finish', 'discard'].includes(String(r.resolution)) || r.confirmed !== true || typeof r.reason !== 'string' || r.reason.trim().length < 5 || r.reason.length > 500) throw new HoursStoreError('Explicit reconciliation confirmation and a reason are required.', 400);
    const fields = r.resolution === 'finish' ? ['resolution', 'confirmed', 'reason', 'end_at', 'elapsed_minutes'] : ['resolution', 'confirmed', 'reason'];
    if (Object.keys(r).some(key => !fields.includes(key))) throw new HoursStoreError('Unexpected reconciliation field.', 400);
    if (r.resolution === 'finish' && (typeof r.end_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/.test(r.end_at) || !Number.isInteger(r.elapsed_minutes))) throw new HoursStoreError('Confirm an exact end timestamp with UTC offset and elapsed_minutes before reconciling.', 400);
  }
  return body;
}
/** Pure transition; clock-in never creates completed attendance or counts default hours. */
export function transitionClock(source: HoursDocument, input: unknown, now: Date) {
  const body = clockInput(input), document = structuredClone(source);
  const clock: HoursClock = document.clock ?? { open: null, receipts: [] };
  const fingerprint = JSON.stringify([body.action, body.shift_id ?? null, body.confirm_overnight === true, body.reconciliation ? Object.entries(body.reconciliation as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)) : null]);
  const receipt = clock.receipts.find(item => item.requestId === body.request_id);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) throw new HoursStoreError('This request_id was already used for a different clock request.', 409);
    return { document, result: receipt.result, duplicate: true };
  }
  if (clock.receipts.length >= 10000) throw new HoursStoreError('Clock history needs maintenance; no receipt was discarded.', 409);
  const time = Math.floor(now.getTime() / 60000) * 60000;
  if (!Number.isFinite(time)) throw new HoursStoreError('Clock time is unavailable.', 503);
  const at = new Date(time).toISOString(), local = clockLocalParts(new Date(time));
  let result: ClockResult;
  if (body.action === 'clock_in') {
    if (clock.open) throw new HoursStoreError('A shift is already open. Reuse its original request_id to recover the clock-in receipt.', 409);
    const anchor = Date.parse(PAYROLL_ANCHOR + 'T00:00:00Z');
    const periodStart = new Date(anchor + Math.floor((Date.parse(local.date + 'T00:00:00Z') - anchor) / (14 * DAY)) * 14 * DAY).toISOString().slice(0,10);
    const existing = document.periods.find(period => period.start === periodStart)?.days.find(day => day.date === local.date);
    if (existing && existing.attendance.state !== 'blank') throw new HoursStoreError('This day already has manual or imported attendance. It will not be overwritten.', 409);
    clock.open = { id: body.request_id as string, at, date: local.date, minute: local.minute, periodStart };
    result = { action: 'clock_in', shiftId: clock.open.id, at, workDate: local.date, workedMinutes: null, overnight: false, timeZone: 'America/Chicago' };
  } else {
    const open = clock.open;
    if (!open || open.id !== body.shift_id) throw new HoursStoreError('The requested open shift was not found.', 409);
    const reconciliation = body.reconciliation as { resolution: 'finish' | 'discard'; reason: string; end_at?: string; elapsed_minutes?: number } | undefined;
    if (reconciliation?.resolution === 'discard') {
      result = { action: 'clock_out', shiftId: open.id, at, workDate: open.date, workedMinutes: null, overnight: false, timeZone: 'America/Chicago', reconciliation: { resolution: 'discard', reason: reconciliation.reason, originalStartAt: open.at } };
      clock.open = null;
      clock.receipts.push({ requestId: body.request_id as string, fingerprint, result });
      document.clock = clock;
      return { document, result, duplicate: false };
    }
    const finishTime = reconciliation ? Date.parse(reconciliation.end_at!) : time;
    if (!Number.isFinite(finishTime) || finishTime > time) throw new HoursStoreError('Confirmed end time must be valid and not in the future.', 400);
    if (reconciliation?.end_at?.endsWith('Z') && new Date(finishTime).toISOString() !== reconciliation.end_at.replace('Z', '.000Z')) throw new HoursStoreError('Invalid confirmed calendar timestamp.', 400);
    const finish = clockLocalParts(new Date(finishTime));
    if (reconciliation && !reconciliation.end_at!.endsWith('Z')) {
      const statedDate = reconciliation.end_at!.slice(0,10), statedMinute = Number(reconciliation.end_at!.slice(11,13))*60+Number(reconciliation.end_at!.slice(14,16));
      if (finish.date !== statedDate || finish.minute !== statedMinute) throw new HoursStoreError('The supplied offset does not match Chicago at that local time.', 400);
    }
    const dayOffset = (Date.parse(finish.date + 'T00:00:00Z') - Date.parse(open.date + 'T00:00:00Z')) / DAY;
    const elapsed = (finishTime - Date.parse(open.at)) / 60000;
    const wall = dayOffset * 1440 + finish.minute - open.minute;
    if (elapsed <= 0 || elapsed > 1440 || dayOffset < 0 || dayOffset > 1) throw new HoursStoreError('Shift must be 1 minute to 24 hours; no attendance was saved.', 409);
    if (reconciliation && reconciliation.elapsed_minutes !== elapsed) throw new HoursStoreError('Confirmed elapsed_minutes does not match the recorded start and exact end. No hours saved.', 400);
    if (wall !== elapsed && !reconciliation) throw new HoursStoreError('This shift crosses a daylight-saving change and needs explicit manual reconciliation. The open shift is preserved.', 409);
    if (dayOffset === 1 && body.confirm_overnight !== true) throw new HoursStoreError('Confirm overnight clock-out explicitly; hours will belong to the shift start date.', 409);
    let period = document.periods.find(item => item.start === open.periodStart);
    if (!period) { period = { start: open.periodStart, days: emptyPeriod(open.periodStart), rateCents: 0, deductionPercent: 0 }; document.periods.push(period); }
    const day = period.days.find(item => item.date === open.date)!;
    if (day.attendance.state !== 'blank') throw new HoursStoreError('Attendance changed during this shift; manual/imported data was preserved.', 409);
    day.attendance = { state: 'work', start: open.minute, end: finish.minute, nextDay: dayOffset === 1, ...(reconciliation ? { clockSpan: { startAt: open.at, endAt: new Date(finishTime).toISOString() } } : {}) };
    const totals = dayTotals(day);
    result = { action: 'clock_out', shiftId: open.id, at, workDate: open.date, workedMinutes: totals.worked, overnight: dayOffset === 1, timeZone: 'America/Chicago', ...(reconciliation ? { reconciliation: { resolution: 'finish' as const, reason: reconciliation.reason, originalStartAt: open.at, endAt: new Date(finishTime).toISOString(), elapsedMinutes: elapsed } } : {}) };
    clock.open = null;
  }
  clock.receipts.push({ requestId: body.request_id as string, fingerprint, result });
  document.clock = clock;
  document.periods.sort((a,b) => a.start.localeCompare(b.start));
  return { document, result, duplicate: false };
}
/** Caller has separately checked the clock-only activation gate; generic MCP hours access remains blocked. */
export async function clockHours(client: SupabaseClient, principal: Principal, input: unknown, now = new Date()) {
  const owner = hoursOwner(principal);
  clockInput(input);
  const current = await readHours(client, principal);
  const next = transitionClock(current?.document ?? { version: 1, anchor: PAYROLL_ANCHOR, periods: [], leaveConfigurations: [] }, input, now);
  if (next.duplicate) return { ...next.result, duplicate: true, revision: current!.revision };
  const revision = (current?.revision ?? 0) + 1;
  const query = current ? client.from('cmpri_personal_hours').update({ document: next.document, revision }).eq('owner_id', owner).eq('revision', current.revision) : client.from('cmpri_personal_hours').insert({ owner_id: owner, document: next.document, revision });
  const { data, error } = await query.select('revision').maybeSingle();
  if (error?.code === '23505' || (!error && !data)) throw new HoursStoreError('Hours changed concurrently. Retry the identical clock request and request_id.', 409);
  if (error) throw new HoursStoreError('Clock save was not confirmed. Retry the identical request_id.', 503);
  return { ...next.result, duplicate: false, revision };
}
