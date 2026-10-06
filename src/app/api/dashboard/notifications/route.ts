import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { receivesOrdinaryWorkOrderNotifications, roleKey } from "@/lib/server/roles";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";
import { isWebPushEligibleProfile } from "@/lib/notifications/schedule";
import {
  dashboardNotificationScanStart,
  engineerHistoryNotifications,
  newWorkOrderNotification,
  sanitizeImportedDashboardNotifications,
  shouldWriteDashboardNotificationCursor,
  technicianViewNotificationsForEngineer,
  unrecordedDashboardNotifications,
  type WorkOrderHistoryNotification,
  type WorkOrderNotification,
  type WorkOrderTechnicianView,
} from "@/lib/dashboard/work-order-notifications";

const PAGE_SIZE = 500;
const MAX_SCAN = 10_000;
const INBOX_LIMIT = 500;
const NO_STORE = { "Cache-Control": "private, no-store" };

async function authorize(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return { response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  if (!allows(auth.principal, "view_dashboard")
    && !allows(auth.principal, "receive_pool_closed_notifications")) {
    return { response: NextResponse.json({ error: "Dashboard access is required." }, { status: 403 }) };
  }
  return { auth };
}

async function scanPages<T>(load: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>) {
  const rows: T[] = [];
  for (let offset = 0; offset < MAX_SCAN; offset += PAGE_SIZE) {
    const { data, error } = await load(offset, offset + PAGE_SIZE - 1);
    if (error) return null;
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function recordNotifications(
  admin: SupabaseClient,
  userId: string,
  candidates: WorkOrderNotification[],
  profile: { role: unknown; secondary_roles?: readonly unknown[] },
  deliverPush = true,
) {
  if (!candidates.length) return true;
  const recordedKeys: string[] = [];
  for (let index = 0; index < candidates.length; index += 200) {
    const keys = candidates.slice(index, index + 200).map((notification) => notification.id);
    const { data, error } = await admin
      .from("cmpri_dashboard_notifications")
      .select("notification_key")
      .eq("hotel_id", HOTEL_ID)
      .eq("recipient_user_id", userId)
      .in("notification_key", keys);
    if (error) return false;
    recordedKeys.push(...(data || []).map((row: { notification_key: string }) => row.notification_key));
  }
  const missing = unrecordedDashboardNotifications(candidates, recordedKeys);
  if (!missing.length) return true;
  // ignoreDuplicates keeps a cleared row cleared even if two tabs record the same key at once.
  const { data: inserted, error } = await admin
    .from("cmpri_dashboard_notifications")
    .upsert(missing.map((notification) => ({
      hotel_id: HOTEL_ID,
      recipient_user_id: userId,
      notification_key: notification.id,
      work_order_id: notification.work_order_id,
      target_path: notification.target_path || null,
      message: notification.message,
      recorded_at: notification.recorded_at,
    })), { onConflict: "hotel_id,recipient_user_id,notification_key", ignoreDuplicates: true })
    .select("notification_key");
  if (error) return false;
  if (deliverPush && inserted?.length && isWebPushEligibleProfile(profile)) {
    const insertedKeys = new Set(inserted.map((row: { notification_key: string }) => row.notification_key));
    try {
      await dispatchWebPushNotifications(admin, userId, profile, missing.filter((item) => insertedKeys.has(item.id)));
    } catch (deliveryError) {
      console.error("New dashboard notifications were saved, but phone alerts could not be delivered.", deliveryError);
    }
  }
  return true;
}

export async function GET(request: NextRequest) {
  const { auth, response } = await authorize(request);
  if (!auth) return response;
  const admin = auth.admin;
  const userId = auth.principal.identity.id;
  const isEngineer = roleKey(auth.principal.profile.role) === "engineer";
  const canReceiveOrdinary = receivesOrdinaryWorkOrderNotifications(auth.principal.profile.role);
  const checkedAt = new Date().toISOString();

  const { data: cursorRow, error: cursorError } = await admin
    .from("cmpri_dashboard_notification_cursors")
    .select("checked_at")
    .eq("hotel_id", HOTEL_ID)
    .eq("recipient_user_id", userId)
    .maybeSingle();
  if (cursorError) return NextResponse.json({ error: "Notifications could not be loaded." }, { status: 503 });
  const savedCursor = (cursorRow as { checked_at?: string } | null)?.checked_at ?? null;
  const scanStart = dashboardNotificationScanStart(savedCursor, checkedAt);

  const candidates: WorkOrderNotification[] = [];
  if (savedCursor && canReceiveOrdinary) {
    const orders = await scanPages<{ id: string; display_id: string | null; room: string | null; issue: string | null; created_at: string }>(
      (from, to) => admin
        .from("work_orders")
        .select("id, display_id, room, issue, created_at")
        .eq("hotel_id", HOTEL_ID)
        .gt("created_at", scanStart)
        .lte("created_at", checkedAt)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );
    if (!orders) return NextResponse.json({ error: "New work orders could not be checked." }, { status: 503 });
    let newOrderCandidates = orders.map(newWorkOrderNotification);
    if (roleKey(auth.principal.profile.role) === "technician" && orders.length) {
      const { data: engineeringViews, error: engineeringViewError } = await admin
        .from("cmpri_work_order_engineering_views")
        .select("work_order_id")
        .eq("hotel_id", HOTEL_ID)
        .in("work_order_id", orders.map((order) => order.id));
      if (engineeringViewError) return NextResponse.json({ error: "Engineering work-order views could not be checked." }, { status: 503 });
      const alreadySeen = new Set((engineeringViews || []).map((view: { work_order_id: string }) => view.work_order_id));
      newOrderCandidates = newOrderCandidates.filter((notification) => !notification.work_order_id || !alreadySeen.has(notification.work_order_id));
    }
    candidates.push(...newOrderCandidates);

    if (isEngineer) {
      const views = await scanPages<WorkOrderTechnicianView>(
        (from, to) => admin
          .from("cmpri_work_order_technician_views")
          .select("id, work_order_id, work_order_display_id, technician_name, viewed_at")
          .eq("hotel_id", HOTEL_ID)
          .gt("viewed_at", scanStart)
          .lte("viewed_at", checkedAt)
          .order("viewed_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      if (!views) return NextResponse.json({ error: "Technician view notifications could not be checked." }, { status: 503 });
      candidates.push(...technicianViewNotificationsForEngineer(views));

      const history = await scanPages<WorkOrderHistoryNotification>(
        (from, to) => admin
          .from("cmpri_work_order_history")
          .select("id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, recorded_at")
          .eq("hotel_id", HOTEL_ID)
          .in("event_type", ["status_changed", "closed", "reopened", "claimed"])
          .gt("recorded_at", scanStart)
          .lte("recorded_at", checkedAt)
          .order("recorded_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      );
      if (!history) return NextResponse.json({ error: "Work-order updates could not be checked." }, { status: 503 });
      candidates.push(...engineerHistoryNotifications(history, userId));
    }
  }

  if (!(await recordNotifications(admin, userId, candidates, auth.principal.profile))) {
    return NextResponse.json({ error: "Notifications could not be saved." }, { status: 503 });
  }

  // Advance the cursor only after every candidate is recorded, so nothing is skipped on failure.
  if (canReceiveOrdinary && shouldWriteDashboardNotificationCursor(savedCursor, checkedAt)) {
    const { error } = await admin
      .from("cmpri_dashboard_notification_cursors")
      .upsert({ hotel_id: HOTEL_ID, recipient_user_id: userId, checked_at: checkedAt, updated_at: checkedAt }, { onConflict: "hotel_id,recipient_user_id" });
    if (error) return NextResponse.json({ error: "Notifications could not be saved." }, { status: 503 });
  }

  const inboxQuery = admin
    .from("cmpri_dashboard_notifications")
    .select("notification_key, work_order_id, target_path, message, recorded_at, read_at")
    .eq("hotel_id", HOTEL_ID)
    .eq("recipient_user_id", userId)
    .is("cleared_at", null)
    .order("recorded_at", { ascending: false })
    .limit(INBOX_LIMIT);
  const versionQuery = canReceiveOrdinary
    ? admin
      .from("work_orders")
      .select("updated_at", { count: "exact" })
      .eq("hotel_id", HOTEL_ID)
      .order("updated_at", { ascending: false })
      .limit(1)
    : Promise.resolve({ data: [], count: 0, error: null });
  const [inboxResult, versionResult] = await Promise.all([inboxQuery, versionQuery]);
  if (inboxResult.error || versionResult.error) {
    return NextResponse.json({ error: "Notifications could not be loaded." }, { status: 503 });
  }

  const notifications = (inboxResult.data || []).map((row: { notification_key: string; work_order_id: string | null; target_path: string | null; message: string; recorded_at: string; read_at: string | null }) => ({
    id: row.notification_key,
    work_order_id: row.work_order_id,
    target_path: row.target_path,
    message: row.message,
    recorded_at: row.recorded_at,
    is_read: row.read_at !== null,
  }));
  const latest = (versionResult.data?.[0] as { updated_at?: string } | undefined)?.updated_at || "";

  return NextResponse.json({
    notifications,
    orders_version: `${versionResult.count ?? 0}:${latest}`,
    checked_at: checkedAt,
  }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const { auth, response } = await authorize(request);
  if (!auth) return response;
  const admin = auth.admin;
  const userId = auth.principal.identity.id;
  const body = await request.json().catch(() => null) as { action?: unknown; ids?: unknown; notifications?: unknown } | null;

  if (body?.action === "read" || body?.action === "clear") {
    const ids = Array.isArray(body.ids)
      ? Array.from(new Set(body.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200)))
      : [];
    if (!ids.length || ids.length > INBOX_LIMIT) {
      return NextResponse.json({ error: `Choose between 1 and ${INBOX_LIMIT} notifications.` }, { status: 400 });
    }
    const update = body.action === "read"
      ? { read_at: new Date().toISOString() }
      : { cleared_at: new Date().toISOString() };
    let query = admin
      .from("cmpri_dashboard_notifications")
      .update(update)
      .eq("hotel_id", HOTEL_ID)
      .eq("recipient_user_id", userId)
      .is("cleared_at", null)
      .in("notification_key", ids);
    if (body.action === "read") query = query.is("read_at", null);
    const { error } = await query;
    if (error) return NextResponse.json({ error: body.action === "read" ? "Notifications could not be marked read." : "Notifications could not be cleared." }, { status: 503 });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  if (body?.action === "import") {
    if (!receivesOrdinaryWorkOrderNotifications(auth.principal.profile)) {
      return NextResponse.json({ error: "Ordinary work-order notifications are not enabled for this role." }, { status: 403 });
    }
    const notifications = sanitizeImportedDashboardNotifications(body.notifications);
    if (!(await recordNotifications(admin, userId, notifications, auth.principal.profile, false))) {
      return NextResponse.json({ error: "Saved notifications could not be moved to your account." }, { status: 503 });
    }
    return NextResponse.json({ ok: true, imported: notifications.length }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "Unknown notification action." }, { status: 400 });
}
