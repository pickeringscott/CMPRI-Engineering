import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import {
  isWebPushEligibleProfile,
  isWithinNotificationSchedule,
  normalizeNotificationSettings,
  type WebPushEligibleProfile,
} from "@/lib/notifications/schedule";

function configuredVapidKeys() {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    throw new Error("Web Push requires WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY, and WEB_PUSH_VAPID_SUBJECT.");
  }
  return { publicKey, privateKey, subject };
}

export function webPushPublicKey() {
  return process.env.WEB_PUSH_VAPID_PUBLIC_KEY || "";
}

export async function dispatchWebPushNotifications(
  admin: SupabaseClient,
  recipientUserId: string,
  profile: WebPushEligibleProfile,
  notifications: Array<{ id: string; message: string; target_path?: string | null }>,
) {
  if (!notifications.length || !isWebPushEligibleProfile(profile)) return;
  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("cmpri_web_push_subscriptions")
    .select("id, subscription")
    .eq("hotel_id", HOTEL_ID)
    .eq("recipient_user_id", recipientUserId)
    .eq("enabled", true);
  if (subscriptionsError) throw new Error("Phone notification subscriptions could not be loaded.");
  if (!subscriptions?.length) return;

  const { data: row, error: settingsError } = await admin
    .from("cmpri_user_notification_schedules")
    .select("timezone, schedule")
    .eq("hotel_id", HOTEL_ID)
    .eq("user_id", recipientUserId)
    .maybeSingle();
  if (settingsError) throw new Error("Phone notification schedule could not be loaded.");
  if (!row) return;
  const settings = normalizeNotificationSettings({ timezone: row.timezone, schedule: row.schedule });
  if (!settings) throw new Error("The saved phone notification schedule is invalid.");

  const scheduledAt = isWithinNotificationSchedule(settings);
  if (scheduledAt) {
    const keys = configuredVapidKeys();
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  }
  for (const notification of notifications) {
    for (const subscription of subscriptions as Array<{ id: string; subscription: webpush.PushSubscription }>) {
      const { data: insertedClaim, error: claimError } = await admin
        .from("cmpri_web_push_deliveries")
        .insert({
          hotel_id: HOTEL_ID,
          recipient_user_id: recipientUserId,
          subscription_id: subscription.id,
          notification_key: notification.id,
          status: "pending",
        })
        .select("id")
        .maybeSingle();
      let claim = insertedClaim;
      if (claimError && (claimError as { code?: string }).code === "23505") {
        const existing = await admin.from("cmpri_web_push_deliveries")
          .select("id, status")
          .eq("hotel_id", HOTEL_ID)
          .eq("recipient_user_id", recipientUserId)
          .eq("subscription_id", subscription.id)
          .eq("notification_key", notification.id)
          .maybeSingle();
        if (existing.error) throw new Error("Phone notification delivery status could not be loaded.");
        if (!existing.data || existing.data.status !== "failed") continue;
        claim = { id: existing.data.id };
        const reset = await admin.from("cmpri_web_push_deliveries")
          .update({ status: "pending" })
          .eq("id", claim.id)
          .eq("status", "failed");
        if (reset.error) throw new Error("Phone notification delivery could not be retried.");
      } else if (claimError) {
        throw new Error("Phone notification delivery could not be recorded.");
      }
      if (!claim) continue;
      if (!scheduledAt) {
        const { error: updateError } = await admin
          .from("cmpri_web_push_deliveries")
          .update({ status: "suppressed" })
          .eq("id", claim.id);
        if (updateError) throw new Error("Suppressed phone notification could not be recorded.");
        continue;
      }
      try {
        await webpush.sendNotification(subscription.subscription, JSON.stringify({
          title: "CMPRI Engineering",
          body: notification.message,
          url: notification.target_path || (notification.id.startsWith("new-order:") && notification.id.length > 10
            ? `/work-orders/${encodeURIComponent(notification.id.slice("new-order:".length))}`
            : "/engineering"),
          tag: `cmpri-${notification.id}`,
        }));
        const { error: updateError } = await admin
          .from("cmpri_web_push_deliveries")
          .update({ status: "sent" })
          .eq("id", claim.id);
        if (updateError) console.error("Phone notification delivery status could not be saved.", updateError);
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          const { error: deleteError } = await admin
            .from("cmpri_web_push_subscriptions")
            .delete()
            .eq("id", subscription.id)
            .eq("recipient_user_id", recipientUserId);
          if (deleteError) console.error("Expired Web Push subscription could not be removed.", deleteError);
        } else {
          console.error(`Web Push delivery failed for notification ${notification.id}.`, error);
        }
        const { error: updateError } = await admin
          .from("cmpri_web_push_deliveries")
          .update({ status: "failed" })
          .eq("id", claim.id);
        if (updateError) console.error("Phone notification delivery status could not be saved.", updateError);
      }
    }
  }
}
