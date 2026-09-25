export type KpiFilter = "open" | "progress" | "priority" | "overdue" | "all";

export type KpiWorkOrder = {
  status?: string | null;
  priority?: string | null;
  due_by?: string | null;
};

export function normalizeKpiStatus(value?: string | null) {
  return (value || "Open").trim();
}

export function isOpenKpiStatus(value?: string | null) {
  const status = normalizeKpiStatus(value).toLowerCase();
  return !["pending verification", "completed", "will not do", "duplicate", "closed", "cancelled", "canceled"].includes(status);
}

export function isKpiOverdue(value?: string | null, now = new Date()) {
  if (!value) return false;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date < today;
}

export function filterKpiWorkOrders<T extends KpiWorkOrder>(orders: T[], filter: KpiFilter, now = new Date()): T[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return orders.filter((order) => {
    const status = normalizeKpiStatus(order.status).toLowerCase();
    const open = isOpenKpiStatus(order.status);
    if (filter === "all") return true;
    if (filter === "open") return open;
    if (filter === "progress") return open && status === "in progress";
    if (filter === "priority") return open && ["urgent", "high"].includes(String(order.priority || "").toLowerCase());
    if (filter === "overdue") {
      if (!order.due_by) return false;
      return open && isKpiOverdue(order.due_by, today);
    }
    return false;
  });
}

export const isOpenStatus = isOpenKpiStatus;
export const isOverdue = isKpiOverdue;
