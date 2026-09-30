import type { CmpriRole } from "@/lib/server/roles";

export type WorkOrderHistoryNotification = {
  id: string;
  work_order_id: string;
  actor_user_id: string | null;
  actor_name?: string | null;
  event_type?: string | null;
  old_status: string | null;
  new_status: string | null;
  changed_fields: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  recorded_at: string;
};

export type WorkOrderNotification = {
  id: string;
  work_order_id: string;
  message: string;
  recorded_at: string;
};

export type WorkOrderNotificationResponse = {
  notifications: WorkOrderNotification[];
  resolved_notification_ids: string[];
  checked_at: string;
};

export type WorkOrderTechnicianView = {
  id: string;
  work_order_id: string;
  work_order_display_id: string;
  technician_name: string;
  viewed_at: string;
};

type NotificationRecipient = {
  id: string;
  name: string;
  role: CmpriRole;
};

export type WorkOrderNotificationRole = "engineer" | "technician";

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function orderLabel(snapshot: Record<string, unknown>) {
  const displayId = typeof snapshot.display_id === "string" ? snapshot.display_id.trim() : "";
  return displayId || "Work order";
}

function isEngineerRole(value: unknown) {
  const role = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
  return ["engineer", "chiefengineer", "systemadmin", "systemadministrator", "administrator", "admin"].includes(role);
}

function changedText(event: WorkOrderHistoryNotification, key: string) {
  const value = event.changed_fields?.[key];
  return typeof value === "string" ? value.trim() : "";
}

const STATUS_EVENTS = new Set(["status_changed", "closed", "reopened"]);

/** Engineer inbox: every status change and claim made by someone else. */
export function engineerHistoryNotifications(
  events: WorkOrderHistoryNotification[],
  recipientId: string,
): WorkOrderNotification[] {
  const notifications: WorkOrderNotification[] = [];
  for (const event of events) {
    if (event.actor_user_id && event.actor_user_id === recipientId) continue;
    const order = orderLabel(event.snapshot || {});
    const who = event.actor_name?.trim() || "System";
    let message = "";
    if (STATUS_EVENTS.has(event.event_type || "") && event.new_status) {
      message = `${order} status changed: ${event.old_status || "—"} → ${event.new_status} by ${who}.`;
    } else if (event.event_type === "claimed") {
      message = `${order} was claimed by ${changedText(event, "technician_name") || who}.`;
    }
    if (message) {
      notifications.push({ id: `history:${event.id}`, work_order_id: event.work_order_id, message, recorded_at: event.recorded_at });
    }
  }
  return notifications;
}

/** Technician alerts: work assigned to them by someone else, and any ticket an engineer claims. */
export function technicianHistoryNotifications(
  events: WorkOrderHistoryNotification[],
  recipient: { id: string; name: string },
): WorkOrderNotification[] {
  const notifications: WorkOrderNotification[] = [];
  for (const event of events) {
    if (event.actor_user_id && event.actor_user_id === recipient.id) continue;
    const order = orderLabel(event.snapshot || {});
    const technician = changedText(event, "technician_name");
    let message = "";
    if ((event.event_type === "assigned" || event.event_type === "claimed") &&
      technician && cleanName(technician) === cleanName(recipient.name)) {
      message = event.changed_fields?.after_close === true
        ? `${order} was reopened and reassigned to you.`
        : `${order} was assigned to you.`;
    } else if (event.event_type === "claimed" && isEngineerRole(event.changed_fields?.actor_role)) {
      message = `${order}: Claimed by Engineer`;
    }
    if (message) {
      notifications.push({ id: event.id, work_order_id: event.work_order_id, message, recorded_at: event.recorded_at });
    }
  }
  return notifications;
}

export function workOrderNotificationsForRecipient(
  events: WorkOrderHistoryNotification[],
  recipient: NotificationRecipient,
): WorkOrderNotification[] {
  if (recipient.role === "engineer") return engineerHistoryNotifications(events, recipient.id);
  if (recipient.role === "technician") return technicianHistoryNotifications(events, recipient);
  return [];
}

export function technicianViewNotificationsForEngineer(
  views: WorkOrderTechnicianView[],
): WorkOrderNotification[] {
  return views.flatMap((view) => {
    return [{
      id: `technician-view:${view.id}`,
      work_order_id: view.work_order_id,
      message: `${orderLabel({ display_id: view.work_order_display_id })} viewed awaiting satisfying.`,
      recorded_at: view.viewed_at,
    }];
  });
}

export function workOrderNotificationCursorKey(userId: string, role: WorkOrderNotificationRole) {
  return `cmpri:work-order-notifications:v2:${role}:${userId}`;
}

function legacyCursorKey(userId: string) {
  return `cmpri:work-order-notifications:v1:${userId}`;
}

export function readWorkOrderNotificationCursor(userId: string, role: WorkOrderNotificationRole) {
  try {
    const saved = window.localStorage.getItem(workOrderNotificationCursorKey(userId, role))
      || window.localStorage.getItem(legacyCursorKey(userId));
    if (saved && Number.isFinite(Date.parse(saved))) return saved;
  } catch {}
  return new Date().toISOString();
}

export function saveWorkOrderNotificationCursor(userId: string, role: WorkOrderNotificationRole, cursor: string) {
  try {
    window.localStorage.setItem(workOrderNotificationCursorKey(userId, role), cursor);
  } catch {}
}

function dismissedViewNotificationsKey(userId: string) {
  return `cmpri:work-order-view-notifications-dismissed:v1:engineer:${userId}`;
}

export function readDismissedWorkOrderViewNotifications(userId: string) {
  try {
    const saved = window.localStorage.getItem(dismissedViewNotificationsKey(userId));
    const parsed: unknown = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      return new Set(parsed);
    }
  } catch {}
  return new Set<string>();
}

export function saveDismissedWorkOrderViewNotifications(userId: string, notificationIds: Iterable<string>) {
  try {
    window.localStorage.setItem(
      dismissedViewNotificationsKey(userId),
      JSON.stringify(Array.from(new Set(notificationIds))),
    );
  } catch {}
}

export async function fetchWorkOrderNotifications(
  accessToken: string,
  since: string,
): Promise<WorkOrderNotificationResponse> {
  const response = await fetch(`/api/work-orders/notifications?since=${encodeURIComponent(since)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as Partial<WorkOrderNotificationResponse> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Work-order notifications could not be loaded.");
  if (
    !Array.isArray(payload.notifications) ||
    !Array.isArray(payload.resolved_notification_ids) ||
    !payload.resolved_notification_ids.every((id) => typeof id === "string") ||
    typeof payload.checked_at !== "string" ||
    !Number.isFinite(Date.parse(payload.checked_at))
  ) {
    throw new Error("Work-order notifications returned an invalid response.");
  }
  return {
    notifications: payload.notifications,
    resolved_notification_ids: payload.resolved_notification_ids,
    checked_at: payload.checked_at,
  };
}

export function mergeWorkOrderNotifications(
  existing: WorkOrderNotification[],
  incoming: WorkOrderNotification[],
) {
  return Array.from(new Map(
    [...existing, ...incoming].map((notification) => [notification.id, notification]),
  ).values());
}

export function dashboardInboxKey(userId: string) {
  return `cmpri:dashboard-notification-inbox:v1:${userId}`;
}

function isNotification(value: unknown): value is WorkOrderNotification {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["id", "work_order_id", "message", "recorded_at"].every((key) => typeof item[key] === "string");
}

function byNewest(a: WorkOrderNotification, b: WorkOrderNotification) {
  return (Date.parse(b.recorded_at) || 0) - (Date.parse(a.recorded_at) || 0);
}

export function readDashboardInbox(userId: string): WorkOrderNotification[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(dashboardInboxKey(userId)) || "[]");
    if (Array.isArray(parsed)) return parsed.filter(isNotification).sort(byNewest);
  } catch {}
  return [];
}

/** Removes the pre-server (per-browser) inbox, dismissals and cursor once they are imported. */
export function forgetLocalDashboardInbox(userId: string) {
  try {
    window.localStorage.removeItem(dashboardInboxKey(userId));
    window.localStorage.removeItem(dismissedViewNotificationsKey(userId));
    window.localStorage.removeItem(workOrderNotificationCursorKey(userId, "engineer"));
  } catch {}
}

export const DASHBOARD_NOTIFICATION_POLL_MS = 1_000;
/** Re-scan window so rows committed late (created_at is the transaction start) are never missed. */
export const DASHBOARD_NOTIFICATION_OVERLAP_MS = 5 * 60_000;
/** The server cursor is written at most this often; the overlap window covers the gap. */
export const DASHBOARD_NOTIFICATION_CURSOR_WRITE_MS = 60_000;
export const DASHBOARD_NOTIFICATION_KEY_MAX = 200;
export const DASHBOARD_NOTIFICATION_MESSAGE_MAX = 500;
export const DASHBOARD_NOTIFICATION_IMPORT_MAX = 200;

export type DashboardInboxResponse = {
  notifications: WorkOrderNotification[];
  orders_version: string;
  checked_at: string;
};

/** Where the server starts scanning for new events. A first-ever poll starts now instead of replaying history. */
export function dashboardNotificationScanStart(savedCursor: string | null | undefined, nowIso: string) {
  const saved = savedCursor ? Date.parse(savedCursor) : NaN;
  if (!Number.isFinite(saved)) return nowIso;
  return new Date(Math.min(saved, Date.parse(nowIso)) - DASHBOARD_NOTIFICATION_OVERLAP_MS).toISOString();
}

export function shouldWriteDashboardNotificationCursor(savedCursor: string | null | undefined, nowIso: string) {
  const saved = savedCursor ? Date.parse(savedCursor) : NaN;
  return !Number.isFinite(saved) || Date.parse(nowIso) - saved >= DASHBOARD_NOTIFICATION_CURSOR_WRITE_MS;
}

/** Keys not yet recorded for this recipient (cleared ones included, so a cleared item never returns). */
export function unrecordedDashboardNotifications(
  candidates: WorkOrderNotification[],
  recordedKeys: Iterable<string>,
) {
  const known = new Set(recordedKeys);
  return candidates.filter((notification) => {
    if (known.has(notification.id)) return false;
    known.add(notification.id);
    return true;
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates notifications a browser asks to import from its old local inbox. */
export function sanitizeImportedDashboardNotifications(value: unknown): WorkOrderNotification[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const accepted: WorkOrderNotification[] = [];
  for (const item of value.slice(0, DASHBOARD_NOTIFICATION_IMPORT_MAX)) {
    if (!isNotification(item)) continue;
    const id = item.id.trim();
    const message = item.message.trim();
    if (!/^(new-order|technician-view):/.test(id) || id.length > DASHBOARD_NOTIFICATION_KEY_MAX || seen.has(id)) continue;
    if (!UUID_PATTERN.test(item.work_order_id) || !message || !Number.isFinite(Date.parse(item.recorded_at))) continue;
    seen.add(id);
    accepted.push({
      id,
      work_order_id: item.work_order_id,
      message: message.slice(0, DASHBOARD_NOTIFICATION_MESSAGE_MAX),
      recorded_at: new Date(Date.parse(item.recorded_at)).toISOString(),
    });
  }
  return accepted;
}

export function sortDashboardNotifications(notifications: WorkOrderNotification[]) {
  return [...notifications].sort(byNewest);
}

export async function fetchDashboardInbox(accessToken: string): Promise<DashboardInboxResponse> {
  const response = await fetch("/api/dashboard/notifications", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({})) as Partial<DashboardInboxResponse> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Notifications could not be loaded.");
  if (
    !Array.isArray(payload.notifications) ||
    !payload.notifications.every(isNotification) ||
    typeof payload.orders_version !== "string" ||
    typeof payload.checked_at !== "string"
  ) {
    throw new Error("Notifications returned an invalid response.");
  }
  return {
    notifications: sortDashboardNotifications(payload.notifications),
    orders_version: payload.orders_version,
    checked_at: payload.checked_at,
  };
}

async function postDashboardInbox(accessToken: string, body: Record<string, unknown>, fallback: string) {
  const response = await fetch("/api/dashboard/notifications", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || fallback);
  }
}

export function clearServerDashboardNotifications(accessToken: string, ids: string[]) {
  return postDashboardInbox(accessToken, { action: "clear", ids }, "Notifications could not be cleared.");
}

export function importServerDashboardNotifications(accessToken: string, notifications: WorkOrderNotification[]) {
  return postDashboardInbox(accessToken, { action: "import", notifications }, "Saved notifications could not be moved to your account.");
}

export function newWorkOrderNotification(order: {
  id: string;
  display_id?: string | null;
  room?: string | null;
  issue?: string | null;
  created_at?: string | null;
}): WorkOrderNotification {
  const label = order.display_id?.trim() || "Work order";
  const location = order.room?.trim() || "No location";
  const issue = order.issue?.trim();
  return {
    id: `new-order:${order.id}`,
    work_order_id: order.id,
    message: `New ${label}: ${location}${issue ? ` — ${issue}` : ""}`,
    recorded_at: order.created_at && Number.isFinite(Date.parse(order.created_at)) ? order.created_at : new Date().toISOString(),
  };
}

export function unseenWorkOrderNotifications(
  seenIds: Set<string>,
  incoming: WorkOrderNotification[],
) {
  const unseen = incoming.filter((notification) => !seenIds.has(notification.id));
  unseen.forEach((notification) => seenIds.add(notification.id));
  return unseen;
}
