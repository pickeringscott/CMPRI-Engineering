import { allows, type Principal } from "./access";
import { roleKey } from "./roles";
import type { WorkOrderReader } from "../work-order-read-policy";

export function workOrderReader(principal: Principal): WorkOrderReader {
  return {
    userId: principal.identity.id,
    hotelId: principal.hotelId,
    canRead: allows(principal, "view_work_orders") || allows(principal, "view_dashboard") || allows(principal, "add_work_order_notes"),
    canViewAllStatuses: allows(principal, "view_dashboard") && (allows(principal, "edit_tickets") || allows(principal, "review_tickets")),
    technician: roleKey(principal.profile.role) === "technician",
    technicianName: principal.profile.full_name?.trim() || "",
  };
}
