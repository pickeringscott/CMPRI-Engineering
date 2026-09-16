import { roleAllows } from "@/lib/server/roles";

/** Compatibility helper: technical mutation access only, never hotel-management-by-title. */
export function canEditEngineeringData(role: unknown) {
  return roleAllows(role, "edit_tickets");
}
