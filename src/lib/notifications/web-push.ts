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
  notifications: Array<{ id: string; message: string; target_path?: string | null; work_order_id?: string | null }>,
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
      const { data: insertedDelivery, error: insertError } = await admin
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
      let deliveryId = insertedDelivery?.id as string | undefined;
      if (insertError && (insertError as { code?: string }).code === "23505") {
        const existing = await admin.from("cmpri_web_push_deliveries")
          .select("id, status, claimed_at")
          .eq("hotel_id", HOTEL_ID)
          .eq("recipient_user_id", recipientUserId)
          .eq("subscription_id", subscription.id)
          .eq("notification_key", notification.id)
          .maybeSingle();
        if (existing.error) throw new Error("Phone notification delivery status could not be loaded.");
        deliveryId = existing.data?.id;
        if (!deliveryId) continue;
      } else if (insertError) {
        throw new Error("Phone notification delivery could not be recorded.");
      }
      if (!scheduledAt) {
        continue;
      }

      const claimedAt = new Date().toISOString();
      const claimPending = await admin.from("cmpri_web_push_deliveries")
        .update({ status: "sending", claimed_at: claimedAt })
        .eq("id", deliveryId)
        .in("status", ["pending", "suppressed", "failed"])
        .select("id")
        .maybeSingle();
      if (claimPending.error) throw new Error("Phone notification delivery could not be claimed.");
      let claim = claimPending.data;
      if (!claim) {
        const existing = await admin.from("cmpri_web_push_deliveries")
          .select("status, claimed_at")
          .eq("id", deliveryId)
          .maybeSingle();
        if (existing.error) throw new Error("Phone notification delivery status could not be loaded.");
        if (!existing.data || existing.data.status !== "sending") continue;

        const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
        let staleClaim = admin.from("cmpri_web_push_deliveries")
          .update({ status: "sending", claimed_at: claimedAt })
          .eq("id", deliveryId)
          .eq("status", "sending");
        staleClaim = existing.data.claimed_at
          ? staleClaim.lt("claimed_at", staleBefore)
          : staleClaim.is("claimed_at", null);
        const staleResult = await staleClaim.select("id").maybeSingle();
        if (staleResult.error) throw new Error("A stalled phone notification delivery could not be recovered.");
        claim = staleResult.data;
      }
      if (!claim) continue;

      try {
        await webpush.sendNotification(subscription.subscription, JSON.stringify({
          title: "CMPRI Engineering",
          body: notification.message,
          url: notification.target_path || (notification.work_order_id
            ? `/work-orders/${encodeURIComponent(notification.work_order_id)}`
            : notification.id.startsWith("new-order:") && notification.id.length > 10
              ? `/work-orders/${encodeURIComponent(notification.id.slice("new-order:".length))}`
              : "/"),
          tag: `cmpri-${notification.id}`,
        }), {
          // These visible alerts are time-sensitive even when a phone is idle.
          // The library's default normal urgency allows deferred delivery.
          urgency: "high",
        });
        // "sent" records provider acceptance, not device receipt or display.
        const { error: updateError } = await admin
          .from("cmpri_web_push_deliveries")
          .update({ status: "sent", claimed_at: null })
          .eq("id", deliveryId);
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
          .update({ status: "failed", claimed_at: null })
          .eq("id", deliveryId);
        if (updateError) console.error("Phone notification delivery status could not be saved.", updateError);
      }
    }
  }
}
