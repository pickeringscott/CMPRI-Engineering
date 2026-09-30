import "server-only";
import { findPmTemplate, pmWeekStart } from "@/lib/pm/catalog";
import { IntegrationConfigurationError } from "@/lib/server/integrations-safe-mode";
import { googleSheetsRequest } from "@/lib/server/google-sheets";

export const LIVE_PM_MONTHS = [
  { name: "JAN", number: 1 },
  { name: "FEB", number: 2 },
  { name: "MAR", number: 3 },
  { name: "APRIL", number: 4 },
  { name: "MAY", number: 5 },
  { name: "JUNE", number: 6 },
  { name: "JULY", number: 7 },
  { name: "AUG", number: 8 },
  { name: "SEPT", number: 9 },
  { name: "OCT", number: 10 },
  { name: "NOV", number: 11 },
  { name: "DEC", number: 12 },
] as const;

export type LivePmTarget = {
  id: string;
  sheet: string;
  row: number;
  column: number;
  label: string;
  kind: "checkbox" | "completion-date";
  value: string;
  period: string;
};

export type LivePmTask = {
  id: string;
  label: string;
  category: string;
  source: string;
  targets: LivePmTarget[];
};

export type LivePmRoom = {
  room: string;
  quarters: Record<string, LivePmTarget | null>;
};
export type LivePmProposedCell = {
  sheet: string;
  row: number;
  column: number;
  label: string;
  kind: LivePmTarget["kind"];
  expectedValue: string;
  proposedValue: string;
};

type SheetSnapshot = { sheet: string; values: string[][]; formulas: string[][] };

function spreadsheetId() {
  const id = process.env.CMPRI_LIVE_PM_SPREADSHEET_ID?.trim();
  if (!id) {
    throw new IntegrationConfigurationError(
      "Live PM is missing the server deployment setting CMPRI_LIVE_PM_SPREADSHEET_ID.",
    );
  }
  return id;
}

function rangeFor(sheet: string) {
  return `'${sheet.replace(/'/g, "''")}'!A:ZZ`;
}

function toStrings(rows: unknown[][] | undefined) {
  return (rows || []).map((row) => (row || []).map((value) => value == null ? "" : String(value).trim()));
}

function columnName(index: number) {
  let value = index;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function cellTarget(
  snapshot: SheetSnapshot,
  rowIndex: number,
  columnIndex: number,
  label: string,
  kind: LivePmTarget["kind"],
  period: string,
): LivePmTarget {
  return {
    id: `${snapshot.sheet}!${columnName(columnIndex + 1)}${rowIndex + 1}`,
    sheet: snapshot.sheet,
    row: rowIndex + 1,
    column: columnIndex + 1,
    label,
    kind,
    value: snapshot.values[rowIndex]?.[columnIndex] || "",
    period,
  };
}

async function readSheet(id: string, sheet: string): Promise<SheetSnapshot> {
  const range = encodeURIComponent(rangeFor(sheet));
  const [values, formulas] = await Promise.all([
    googleSheetsRequest<{ values?: unknown[][] }>(
      id,
      `/values/${range}?valueRenderOption=FORMATTED_VALUE`,
      {},
      "Live PM",
    ),
    googleSheetsRequest<{ values?: unknown[][] }>(
      id,
      `/values/${range}?valueRenderOption=FORMULA`,
      {},
      "Live PM",
    ),
  ]);
  return { sheet, values: toStrings(values.values), formulas: toStrings(formulas.values) };
}

function boolCell(snapshot: SheetSnapshot, row: number, column: number) {
  const value = snapshot.values[row]?.[column] || "";
  const formula = snapshot.formulas[row]?.[column] || "";
  return !formula && (value === "TRUE" || value === "FALSE");
}

function findRow(snapshot: SheetSnapshot, expression: RegExp, startAt = 0) {
  return snapshot.values.findIndex((row, index) => index >= startAt && row.some((value) => expression.test(value)));
}

function dateHeader(value: string, year: number) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const resolvedYear = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(resolvedYear, Number(match[1]) - 1, Number(match[2])));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== Number(match[1]) || date.getUTCDate() !== Number(match[2])) return null;
  return date.toISOString().slice(0, 10);
}

function monthlyTasks(snapshot: SheetSnapshot, year: number) {
  const dailyHeading = findRow(snapshot, /^DAILY$/i);
  const weeklyHeading = findRow(snapshot, /^WEEKLY$/i, dailyHeading + 1);
  const dateRow = snapshot.values.findIndex((row, index) =>
    index > dailyHeading && index < weeklyHeading && row.some((value) => value.toUpperCase() === "DATE"),
  );
  const dailyDates = new Map<number, string>();
  if (dateRow >= 0) {
    snapshot.values[dateRow].forEach((value, column) => {
      const date = dateHeader(value, year);
      if (date) dailyDates.set(column, date);
    });
  }

  const daily = new Map<string, LivePmTask>();
  if (dailyHeading >= 0 && weeklyHeading > dailyHeading && dateRow >= 0) {
    for (let row = dateRow + 1; row < weeklyHeading; row += 1) {
      const label = snapshot.values[row]?.[0] || "";
      if (!label || /CHECKLIST COMPLETION$/i.test(label)) continue;
      const targets = [...dailyDates.entries()]
        .filter(([column]) => boolCell(snapshot, row, column))
        .map(([column, date]) => cellTarget(snapshot, row, column, label, "checkbox", date));
      if (!targets.length) continue;
      daily.set(label.trim().toLowerCase(), {
        id: `daily:${label.trim().toLowerCase()}`,
        label,
        category: "",
        source: snapshot.sheet,
        targets,
      });
    }
  }

  const weekly = new Map<string, LivePmTask>();
  if (weeklyHeading >= 0) {
    const monthEnd = findRow(snapshot, /^MAINTENANCE SCHEDULE\b/i, weeklyHeading + 1);
    const end = monthEnd >= 0 ? monthEnd : snapshot.values.length;
    let headerRow = -1;
    for (let row = weeklyHeading + 1; row < end; row += 1) {
      if (snapshot.values[row]?.some((value) => /^WK[1-5]$/i.test(value))) {
        headerRow = row;
        break;
      }
    }
    if (headerRow >= 0) {
      const slots = new Map<number, number>();
      snapshot.values[headerRow].forEach((value, column) => {
        const match = value.match(/^WK([1-5])$/i);
        if (match) slots.set(column, Number(match[1]));
      });
      for (let row = headerRow + 1; row < end; row += 1) {
        const label = snapshot.values[row]?.[0] || "";
        if (!label || /CHECKLIST COMPLETION$/i.test(label)) continue;
        const targets = [...slots.entries()]
          .filter(([column]) => boolCell(snapshot, row, column))
          .map(([column, slot]) => cellTarget(snapshot, row, column, label, "checkbox", `WK${slot}`));
        if (!targets.length) continue;
        weekly.set(label.trim().toLowerCase(), {
          id: `weekly:${label.trim().toLowerCase()}`,
          label,
          category: "",
          source: snapshot.sheet,
          targets,
        });
      }
    }
  }

  const monthly = new Map<string, LivePmTask>();
  const monthlyHeading = findRow(snapshot, /MONTHLY\s*\/?\s*QUARTERLY CHECKLIST/i);
  if (monthlyHeading >= 0) {
    for (let row = monthlyHeading + 1; row < snapshot.values.length; row += 1) {
      const values = snapshot.values[row] || [];
      if (/^MAINTENANCE SCHEDULE\b/i.test(values[0] || "")) break;
      if (!/^(TRUE|FALSE)$/.test(values[0] || "") || !/^\d+$/.test(values[1] || "")) continue;
      const label = values[2] || "";
      if (!label || !boolCell(snapshot, row, 0)) continue;
      const target = cellTarget(snapshot, row, 0, label, "checkbox", snapshot.sheet);
      monthly.set(label.trim().toLowerCase(), {
        id: `monthly:${values[1]}`,
        label,
        category: "",
        source: snapshot.sheet,
        targets: [target],
      });
    }
  }
  return { daily: [...daily.values()], weekly: [...weekly.values()], monthly: [...monthly.values()] };
}

function parseRooms(snapshot: SheetSnapshot) {
  const header = snapshot.values.findIndex((row) =>
    row.some((value) => /^ROOM(?:\s+NUMBER)?$/i.test(value))
    && ["Q1", "Q2", "Q3", "Q4"].every((quarter) => row.includes(quarter)),
  );
  if (header < 0) return [];
  const row = snapshot.values[header];
  const roomColumn = row.findIndex((value) => /^ROOM(?:\s+NUMBER)?$/i.test(value));
  const quarterColumns = Object.fromEntries(["Q1", "Q2", "Q3", "Q4"].map((quarter) => [quarter, row.indexOf(quarter)]));
  const rooms: LivePmRoom[] = [];
  for (let index = header + 1; index < snapshot.values.length; index += 1) {
    const room = snapshot.values[index]?.[roomColumn] || "";
    if (!/^\d{2,4}[A-Z]?$/i.test(room)) continue;
    const quarters = Object.fromEntries(Object.entries(quarterColumns).map(([quarter, column]) => {
      if (column < 0 || snapshot.formulas[index]?.[column]) return [quarter, null];
      return [quarter, cellTarget(snapshot, index, column, `${room} ${quarter}`, "completion-date", quarter)];
    }));
    rooms.push({ room, quarters });
  }
  return rooms;
}

function weekMonthDates(weekStart: string) {
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(`${weekStart}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

function monthSheet(number: number) {
  return LIVE_PM_MONTHS.find((month) => month.number === number)?.name || "";
}

function normalizedLabel(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedDate(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const formatted = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  const parts = iso || formatted;
  if (!parts) return null;
  const sourceYear = iso ? parts[1] : parts[3];
  const year = iso ? Number(sourceYear) : sourceYear.length === 2 ? 2000 + Number(sourceYear) : Number(sourceYear);
  const month = Number(iso ? parts[2] : parts[1]);
  const day = Number(iso ? parts[3] : parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function dateValue(value: string) {
  return normalizedDate(value) || value;
}

function validDateValue(value: string) {
  return Boolean(normalizedDate(value));
}

function yearFromSnapshot(snapshot: SheetSnapshot) {
  for (const value of snapshot.values.flat()) {
    const match = value.match(/^\d{1,2}\/\d{1,2}\/(\d{2}|\d{4})$/);
    if (match) return match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1]);
  }
  return Number(snapshot.sheet);
}

export async function readLivePmWeek(weekStart: string) {
  const weekDates = weekMonthDates(weekStart);
  const year = Number(weekDates[3].slice(0, 4));
  const monthNumbers = [...new Set(weekDates.map((date) => Number(date.slice(5, 7))))];
  const months = monthNumbers.map((number) => monthSheet(number));
  const spreadsheet = spreadsheetId();
  const [yearSnapshot, ...monthSnapshots] = await Promise.all([
    readSheet(spreadsheet, String(year)),
    ...months.map((month) => readSheet(spreadsheet, month)),
  ]);
  const dailyByDate = new Map<string, LivePmTask[]>();
  const weeklyByMonth = new Map<string, LivePmTask[]>();
  const monthlyByMonth = new Map<string, LivePmTask[]>();
  for (const snapshot of monthSnapshots) {
    const sheetMonth = LIVE_PM_MONTHS.find((entry) => entry.name === snapshot.sheet);
    const parsed = monthlyTasks(snapshot, year);
    for (const task of parsed.daily) {
      for (const target of task.targets) {
        dailyByDate.set(target.period, [
          ...(dailyByDate.get(target.period) || []),
          { ...task, targets: [target] },
        ]);
      }
    }
    if (sheetMonth) {
      const weekDate = weekDates.find((date) => Number(date.slice(5, 7)) === sheetMonth.number);
      const weekSlot = weekDate ? Math.ceil(Number(weekDate.slice(8, 10)) / 7) : 0;
      weeklyByMonth.set(snapshot.sheet, parsed.weekly.map((task) => ({
        ...task,
        targets: task.targets.filter((target) => Number(target.period.slice(2)) === weekSlot),
      })));
      monthlyByMonth.set(snapshot.sheet, parsed.monthly);
    }
  }

  return {
    week: weekStart,
    year,
    weekDates,
    monthSheets: months,
    daily: Object.fromEntries(weekDates.map((date) => [date, dailyByDate.get(date) || []])),
    weekly: Object.fromEntries(months.map((month) => [month, weeklyByMonth.get(month) || []])),
    monthly: Object.fromEntries(months.map((month) => [month, monthlyByMonth.get(month) || []])),
    rooms: parseRooms(yearSnapshot),
    fetchedAt: new Date().toISOString(),
  };
}

export async function readLivePmSheet(sheet: string) {
  const normalized = sheet.trim().toUpperCase();
  const valid = LIVE_PM_MONTHS.some((month) => month.name === normalized) || /^\d{4}$/.test(normalized);
  if (!valid) throw new Error(`Live PM tab '${sheet}' is not a supported year or month tab.`);
  const snapshot = await readSheet(spreadsheetId(), normalized);
  return { sheet: normalized, values: snapshot.values, formulas: snapshot.formulas };
}

export async function resolveLivePmChanges(input: {
  templateId: string;
  periodStart: string;
  scopeKey: string;
  responses: Record<string, unknown>;
  completedOn: string | null;
}): Promise<LivePmProposedCell[]> {
  const template = findPmTemplate(input.templateId);
  if (!template) throw new Error("The PM form is not supported.");
  const workbook = await readLivePmWeek(pmWeekStart(input.periodStart));
  const changes: LivePmProposedCell[] = [];

  if (template.kind === "routine") {
    const month = monthSheet(Number(input.periodStart.slice(5, 7)));
    const tasks = template.cadence === "daily"
      ? workbook.daily[input.periodStart] || []
      : template.cadence === "weekly"
        ? workbook.weekly[month] || []
        : workbook.monthly[month] || [];
    for (const item of template.checklist) {
      const proposed = input.responses[item.id];
      if (proposed === undefined) continue;
      if (typeof proposed !== "boolean") throw new Error(`The response for '${item.label}' must be a checkbox value.`);
      const task = tasks.find((candidate) => normalizedLabel(candidate.label) === normalizedLabel(item.label));
      const target = task?.targets[0];
      if (!target) throw new Error(`The live PM sheet has no editable checkbox for '${item.label}'.`);
      if ((target.value === "TRUE") === proposed) continue;
      changes.push({
        sheet: target.sheet,
        row: target.row,
        column: target.column,
        label: target.label,
        kind: target.kind,
        expectedValue: target.value,
        proposedValue: proposed ? "TRUE" : "FALSE",
      });
    }
  } else if (template.kind === "room" && input.completedOn) {
    const room = input.scopeKey.match(/^room:(\d{2,4})$/)?.[1];
    const quarter = `Q${Math.floor((Number(input.periodStart.slice(5, 7)) - 1) / 3) + 1}`;
    const target = room && workbook.rooms.find((entry) => entry.room === room)?.quarters[quarter] || null;
    if (!target) throw new Error(`The live PM year sheet has no editable completion-date cell for room ${room || ""} ${quarter}.`);
    if (dateValue(target.value) !== input.completedOn) {
      changes.push({
        sheet: target.sheet,
        row: target.row,
        column: target.column,
        label: target.label,
        kind: target.kind,
        expectedValue: target.value,
        proposedValue: input.completedOn,
      });
    }
  }
  return changes;
}

export function livePmWritesEnabled() {
  return process.env.CMPRI_LIVE_PM_WRITES_ENABLED?.trim().toLowerCase() === "true";
}

export async function applyLivePmChanges(changes: LivePmProposedCell[]) {
  if (!changes.length) return { written: 0 };
  if (!livePmWritesEnabled()) {
    throw new Error("Live PM writes are disabled. Enable CMPRI_LIVE_PM_WRITES_ENABLED only after the dev review is complete.");
  }
  const spreadsheet = spreadsheetId();
  const sheets = [...new Set(changes.map((change) => change.sheet))];
  const snapshots = new Map(await Promise.all(sheets.map(async (sheet) => [sheet, await readSheet(spreadsheet, sheet)] as const)));
  const allowedTargets = new Map<string, LivePmTarget>();
  for (const snapshot of snapshots.values()) {
    if (/^\d{4}$/.test(snapshot.sheet)) {
      for (const room of parseRooms(snapshot)) {
        for (const target of Object.values(room.quarters)) {
          if (target) allowedTargets.set(target.id, target);
        }
      }
    } else {
      const tasks = monthlyTasks(snapshot, yearFromSnapshot(snapshot));
      for (const target of [...tasks.daily, ...tasks.weekly, ...tasks.monthly].flatMap((task) => task.targets)) {
        allowedTargets.set(target.id, target);
      }
    }
  }

  const changesByTarget = new Map<string, LivePmProposedCell>();
  for (const change of changes) {
    if (!Number.isSafeInteger(change.row) || change.row < 1
      || !Number.isSafeInteger(change.column) || change.column < 1
      || !["checkbox", "completion-date"].includes(change.kind)) {
      throw new Error("The saved PM proposal contains an invalid workbook target.");
    }
    const key = `${change.sheet}!${columnName(change.column)}${change.row}`;
    const target = allowedTargets.get(key);
    if (!target || target.kind !== change.kind) {
      throw new Error(`The saved PM target ${key} is no longer an editable workbook cell.`);
    }
    if (change.kind === "checkbox"
      && !["TRUE", "FALSE"].includes(change.proposedValue)) {
      throw new Error(`The saved PM checkbox proposal for ${key} is invalid.`);
    }
    if (change.kind === "completion-date" && !/^\d{4}-\d{2}-\d{2}$/.test(change.proposedValue)) {
      throw new Error(`The saved PM completion date for ${key} is invalid.`);
    }
    if (changesByTarget.has(key) && changesByTarget.get(key)!.proposedValue !== change.proposedValue) {
      throw new Error(`The PM proposal contains conflicting values for ${key}.`);
    }
    changesByTarget.set(key, change);
  }

  const writes: Array<{ range: string; values: string[][] }> = [];
  for (const [key, change] of changesByTarget) {
    const snapshot = snapshots.get(change.sheet)!;
    const current = snapshot.values[change.row - 1]?.[change.column - 1] || "";
    const formula = snapshot.formulas[change.row - 1]?.[change.column - 1] || "";
    if (formula) throw new Error(`The live PM cell ${key} is formula-backed and cannot be changed.`);
    if (change.kind === "checkbox" && !["TRUE", "FALSE"].includes(current)) {
      throw new Error(`The live PM cell ${key} is no longer a checkbox.`);
    }
    if (change.kind === "completion-date" && current && !validDateValue(current)) {
      throw new Error(`The live PM cell ${key} no longer contains a valid completion date.`);
    }
    if (dateValue(current) !== dateValue(change.expectedValue)
      && dateValue(current) !== dateValue(change.proposedValue)) {
      throw new Error(`The live PM cell ${key} changed after this PM proposal was submitted. Refresh it before approval.`);
    }
    if (dateValue(current) !== dateValue(change.proposedValue)) {
      writes.push({ range: `'${change.sheet.replace(/'/g, "''")}'!${columnName(change.column)}${change.row}`, values: [[change.proposedValue]] });
    }
  }

  if (writes.length) {
    await googleSheetsRequest(
      spreadsheet,
      "/values:batchUpdate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: writes }),
      },
      "Live PM",
    );
    for (const sheet of sheets) {
      const snapshot = await readSheet(spreadsheet, sheet);
      for (const change of changesByTarget.values()) {
        if (change.sheet !== sheet) continue;
        const actual = snapshot.values[change.row - 1]?.[change.column - 1] || "";
        if (dateValue(actual) !== dateValue(change.proposedValue)) {
          throw new Error(`Google Sheets did not confirm the approved PM value at ${sheet}!${columnName(change.column)}${change.row}.`);
        }
      }
    }
  }
  return { written: writes.length };
}
