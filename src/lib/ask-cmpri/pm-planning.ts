import type { PmTemplate } from "@/lib/pm/catalog";

type Row = Record<string, unknown>;
export type AskPmOptions = {
  question?: string;
  fromDate?: string;
  toDate?: string;
  rooms?: string[];
  /** An explicit date is useful for deterministic tests; production uses Chicago. */
  today?: string;
};
export type AskPmWindow = {
  today: string;
  fromDate: string;
  toDate: string;
  readFrom: string;
  paceFrom: string;
  calendarDays: number;
  weekdays: number;
};
export type AskPmCount = { scheduled: number; complete: number; remaining: number; awaitingReview: number };
export type AskPmRoomPeriod = AskPmCount & { period: string; remainingRooms: string[]; completedRooms: string[] };
export type AskPmPlanning = {
  window: AskPmWindow;
  rooms: string[];
  roomPm: AskPmCount;
  roomPeriods: AskPmRoomPeriod[];
  priorRoomPm: AskPmCount;
  priorRoomPeriods: AskPmRoomPeriod[];
  routineItems: AskPmCount & { byCadence: Record<"daily" | "weekly" | "monthly", AskPmCount> };
  inspections: {
    scheduledTemplatePeriods: number;
    periodsWithCompletedForm: number;
    periodsWithoutCompletedForm: number;
    savedCompletedForms: number;
    savedDraftForms: number;
    awaitingReview: number;
    equipmentOrAreaSchedules: number;
  };
  sourceRecords: { proposals: number; roomHistory: number };
};

const dayMilliseconds = 86_400_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function validAskPmDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const dayNumber = (value: string) => new Date(value + "T12:00:00Z").getTime() / dayMilliseconds;
const dateFromDay = (value: number) => new Date(value * dayMilliseconds).toISOString().slice(0, 10);
const addDays = (value: string, days: number) => dateFromDay(dayNumber(value) + days);
const dayOfWeek = (value: string) => new Date(value + "T12:00:00Z").getUTCDay();
const monday = (value: string) => addDays(value, -((dayOfWeek(value) + 6) % 7));
function quarter(value: string) {
  const month = Math.floor((Number(value.slice(5, 7)) - 1) / 3) * 3 + 1;
  return value.slice(0, 4) + "-" + String(month).padStart(2, "0") + "-01";
}
function nextMonth(value: string) {
  const date = new Date(value + "T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date.toISOString().slice(0, 10);
}
function emptyCount(): AskPmCount { return { scheduled: 0, complete: 0, remaining: 0, awaitingReview: 0 }; }
function addCount(target: AskPmCount, count: AskPmCount) {
  target.scheduled += count.scheduled;
  target.complete += count.complete;
  target.remaining += count.remaining;
  target.awaitingReview += count.awaitingReview;
}
function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
const pending = (row: Row | undefined) => row?.status === "pending" || row?.status === "processing";
const roomComplete = (row: Row | undefined) => row?.is_complete === true || validAskPmDate(row?.completed_on);

export function askPmWindow(options: AskPmOptions = {}, now = new Date()): AskPmWindow {
  const today = options.today || new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const fromDate = options.fromDate || today;
  const toDate = options.toDate || fromDate.slice(0, 4) + "-12-31";
  if (![today, fromDate, toDate].every(validAskPmDate) || toDate < fromDate) {
    throw new Error("Use a valid PM date range in YYYY-MM-DD format, with the end on or after the start.");
  }
  const paceFrom = today > fromDate ? today : fromDate;
  const calendarDays = Math.max(0, dayNumber(toDate) - dayNumber(paceFrom) + 1);
  let weekdays = Math.floor(calendarDays / 7) * 5;
  for (let index = 0; index < calendarDays % 7; index++) {
    const day = dayOfWeek(addDays(paceFrom, Math.floor(calendarDays / 7) * 7 + index));
    if (day !== 0 && day !== 6) weekdays++;
  }
  return { today, fromDate, toDate, readFrom: monday(fromDate.slice(0, 4) + "-01-01"), paceFrom, calendarDays, weekdays };
}

/** Periods are schedule occurrences, never individual lines on an inspection form. */
function periods(template: PmTemplate, fromDate: string, toDate: string): string[] {
  if (fromDate > toDate) return [];
  const result: string[] = [];
  if (template.cadence === "daily" || template.cadence === "weekly") {
    const step = template.cadence === "daily" ? 1 : 7;
    for (let date = step === 1 ? fromDate : monday(fromDate); date <= toDate; date = addDays(date, step)) result.push(date);
  } else {
    for (let date = template.kind === "room" ? quarter(fromDate) : fromDate.slice(0, 7) + "-01"; date <= toDate; date = nextMonth(date)) {
      if (!template.months || template.months.includes(Number(date.slice(5, 7)))) result.push(date);
    }
  }
  return result;
}

/** Use the same owned-pending / pending / latest priority as the native PM modal. */
export function latestAskPmEntries(proposals: Row[], userId: string): Row[] {
  const latest = new Map<string, { priority: number; entry: Row }>();
  for (const row of proposals) {
    if (row.status === "rejected") continue;
    const key = `${row.template_id}|${row.period_start}|${row.scope_key}`;
    const priority = row.status === "pending" && row.submitted_by === userId ? 3 : pending(row) ? 2 : 1;
    const previous = latest.get(key);
    if (!previous || priority > previous.priority || priority === previous.priority && String(row.updated_at || "") >= String(previous.entry.updated_at || "")) {
      latest.set(key, { priority, entry: { ...object(row.payload), ...row, payload: undefined } });
    }
  }
  return [...latest.values()].map(({ entry }) => entry);
}

export function buildAskPmPlanning(input: {
  window: AskPmWindow;
  rooms: string[];
  templates: PmTemplate[];
  entries: Row[];
  roomHistory: Row[];
  proposalCount: number;
}): AskPmPlanning {
  const { window, rooms, templates, entries, roomHistory } = input;
  const byKey = new Map(entries.map(entry => [`${entry.template_id}|${entry.period_start}|${entry.scope_key}`, entry]));
  const history = new Map(roomHistory.map(entry => [`${entry.period_start}|${entry.room}`, entry]));
  const roomTemplate = templates.find(template => template.kind === "room");
  const summarizeRooms = (from: string, to: string): AskPmRoomPeriod[] => roomTemplate ? periods(roomTemplate, from, to).map(period => {
    const result: AskPmRoomPeriod = { ...emptyCount(), period, remainingRooms: [], completedRooms: [] };
    for (const room of rooms) {
      const current = byKey.get(`${roomTemplate.id}|${period}|room:${room}`);
      const record = current || history.get(`${period}|${room}`);
      const complete = roomComplete(record);
      result.scheduled++;
      if (complete) {
        result.complete++;
        result.completedRooms.push(room);
        if (pending(current)) result.awaitingReview++;
      } else { result.remaining++; result.remainingRooms.push(room); }
    }
    return result;
  }) : [];
  const roomPeriods = summarizeRooms(window.fromDate, window.toDate);
  const priorRoomPeriods = summarizeRooms(window.fromDate.slice(0, 4) + "-01-01", addDays(quarter(window.fromDate), -1));
  const roomPm = emptyCount(), priorRoomPm = emptyCount();
  roomPeriods.forEach(count => addCount(roomPm, count));
  priorRoomPeriods.forEach(count => addCount(priorRoomPm, count));
  const byCadence = { daily: emptyCount(), weekly: emptyCount(), monthly: emptyCount() };
  const routineItems = { ...emptyCount(), byCadence };
  const inspections: AskPmPlanning["inspections"] = { scheduledTemplatePeriods: 0, periodsWithCompletedForm: 0, periodsWithoutCompletedForm: 0, savedCompletedForms: 0, savedDraftForms: 0, awaitingReview: 0, equipmentOrAreaSchedules: 0 };
  for (const template of templates) {
    if (template.kind === "room") continue;
    for (const period of periods(template, window.fromDate, window.toDate)) {
      if (template.kind === "routine") {
        const count = byCadence[template.cadence as keyof typeof byCadence];
        if (!count) continue;
        const entry = byKey.get(`${template.id}|${period}|property`);
        const responses = object(entry?.responses), states = object(entry?.task_states);
        for (const item of template.checklist) {
          const state = object(states[item.id]);
          const complete = Object.hasOwn(states, item.id) ? state.workerChecked === true || state.status === "approved" : responses[item.id] === true;
          count.scheduled++;
          if (complete) {
            count.complete++;
            if (Object.hasOwn(states, item.id) ? state.status !== "approved" : pending(entry)) count.awaitingReview++;
          } else count.remaining++;
        }
      } else {
        const saved = entries.filter(entry => entry.template_id === template.id && entry.period_start === period);
        const completed = saved.filter(entry => entry.is_complete === true);
        inspections.scheduledTemplatePeriods++;
        if (completed.length) inspections.periodsWithCompletedForm++;
        else inspections.periodsWithoutCompletedForm++;
        inspections.savedCompletedForms += completed.length;
        inspections.savedDraftForms += saved.length - completed.length;
        inspections.awaitingReview += completed.filter(pending).length;
        if (template.scope === "equipment" || template.scope === "area") inspections.equipmentOrAreaSchedules++;
      }
    }
  }
  Object.values(byCadence).forEach(count => addCount(routineItems, count));
  return { window, rooms, roomPm, roomPeriods, priorRoomPm, priorRoomPeriods, routineItems, inspections,
    sourceRecords: { proposals: input.proposalCount, roomHistory: roomHistory.length } };
}

export function askPmPace(remaining: number, window: AskPmWindow) {
  return {
    calendarAverage: window.calendarDays ? remaining / window.calendarDays : null,
    calendarTarget: window.calendarDays ? Math.ceil(remaining / window.calendarDays) : null,
    weekdayAverage: window.weekdays ? remaining / window.weekdays : null,
    weekdayTarget: window.weekdays ? Math.ceil(remaining / window.weekdays) : null,
  };
}

/** Exact counts remain useful even when the language model is unavailable. */
export function askPmPlanningSummary(planning: AskPmPlanning): string {
  const { window, roomPm, priorRoomPm, routineItems, inspections } = planning;
  const pace = askPmPace(roomPm.remaining, window);
  const lines = [
    `As of ${window.today}, ${roomPm.remaining} guest-room PMs remain for the room quarters overlapping ${window.fromDate} through ${window.toDate}: ${roomPm.complete} of ${roomPm.scheduled} room-quarter PMs have recorded completion${roomPm.awaitingReview ? ` (${roomPm.awaitingReview} awaiting review)` : ""}.`,
    window.calendarDays
      ? `From ${window.paceFrom} through ${window.toDate}, including both dates, there are ${window.calendarDays} calendar days and ${window.weekdays} Monday–Friday weekdays. That is ${pace.calendarAverage!.toFixed(2)} room PMs per calendar day; a whole-number daily target is ${pace.calendarTarget}${window.weekdays ? `, or ${pace.weekdayTarget} per weekday (${pace.weekdayAverage!.toFixed(2)} average)` : ""}. Holidays are included.`
      : `The selected deadline has passed; there are no remaining days for a daily pace.`,
  ];
  if (priorRoomPm.scheduled) {
    const total = priorRoomPm.remaining + roomPm.remaining;
    const combined = askPmPace(total, window);
    lines.push(`Earlier quarters in ${window.fromDate.slice(0, 4)} have ${priorRoomPm.remaining} additional room-quarter PMs without recorded completion. Including that backlog gives ${total} remaining${window.calendarDays ? `: ${combined.calendarTarget} per calendar day${window.weekdays ? ` or ${combined.weekdayTarget} per Monday–Friday weekday` : ""}` : ""}.`);
  }
  lines.push(`Separately, ${routineItems.remaining} of ${routineItems.scheduled} scheduled routine checklist items remain in this window. These are checklist items, not room PMs. ${inspections.periodsWithoutCompletedForm} of ${inspections.scheduledTemplatePeriods} other scheduled inspection-template periods have no completed form; equipment/area unit counts are not inferred from template counts.`);
  return lines.join("\n\n");
}
