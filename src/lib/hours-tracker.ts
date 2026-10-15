/** Pure calculations only. No persistence, attendance creation, or employer policy defaults. */
export type LeaveKind = 'company-pto' | 'illinois-sick';
export type Attendance =
  | { state: 'blank' }
  | { state: 'off' }
  | { state: 'work'; start: number; end: number; nextDay: boolean; clockSpan?: { startAt: string; endAt: string } };
export type HoursDay = { date: string; attendance: Attendance; leave: { kind: LeaveKind; minutes: number }[] };
export const NEW_WORK = { state: 'work', start: 540, end: 1050, nextDay: false } as const;
export const PAYROLL_ANCHOR = '2026-09-18';
const DAY = 86_400_000;
function dateValue(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use an ISO calendar date.');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('Invalid date.');
  return time;
}
function dateAt(time: number): string { return new Date(time).toISOString().slice(0, 10); }
function integer(value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid minute value.');
}
export function periodDates(start: string) {
  const time = dateValue(start);
  if (new Date(time).getUTCDay() !== 5) throw new Error('Period must start Friday.');
  if ((time - dateValue(PAYROLL_ANCHOR)) % (14 * DAY) !== 0) throw new Error('Period must match the verified payroll cycle.');
  return { dates: Array.from({ length: 14 }, (_, i) => dateAt(time + i * DAY)), end: dateAt(time + 13 * DAY), payday: dateAt(time + 20 * DAY) };
}
export function emptyPeriod(start: string): HoursDay[] {
  return periodDates(start).dates.map(date => ({ date, attendance: { state: 'blank' }, leave: [] }));
}
export function workedMinutes(attendance: Attendance): number {
  if (attendance.state === 'blank' || attendance.state === 'off') return 0;
  if (attendance.state !== 'work' || typeof attendance.nextDay !== 'boolean') throw new Error('Invalid attendance.');
  integer(attendance.start, 0, 1439); integer(attendance.end, 0, 1439);
  let duration = attendance.end - attendance.start + (attendance.nextDay ? 1440 : 0);
  if (attendance.clockSpan) {
    const span = attendance.clockSpan;
    const start = Date.parse(span.startAt), end = Date.parse(span.endAt);
    if (![span.startAt, span.endAt].every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value)) || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Invalid confirmed clock timestamps.');
    const a = clockLocalParts(new Date(start)), b = clockLocalParts(new Date(end));
    const days = (dateValue(b.date) - dateValue(a.date)) / DAY;
    if (a.minute !== attendance.start || b.minute !== attendance.end || days !== (attendance.nextDay ? 1 : 0)) throw new Error('Clock timestamps do not match the displayed times.');
    duration = (end - start) / 60000;
  }
  if (duration <= 0 || duration > 1440) throw new Error('Choose valid times and explicitly confirm overnight work.');
  return duration - (duration >= 300 ? 30 : 0);
}
export function clockLocalParts(at: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (name: string) => parts.find(part => part.type === name)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}
export function dayTotals(day: HoursDay) {
  dateValue(day.date);
  const worked = workedMinutes(day.attendance);
  if (day.attendance.state === 'work' && day.attendance.clockSpan && clockLocalParts(new Date(day.attendance.clockSpan.startAt)).date !== day.date) throw new Error('Clock timestamps do not match the work date.');
  let leave = 0;
  for (const entry of day.leave) {
    if (!['company-pto', 'illinois-sick'].includes(entry.kind)) throw new Error('Invalid leave type.');
    integer(entry.minutes, 1, 1440); leave += entry.minutes;
  }
  if (worked + leave > 1440) throw new Error('Paid time exceeds one day.');
  return { worked, leave, paid: worked + leave };
}
export function summarizePeriod(start: string, days: HoursDay[], rateCents: number, deductionPercent: number) {
  integer(rateCents, 0, 1_000_000);
  if (!Number.isFinite(deductionPercent) || deductionPercent < 0 || deductionPercent > 100) throw new Error('Invalid deduction.');
  const period = periodDates(start);
  if (days.length !== 14 || days.some((day, i) => day.date !== period.dates[i])) throw new Error('Days must match the original period dates.');
  const weeks = [days.slice(0, 7), days.slice(7)].map(week => {
    const totals = week.map(dayTotals).reduce((sum, day) => ({ worked: sum.worked + day.worked, leave: sum.leave + day.leave, paid: sum.paid + day.paid }), { worked: 0, leave: 0, paid: 0 });
    const overtime = Math.max(0, totals.worked - 2400);
    return { ...totals, overtime, regular: totals.worked - overtime, remaining: Math.max(0, 2400 - totals.worked), percent: totals.worked / 24, barPercent: Math.min(100, totals.worked / 24), goalMet: totals.worked >= 2400 };
  });
  const grossCents = Math.round(weeks.reduce((sum, week) => sum + (week.regular + week.leave + week.overtime * 1.5) * rateCents / 60, 0));
  const deductionCents = Math.round(grossCents * deductionPercent / 100);
  return { ...period, weeks, worked: weeks.reduce((sum, week) => sum + week.worked, 0), leave: weeks.reduce((sum, week) => sum + week.leave, 0), paid: weeks.reduce((sum, week) => sum + week.paid, 0), grossCents, deductionCents, takeHomeCents: grossCents - deductionCents };
}
export type LeaveBaseline = { date: string; minutes: number; earnedMinutesPerWorkedHour: number | null };
export type DatedLeaveConfiguration = LeaveBaseline & {
  kind: LeaveKind; policy: 'unconfigured' | 'manual'; note: string;
  statementDate: string; coveredThrough: string;
  evidence: { earnedMinutes: number | null; carriedInMinutes: number | null; usedMinutes: number | null; benefitYearStart: string | null };
};
export function validateLeaveConfiguration(value: DatedLeaveConfiguration): DatedLeaveConfiguration {
  dateValue(value.date);
  dateValue(value.statementDate);
  const covered = dateValue(value.coveredThrough);
  if (value.date !== dateAt(covered + DAY) || value.statementDate < value.coveredThrough) throw new Error('Replay must begin the day after covered work, separately from statement date.');
  if (!value.evidence || typeof value.evidence !== 'object') throw new Error('Explicit evidence fields are required.');
  for (const amount of [value.evidence.earnedMinutes, value.evidence.carriedInMinutes, value.evidence.usedMinutes]) {
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('Invalid statement amount.');
  }
  if (value.evidence.benefitYearStart !== null) dateValue(value.evidence.benefitYearStart);
  if (!['company-pto', 'illinois-sick'].includes(value.kind) || !['unconfigured', 'manual'].includes(value.policy)
    || !Number.isFinite(value.minutes) || typeof value.note !== 'string' || value.note.length > 1000
    || (value.earnedMinutesPerWorkedHour !== null && (!Number.isFinite(value.earnedMinutesPerWorkedHour) || value.earnedMinutesPerWorkedHour < 0))
    || (value.policy === 'unconfigured' && value.earnedMinutesPerWorkedHour !== null)) throw new Error('Invalid dated leave configuration.');
  return structuredClone(value);
}
/** Returns the latest explicit baseline, never a guessed policy or sample balance. */
export function leaveConfigurationAt(configurations: DatedLeaveConfiguration[], kind: LeaveKind, through: string): DatedLeaveConfiguration | null {
  dateValue(through);
  return configurations.filter(item => item.kind === kind && item.date <= through).sort((a,b) => b.date.localeCompare(a.date))[0] ?? null;
}
/** Baseline is the balance at the start of its date. Recompute from unique saved days; never add credits on save. */
export function leaveBalance(kind: LeaveKind, baseline: LeaveBaseline | null, savedDays: HoursDay[], through: string): number | null {
  if (!baseline || baseline.earnedMinutesPerWorkedHour === null) return null;
  const start = dateValue(baseline.date), end = dateValue(through);
  if (end < start) throw new Error('Balance date precedes baseline.');
  if (!Number.isFinite(baseline.minutes) || !Number.isFinite(baseline.earnedMinutesPerWorkedHour) || baseline.earnedMinutesPerWorkedHour < 0) throw new Error('Invalid leave configuration.');
  const seen = new Set<string>();
  let balance = baseline.minutes;
  for (const day of savedDays) {
    if (seen.has(day.date)) throw new Error('Duplicate saved date.');
    seen.add(day.date);
    const time = dateValue(day.date);
    if (time < start || time > end) continue;
    const totals = dayTotals(day);
    balance += totals.worked / 60 * baseline.earnedMinutesPerWorkedHour;
    balance -= day.leave.filter(entry => entry.kind === kind).reduce((sum, entry) => sum + entry.minutes, 0);
  }
  return balance;
}
