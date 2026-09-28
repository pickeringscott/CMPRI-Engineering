import { roleKey } from "./roles";

export function canAccessWorkOrderByAssignment(
  role: unknown,
  profileName: string | null | undefined,
  workOrder: { technician_name?: unknown },
) {
  if (roleKey(role) !== "technician") return true;
  const technicianName = typeof profileName === "string" ? profileName.trim() : "";
  const assignedName = typeof workOrder.technician_name === "string" ? workOrder.technician_name.trim() : "";
  return Boolean(technicianName && assignedName && technicianName === assignedName);
}