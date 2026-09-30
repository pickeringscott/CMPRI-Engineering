import "server-only";
import { IntegrationConfigurationError } from "@/lib/server/integrations-safe-mode";
import { googleSheetsRequest } from "@/lib/server/google-sheets";

export const CORPORATE_PM_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"] as const;

type PmCell = { sheet: string; row: number; column: number; label: string; checked: boolean };
type PmSnapshot = { sheet: string; values: string[][]; formulas: string[][]; lastRow: number; lastColumn: number };

function spreadsheetId() {
  const id = process.env.CMPRI_CORPORATE_PM_SPREADSHEET_ID?.trim();
  if (!id) throw new IntegrationConfigurationError("Corporate PM is missing the server deployment setting CMPRI_CORPORATE_PM_SPREADSHEET_ID.");
  return id;
}

function validMonth(sheet: string) {
  const month = sheet.trim().toUpperCase();
  if (!(CORPORATE_PM_MONTHS as readonly string[]).includes(month)) {
    throw new Error(`Corporate PM tab '${sheet}' is not a supported monthly sheet.`);
  }
  return month;
}

function rangeFor(sheet: string) {
  return `'${sheet.replace(/'/g, "''")}'!A:ZZ`;
}

function strings(rows: unknown[][] | undefined) {
  return (rows || []).map((row) => (row || []).map((value) => value == null ? "" : String(value)));
}

async function readValues(spreadsheet: string, sheet: string, render: "FORMATTED_VALUE" | "FORMULA") {
  const range = encodeURIComponent(rangeFor(sheet));
  const result = await googleSheetsRequest<{ values?: unknown[][] }>(
    spreadsheet,
    `/values/${range}?valueRenderOption=${render}`,
    {},
    "Corporate PM",
  );
  return strings(result.values);
}

export async function readCorporatePmSheet(sheetName: string): Promise<PmSnapshot & { ok: true; timestamp: string }> {
  const sheet = validMonth(sheetName);
  const spreadsheet = spreadsheetId();
  const metadata = await googleSheetsRequest<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    spreadsheet,
    "?fields=sheets.properties.title",
    {},
    "Corporate PM",
  );
  if (!metadata.sheets?.some((tab) => tab.properties?.title === sheet)) {
    throw new Error(`The configured Corporate PM spreadsheet does not contain the '${sheet}' tab.`);
  }
  const [values, formulas] = await Promise.all([
    readValues(spreadsheet, sheet, "FORMATTED_VALUE"),
    readValues(spreadsheet, sheet, "FORMULA"),
  ]);
  return {
    ok: true,
    sheet,
    lastRow: values.length,
    lastColumn: values.reduce((maximum, row) => Math.max(maximum, row.length), 0),
    values,
    formulas,
    timestamp: new Date().toISOString(),
  };
}

function roomMatches(value: string, room: string) {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized === room || (normalized.startsWith("ROOM") && normalized.slice(4) === room);
}

function checkbox(value: string, formula: string) {
  return formula === "" && (value === "TRUE" || value === "FALSE");
}

function isDailyOrWeekly(label: string) {
  return /\b(?:daily|weekly)\b/i.test(label);
}

function dailyWeeklyCells(sheet: string, values: string[][], formulas: string[][], room: string): PmCell[] {
  const cells = new Map<string, PmCell>();
  const add = (rowIndex: number, columnIndex: number, label: string) => {
    const value = values[rowIndex]?.[columnIndex] || "";
    const formula = formulas[rowIndex]?.[columnIndex] || "";
    if (!isDailyOrWeekly(label) || !checkbox(value, formula)) return;
    const key = `${rowIndex + 1}:${columnIndex + 1}`;
    cells.set(key, { sheet, row: rowIndex + 1, column: columnIndex + 1, label: label.trim(), checked: value === "TRUE" });
  };

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    for (let roomColumn = 0; roomColumn < row.length; roomColumn += 1) {
      if (!roomMatches(row[roomColumn], room)) continue;

      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        if (columnIndex === roomColumn || !checkbox(row[columnIndex] || "", formulas[rowIndex]?.[columnIndex] || "")) continue;
        const header = values[0]?.[columnIndex] || "";
        const description = row.find((value, index) => index !== roomColumn && index !== columnIndex && value.trim() && value !== "TRUE" && value !== "FALSE") || "";
        add(rowIndex, columnIndex, [header, description].filter(Boolean).join(" "));
      }

      if (rowIndex < 20) {
        for (let dataRow = rowIndex + 1; dataRow < values.length; dataRow += 1) {
          const value = values[dataRow]?.[roomColumn] || "";
          if (!checkbox(value, formulas[dataRow]?.[roomColumn] || "")) continue;
          const description = values[dataRow]?.find((entry, index) => index !== roomColumn && entry.trim() && entry !== "TRUE" && entry !== "FALSE") || "";
          const group = [...values.slice(1, dataRow).map((candidate) => candidate?.[0] || "")]
            .reverse()
            .find((entry) => entry.trim() && entry !== "TRUE" && entry !== "FALSE") || "";
          add(dataRow, roomColumn, [group, description].filter(Boolean).join(" "));
        }
      }
    }
  }
  return [...cells.values()];
}

export async function readCorporatePmRoom(roomValue: string) {
  const room = roomValue.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!room) throw new Error("A room number is required for Corporate PM.");
  const spreadsheet = spreadsheetId();
  const ranges = CORPORATE_PM_MONTHS.map(rangeFor);
  const valueQuery = new URLSearchParams();
  for (const range of ranges) valueQuery.append("ranges", range);
  valueQuery.set("valueRenderOption", "FORMATTED_VALUE");
  const formulaQuery = new URLSearchParams();
  for (const range of ranges) formulaQuery.append("ranges", range);
  formulaQuery.set("valueRenderOption", "FORMULA");
  const [valueResult, formulaResult] = await Promise.all([
    googleSheetsRequest<{ valueRanges?: Array<{ values?: unknown[][] }> }>(spreadsheet, `/values:batchGet?${valueQuery}`, {}, "Corporate PM"),
    googleSheetsRequest<{ valueRanges?: Array<{ values?: unknown[][] }> }>(spreadsheet, `/values:batchGet?${formulaQuery}`, {}, "Corporate PM"),
  ]);
  const tasks = CORPORATE_PM_MONTHS.flatMap((sheet, index) => dailyWeeklyCells(
    sheet,
    strings(valueResult.valueRanges?.[index]?.values),
    strings(formulaResult.valueRanges?.[index]?.values),
    room,
  ));
  return { ok: true, room: roomValue.trim(), tasks, fetchedAt: new Date().toISOString() };
}
