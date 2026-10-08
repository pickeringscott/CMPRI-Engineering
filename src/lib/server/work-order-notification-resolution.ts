import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { profileHasRole } from "@/lib/server/roles";

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
}
