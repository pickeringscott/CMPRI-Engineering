/** Additive ticket reads. Drafts and pending approval are never treated as active. */
export const ACTIVE_WORK_ORDER_STATUSES = ["Open", "In Progress"] as const;

export type WorkOrderReader = {
  userId: string;
  hotelId: string;
  canRead: boolean;
  canViewAllStatuses: boolean;
  technician: boolean;
  technicianName: string;
};

/** All ticket states are readable by active members of the ticket's hotel. */
export function canReadWorkOrder(reader: WorkOrderReader, row: { hotel_id: string }) {
  return Boolean(reader.canRead && reader.userId && reader.hotelId && row.hotel_id === reader.hotelId);
}

/** Preserve the pre-expansion row eligibility wherever reads gate a mutation. */
export function canReadWorkOrderForMutation(reader: WorkOrderReader, row: {
  hotel_id: string;
  status?: unknown;
  created_by?: unknown;
  technician_name?: unknown;
}) {
  if (!reader.canRead || !reader.userId || row.hotel_id !== reader.hotelId) return false;
  if (ACTIVE_WORK_ORDER_STATUSES.some((status) => status === row.status)) return true;
  if (row.status === "Closed" && row.created_by === reader.userId) return true;
  // Preserve the pre-existing technical detail access, including assignment checks.
  const assigned = typeof row.technician_name === "string" ? row.technician_name.trim() : "";
  return reader.canViewAllStatuses && (!reader.technician || !assigned || (!!reader.technicianName && assigned === reader.technicianName));
}

/** Hotel scope must also be applied by the caller, before pagination. */
export function workOrderReadFilter(reader: WorkOrderReader): string | null {
  return reader.canRead && reader.hotelId && /^[0-9a-f-]{36}$/i.test(reader.userId) ? null : "id.is.null";
}
