import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { requireUser } from "@/lib/server/auth";
import {
  defaultNotificationSchedule,
  isNotificationScheduleEligibleProfile,
  normalizeNotificationSettings,
} from "@/lib/notifications/schedule";
import { webPushPublicKey } from "@/lib/notifications/web-push";

function validSubscription(value: unknown): value is {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = candidate.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return false;
  const keyValues = keys as Record<string, unknown>;
  if (typeof candidate.endpoint !== "string" || candidate.endpoint.length > 2000) return false;
  try {
    if (new URL(candidate.endpoint).protocol !== "https:") return false;
  } catch {
    return false;
  }
  return typeof keyValues.p256dh === "string" && keyValues.p256dh.length > 0 && keyValues.p256dh.length <= 256
    && typeof keyValues.auth === "string" && keyValues.auth.length > 0 && keyValues.auth.length <= 256
    && (candidate.expirationTime === null || candidate.expirationTime === undefined || typeof candidate.expirationTime === "number");
}

async function authorize(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return { response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  if (!isNotificationScheduleEligibleProfile(auth.principal.profile)) {
    return { response: NextResponse.json({ error: "Notification schedules are not available for this role." }, { status: 403 }) };
  }
  return { auth };
}

export async function GET(request: NextRequest) {
  const { auth, response } = await authorize(request);
  if (!auth) return response;
  const userId = auth.principal.identity.id;
  const endpoint = request.nextUrl.searchParams.get("endpoint");
  const [settingsResult, subscriptionResult] = await Promise.all([
    auth.admin.from("cmpri_user_notification_schedules")
      .select("timezone, schedule")
      .eq("hotel_id", HOTEL_ID)
      .eq("user_id", userId)
      .maybeSingle(),
    endpoint
      ? auth.admin.from("cmpri_web_push_subscriptions")
        .select("id")
        .eq("hotel_id", HOTEL_ID)
        .eq("recipient_user_id", userId)
        .eq("endpoint", endpoint)
        .eq("enabled", true)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (settingsResult.error || subscriptionResult.error) {
    return NextResponse.json({ error: "Phone notification settings could not be loaded." }, { status: 503 });
  }
  const savedSettings = settingsResult.data
    ? normalizeNotificationSettings({ timezone: settingsResult.data.timezone, schedule: settingsResult.data.schedule })
    : null;
  if (settingsResult.data && !savedSettings) {
    return NextResponse.json({ error: "The saved phone notification schedule is invalid." }, { status: 503 });
  }
  return NextResponse.json({
    public_key: webPushPublicKey(),
    subscribed_on_this_device: !!subscriptionResult.data,
    configured: !!settingsResult.data,
    settings: savedSettings || { timezone: "UTC", schedule: defaultNotificationSchedule() },
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const { auth, response } = await authorize(request);
  if (!auth) return response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "A valid phone notification request is required." }, { status: 400 });
  }
  const admin = auth.admin;
  const userId = auth.principal.identity.id;

  if (body.action === "schedule") {
    const settings = normalizeNotificationSettings({ timezone: body.timezone, schedule: body.schedule });
    if (!settings) return NextResponse.json({ error: "Supply a valid timezone and Monday-through-Sunday schedule." }, { status: 400 });
    const { error } = await admin.from("cmpri_user_notification_schedules").upsert({
      hotel_id: HOTEL_ID,
      user_id: userId,
      timezone: settings.timezone,
      schedule: settings.schedule,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hotel_id,user_id" });
    if (error) return NextResponse.json({ error: "Phone notification schedule could not be saved." }, { status: 503 });
    return NextResponse.json({ ok: true, settings });
  }

  if (body.action === "subscribe") {
    if (!webPushPublicKey()) return NextResponse.json({ error: "Phone notifications are not configured on this server." }, { status: 503 });
    if (!validSubscription(body.subscription)) return NextResponse.json({ error: "A valid browser push subscription is required." }, { status: 400 });
    const subscription = body.subscription;
    const { data: cursor, error: cursorError } = await admin.from("cmpri_dashboard_notification_cursors")
      .select("checked_at")
      .eq("hotel_id", HOTEL_ID)
      .eq("recipient_user_id", userId)
      .maybeSingle();
    if (cursorError) return NextResponse.json({ error: "Notification delivery could not be initialized." }, { status: 503 });
    if (!cursor) {
      const now = new Date().toISOString();
      const { error: seedError } = await admin.from("cmpri_dashboard_notification_cursors").upsert({
        hotel_id: HOTEL_ID,
        recipient_user_id: userId,
        checked_at: now,
        updated_at: now,
      }, { onConflict: "hotel_id,recipient_user_id", ignoreDuplicates: true });
      if (seedError) return NextResponse.json({ error: "Notification delivery could not be initialized." }, { status: 503 });
    }
    const { error } = await admin.from("cmpri_web_push_subscriptions").upsert({
      hotel_id: HOTEL_ID,
      recipient_user_id: userId,
      endpoint: subscription.endpoint,
      subscription,
      enabled: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "endpoint" });
    if (error) return NextResponse.json({ error: "This device could not be registered for phone notifications." }, { status: 503 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "unsubscribe") {
    if (typeof body.endpoint !== "string" || !body.endpoint) {
      return NextResponse.json({ error: "The current device subscription is required." }, { status: 400 });
    }
    const { error } = await admin.from("cmpri_web_push_subscriptions")
      .delete()
      .eq("hotel_id", HOTEL_ID)
      .eq("recipient_user_id", userId)
      .eq("endpoint", body.endpoint);
    if (error) return NextResponse.json({ error: "This device could not be removed from phone notifications." }, { status: 503 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown phone notification action." }, { status: 400 });
}
