export type KpiFilter = "open" | "progress" | "priority" | "overdue" | "all";

export type KpiWorkOrder = {
  status?: string | null;
  priority?: string | null;
  due_by?: string | null;
};

function normalizeStatus(value?: string | null) {
  return (value || "Open").trim().toLowerCase();
}

function isOpenStatus(value?: string | null) {
  return !["pending verification", "completed", "will not do", "duplicate", "closed", "cancelled", "canceled"].includes(normalizeStatus(value));
}

function isOverdue(value?: string | null) {
  if (!value) return false;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return date < today;
}

export function filterKpiWorkOrders<T extends KpiWorkOrder>(orders: T[], filter: KpiFilter, now = new Date()): T[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return orders.filter((order) => {
    const status = normalizeStatus(order.status);
    const open = isOpenStatus(order.status);
    if (filter === "all") return true;
    if (filter === "open") return open;
    if (filter === "progress") return open && status === "in progress";
    if (filter === "priority") return open && ["urgent", "high"].includes(String(order.priority || "").toLowerCase());
    if (filter === "overdue") {
      if (!order.due_by) return false;
      const date = new Date(`${String(order.due_by).slice(0, 10)}T12:00:00`);
      if (Number.isNaN(date.getTime())) return false;
      date.setHours(0, 0, 0, 0);
      return open && date < today;
    }
    return false;
  });
}

export { isOpenStatus, isOverdue };
