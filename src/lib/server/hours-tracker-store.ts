import type { SupabaseClient } from '@supabase/supabase-js';
import { profileCanUseHoursTracker, profileIsEstablishedHoursChief } from './roles';
import type { HoursClock } from './hours-clock';
import type { Principal } from './access';
import { PAYROLL_ANCHOR, summarizePeriod, validateLeaveConfiguration, leaveConfigurationAt, clockLocalParts, type DatedLeaveConfiguration, type HoursDay } from '../hours-tracker';

export type SavedHoursPeriod = { start: string; days: HoursDay[]; rateCents: number; deductionPercent: number };
export type HoursDocument = { version: 1; anchor: string; clock?: HoursClock; periods: SavedHoursPeriod[]; leaveConfigurations: DatedLeaveConfiguration[] };
export class HoursStoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export function hoursOwner(principal: Principal, mcp = false): string {
  if (mcp || !principal.identity.id || principal.profile.id !== principal.identity.id
    || principal.profile.active !== true || principal.membership.active !== true
    || principal.membership.user_id !== principal.identity.id
    || principal.membership.hotel_id !== principal.hotelId
    || !profileCanUseHoursTracker(principal.profile)) throw new HoursStoreError('Hours Tracker is private to an eligible signed-in account.', 403);
  if (profileIsEstablishedHoursChief(principal.profile)
    && (principal.identity.email?.trim().toLowerCase() !== 'maint.cmpri@hawkeyehotels.com'
      || principal.hotelId !== 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'
      || principal.membership.role !== 'admin')) throw new HoursStoreError('Established owner identity or membership does not match.', 403);
  return principal.identity.id;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HoursStoreError('Invalid hours data.', 400);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).some(key => !expected.includes(key))) throw new HoursStoreError('Unexpected hours field.', 400);
}
export function parseHoursPeriod(input: unknown): SavedHoursPeriod {
  const value = object(input); keys(value, ['start', 'days', 'rateCents', 'deductionPercent']);
  if (typeof value.start !== 'string' || typeof value.rateCents !== 'number' || typeof value.deductionPercent !== 'number' || !Array.isArray(value.days)) throw new HoursStoreError('Invalid period.', 400);
  for (const raw of value.days) {
    const day = object(raw); keys(day, ['date', 'attendance', 'leave']);
    if (typeof day.date !== 'string' || !Array.isArray(day.leave)) throw new HoursStoreError('Invalid day.', 400);
    const attendance = object(day.attendance);
    if (!['blank', 'off', 'work'].includes(String(attendance.state))) throw new HoursStoreError('Invalid attendance state.', 400);
    keys(attendance, attendance.state === 'work' ? ['state', 'start', 'end', 'nextDay', 'clockSpan'] : ['state']);
    if (attendance.clockSpan !== undefined) keys(object(attendance.clockSpan), ['startAt', 'endAt']);
    for (const rawLeave of day.leave) { const leave = object(rawLeave); keys(leave, ['kind', 'minutes']); }
  }
  const period = value as SavedHoursPeriod;
  try { summarizePeriod(period.start, period.days, period.rateCents, period.deductionPercent); }
  catch (error) { throw new HoursStoreError(error instanceof Error ? error.message : 'Invalid period.', 400); }
  return structuredClone(period);
}
const TABLE = 'cmpri_personal_hours';
export async function readHours(client: SupabaseClient, principal: Principal, mcp = false) {
  const owner = hoursOwner(principal, mcp);
  const { data, error } = await client.from(TABLE).select('document,revision').eq('owner_id', owner).maybeSingle();
  if (error) throw new HoursStoreError('Hours storage is unavailable. No changes were saved.', 503);
  return data as { document: HoursDocument; revision: number } | null;
}
/** One explicit save replaces only one complete period; every other period retains its original rate and dates. */
export async function saveHours(client: SupabaseClient, principal: Principal, input: unknown, mcp = false) {
  const owner = hoursOwner(principal, mcp);
  const body = object(input); keys(body, ['period', 'configuration', 'revision', 'confirmRateChange']);
  if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw new HoursStoreError('A saved revision is required.', 400);
  if (('period' in body) === ('configuration' in body)) throw new HoursStoreError('Save one period or one dated leave configuration.', 400);
  const period = 'period' in body ? parseHoursPeriod(body.period) : null;
  let configuration: DatedLeaveConfiguration | null = null;
  if ('configuration' in body) {
    const value = object(body.configuration); keys(value, ['kind', 'date', 'minutes', 'earnedMinutesPerWorkedHour', 'policy', 'note', 'statementDate', 'coveredThrough', 'evidence', 'hawkeye', 'provisionalYearStart']);
    if (value.hawkeye !== undefined) keys(object(value.hawkeye), ['hireDate', 'hourlyFullTime']);
    keys(object(value.evidence), ['earnedMinutes', 'carriedInMinutes', 'usedMinutes', 'benefitYearStart']);
    try { configuration = validateLeaveConfiguration(value as DatedLeaveConfiguration); }
    catch { throw new HoursStoreError('Invalid dated leave configuration.', 400); }
  }
  const current = await readHours(client, principal, mcp);
  if ((current?.revision ?? 0) !== body.revision) throw new HoursStoreError('Hours changed elsewhere. Reload before saving.', 409);
  if (configuration && current?.document.leaveConfigurations.some(item => item.kind === configuration.kind && item.date === configuration.date)) {
    throw new HoursStoreError('A starting balance already exists for this bank and date. It has been preserved. Use a later documented cutoff for a new balance.', 409);
  }
  if (configuration?.kind === 'illinois-sick') {
    const prior = current?.document.leaveConfigurations.filter(item => item.kind === 'illinois-sick').sort((a,b) => b.date.localeCompare(a.date))[0];
    if (prior && configuration.date <= prior.date) throw new HoursStoreError('A new Illinois configuration must follow the existing dated history.', 409);
    if (prior?.policy === 'illinois-accrual' && (configuration.policy !== prior.policy || configuration.evidence.benefitYearStart !== prior.evidence.benefitYearStart || configuration.provisionalYearStart !== prior.provisionalYearStart)
      && configuration.coveredThrough !== clockLocalParts(new Date()).date) throw new HoursStoreError('Change the Illinois leave-year setting with a current closing balance and documented earned-to-date amount. The change starts tomorrow; earlier history is preserved.', 409);
  }
  const open = current?.document.clock?.open;
  if (period && open) {
    const incoming = period.days.find(day => day.date === open.date);
    const stored = current?.document.periods.find(item => item.start === period.start)?.days.find(day => day.date === open.date);
    if (incoming && JSON.stringify(incoming.attendance) !== JSON.stringify(stored?.attendance ?? { state: 'blank' })) throw new HoursStoreError('Clock out before changing attendance on the open shift date.', 409);
  }
  const previous = period && current?.document.periods.find(item => item.start === period.start);
  if (period) for (const day of period.days) {
    if (leaveConfigurationAt(current?.document.leaveConfigurations ?? [], 'company-pto', day.date)?.policy !== 'hawkeye-hourly') continue;
    const pto = day.leave.filter(entry => entry.kind === 'company-pto');
    const oldPto = previous?.days.find(item => item.date === day.date)?.leave.filter(entry => entry.kind === 'company-pto') ?? [];
    const minutes = pto.reduce((sum, entry) => sum + entry.minutes, 0);
    // Retain historical records unchanged; apply the handbook minimum only to new/changed PTO.
    if (minutes > 0 && minutes < 120 && JSON.stringify(pto) !== JSON.stringify(oldPto)) throw new HoursStoreError('Hawkeye PTO must be entered in a minimum of 2 hours per use.', 400);
  }
  if (period && previous && previous.rateCents !== period.rateCents && body.confirmRateChange !== true) throw new HoursStoreError('Confirm the rate change for this period only.', 409);
  const document: HoursDocument = { ...(current?.document.clock ? { clock: current.document.clock } : {}), version: 1, anchor: PAYROLL_ANCHOR, periods: current?.document.periods ?? [], leaveConfigurations: current?.document.leaveConfigurations ?? [] };
  if (period) document.periods = [...document.periods.filter(item => item.start !== period.start), period].sort((a,b) => a.start.localeCompare(b.start));
  if (configuration) document.leaveConfigurations = [...document.leaveConfigurations, configuration].sort((a,b) => a.date.localeCompare(b.date));
  const revision = (body.revision as number) + 1;
  const query = current
    ? client.from(TABLE).update({ document, revision }).eq('owner_id', owner).eq('revision', body.revision)
    : client.from(TABLE).insert({ owner_id: owner, document, revision });
  const { data, error } = await query.select('revision').maybeSingle();
  if (error?.code === '23505' || (!error && !data)) throw new HoursStoreError('Hours changed elsewhere. Reload before saving.', 409);
  if (error) throw new HoursStoreError('Hours could not be saved. Your draft is unchanged.', 503);
  return { document, revision };
}
