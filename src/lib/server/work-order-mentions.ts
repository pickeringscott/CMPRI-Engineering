import type { SupabaseClient } from "@supabase/supabase-js";
import { addedWorkOrderNoteText, workOrderMentionDirectory, workOrderMentionRecipients, type MentionProfile } from "@/lib/work-order-mentions";

export async function loadWorkOrderMentionProfiles(admin: SupabaseClient, hotelId: string): Promise<MentionProfile[]> {
  const members = await admin.from("hotel_members").select("user_id").eq("hotel_id", hotelId).eq("active", true);
  if (members.error) throw new Error("Work-order mention recipients could not be loaded.");
  const ids = [...new Set((members.data || []).map(member => member.user_id))];
  if (!ids.length) return [];
  const profiles = await admin.from("profiles").select("id,full_name,role,secondary_roles,preferences").eq("active", true).in("id", ids);
  if (profiles.error) throw new Error("Work-order mention recipients could not be loaded.");
  return (profiles.data || []) as MentionProfile[];
}

export async function loadPublicWorkOrderMentions(admin: SupabaseClient, hotelId: string) {
  return workOrderMentionDirectory(await loadWorkOrderMentionProfiles(admin, hotelId)).map(({ label, kind }) => ({ label, kind }));
}

/** The database commits the existing validated update and targeted inbox/push intents together. */
export async function persistMentionedWorkOrder(admin: SupabaseClient, input: {
  hotelId: string; id: string; actorId: string; revision: number; beforeNotes: string;
  update: Record<string, unknown>; openOnly?: boolean;
}) {
  if (typeof input.update.notes !== "string") return null;
  const added = addedWorkOrderNoteText(input.beforeNotes, input.update.notes);
  if (!added.includes("@")) return null;
  const recipients = workOrderMentionRecipients(added, await loadWorkOrderMentionProfiles(admin, input.hotelId), input.actorId);
  if (!recipients.length) return null;
  return await admin.rpc("cmpri_save_mentioned_work_order", {
    p_hotel: input.hotelId, p_id: input.id, p_actor: input.actorId,
    p_revision: input.revision, p_update: input.update, p_recipients: recipients, p_open_only: input.openOnly === true,
  });
}
