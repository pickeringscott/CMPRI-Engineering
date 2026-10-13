import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { profileHasRole, profileIsChiefEngineerOrSystemAdmin, receivesWorkOrderNotifications } from "@/lib/server/roles";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";
import { dispatchDuePhoneNotificationTests } from "@/lib/server/phone-notification-tests";
import {
  dashboardNotificationScanStart,
  engineerHistoryNotifications,
  markTechnicianViewedWorkOrdersRead,
  newWorkOrderNotification,
  shouldWriteDashboardNotificationCursor,
  technicianHistoryNotifications,
  technicianViewNotificationsForEngineer,
  unrecordedDashboardNotifications,
  type WorkOrderHistoryNotification,
  type WorkOrderNotification,
  type WorkOrderTechnicianView,
} from "@/lib/dashboard/work-order-notifications";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;
const MAX_SCAN = 10_000;

type PushProfile = {
  id: string;
  role: string;
  secondary_roles?: string[];
  full_name: string | null;
};

async function scanPages<T>(load: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>) {
  const rows: T[] = [];
  for (let offset = 0; offset < MAX_SCAN; offset += PAGE_SIZE) {
    const { data, error } = await load(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("Notification events could not be checked.");
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new Error("Too many notification events are pending; review the dashboard before retrying.");
}

async function saveInboxRows(
  admin: SupabaseClient,
  profile: PushProfile,
  notifications: WorkOrderNotification[],
) {
  if (!notifications.length) return;
  const userId = profile.id;
  const recordedKeys: string[] = [];
  for (let index = 0; index < notifications.length; index += 200) {
    const keys = notifications.slice(index, index + 200).map((notification) => notification.id);
    const { data, error } = await admin.from("cmpri_dashboard_notifications")
      .select("notification_key")
      .eq("hotel_id", HOTEL_ID)
      .eq("recipient_user_id", userId)
      .in("notification_key", keys);
    if (error) throw new Error("Dashboard notifications could not be checked.");
    recordedKeys.push(...(data || []).map((row: { notification_key: string }) => row.notification_key));
  }
  const missing = unrecordedDashboardNotifications(notifications, recordedKeys);
  if (!missing.length) return;
  const { error } = await admin.from("cmpri_dashboard_notifications")
    .upsert(missing.map((notification) => ({
      hotel_id: HOTEL_ID,
      recipient_user_id: userId,
      notification_key: notification.id,
      work_order_id: notification.work_order_id,
      target_path: notification.target_path || null,
      message: notification.message,
      recorded_at: notification.recorded_at,
      push_requested: true,
      read_at: !profileIsChiefEngineerOrSystemAdmin(profile)
        && profileHasRole(profile, "technician")
        && notification.is_read
        ? notification.recorded_at
        : null,
    })), { onConflict: "hotel_id,recipient_user_id,notification_key", ignoreDuplicates: true });
  if (error) throw new Error("Dashboard notifications could not be saved.");
}

async function notificationsForUser(
  admin: SupabaseClient,
  profile: PushProfile,
  savedCursor: string,
  checkedAt: string,
) {
  const role = profileIsChiefEngineerOrSystemAdmin(profile) ? "engineer" : "technician";
  const start = dashboardNotificationScanStart(savedCursor, checkedAt);
  const orders = await scanPages<{ id: string; display_id: string | null; room: string | null; issue: string | null; status: string | null; created_at: string }>(
    (from, to) => admin.from("work_orders")
      .select("id, display_id, room, issue, status, created_at")
      .eq("hotel_id", HOTEL_ID)
      .gt("created_at", start)
      .lte("created_at", checkedAt)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  let dashboard: WorkOrderNotification[] = orders.map(newWorkOrderNotification);
  let technicianHistory: WorkOrderNotification[] = [];
  if (role === "technician" && orders.length) {
    const { data: views, error } = await admin.from("cmpri_work_order_technician_views")
      .select("work_order_id")
      .eq("hotel_id", HOTEL_ID)
      .in("work_order_id", orders.map((order) => order.id));
    if (error) throw new Error("Technician work-order views could not be checked.");
    dashboard = markTechnicianViewedWorkOrdersRead(
      dashboard,
      (views || []).map((view: { work_order_id: string }) => view.work_order_id),
    );
  }

  const history = await scanPages<WorkOrderHistoryNotification>(
    (from, to) => admin.from("cmpri_work_order_history")
      .select("id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, recorded_at")
      .eq("hotel_id", HOTEL_ID)
      .gt("recorded_at", start)
      .lte("recorded_at", checkedAt)
      .order("recorded_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (role === "engineer") {
    dashboard.push(...engineerHistoryNotifications(history.filter((event) =>
      ["status_changed", "closed", "reopened", "claimed"].includes(event.event_type || ""),
    ), profile.id));
    const views = await scanPages<WorkOrderTechnicianView>(
      (from, to) => admin.from("cmpri_work_order_technician_views")
        .select("id, work_order_id, work_order_display_id, technician_name, viewed_at")
        .eq("hotel_id", HOTEL_ID)
        .gt("viewed_at", start)
        .lte("viewed_at", checkedAt)
        .order("viewed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    dashboard.push(...technicianViewNotificationsForEngineer(views));
  } else if (role === "technician") {
    technicianHistory = technicianHistoryNotifications(history, {
      id: profile.id,
      name: profile.full_name || "",
    });
  }
  return { dashboard, technicianHistory };
}

async function dispatchPendingInboxNotifications(admin: SupabaseClient, profile: PushProfile) {
  // New intent survives later reads/clears. Legacy retries keep their original
  // unread-only behavior; no historical inbox rows are enrolled on recovery.
  const deliveries = await scanPages<{ notification_key: string; inbox_id: string | null }>(
    (from, to) => admin.from("cmpri_web_push_deliveries")
      .select("notification_key, inbox_id")
      .eq("hotel_id", HOTEL_ID).eq("recipient_user_id", profile.id)
      .in("status", ["pending", "sending", "suppressed", "failed"])
      .order("id").range(from, to),
  );
  const durableKeys = new Set(deliveries.filter((row) => row.inbox_id).map((row) => row.notification_key));
  const keys = Array.from(new Set(deliveries.map((row) => row.notification_key)));
  let count = 0;
  for (let index = 0; index < keys.length; index += 200) {
    const { data: rows, error } = await admin.from("cmpri_dashboard_notifications")
      .select("notification_key, work_order_id, target_path, message, recorded_at, read_at, cleared_at")
      .eq("hotel_id", HOTEL_ID).eq("recipient_user_id", profile.id)
      .in("notification_key", keys.slice(index, index + 200));
    if (error) throw new Error("Pending phone notification messages could not be loaded.");
    const notifications = (rows || []).filter((row) =>
      durableKeys.has(row.notification_key) || (!row.read_at && !row.cleared_at),
    ).map((row) => ({ ...row, id: row.notification_key }));
    await dispatchWebPushNotifications(admin, profile.id, profile, notifications);
    count += notifications.length;
  }
  return count;
}

async function dispatch(admin: SupabaseClient) {
  const { data: subscriptions, error: subscriptionError } = await admin.from("cmpri_web_push_subscriptions")
    .select("recipient_user_id")
    .eq("hotel_id", HOTEL_ID)
    .eq("enabled", true);
  if (subscriptionError) throw new Error("Phone notification subscribers could not be loaded.");
  const userIds = Array.from(new Set((subscriptions || []).map((row: { recipient_user_id: string }) => row.recipient_user_id)));
  if (!userIds.length) return { users: 0, notifications: 0 };

  const [{ data: profiles, error: profilesError }, { data: memberships, error: membershipError }] = await Promise.all([
    admin.from("profiles").select("id, role, secondary_roles, full_name, active").eq("active", true).in("id", userIds),
    admin.from("hotel_members").select("user_id").eq("hotel_id", HOTEL_ID).eq("active", true).in("user_id", userIds),
  ]);
  if (profilesError || membershipError) throw new Error("Phone notification recipients could not be verified.");
  const activeMembers = new Set((memberships || []).map((row: { user_id: string }) => row.user_id));
  const recipients = ((profiles || []) as PushProfile[]).filter((profile) =>
    activeMembers.has(profile.id),
  );
  const checkedAt = new Date().toISOString();
  let notificationCount = 0;

  for (const profile of recipients) {
    await dispatchPendingInboxNotifications(admin, profile);
    if (!receivesWorkOrderNotifications(profile)) continue;
    const { data: cursorRow, error: cursorError } = await admin.from("cmpri_dashboard_notification_cursors")
      .select("checked_at")
      .eq("hotel_id", HOTEL_ID)
      .eq("recipient_user_id", profile.id)
      .maybeSingle();
    if (cursorError) throw new Error("Phone notification scan cursor could not be loaded.");
    const savedCursor = (cursorRow as { checked_at?: string } | null)?.checked_at;
    if (!savedCursor) {
      const { error } = await admin.from("cmpri_dashboard_notification_cursors")
        .upsert({ hotel_id: HOTEL_ID, recipient_user_id: profile.id, checked_at: checkedAt, updated_at: checkedAt }, { onConflict: "hotel_id,recipient_user_id", ignoreDuplicates: true });
      if (error) throw new Error("Phone notification scan cursor could not be initialized.");
      continue;
    }

    const candidates = await notificationsForUser(admin, profile, savedCursor, checkedAt);
    const allNotifications = [...candidates.dashboard, ...candidates.technicianHistory];
    await saveInboxRows(admin, profile, allNotifications);
    notificationCount += candidates.dashboard.length + candidates.technicianHistory.length;
    try {
      await dispatchWebPushNotifications(admin, profile.id, profile, allNotifications.filter((notification) =>
        profileIsChiefEngineerOrSystemAdmin(profile)
        || !profileHasRole(profile, "technician")
        || !notification.is_read,
      ));
    } catch (error) {
      console.error(`Existing notifications were retained, but phone delivery failed for user ${profile.id}.`, error);
    }
    if (shouldWriteDashboardNotificationCursor(savedCursor, checkedAt)) {
      const { error } = await admin.from("cmpri_dashboard_notification_cursors")
        .upsert({ hotel_id: HOTEL_ID, recipient_user_id: profile.id, checked_at: checkedAt, updated_at: checkedAt }, { onConflict: "hotel_id,recipient_user_id" });
      if (error) throw new Error("Phone notification scan cursor could not be advanced.");
    }
  }
  return { users: recipients.length, notifications: notificationCount };
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    console.warn("Scheduled phone notification dispatch authorization failed.", {
      cronSecretConfigured: Boolean(secret),
      authorizationPresent: Boolean(authorization),
      bearerAuthorization: authorization?.startsWith("Bearer ") ?? false,
      cronSchedulePresent: Boolean(request.headers.get("x-vercel-cron-schedule")),
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Notification service credentials are unavailable." }, { status: 503 });
  try {
    // Isolated explicit test queue; never replay the normal inbox to run a test.
    try { await dispatchDuePhoneNotificationTests(admin); }
    catch { console.error("Explicit phone notification tests could not be checked."); }
    return NextResponse.json({ ok: true, ...(await dispatch(admin)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Scheduled phone notification dispatch failed.", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Phone notifications could not be dispatched." }, { status: 503 });
  }
}
