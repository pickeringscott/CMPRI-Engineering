import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { receivesOrdinaryWorkOrderNotifications, roleKey } from "@/lib/server/roles";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";
import { isWebPushEligibleProfile } from "@/lib/notifications/schedule";
import {
  dashboardNotificationScanStart,
  engineerHistoryNotifications,
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

async function saveInboxRows(admin: SupabaseClient, userId: string, notifications: WorkOrderNotification[]) {
  if (!notifications.length) return;
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
    })), { onConflict: "hotel_id,recipient_user_id,notification_key", ignoreDuplicates: true });
  if (error) throw new Error("Dashboard notifications could not be saved.");
}

async function notificationsForUser(
  admin: SupabaseClient,
  profile: PushProfile,
  savedCursor: string,
  checkedAt: string,
) {
  const role = roleKey(profile.role);
  const start = dashboardNotificationScanStart(savedCursor, checkedAt);
  const orders = await scanPages<{ id: string; display_id: string | null; room: string | null; issue: string | null; created_at: string }>(
    (from, to) => admin.from("work_orders")
      .select("id, display_id, room, issue, created_at")
      .eq("hotel_id", HOTEL_ID)
      .gt("created_at", start)
      .lte("created_at", checkedAt)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  let newOrders = orders.map(newWorkOrderNotification);
  const dashboard: WorkOrderNotification[] = [...newOrders];
  let technicianHistory: WorkOrderNotification[] = [];

  if (role === "technician" && orders.length) {
    const { data: views, error } = await admin.from("cmpri_work_order_engineering_views")
      .select("work_order_id")
      .eq("hotel_id", HOTEL_ID)
      .in("work_order_id", orders.map((order) => order.id));
    if (error) throw new Error("Engineering work-order views could not be checked.");
    const alreadySeen = new Set((views || []).map((view: { work_order_id: string }) => view.work_order_id));
    newOrders = newOrders.filter((notification) => !notification.work_order_id || !alreadySeen.has(notification.work_order_id));
    dashboard.splice(0, dashboard.length, ...newOrders);
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
    activeMembers.has(profile.id)
      && isWebPushEligibleProfile(profile)
      && receivesOrdinaryWorkOrderNotifications(profile.role),
  );
  const checkedAt = new Date().toISOString();
  let notificationCount = 0;

  for (const profile of recipients) {
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
    await saveInboxRows(admin, profile.id, candidates.dashboard);
    notificationCount += candidates.dashboard.length + candidates.technicianHistory.length;
    try {
      await dispatchWebPushNotifications(admin, profile.id, profile, [...candidates.dashboard, ...candidates.technicianHistory]);
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
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Notification service credentials are unavailable." }, { status: 503 });
  try {
    return NextResponse.json({ ok: true, ...(await dispatch(admin)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Scheduled phone notification dispatch failed.", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Phone notifications could not be dispatched." }, { status: 503 });
  }
}
