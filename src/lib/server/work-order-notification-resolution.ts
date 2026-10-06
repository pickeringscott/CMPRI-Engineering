import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { profileHasRole, roleKey } from "@/lib/server/roles";

export function isEngineeringWorkOrderActor(profile: { role: unknown; secondary_roles?: readonly unknown[] }) {
  return profileHasRole(profile, "engineer") || profileHasRole(profile, "system_admin");
}

export async function recordEngineeringWorkOrderView(
  admin: SupabaseClient,
  workOrder: { id: string; display_id?: string | null },
  user: { id: string },
) {
  const { error } = await admin
    .from("cmpri_work_order_engineering_views")
    .upsert({
      hotel_id: HOTEL_ID,
      work_order_id: workOrder.id,
      work_order_display_id: workOrder.display_id || "",
      engineering_user_id: user.id,
    }, { onConflict: "hotel_id,work_order_id,engineering_user_id", ignoreDuplicates: true });
  if (error) throw new Error("Engineering work-order view could not be recorded.");

  const { data: notifications, error: notificationError } = await admin
    .from("cmpri_dashboard_notifications")
    .select("recipient_user_id")
    .eq("hotel_id", HOTEL_ID)
    .eq("work_order_id", workOrder.id)
    .eq("notification_key", `new-order:${workOrder.id}`)
    .is("cleared_at", null);
  if (notificationError) throw new Error("Technician work-order notifications could not be resolved.");
  const recipientIds = Array.from(new Set((notifications || []).map((item: { recipient_user_id: string }) => item.recipient_user_id)));
  if (!recipientIds.length) return;

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, role")
    .in("id", recipientIds);
  if (profileError) throw new Error("Technician notification recipients could not be checked.");
  const technicianIds = (profiles || [])
    .filter((profile: { id: string; role: string | null }) => roleKey(profile.role) === "technician")
    .map((profile: { id: string }) => profile.id);
  if (!technicianIds.length) return;

  const { error: clearError } = await admin
    .from("cmpri_dashboard_notifications")
    .update({ cleared_at: new Date().toISOString() })
    .eq("hotel_id", HOTEL_ID)
    .eq("work_order_id", workOrder.id)
    .eq("notification_key", `new-order:${workOrder.id}`)
    .is("cleared_at", null)
    .in("recipient_user_id", technicianIds);
  if (clearError) throw new Error("Technician work-order notifications could not be resolved.");
}
