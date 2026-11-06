import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { dispatchWebPushNotifications } from "@/lib/notifications/web-push";
import { dispatchDuePhoneNotificationTests } from "@/lib/server/phone-notification-tests";


export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;
const MAX_SCAN = 10_000;

type PushProfile = {
  id: string;
  email?: string | null;
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
    admin.from("profiles").select("id, email, role, secondary_roles, full_name, active").eq("active", true).in("id", userIds),
    admin.from("hotel_members").select("user_id").eq("hotel_id", HOTEL_ID).eq("active", true).in("user_id", userIds),
  ]);
  if (profilesError || membershipError) throw new Error("Phone notification recipients could not be verified.");
  const activeMembers = new Set((memberships || []).map((row: { user_id: string }) => row.user_id));
  const recipients = ((profiles || []) as PushProfile[]).filter((profile) =>
    activeMembers.has(profile.id),
  );
  let notificationCount = 0;
  for (const profile of recipients) {
    notificationCount += await dispatchPendingInboxNotifications(admin, profile);
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

/** Database webhook on inserted delivery intent, authenticated separately from cron recovery. */
export async function POST(request: NextRequest) {
  const secret = process.env.CMPRI_NOTIFICATION_WEBHOOK_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Notification service is unavailable.' }, { status: 503 });
  try { return NextResponse.json({ ok: true, ...(await dispatch(admin)) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'Phone notifications could not be dispatched.' }, { status: 503 }); }
}
