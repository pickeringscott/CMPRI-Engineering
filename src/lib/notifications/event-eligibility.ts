import { profileAllows, profileIsChiefEngineer, profileIsEstablishedHoursChief, profileHasRole, receivesPoolClosedNotifications, receivesWorkOrderNotifications } from "@/lib/server/roles";
import type { WebPushEligibleProfile } from "@/lib/notifications/schedule";

// Phone delivery uses the same per-event recipient policy as the existing inbox.
// A manager's pool alert never authorizes ordinary work-order alerts.
export function receivesEventPush(profile: WebPushEligibleProfile, notification: { id: string; work_order_id?: string | null }) {
  // Room-rank notifications are materialized only for their intended recipients.
  if (notification.id.startsWith("room-rank-change:") || notification.id.startsWith("room-rank-urgent:")) return true;
  // These private, database-targeted events already identify the Chief Engineer,
  // assigned technician and original submitter. Keep every other event's policy.
  if (notification.id.startsWith("work-order-note:") || notification.id.startsWith("work-order-status:")) return Boolean(notification.work_order_id);
  if (notification.id.startsWith("work-order-mention:")) return !profileHasRole(profile, "front_desk") && profileAllows(profile, "add_work_order_notes");
  if (notification.id.startsWith("staff-note:")) return !profileHasRole(profile, "front_desk") && ["engineer", "technician", "manager", "assistant_manager", "front_desk_manager", "housekeeping", "system_admin"].some(role => profileHasRole(profile, role as Parameters<typeof profileHasRole>[1]));
  if (notification.id.startsWith("report-correction:")) return profileIsChiefEngineer(profile) || profileIsEstablishedHoursChief(profile);
  if (notification.id.startsWith("pool-closed:")) return receivesPoolClosedNotifications(profile);
  if (notification.id.startsWith("room-operations:")) return profileHasRole(profile, "engineer");
  if (notification.work_order_id || notification.id.startsWith("new-order:") || notification.id.startsWith("history:") || notification.id.startsWith("technician-view:")) {
    return receivesWorkOrderNotifications(profile);
  }
  return false;
}
