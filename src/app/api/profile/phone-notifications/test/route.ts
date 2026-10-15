import { after, NextRequest, NextResponse } from "next/server";
import { setTimeout as delay } from "node:timers/promises";
import { HOTEL_ID } from "@/lib/constants";
import { requireUserAttempt } from "@/lib/server/auth";
import { isStaffNotesPushEligibleProfile } from "@/lib/notifications/schedule";
import { dispatchPhoneNotificationTest, PUSH_TEST_FIELDS, PUSH_TEST_TABLE, publicPushTest, pushTestScheduleAllows, pushTestsConfigured } from "@/lib/server/phone-notification-tests";

export const maxDuration = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok) return reply({ error: "Sign in is required." }, 401);
  if (auth.mcp || !isStaffNotesPushEligibleProfile(auth.principal.profile)) return reply({ error: "Phone notification tests are unavailable for this account." }, 403);
  const raw = await request.text();
  if (raw.length > 4096) return reply({ error: "Invalid test request." }, 400);
  let body;
  try { body = JSON.parse(raw); } catch { return reply({ error: "Invalid test request." }, 400); }
  if (!body || !["send", "status", "cancel"].includes(body.action) || typeof body.endpoint !== "string" || !body.endpoint || body.endpoint.length > 2000
    || (body.id !== undefined && (typeof body.id !== "string" || !UUID.test(body.id)))) return reply({ error: "Invalid test request." }, 400);
  if (body.action === "send" && (!body.id || ![0, 10].includes(body.delay_seconds))) return reply({ error: "Choose an immediate or 10-second test." }, 400);
  if (body.action === "cancel" && !body.id) return reply({ error: "The test to cancel is required." }, 400);
  const { admin, principal } = auth;
  const userId = principal.identity.id;
  try {
    // Use the stored subscription, never browser-supplied keys or a recipient ID.
    const device = await admin.from("cmpri_web_push_subscriptions").select("id")
      .eq("hotel_id", HOTEL_ID).eq("recipient_user_id", userId).eq("endpoint", body.endpoint).eq("enabled", true).maybeSingle();
    if (device.error) throw new Error("This device could not be checked.");
    if (!device.data) return reply({ error: "Enable phone notifications on this device first." }, 409);
    const owned = () => admin.from(PUSH_TEST_TABLE).select(PUSH_TEST_FIELDS)
      .eq("hotel_id", HOTEL_ID).eq("recipient_user_id", userId).eq("subscription_id", device.data!.id);
    if (body.action === "status") {
      let query = owned();
      query = body.id ? query.eq("id", body.id) : query.gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString()).order("created_at", { ascending: false }).limit(1);
      const result = await query.maybeSingle();
      if (result.error) throw new Error("Test status could not be loaded.");
      return reply({ test: result.data ? publicPushTest(result.data) : null });
    }
    if (body.action === "cancel") {
      const result = await admin.from(PUSH_TEST_TABLE).update({ status: "cancelled" })
        .eq("hotel_id", HOTEL_ID).eq("recipient_user_id", userId).eq("subscription_id", device.data.id)
        .eq("id", body.id).eq("status", "pending").select(PUSH_TEST_FIELDS).maybeSingle();
      if (result.error) throw new Error("Test could not be cancelled.");
      if (result.data) return reply({ test: publicPushTest(result.data) });
      const existing = await owned().eq("id", body.id).maybeSingle();
      if (existing.error) throw new Error("Test status could not be loaded.");
      return reply({ error: "This test is no longer pending and cannot be cancelled.", test: existing.data ? publicPushTest(existing.data) : null }, 409);
    }
    if (!pushTestsConfigured()) return reply({ error: "Notification tests are not configured on this server." }, 503);
    if (!await pushTestScheduleAllows(admin, userId, new Date(Date.now() + body.delay_seconds * 1000))) {
      return reply({ error: "Tests follow your saved notification hours. Try during that window." }, 409);
    }
    const result = await admin.rpc("cmpri_enqueue_web_push_test", {
      p_id: body.id, p_hotel_id: HOTEL_ID, p_user_id: userId,
      p_subscription_id: device.data.id, p_delay_seconds: body.delay_seconds,
    });
    if (result.error) {
      if (result.error.message === "push_test_rate_limit") return reply({ error: "Wait 30 seconds between tests. Maximum five tests per hour." }, 429);
      if (result.error.message === "push_test_device_unavailable") return reply({ error: "This device is no longer enabled." }, 409);
      if (result.error.message === "push_test_id_conflict") return reply({ error: "This request ID is unavailable. Refresh the profile before trying again." }, 409);
      throw new Error("Test could not be scheduled.");
    }
    const job = result.data;
    if (!job?.id) throw new Error("Test could not be scheduled.");
    if (job.status === "pending") after(async () => {
      try {
        // Server-side, after the response. The persisted job also has cron recovery.
        await delay(Math.max(0, Math.min(10_000, Date.parse(job.due_at) - Date.now())));
        await dispatchPhoneNotificationTest(admin, job.id);
      } catch { console.error("An explicit phone notification test could not be processed after the response."); }
    });
    return reply({ test: publicPushTest(job) }, 202);
  } catch {
    // Do not include endpoints, push keys, or provider response bodies in errors/logs.
    console.error("Phone notification test request failed.");
    return reply({ error: "The test request could not be completed. Check its status before trying again." }, 503);
  }
}
