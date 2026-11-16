import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { rankTicketRooms, type RankingLocation, type RankingTicket } from "@/lib/ticket-room-ranking";
import { fetchAllPages } from "@/lib/server/paginated-query";
import { googleSheetsRequest } from "@/lib/server/google-sheets";

// The corporate workbook is an output of the current ticket ranker. The old
// editable ranker and its historical per-ticket retry queue stay retired.
export const CORPORATE_RANKER_HEADERS = ["Rooms", "Room Inspected by", "Specific Room Check 1", "Specific Room Check 2", "Specific Room Check 3", "Room Ranker", "Notes/Actions needed in Room"];
const START = "[CMPRI work orders]";
const END = "[/CMPRI work orders]";
type Ticket = RankingTicket & { display_id: string | null };
type SheetCell = { userEnteredValue?: { stringValue?: string; numberValue?: number; formulaValue?: string }; dataValidation?: { condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> } } };
type Sheet = { properties: { sheetId: number; title: string; gridProperties: { rowCount: number; columnCount: number } }; tables?: Array<{ range: { startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }; columnProperties?: Array<{ columnIndex?: number; columnName?: string; dataValidationRule?: SheetCell["dataValidation"] }> }>; data?: Array<{ startRow?: number; startColumn?: number; rowData?: Array<{ values?: SheetCell[] }> }> };
type Update = { range: string; values: string[][] };
const text = (cell?: SheetCell) => String(cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? "");
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").replaceAll(START, "(CMPRI work orders)").replaceAll(END, "(/CMPRI work orders)").trim();

export function corporateRankerNotes(existing: string, tickets: Ticket[]) {
  const start = existing.indexOf(START), end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && (end < start || existing.indexOf(START, start + START.length) >= 0 || existing.indexOf(END, end + END.length) >= 0))) {
    throw new Error("The corporate notes contain an incomplete CMPRI block; review it before syncing.");
  }
  // Remove only our own delimited block. Preserve all other corporate notes.
  const manual = start < 0 ? existing : (existing.slice(0, start).replace(/\n$/, "") + existing.slice(end + END.length));
  if (!tickets.length) return manual;
  const lines = tickets.map(ticket => `[${oneLine(ticket.display_id || ticket.id)}] ${oneLine(ticket.priority)} / ${oneLine(ticket.status)}: ${oneLine(ticket.issue)}`);
  const result = `${manual}${manual && !manual.endsWith("\n") ? "\n" : ""}${START}\n${lines.join("\n")}\n${END}`;
  if (result.length > 50_000) throw new Error("The corporate notes exceed Google's cell limit; no notes were truncated.");
  return result;
}

export function planCorporateRankerUpdates(sheet: Sheet, locations: RankingLocation[], tickets: Ticket[]) {
  const rows = sheet.data?.[0]?.rowData || [];
  const headers = rows[0]?.values || [];
  if (!CORPORATE_RANKER_HEADERS.every((header, index) => text(headers[index]).trim() === header)) {
    throw new Error("The corporate Room Ranker headers do not match the approved A:G layout.");
  }
  const ranked = rankTicketRooms(locations, tickets);
  if (!ranked.length) throw new Error("CMPRI guest-room inventory is empty; the corporate sheet was not changed.");
  const byNumber = new Map(ranked.map(room => [room.number, room]));
  if (byNumber.size !== ranked.length) throw new Error("CMPRI has duplicate guest-room numbers.");
  const seen = new Set<string>();
  const updates: Update[] = [];
  const quoted = `'${sheet.properties.title.replace(/'/g, "''")}'`;
  for (let index = 1; index < rows.length; index++) {
    const cells = rows[index].values || [];
    const number = text(cells[0]).trim();
    if (!number) continue;
    if (seen.has(number)) throw new Error(`The corporate sheet has duplicate room ${number}.`);
    seen.add(number);
    const room = byNumber.get(number);
    if (!room) throw new Error(`Corporate room ${number} has no active CMPRI guest-room mapping.`);
    for (const column of [5, 6]) {
      if (cells[column]?.userEnteredValue?.formulaValue) throw new Error(`Corporate room ${number} has a formula in a sync output cell.`);
    }
    const table = sheet.tables?.find(table => (table.range.startRowIndex ?? 0) < index && (table.range.endRowIndex ?? 0) > index && (table.range.startColumnIndex ?? 0) === 0 && (table.range.endColumnIndex ?? 0) >= 7);
    const rankRule = cells[5]?.dataValidation?.condition ?? table?.columnProperties?.find(column => column.columnIndex === 5)?.dataValidationRule?.condition;
    if (rankRule && (rankRule.type !== "ONE_OF_LIST" || !rankRule.values?.some(value => value.userEnteredValue === room.rank))) {
      throw new Error(`Corporate room ${number} does not permit rank ${room.rank}.`);
    }
    const notes = corporateRankerNotes(text(cells[6]), room.issues as Ticket[]);
    if (notes !== text(cells[6]) && cells[6]?.dataValidation) throw new Error(`Corporate room ${number} has unsupported notes validation.`);
    if (text(cells[5]) !== room.rank) updates.push({ range: `${quoted}!F${index + 1}`, values: [[room.rank]] });
    if (text(cells[6]) !== notes) updates.push({ range: `${quoted}!G${index + 1}`, values: [[notes]] });
  }
  for (const room of ranked) if (!seen.has(room.number)) throw new Error(`CMPRI room ${room.number} is missing from the corporate sheet.`);
  return { updates, rooms: ranked.length };
}

async function syncSheet(admin: SupabaseClient) {
  const spreadsheetId = process.env.CMPRI_ROOM_RANKER_SPREADSHEET_ID?.trim();
  const sheetName = process.env.CMPRI_ROOM_RANKER_SHEET_NAME?.trim();
  if (!spreadsheetId || !sheetName) throw new Error("The corporate Room Ranker spreadsheet ID and tab must be configured.");
  const metadata = await googleSheetsRequest<{ sheets: Sheet[] }>(spreadsheetId, "?fields=sheets.properties", { signal: AbortSignal.timeout(10_000) }, "Room Ranker");
  const target = metadata.sheets.find(sheet => sheet.properties.title === sheetName);
  if (!target || target.properties.gridProperties.columnCount < 7 || target.properties.gridProperties.rowCount > 5000) throw new Error("The configured corporate Room Ranker tab or grid is invalid.");
  const range = `'${sheetName.replace(/'/g, "''")}'!A1:G${target.properties.gridProperties.rowCount}`;
  const cellsPath = `?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets(properties,tables,data(rowData(values(userEnteredValue,dataValidation))))`;
  const [cells, locations, tickets] = await Promise.all([
    googleSheetsRequest<{ sheets: Sheet[] }>(spreadsheetId, cellsPath, { signal: AbortSignal.timeout(10_000) }, "Room Ranker"),
    fetchAllPages<RankingLocation>((from, to) => admin.from("locations").select("id,room_number,name,location_type,active").eq("hotel_id", HOTEL_ID).eq("active", true).eq("location_type", "Guest Room").order("id").range(from, to)),
    fetchAllPages<Ticket>((from, to) => admin.from("work_orders").select("id,display_id,location_id,room,issue,priority,ranker_base_priority,status").eq("hotel_id", HOTEL_ID).not("status", "in", '("Completed","Closed","Will Not Do")').order("id").range(from, to)),
  ]);
  if (locations.error || tickets.error) throw new Error("CMPRI rooms and tickets could not be loaded.");
  const sheet = cells.sheets.find(sheet => sheet.properties.sheetId === target.properties.sheetId);
  if (!sheet) throw new Error("The corporate sheet changed while loading.");
  const plan = planCorporateRankerUpdates(sheet, locations.data || [], tickets.data || []);
  if (!plan.updates.length) return { rooms: plan.rooms, changedCells: 0 };
  // RAW keeps issue text as text, even when it starts with '='. Values API
  // updates preserve table metadata, formats, validations, and summary formulas.
  await googleSheetsRequest(spreadsheetId, "/values:batchUpdate", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ valueInputOption: "RAW", data: plan.updates }),
  }, "Room Ranker");
  const verified = await googleSheetsRequest<{ sheets: Sheet[] }>(spreadsheetId, cellsPath, { signal: AbortSignal.timeout(10_000) }, "Room Ranker");
  const saved = verified.sheets.find(sheet => sheet.properties.sheetId === target.properties.sheetId);
  if (!saved || planCorporateRankerUpdates(saved, locations.data || [], tickets.data || []).updates.length) throw new Error("Corporate Room Ranker read-back did not match the saved values.");
  return { rooms: plan.rooms, changedCells: plan.updates.length };
}

export async function dispatchCorporateRoomRanker(admin: SupabaseClient) {
  if (process.env.CMPRI_CORPORATE_RANKER_ENABLED !== "true") throw new Error("Corporate Room Ranker delivery is disabled.");
  const { data: claim, error } = await admin.rpc("cmpri_corporate_ranker_claim", { p_hotel: HOTEL_ID });
  if (error) throw new Error("Corporate Room Ranker delivery could not be claimed.");
  if (!claim) return { skipped: true, reason: "unchanged-or-in-progress" };
  try {
    const result = await syncSheet(admin);
    const { data: completed, error: completionError } = await admin.rpc("cmpri_corporate_ranker_finish", { p_hotel: HOTEL_ID, p_owner: claim.owner, p_revision: claim.revision, p_error: null });
    if (completionError || !completed) throw new Error("Corporate Room Ranker delivery could not be acknowledged.");
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Corporate Room Ranker delivery failed.";
    await admin.rpc("cmpri_corporate_ranker_finish", { p_hotel: HOTEL_ID, p_owner: claim.owner, p_revision: claim.revision, p_error: message.slice(0, 2000) });
    throw error;
  }
}
