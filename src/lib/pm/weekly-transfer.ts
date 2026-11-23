import {
  findPmTemplate, PM_DAILY_TEMPLATE_ID, PM_ROOM_NUMBERS, PM_ROOM_TEMPLATE_ID,
  PM_TEMPLATES, PM_WEEKLY_TEMPLATE_ID, quarterPeriodForDate, templatePeriodsForWeek, type PmTemplate,
} from "./catalog";
import { taskComplete, type PmTaskState } from "./task-review";

export type PmTransferEntry = {
  template_id: string; period_start: string; scope_key: string;
  responses?: Record<string, unknown>; task_states?: Record<string, PmTaskState>;
  completed_on?: string | null; notes?: string; deficiency_notes?: string; is_complete?: boolean; status?: string;
};

export type PmWeeklyTransferInput = {
  weekStart: string;
  entries: readonly PmTransferEntry[];
  spreadsheetSyncEnabled: boolean;
  workbook?: { rooms: Array<{ room: string; quarters: Record<string, { value: string } | null> }> } | null;
  /** The screen supplies its existing queued-change view; the native export omits this. */
  routineStatus?: (template: PmTemplate, period: string, itemId: string) => unknown;
  roomCompleted?: (room: string) => boolean;
};

function statusText(value: unknown) {
  if (value === true || value === "complete") return "Complete";
  if (value === "follow-up") return "Needs work";
  if (value === "na") return "N/A";
  return "Open";
}

function sourceDateIso(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== Number(match[1]) || date.getUTCDate() !== Number(match[2])) return "";
  return date.toISOString().slice(0, 10);
}

/** The native PM screen's Weekly CSV layout, shared with the saved-record export. */
export function pmWeeklyTransferRows(input: PmWeeklyTransferInput): string[][] {
  const { weekStart, entries, spreadsheetSyncEnabled, workbook } = input;
  const recordsByKey = new Map(entries.map(entry => [`${entry.template_id}|${entry.period_start}|${entry.scope_key}`, entry]));
  const entryFor = (template: PmTemplate, period: string, scope = "property") => recordsByKey.get(`${template.id}|${period}|${scope}`);
  const savedRoutineStatus = (template: PmTemplate, period: string, itemId: string) => {
    const entry = entryFor(template, period);
    const state = entry?.task_states?.[itemId];
    return state ? taskComplete(state) : entry?.responses?.[itemId] === true;
  };
  const routineStatus = input.routineStatus || savedRoutineStatus;
  const monthTemplates = PM_TEMPLATES.filter(template => template.id.startsWith("workbook:monthly:") && templatePeriodsForWeek(template, weekStart).length > 0);
  const formPeriods = PM_TEMPLATES.filter(template => template.kind !== "routine" && template.kind !== "room")
    .flatMap(template => templatePeriodsForWeek(template, weekStart).map(periodStart => ({ template, periodStart })));
  const roomTemplate = findPmTemplate(PM_ROOM_TEMPLATE_ID);
  const currentQuarterPeriod = quarterPeriodForDate(weekStart);
  const roomCompleted = input.roomCompleted || ((room: string) => {
    const entry = roomTemplate && entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
    return Boolean(entry?.is_complete || entry?.completed_on);
  });
  const rows: string[][] = [["Date / period", "Cadence", "Form / task", "Scope", "Status", "Completion date", "Notes / deficiency", "Source", "Review status"]];
  const routineTemplates = PM_TEMPLATES.filter(template => template.id === PM_DAILY_TEMPLATE_ID || template.id === PM_WEEKLY_TEMPLATE_ID || monthTemplates.some(month => month.id === template.id));
  for (const template of routineTemplates) {
    for (const period of templatePeriodsForWeek(template, weekStart)) {
      const entry = entryFor(template, period);
      for (const item of template.checklist) rows.push([
        period, template.cadence, item.label, item.category || "Property", statusText(routineStatus(template, period, item.id)),
        entry?.completed_on || "", entry?.notes || "", item.source || template.sourceReference,
        entry?.task_states?.[item.id]?.status || (entry?.status === "pending" ? "Pending review" : spreadsheetSyncEnabled ? "Current workbook" : "CMPRI only; sheet sync disabled"),
      ]);
    }
  }
  for (const { template, periodStart } of formPeriods) {
    const scoped = entries.filter(entry => entry.template_id === template.id && entry.period_start === periodStart);
    const records = scoped.length ? scoped : [undefined];
    for (const entry of records) {
      for (const item of template.checklist) rows.push([
        periodStart, template.cadence, `${template.title}: ${item.label}`, entry?.scope_key || template.scope,
        statusText(entry?.responses?.[item.id]), entry?.completed_on || "", entry?.deficiency_notes || entry?.notes || "",
        item.source || template.sourceReference, entry?.status === "pending" ? "Pending review" : entry?.status === "approved" ? "Approved in CMPRI" : "Open",
      ]);
      if (!template.checklist.length) rows.push([periodStart, template.cadence, template.title, entry?.scope_key || template.scope,
        entry?.is_complete ? "Complete" : "Open", entry?.completed_on || "", entry?.deficiency_notes || entry?.notes || "", template.sourceReference,
        entry?.status === "pending" ? "Pending review" : entry?.status === "approved" ? "Approved in CMPRI" : "Open"]);
    }
  }
  if (roomTemplate) {
    for (const room of PM_ROOM_NUMBERS) {
      const entry = entryFor(roomTemplate, currentQuarterPeriod, `room:${room}`);
      const quarter = `Q${Math.floor((Number(currentQuarterPeriod.slice(5, 7)) - 1) / 3) + 1}`;
      const sourceDate = workbook?.rooms.find(item => item.room === room)?.quarters[quarter]?.value || "";
      rows.push([currentQuarterPeriod, "quarterly", roomTemplate.title, `Room ${room}`, roomCompleted(room) ? "Complete" : "Open",
        entry?.completed_on || (spreadsheetSyncEnabled ? sourceDateIso(sourceDate) : ""), entry?.deficiency_notes || entry?.notes || "", roomTemplate.sourceReference,
        entry?.status === "pending" ? "Pending review" : spreadsheetSyncEnabled ? "Current workbook" : "CMPRI only; sheet sync disabled"]);
    }
  }
  return rows;
}

export function createPmWeeklyTransferCsv(input: PmWeeklyTransferInput): string {
  return pmWeeklyTransferRows(input).map(row => row.map(cell => {
    const value = String(cell || "");
    const literal = /^[\s\x00-\x1f]*[=+\-@]/.test(value) ? "'" + value : value;
    return `"${literal.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
}
