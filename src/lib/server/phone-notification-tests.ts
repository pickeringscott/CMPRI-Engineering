import type { SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";
import { HOTEL_ID } from "@/lib/constants";
import { isStaffNotesPushEligibleProfile, isWithinNotificationSchedule, normalizeNotificationSettings } from "@/lib/notifications/schedule";
import type { PushTest } from "@/lib/notifications/push-test-status";

export const PUSH_TEST_TABLE = "cmpri_web_push_tests";
export const PUSH_TEST_FIELDS = "id, status, due_at, expires_at";

export function publicPushTest(row: PushTest): PushTest {
  // A stopped sender may have reached the provider. Never automatically resend it.
  const elapsed = Date.now() > Date.parse(row.expires_at);
  return { id: row.id, due_at: row.due_at, expires_at: row.expires_at,
    status: elapsed && row.status === "sending" ? "unknown"
      : elapsed && row.status === "pending" ? "expired" : row.status };
}

export function pushTestsConfigured() {
  return !!(process.env.WEB_PUSH_VAPID_PUBLIC_KEY && process.env.WEB_PUSH_VAPID_PRIVATE_KEY && process.env.WEB_PUSH_VAPID_SUBJECT);
}

export async function pushTestScheduleAllows(admin: SupabaseClient, userId: string, dueAt = new Date()) {
  const { data, error } = await admin.from("cmpri_user_notification_schedules")
    .select("timezone, schedule").eq("hotel_id", HOTEL_ID).eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Notification schedule could not be checked.");
  const settings = normalizeNotificationSettings(data);
  return !!settings && isWithinNotificationSchedule(settings) && isWithinNotificationSchedule(settings, dueAt);
}

// Called by the server's after-response task and, if it stops before claiming,
// by the existing cron. Only explicit test jobs are considered here.
export async function dispatchPhoneNotificationTest(admin: SupabaseClient, id: string) {
  const { data: job, error } = await admin.from(PUSH_TEST_TABLE)
    .select("id, recipient_user_id, subscription_id, due_at, expires_at, status")
    .eq("hotel_id", HOTEL_ID).eq("id", id).eq("status", "pending").maybeSingle();
  if (error) throw new Error("Notification test could not be loaded.");
  if (!job || Date.parse(job.due_at) > Date.now()) return;
  const finishPending = async (status: string) => {
    const result = await admin.from(PUSH_TEST_TABLE).update({ status })
      .eq("hotel_id", HOTEL_ID).eq("id", id).eq("status", "pending");
    if (result.error) throw new Error("Notification test status could not be saved.");
  };
  if (Date.parse(job.expires_at) <= Date.now()) return finishPending("expired");
  const [profile, member, device] = await Promise.all([
    admin.from("profiles").select("role, secondary_roles, active").eq("id", job.recipient_user_id).maybeSingle(),
    admin.from("hotel_members").select("active").eq("hotel_id", HOTEL_ID).eq("user_id", job.recipient_user_id).maybeSingle(),
    admin.from("cmpri_web_push_subscriptions").select("subscription").eq("hotel_id", HOTEL_ID)
      .eq("id", job.subscription_id).eq("recipient_user_id", job.recipient_user_id).eq("enabled", true).maybeSingle(),
  ]);
  if (profile.error || member.error || device.error) throw new Error("Notification test eligibility could not be checked.");
  if (!profile.data?.active || !member.data?.active || !device.data || !isStaffNotesPushEligibleProfile(profile.data)
    || !await pushTestScheduleAllows(admin, job.recipient_user_id)) return finishPending("blocked");
  if (!pushTestsConfigured()) throw new Error("Notification tests are not configured.");

  // Atomic claim arbitrates cancellation and multiple workers. Never reclaim sending jobs.
  const now = new Date().toISOString();
  const claim = await admin.from(PUSH_TEST_TABLE).update({ status: "sending" })
    .eq("hotel_id", HOTEL_ID).eq("id", id).eq("status", "pending")
    .lte("due_at", now).gt("expires_at", now).select("id").maybeSingle();
  if (claim.error) throw new Error("Notification test could not be claimed.");
  if (!claim.data) return;
  let status = "accepted";
  try {
    await webpush.sendNotification(device.data.subscription, JSON.stringify({
      title: "CMPRI notification test",
      body: "This is a test notification for this device only. No work order was created.",
      url: "/profile",
      tag: `cmpri-test-${id}`,
    }), {
      urgency: "high", TTL: 60, timeout: 10_000,
      vapidDetails: {
        subject: process.env.WEB_PUSH_VAPID_SUBJECT!,
        publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY!,
        privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY!,
      },
    });
  } catch (error) {
    // Transport failures may occur after acceptance. Do not retry or log subscription material.
    const code = (error as { statusCode?: number }).statusCode;
    status = code && code >= 400 && code < 500 ? "failed" : "unknown";
  }
  const result = await admin.from(PUSH_TEST_TABLE).update({ status })
    .eq("hotel_id", HOTEL_ID).eq("id", id).eq("status", "sending");
  if (result.error) throw new Error("Notification test outcome could not be saved.");
}

export async function dispatchDuePhoneNotificationTests(admin: SupabaseClient) {
  const { data, error } = await admin.from(PUSH_TEST_TABLE).select("id")
    .eq("hotel_id", HOTEL_ID).eq("status", "pending").lte("due_at", new Date().toISOString())
    .order("due_at").limit(20);
  if (error) throw new Error("Pending notification tests could not be loaded.");
  await Promise.all((data || []).map(async ({ id }) => {
    try { await dispatchPhoneNotificationTest(admin, id); }
    catch { console.error("An explicit phone notification test could not be processed."); }
  }));
}
