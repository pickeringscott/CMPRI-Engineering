export type RoomHistoryRow = { room: string; periodStart: string; completedOn: string | null; sourceReference: string };
export type RoomHistoryImport = { sourceId: string; sourceName: string; rows: RoomHistoryRow[] };
export type StoredRoomHistory = { room: string; period_start: string; completed_on: string | null; source_name: string; source_reference: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
export function validateRoomHistory(value: unknown, rooms: readonly string[]): RoomHistoryImport {
  const input = object(value);
  const sourceId = text(input.sourceId, "Stable source ID", 160);
  const sourceName = text(input.sourceName, "Source name", 300);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 2000) throw new Error("Provide 1–2000 room-quarter records.");
  const keys = new Set<string>();
  const rows = input.rows.map((value): RoomHistoryRow => {
    const row = object(value);
    const room = text(row.room, "Room", 4);
    if (!rooms.includes(room)) throw new Error(`Room ${room} is not in the PM room catalog.`);
    const periodStart = text(row.periodStart, "Quarter start", 10);
    if (!/^20\d{2}-(01|04|07|10)-01$/.test(periodStart)) throw new Error(`Room ${room}: use the first date of the intended quarter.`);
    const completedOn = row.completedOn;
    if (completedOn !== null) {
      if (typeof completedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(completedOn)) throw new Error(`Room ${room}: completion date must be YYYY-MM-DD or explicit null for unknown.`);
      const date = new Date(`${completedOn}T12:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== completedOn
        || completedOn.slice(0, 4) !== periodStart.slice(0, 4)
        || Math.floor((Number(completedOn.slice(5, 7)) - 1) / 3) !== Math.floor((Number(periodStart.slice(5, 7)) - 1) / 3)) throw new Error(`Room ${room}: completion date must be a real date within its intended quarter.`);
    }
    const key = `${room}|${periodStart}`;
    if (keys.has(key)) throw new Error(`Duplicate room-quarter ${key} in this file.`);
    keys.add(key);
    return { room, periodStart, completedOn, sourceReference: text(row.sourceReference, "Source page or reconciliation reference", 1000) };
  }).sort((a, b) => `${a.periodStart}|${a.room}`.localeCompare(`${b.periodStart}|${b.room}`));
  return { sourceId, sourceName, rows };
}

export function roomCompletion(history: StoredRoomHistory | undefined, entry: { status?: string; completed_on?: string | null; is_complete?: boolean } | undefined, workbookDate = "") {
  if (history) return { complete: true, date: history.completed_on || "", status: "Complete (historical)" };
  if (entry?.status === "pending" || entry?.status === "processing") return { complete: false, date: entry.completed_on || "", status: "Pending review" };
  if (entry?.status === "approved" && (entry.is_complete || entry.completed_on)) return { complete: true, date: entry.completed_on || "", status: "Complete" };
  if (workbookDate) return { complete: true, date: workbookDate, status: "Complete" };
  return { complete: false, date: "", status: "Due" };
}
