export type WorkOrderFormTarget = { templateId: string; periodStart: string; scopeKey: string };

/** Recognize only a complete guest-room label present in the PM room catalog. */
export function pmRoomNumber(value: unknown, roomNumbers: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const room = value.trim().match(/^(?:room\s+)?(\d{2,4})$/i)?.[1];
  return room && roomNumbers.includes(room) ? room : null;
}

/** Prefer the explicitly linked form; otherwise only guest-room numbers identify a unique form. */
export function workOrderFormTarget(
  linked: WorkOrderFormTarget | null,
  location: { name: string; room_number: string | null } | undefined,
  roomNumbers: readonly string[],
  roomTemplateId: string,
  currentQuarter: string,
  workOrderRoom?: string | null,
): WorkOrderFormTarget | null {
  if (linked) return linked;
  const room = pmRoomNumber(location?.room_number, roomNumbers)
    || pmRoomNumber(location?.name, roomNumbers)
    || pmRoomNumber(workOrderRoom, roomNumbers);
  return room
    ? { templateId: roomTemplateId, periodStart: currentQuarter, scopeKey: `room:${room}` }
    : null;
}
