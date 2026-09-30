type Payload = Record<string, unknown>;
export async function jsonObject(request: { json(): Promise<unknown> }): Promise<Payload | null> {
  try {
    const value = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Payload : null;
  } catch { return null; }
}
const positiveInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown, limit: number, required = false) => typeof value === "string" && value.length <= limit && (!required || !!value.trim()) && !value.trimStart().startsWith("=");

export function rankerUpdate(body: Payload | null): Payload | null {
  if (!body || !positiveInteger(body.rowNumber) || !text(body.expectedRoom, 80, true)) return null;
  const payload: Payload = { action: "update", rowNumber: body.rowNumber, expectedRoom: body.expectedRoom };
  const fields = ["inspectedBy", "check1", "check2", "check3", "rank", "notes"];
  let changes = 0;
  for (const key of fields) {
    if (!(key in body)) continue;
    if (!text(body[key], key === "notes" ? 10000 : 500)) return null;
    if (key === "rank" && !["", "A", "B", "C"].includes(String(body[key]))) return null;
    payload[key] = body[key]; changes++;
  }
  return changes ? payload : null;
}

export function corporatePmUpdate(body: Payload | null): Payload | null {
  if (!body || typeof body.action !== "string") return null;
  const action = body.action.trim().toLowerCase();
  if (action === "setcheckbox") {
    if (!text(body.sheet, 100, true) || !positiveInteger(body.row) || !positiveInteger(body.column) || typeof body.checked !== "boolean") return null;
    if (body.expectedChecked !== undefined && typeof body.expectedChecked !== "boolean") return null;
    return {
      action,
      sheet: String(body.sheet).trim().toUpperCase(),
      row: body.row,
      column: body.column,
      checked: body.checked,
      ...(body.expectedChecked === undefined ? {} : { expectedChecked: body.expectedChecked }),
    };
  }
  if (action !== "completeroompm" && action !== "clearroompm") return null;
  if (!text(body.room, 80, true) || !text(body.quarter, 40, true)) return null;
  const payload: Payload = { action, room: String(body.room).trim(), quarter: String(body.quarter).trim().toUpperCase() };
  if (action === "completeroompm" && body.completedDate !== undefined) {
    if (typeof body.completedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.completedDate)) return null;
    const date = new Date(body.completedDate);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== body.completedDate) return null;
    payload.completedDate = body.completedDate;
  }
  return payload;
}

export function matchesWritablePmCell(snapshot: Payload, payload: Payload) {
  if (snapshot.sheet !== payload.sheet || !Array.isArray(snapshot.values) || !Array.isArray(snapshot.formulas)) return false;
  const row = Number(payload.row) - 1, column = Number(payload.column) - 1;
  const values: unknown = snapshot.values[row], formulas: unknown = snapshot.formulas[row];
  if (!Array.isArray(values) || !Array.isArray(formulas) || formulas[column] !== "") return false;
  return values[column] === "TRUE" || values[column] === "FALSE" || typeof values[column] === "boolean";
}
