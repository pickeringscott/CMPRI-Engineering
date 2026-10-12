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

export function canReadWorkOrder(reader: WorkOrderReader, row: {
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

/** Applied before pagination/limits. Hotel scope must also be applied by the caller. */
export function workOrderReadFilter(reader: WorkOrderReader): string | null {
  if (!reader.canRead || !/^[0-9a-f-]{36}$/i.test(reader.userId)) return "id.is.null";
  if (reader.canViewAllStatuses && !reader.technician) return null;
  const clauses = [`status.in.(Open,In Progress)`, `and(status.eq.Closed,created_by.eq.${reader.userId})`];
  if (reader.canViewAllStatuses && reader.technician) {
    clauses.push("technician_name.is.null", 'technician_name.eq.""');
    if (reader.technicianName) clauses.push(`technician_name.eq.${JSON.stringify(reader.technicianName)}`);
  }
  return clauses.join(",");
}
