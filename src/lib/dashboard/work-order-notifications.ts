import type { CmpriRole } from "@/lib/server/roles";

export type WorkOrderHistoryNotification = {
  id: string;
  work_order_id: string;
  actor_user_id: string | null;
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

type ActorProfile = {
  full_name: string | null;
  role: string;
};

export type WorkOrderNotificationRole = "engineer" | "technician";

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function orderLabel(snapshot: Record<string, unknown>) {
  const displayId = typeof snapshot.display_id === "string" ? snapshot.display_id.trim() : "";
  return displayId || "Work order";
}

function isTechnicianRole(value: string) {
  const role = value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return role === "technician" || role === "maintenancetechnician";
}

export function workOrderNotificationsForRecipient(
  events: WorkOrderHistoryNotification[],
  recipient: NotificationRecipient,
  actorProfiles: ReadonlyMap<string, ActorProfile>,
): WorkOrderNotification[] {
  const notifications: WorkOrderNotification[] = [];
  for (const event of events) {
    const snapshot = event.snapshot || {};
    const order = orderLabel(snapshot);
    if (recipient.role === "engineer" && event.old_status && event.old_status !== event.new_status && event.new_status) {
      notifications.push({
        id: event.id,
        work_order_id: event.work_order_id,
        message: `${order} status changed: ${event.old_status || "—"} → ${event.new_status}`,
        recorded_at: event.recorded_at,
      });
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(event.changed_fields || {}, "technician_name")) continue;
    const technicianName = typeof snapshot.technician_name === "string" ? snapshot.technician_name.trim() : "";
    if (!technicianName) continue;

    if (recipient.role === "technician" &&
      cleanName(technicianName) === cleanName(recipient.name) &&
      event.actor_user_id !== recipient.id) {
      notifications.push({
        id: event.id,
        work_order_id: event.work_order_id,
        message: `${order} was assigned to you.`,
        recorded_at: event.recorded_at,
      });
      continue;
    }

    if (recipient.role === "engineer" && event.actor_user_id) {
      const actor = actorProfiles.get(event.actor_user_id);
      if (actor && isTechnicianRole(actor.role) &&
        cleanName(actor.full_name) !== "" &&
        cleanName(actor.full_name) === cleanName(technicianName)) {
        notifications.push({
          id: event.id,
          work_order_id: event.work_order_id,
          message: `${order} was claimed by ${actor.full_name?.trim()}.`,
          recorded_at: event.recorded_at,
        });
      }
    }
  }
  return notifications;
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

export function unseenWorkOrderNotifications(
  seenIds: Set<string>,
  incoming: WorkOrderNotification[],
) {
  const unseen = incoming.filter((notification) => !seenIds.has(notification.id));
  unseen.forEach((notification) => seenIds.add(notification.id));
  return unseen;
}
