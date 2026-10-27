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
  kind: LeaveKind; policy: 'unconfigured' | 'manual' | 'hawkeye-hourly' | 'illinois-accrual'; note: string;
  hawkeye?: { hireDate: string; hourlyFullTime: true };
  provisionalYearStart?: boolean;
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
  if (!['company-pto', 'illinois-sick'].includes(value.kind) || !['unconfigured', 'manual', 'hawkeye-hourly', 'illinois-accrual'].includes(value.policy)
    || !Number.isFinite(value.minutes) || typeof value.note !== 'string' || value.note.length > 1000
    || (value.earnedMinutesPerWorkedHour !== null && (!Number.isFinite(value.earnedMinutesPerWorkedHour) || value.earnedMinutesPerWorkedHour < 0))
    || (value.policy !== 'manual' && value.earnedMinutesPerWorkedHour !== null)) throw new Error('Invalid dated leave configuration.');
  if (value.policy === 'hawkeye-hourly') {
    if (value.kind !== 'company-pto' || value.hawkeye?.hourlyFullTime !== true) throw new Error('Confirm hourly full-time eligibility for Hawkeye PTO.');
    dateValue(value.hawkeye.hireDate);
    if (value.hawkeye.hireDate > value.coveredThrough) throw new Error('Hire date must be on or before the starting balance cutoff.');
  } else if (value.hawkeye !== undefined) throw new Error('Hawkeye tenure belongs only to the Hawkeye PTO policy.');
  if (value.policy === 'illinois-accrual') {
    const { benefitYearStart, earnedMinutes } = value.evidence;
    if (value.kind !== 'illinois-sick' || !benefitYearStart) throw new Error('Enter the employer-designated Illinois leave-year start date.');
    if (benefitYearStart > value.coveredThrough || value.coveredThrough >= monthAnniversary(benefitYearStart, 12)) throw new Error('The starting balance cutoff must fall within the documented Illinois leave year.');
    if (earnedMinutes === null || earnedMinutes > 2400) throw new Error('Enter documented hours earned in this Illinois leave year (0–40); do not infer them from available hours.');
  }
  if (value.provisionalYearStart !== undefined && (value.policy !== 'illinois-accrual' || typeof value.provisionalYearStart !== 'boolean')) throw new Error('Invalid provisional Illinois leave-year setting.');
  return structuredClone(value);
}
/** Returns the latest explicit baseline, never a guessed policy or sample balance. */
export function leaveConfigurationAt(configurations: DatedLeaveConfiguration[], kind: LeaveKind, through: string): DatedLeaveConfiguration | null {
  dateValue(through);
  return configurations.filter(item => item.kind === kind && item.date <= through).sort((a,b) => b.date.localeCompare(a.date))[0] ?? null;
}
/** Baseline is the balance at the start of its date. Recompute from unique saved days; never add credits on save. */
export function leaveBalance(kind: LeaveKind, baseline: LeaveCalculationBaseline | null, savedDays: HoursDay[], through: string): number | null {
  return leaveBalanceDetails(kind, baseline, savedDays, through)?.available ?? null;
}

type LeaveCalculationBaseline = LeaveBaseline & Partial<Pick<DatedLeaveConfiguration, 'policy' | 'hawkeye' | 'evidence'>>;

/** Calendar-month anniversaries, clamped to month end for hires on the 29th–31st. */
function monthAnniversary(hireDate: string, months: number): string {
  const hire = new Date(dateValue(hireDate));
  const target = new Date(Date.UTC(hire.getUTCFullYear(), hire.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(hire.getUTCDate(), last));
  return dateAt(target.getTime());
}

/** Hawkeye handbook §6.3, January 1, 2023: hours earned per worked hour, bank caps. */
export function hawkeyeHourlyTerms(hireDate: string, date: string) {
  dateValue(date);
  if (date < monthAnniversary(hireDate, 3)) return { rate: 0, cap: 40 * 60 };
  if (date < monthAnniversary(hireDate, 36)) return { rate: 0.019305, cap: 40 * 60 };
  if (date < monthAnniversary(hireDate, 72)) return { rate: 0.023077, cap: 48 * 60 };
  return { rate: 0.038461, cap: 80 * 60 };
}

/** Existing tracker weeks are Friday–Thursday. The user confirmed 40 eligible hours per week for company PTO. */
export function hoursWorkWeekStart(date: string): string {
  const anchor = dateValue(PAYROLL_ANCHOR);
  return dateAt(anchor + Math.floor((dateValue(date) - anchor) / (7 * DAY)) * 7 * DAY);
}

/** Show recorded facts even when policy is unresolved; unknown accrual is never zero. */
export function leaveBalanceDetails(kind: LeaveKind, baseline: LeaveCalculationBaseline | null, savedDays: HoursDay[], through: string) {
  if (!baseline) return null;
  const start = dateValue(baseline.date), end = dateValue(through);
  if (end < start) throw new Error('Balance date precedes baseline.');
  const hawkeye = baseline.policy === 'hawkeye-hourly';
  const illinois = baseline.policy === 'illinois-accrual';
  if (hawkeye && (kind !== 'company-pto' || baseline.hawkeye?.hourlyFullTime !== true)) throw new Error('Invalid Hawkeye PTO configuration.');
  const rate = baseline.earnedMinutesPerWorkedHour;
  if (!Number.isFinite(baseline.minutes) || (rate !== null && (!Number.isFinite(rate) || rate < 0))) throw new Error('Invalid leave configuration.');
  let issue: string | null = !hawkeye && !illinois && rate === null ? 'Accrual pending policy confirmation.' : null;
  const yearStart = baseline.evidence?.benefitYearStart;
  const yearEarned = baseline.evidence?.earnedMinutes;
  if (illinois && (kind !== 'illinois-sick' || !yearStart || yearEarned == null)) issue = 'Illinois accrual needs the employer-designated leave-year start and documented earned-to-date hours.';
  let yearIndex = 0;
  let yearAccrued = yearEarned ?? 0;
  let balance = baseline.minutes;
  let earned = 0;
  const seen = new Set<string>();
  let used = 0;
  let worked = 0;
  for (const day of [...savedDays].sort((a,b) => a.date.localeCompare(b.date))) {
    if (seen.has(day.date)) throw new Error('Duplicate saved date.');
    seen.add(day.date);
    const time = dateValue(day.date);
    if (time < start || time > end) continue;
    const dayWorked = dayTotals(day).worked;
    const dayUsed = day.leave.filter(entry => entry.kind === kind).reduce((sum, entry) => sum + entry.minutes, 0);
    worked += dayWorked;
    used += dayUsed;
    if (issue) continue;
    let credit = dayWorked / 60 * (rate ?? 0);
    if (illinois) {
      while (day.date >= monthAnniversary(yearStart!, (yearIndex + 1) * 12)) {
        yearIndex += 1;
        yearAccrued = 0; // New annual earning allowance, never a balance reset or frontloaded credit.
      }
      // PLAWA accrual: actual recorded worked hours, including overtime at straight time.
      // Annual earned allowance is separate from available/carryover balance; usage does not reopen it.
      credit = Math.min(dayWorked / 40, Math.max(0, 2400 - yearAccrued));
      yearAccrued += credit;
    }
    if (hawkeye) {
      const terms = hawkeyeHourlyTerms(baseline.hawkeye!.hireDate, day.date);
      const weekStart = hoursWorkWeekStart(day.date);
      const earlierWorked = savedDays.filter(item => item.date >= weekStart && item.date < day.date)
        .reduce((sum, item) => sum + dayTotals(item).worked, 0);
      // A midweek starting balance includes earned leave, but not the week's consumed work allowance.
      // Require the actual pre-cutoff days instead of inventing zero hours for those days.
      if (dayWorked > 0 && terms.rate > 0 && earlierWorked < 2400) {
        for (let at = dateValue(weekStart); at < start; at += DAY) {
          const earlier = savedDays.find(item => item.date === dateAt(at));
          if (!earlier || earlier.attendance.state === 'blank') {
            issue = `Enter the worked/off status for ${dateAt(at)} to apply the company PTO 40-hour weekly limit across your starting date. Earlier work is not credited again.`;
            break;
          }
        }
        if (issue) continue;
      }
      credit = Math.min(dayWorked, Math.max(0, 2400 - earlierWorked)) * terms.rate;
      const beforeUse = Math.min(credit, Math.max(0, terms.cap - balance));
      const afterUse = Math.min(credit, Math.max(0, terms.cap - balance + dayUsed));
      if (beforeUse !== afterUse) {
        // Daily leave has no timestamp: do not guess whether usage freed cap space before work.
        issue = `Work and PTO on ${day.date} cross the balance cap. Confirm their order before calculating this balance.`;
        continue;
      }
      credit = beforeUse;
      if (dayUsed > 0 && dayUsed > balance + credit) {
        issue = `PTO recorded on ${day.date} exceeds the available balance. Hawkeye PTO cannot borrow future accrual; reconcile the starting balance or recorded leave.`;
        continue;
      }
    }
    earned += credit;
    balance += credit - dayUsed;
  }
  return {
    starting: baseline.minutes,
    used,
    worked,
    earned: issue ? null : earned,
    available: issue ? null : balance,
    issue,
  };
}
