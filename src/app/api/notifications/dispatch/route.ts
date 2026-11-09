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

async function pendingRecipients(admin: SupabaseClient) {
  const ids: string[] = [];
  // Walk by id, so concurrent inserts/deletes cannot shift offset pages. New
  // earlier ids are picked up by their webhook or the next recovery run.
  let after: string | null = null;
  for (;;) {
    const { data, error } = await admin.rpc("cmpri_pending_push_recipients", {
      p_hotel: HOTEL_ID, p_after: after, p_limit: PAGE_SIZE,
    });
    if (error) throw new Error("Pending phone notification recipients could not be loaded.");
    const page = (data || []) as Array<{ recipient_user_id: string }>;
    ids.push(...page.map(row => row.recipient_user_id));
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1].recipient_user_id;
  }
  return ids;
}

async function dispatch(admin: SupabaseClient, requestedRecipients?: string[]) {
  const userIds = requestedRecipients ?? await pendingRecipients(admin);
  if (!userIds.length) return { users: 0, notifications: 0 };

  let notificationCount = 0, users = 0;
  // Keep PostgREST filters bounded even if an insert or recovery contains a
  // large number of recipients. Delivery claims remain atomic per device.
  for (let offset = 0; offset < userIds.length; offset += 200) {
    const batch = userIds.slice(offset, offset + 200);
    const [{ data: profiles, error: profilesError }, { data: memberships, error: membershipError }] = await Promise.all([
      admin.from("profiles").select("id, email, role, secondary_roles, full_name, active").eq("active", true).in("id", batch),
      admin.from("hotel_members").select("user_id").eq("hotel_id", HOTEL_ID).eq("active", true).in("user_id", batch),
    ]);
    if (profilesError || membershipError) throw new Error("Phone notification recipients could not be verified.");
    const activeMembers = new Set((memberships || []).map((row: { user_id: string }) => row.user_id));
    const recipients = ((profiles || []) as PushProfile[]).filter(profile => activeMembers.has(profile.id));
    users += recipients.length;
    for (const profile of recipients) notificationCount += await dispatchPendingInboxNotifications(admin, profile);
  }
  return { users, notifications: notificationCount };
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
  try {
    const body = await request.json().catch(() => null);
    // Older database triggers send no recipient list and retain full recovery.
    const recipients = Array.isArray(body?.recipient_user_ids)
      && body.recipient_user_ids.every((id: unknown) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      ? Array.from(new Set(body.recipient_user_ids as string[])) : undefined;
    return NextResponse.json({ ok: true, ...(await dispatch(admin, recipients)) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  catch { return NextResponse.json({ error: 'Phone notifications could not be dispatched.' }, { status: 503 }); }
}
