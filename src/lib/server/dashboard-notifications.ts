import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import {
  profileHasRole,
  profileIsChiefEngineerOrSystemAdmin,
  receivesWorkOrderNotifications,
} from "@/lib/server/roles";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";
import { receivesEventPush } from "@/lib/notifications/event-eligibility";
import {
  sanitizeImportedDashboardNotifications,
  unrecordedDashboardNotifications,
  type WorkOrderNotification,
} from "@/lib/dashboard/work-order-notifications";

const INBOX_LIMIT = 500;
const NO_STORE = { "Cache-Control": "private, no-store" };

async function authorize(request: NextRequest, verified?: Awaited<ReturnType<typeof requireUser>>) {
  const auth = verified === undefined ? await requireUser(request) : verified;
  if (!auth) return { response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  if (!allows(auth.principal, "view_dashboard")
    && !allows(auth.principal, "receive_pool_closed_notifications")) {
    return { response: NextResponse.json({ error: "Dashboard access is required." }, { status: 403 }) };
  }
  return { auth };
}

export async function recordNotifications(
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
      push_requested: deliverPush && !notification.is_read && receivesEventPush(profile, notification),
      read_at: !profileIsChiefEngineerOrSystemAdmin(profile)
        && profileHasRole(profile, "technician")
        && notification.is_read
        ? notification.recorded_at
        : null,
    })), { onConflict: "hotel_id,recipient_user_id,notification_key", ignoreDuplicates: true })
    .select("notification_key,read_at");
  if (error) return false;
  if (deliverPush && inserted?.length) {
    const insertedKeys = new Set(inserted.filter((row: { read_at?: string | null }) => !row.read_at).map((row: { notification_key: string }) => row.notification_key));
    try {
      await dispatchWebPushNotifications(admin, userId, profile, missing.filter((item) =>
        insertedKeys.has(item.id)
        && (profileIsChiefEngineerOrSystemAdmin(profile) || !profileHasRole(profile, "technician") || !item.is_read),
      ));
    } catch (deliveryError) {
      console.error("New dashboard notifications were saved, but phone alerts could not be delivered.", deliveryError);
    }
  }
  return true;
}

export async function getDashboardNotifications(request: NextRequest, verified?: Awaited<ReturnType<typeof requireUser>>) {
  const { auth, response } = await authorize(request, verified);
  if (!auth) return response;
  const admin = auth.admin;
  const userId = auth.principal.identity.id;
  const canReceiveOrdinary = receivesWorkOrderNotifications(auth.principal.profile);
  const checkedAt = new Date().toISOString();

  const inboxQuery = admin
    .from("cmpri_dashboard_notifications")
    .select("notification_key, work_order_id, target_path, message, recorded_at, read_at")
    .not("notification_key", "like", "staff-note:%")
    .eq("hotel_id", HOTEL_ID)
    .eq("recipient_user_id", userId)
    .is("cleared_at", null)
    .order("recorded_at", { ascending: false })
    .limit(INBOX_LIMIT);
  const inboxResult = await inboxQuery;
  if (inboxResult.error) return NextResponse.json({error:"Notifications could not be loaded."},{status:503});

  const notifications = (inboxResult.data || [])
    .filter((row: { work_order_id: string | null }) => canReceiveOrdinary || row.work_order_id === null)
    .map((row: { notification_key: string; work_order_id: string | null; target_path: string | null; message: string; recorded_at: string; read_at: string | null }) => ({
      id: row.notification_key,
      work_order_id: row.work_order_id,
      target_path: row.target_path,
      message: row.message,
      recorded_at: row.recorded_at,
      is_read: row.read_at !== null,
    }));

  return NextResponse.json({
    notifications,
    orders_version: "event-driven",
    checked_at: checkedAt,
  }, { headers: NO_STORE });
}

export async function postDashboardNotifications(request: NextRequest) {
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
    if (!receivesWorkOrderNotifications(auth.principal.profile)) query = query.is("work_order_id", null);
    if (body.action === "read") query = query.is("read_at", null);
    const { error } = await query;
    if (error) return NextResponse.json({ error: body.action === "read" ? "Notifications could not be marked read." : "Notifications could not be cleared." }, { status: 503 });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  }

  if (body?.action === "import") {
    if (!receivesWorkOrderNotifications(auth.principal.profile)) {
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
