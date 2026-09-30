import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { googleSheetsRequest } from "@/lib/server/google-sheets";
import { IntegrationConfigurationError, isIntegrationsSafeMode, safeModeBlocked } from "@/lib/server/integrations-safe-mode";

export type RoomRankerRow = {
  rowNumber: number;
  room: string;
  notes?: string | null;
  [key: string]: unknown;
};

type RoomRankerConfig = { spreadsheetId: string; sheetName: string };
type SheetLayout = { headerRow: number; columns: Record<string, number> };

const RANKER_FIELDS = ["inspectedBy", "check1", "check2", "check3", "rank", "notes"] as const;
const FIELD_HEADERS: Record<(typeof RANKER_FIELDS)[number] | "room", string[]> = {
  room: ["room", "rooms", "roomnumber", "roomno", "roomnum", "rm"],
  inspectedBy: ["inspectedby", "roominspectedby", "inspector", "inspected"],
  check1: ["check1", "roomcheck1", "specificroomcheck1"],
  check2: ["check2", "roomcheck2", "specificroomcheck2"],
  check3: ["check3", "roomcheck3", "specificroomcheck3"],
  rank: ["rank", "roomrank", "roomranker"],
  notes: ["notes", "notesactionsneeded", "actionsneeded", "notesactions", "notesactionsneededinroom"],
};
function roomRankerConfig(): RoomRankerConfig {
  const spreadsheetId = process.env.CMPRI_ROOM_RANKER_SPREADSHEET_ID?.trim();
  const sheetName = process.env.CMPRI_ROOM_RANKER_SHEET_NAME?.trim();
  const missing = [
    !spreadsheetId && "CMPRI_ROOM_RANKER_SPREADSHEET_ID",
    !sheetName && "CMPRI_ROOM_RANKER_SHEET_NAME",
  ].filter(Boolean);
  if (missing.length) {
    throw new IntegrationConfigurationError(`Room Ranker is missing server deployment settings: ${missing.join(", ")}.`);
  }
  return { spreadsheetId: spreadsheetId as string, sheetName: sheetName as string };
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function escapedSheetName(name: string) {
  return `'${name.replace(/'/g, "''")}'`;
}

async function getRoomRankerValues(config: RoomRankerConfig) {
  const metadata = await googleSheetsRequest<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    config.spreadsheetId,
    "?fields=sheets.properties.title",
    {},
    "Room Ranker",
  );
  if (!metadata.sheets?.some((sheet) => sheet.properties?.title === config.sheetName)) {
    throw new Error(`The configured Room Ranker tab '${config.sheetName}' was not found in the spreadsheet.`);
  }
  const range = encodeURIComponent(`${escapedSheetName(config.sheetName)}!A:Z`);
  const result = await googleSheetsRequest<{ values?: unknown[][] }>(
    config.spreadsheetId,
    `/values/${range}?valueRenderOption=FORMATTED_VALUE`,
    {},
    "Room Ranker",
  );
  return result.values || [];
}

function normalizedHeader(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sheetLayout(values: unknown[][]): SheetLayout {
  for (let rowIndex = 0; rowIndex < Math.min(values.length, 20); rowIndex += 1) {
    const headers = values[rowIndex].map(normalizedHeader);
    const columns: Record<string, number> = {};
    for (const [field, aliases] of Object.entries(FIELD_HEADERS)) {
      const index = headers.findIndex((header) => aliases.includes(header));
      if (index >= 0) columns[field] = index;
    }
    if (columns.room !== undefined && RANKER_FIELDS.every((field) => columns[field] !== undefined)) {
      return { headerRow: rowIndex, columns };
    }
  }
  throw new Error("Room Ranker headers were not found. The sheet needs Room, Inspected By, Check 1–3, Rank, and Notes columns.");
}

function getCell(row: unknown[], index: number) {
  const value = row[index];
  return value === undefined || value === null ? "" : String(value);
}

async function readRoomRanker(config: RoomRankerConfig) {
  const values = await getRoomRankerValues(config);
  const layout = sheetLayout(values);
  const rooms = values.slice(layout.headerRow + 1).flatMap((row, index) => {
    if (!Array.isArray(row)) return [];
    const room = getCell(row, layout.columns.room).trim();
    if (!room) return [];
    return [{
      rowNumber: layout.headerRow + index + 2,
      room,
      inspectedBy: getCell(row, layout.columns.inspectedBy),
      check1: getCell(row, layout.columns.check1),
      check2: getCell(row, layout.columns.check2),
      check3: getCell(row, layout.columns.check3),
      rank: getCell(row, layout.columns.rank),
      notes: getCell(row, layout.columns.notes),
    }];
  });
  return { ok: true, rooms, fetchedAt: new Date().toISOString(), config, layout };
}

async function updateRoomRanker(config: RoomRankerConfig, payload: Record<string, unknown>) {
  const { layout, rooms } = await readRoomRanker(config);
  const rowNumber = Number(payload.rowNumber);
  const target = rooms.find((room) => room.rowNumber === rowNumber);
  if (!target || target.room !== String(payload.expectedRoom || "").trim()) {
    throw new Error("The Room Ranker row changed since it was loaded. Refresh and try again.");
  }

  const updates = RANKER_FIELDS.flatMap((field) => {
    if (!(field in payload)) return [];
    return [{
      range: `${escapedSheetName(config.sheetName)}!${columnName(layout.columns[field])}${rowNumber}`,
      values: [[String(payload[field] ?? "")]],
    }];
  });
  if (!updates.length) throw new Error("No editable Room Ranker fields were supplied.");
  await googleSheetsRequest(config.spreadsheetId, "/values:batchUpdate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
  }, "Room Ranker");

  const verified = await readRoomRanker(config);
  const saved = verified.rooms.find((room) => room.rowNumber === rowNumber);
  if (!saved || saved.room !== target.room || updates.some((update) => {
    const field = RANKER_FIELDS.find((key) => update.range.startsWith(`${escapedSheetName(config.sheetName)}!${columnName(layout.columns[key])}`));
    return field !== undefined && saved[field] !== update.values[0][0];
  })) {
    throw new Error("Google Sheets accepted the Room Ranker write, but read-back verification did not match. Refresh and verify the room.");
  }
  return { ok: true, room: saved.room, rowNumber };
}

export async function callRoomRanker(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(payload.action || "").trim().toLowerCase();
  if (action !== "read" && isIntegrationsSafeMode()) {
    return safeModeBlocked("Room Ranker", action || "write") as unknown as Record<string, unknown>;
  }
  const config = roomRankerConfig();
  if (action === "read") {
    const { rooms, fetchedAt } = await readRoomRanker(config);
    return { ok: true, rooms, fetchedAt };
  }
  if (action !== "update") throw new Error("Room Ranker action is not supported.");
  return updateRoomRanker(config, payload);
}

function roomNumber(value: unknown) {
  return String(value || "").match(/\b\d{2,4}\b/)?.[0] || "";
}

function markerLine(displayId: string, issue: string) {
  const normalizedIssue = issue.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `[${displayId}] ${normalizedIssue}`.trim();
}

function isRankerActiveStatus(status: unknown) {
  const value = String(status || "Open").trim().toLowerCase();
  return !["closed", "will not do", "duplicate", "cancelled", "canceled"].includes(value);
}

async function syncSnapshot(snapshot: { display_id?: unknown; room?: unknown; issue?: unknown; status?: unknown }) {
  const displayId = String(snapshot.display_id || "").trim();
  const room = roomNumber(snapshot.room);
  if (!displayId || !room) return { skipped: true, reason: "not-a-ranked-guest-room" } as const;

  const read = await callRoomRanker({ action: "read" });
  const rooms = Array.isArray(read.rooms) ? read.rooms as RoomRankerRow[] : [];
  const target = rooms.find((row) => String(row.room || "").trim() === room);
  if (!target || !Number.isSafeInteger(Number(target.rowNumber)) || Number(target.rowNumber) < 1) {
    return { skipped: true, reason: "room-not-present-in-ranker" } as const;
  }

  const prefix = `[${displayId}]`;
  const existingLines = String(target.notes || "").split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !line.trimStart().startsWith(prefix));

  if (isRankerActiveStatus(snapshot.status)) {
    existingLines.push(markerLine(displayId, String(snapshot.issue || "Work order")));
  }

  // Keep unrelated Room Ranker notes intact. Only the exact tagged ticket line is
  // added/replaced/removed. The Apps Script input contract limits notes to 10,000 chars.
  let notes = existingLines.filter(Boolean).join("\n");
  if (notes.length > 10_000) {
    if (isRankerActiveStatus(snapshot.status)) {
      const marker = markerLine(displayId, String(snapshot.issue || "Work order"));
      const keep = Math.max(0, 9_999 - marker.length);
      notes = `${existingLines.filter((line) => !line.startsWith(prefix)).join("\n").slice(0, keep).trimEnd()}\n${marker}`.trim();
    } else {
      notes = notes.slice(0, 10_000).trimEnd();
    }
  }

  await callRoomRanker({
    action: "update",
    rowNumber: Number(target.rowNumber),
    expectedRoom: String(target.room),
    notes,
  });
  return { skipped: false, room, rowNumber: Number(target.rowNumber) } as const;
}

export async function processRoomRankerSyncForWorkOrder(admin: SupabaseClient, workOrderId: string) {
  const { data: queue, error: queueError } = await admin
    .from("cmpri_room_ranker_sync_queue")
    .select("id, work_order_id, attempts")
    .eq("hotel_id", HOTEL_ID)
    .eq("work_order_id", workOrderId)
    .maybeSingle();
  if (queueError || !queue) return { processed: false, reason: "queue-unavailable" } as const;

  const { data: workOrder, error: workOrderError } = await admin
    .from("work_orders")
    .select("id, display_id, room, issue, status")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", workOrderId)
    .maybeSingle();
  if (workOrderError || !workOrder) {
    await admin.from("cmpri_room_ranker_sync_queue").update({
      processed_at: new Date().toISOString(),
      last_error: workOrderError ? "Work order could not be loaded." : "Work order no longer exists.",
      updated_at: new Date().toISOString(),
    }).eq("id", queue.id);
    return { processed: false, reason: "work-order-unavailable" } as const;
  }

  try {
    const result = await syncSnapshot(workOrder);
    await admin.from("cmpri_room_ranker_sync_queue").update({
      processed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", queue.id);
    return { processed: true, ...result } as const;
  } catch (error) {
    const attempts = Number(queue.attempts || 0) + 1;
    const delayMinutes = Math.min(60, Math.max(1, 2 ** Math.min(attempts - 1, 6)));
    await admin.from("cmpri_room_ranker_sync_queue").update({
      attempts,
      last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", queue.id);
    return { processed: false, reason: "room-ranker-error" } as const;
  }
}

export async function processDueRoomRankerSync(admin: SupabaseClient, limit = 25) {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("cmpri_room_ranker_sync_queue")
    .select("work_order_id")
    .eq("hotel_id", HOTEL_ID)
    .is("processed_at", null)
    .lte("next_attempt_at", now)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) throw new Error("Room Ranker sync queue could not be loaded.");
  const results = [];
  for (const row of data || []) {
    results.push(await processRoomRankerSyncForWorkOrder(admin, String(row.work_order_id)));
  }
  return results;
}
