export const MAX_AI_ROOM_OPERATION_ROWS = 50;

export type AiRoomOperationRow = {
  room: string;
  checkout_date: string;
  checkout_time: string;
  room_status: string;
  arrival_date: string;
  arrival_time: string;
  move_from: string;
  move_to: string;
  room_type: string;
  guest_arrival_date: string;
  stay_nights: number;
  reserved: boolean;
};

export type AiRoomOperationsImport = {
  report_date: string;
  rows: AiRoomOperationRow[];
};

function text(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${field} is invalid.`);
  return value.trim();
}

function isoDate(value: unknown, field: string, required = false) {
  const date = text(value, field, 10);
  if (!date && !required) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  return date;
}

function roomNumber(value: unknown, field: string) {
  const raw = text(value, field, 40);
  const room = raw.match(/\b\d{2,4}\b/)?.[0] || "";
  if (!room) throw new Error(`${field} must include a room number.`);
  return room;
}

export function validateAiRoomOperationsImport(value: unknown): AiRoomOperationsImport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A room-operations import is required.");
  const input = value as Record<string, unknown>;
  const reportDate = isoDate(input.report_date, "Report date", true);
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_AI_ROOM_OPERATION_ROWS) {
    throw new Error(`Prepare between 1 and ${MAX_AI_ROOM_OPERATION_ROWS} room rows at a time.`);
  }
  const seenRooms = new Set<string>();
  const rows = input.rows.map((value, index): AiRoomOperationRow => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Row ${index + 1} is invalid.`);
    const row = value as Record<string, unknown>;
    const room = roomNumber(row.room, `Row ${index + 1} room`);
    if (seenRooms.has(room)) throw new Error(`Room ${room} appears more than once in the import.`);
    seenRooms.add(room);
    const stayNights = row.stay_nights;
    if (typeof stayNights !== "number" || !Number.isInteger(stayNights) || stayNights < 0 || stayNights > 3650) throw new Error(`Row ${index + 1} stay nights is invalid.`);
    if (typeof row.reserved !== "boolean") throw new Error(`Row ${index + 1} reserved value is invalid.`);
    return {
      room,
      checkout_date: isoDate(row.checkout_date, `Row ${index + 1} checkout date`),
      checkout_time: text(row.checkout_time, `Row ${index + 1} checkout time`, 80),
      room_status: text(row.room_status, `Row ${index + 1} room status`, 200),
      arrival_date: isoDate(row.arrival_date, `Row ${index + 1} arrival date`),
      arrival_time: text(row.arrival_time, `Row ${index + 1} arrival time`, 80),
      move_from: row.move_from ? roomNumber(row.move_from, `Row ${index + 1} move-from room`) : "",
      move_to: row.move_to ? roomNumber(row.move_to, `Row ${index + 1} move-to room`) : "",
      room_type: text(row.room_type, `Row ${index + 1} room type`, 80),
      guest_arrival_date: "",
      stay_nights: stayNights,
      reserved: row.reserved,
    };
  });
  return { report_date: reportDate, rows };
}