import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
export type RankerWrite = { signal: AbortSignal; assertOwner: () => Promise<void> };
/** Serialize CMPRI sheet writers, not external editors. Failed/uncertain writes retain the lease. */
export async function withRankerWrite<T>(admin: SupabaseClient, run: (write: RankerWrite) => Promise<T>, invalidate = true): Promise<T> {
  const { data: owner, error } = await admin.rpc("cmpri_ranker_claim", { p_hotel: HOTEL_ID });
  if (error || typeof owner !== "string") throw new Error("Room Ranker is busy; retry the pending change.");
  const signal = AbortSignal.timeout(90_000);
  const assertOwner = async () => {
    signal.throwIfAborted();
    const result = await admin.rpc("cmpri_ranker_owned", { p_hotel: HOTEL_ID, p_owner: owner });
    if (result.error || result.data !== true) throw new Error("Room Ranker write lease expired.");
    signal.throwIfAborted();
  };
  await assertOwner();
  const result = await run({ signal, assertOwner });
  await assertOwner();
  const invalidated = invalidate ? await admin.rpc("cmpri_invalidate", { p_hotel: HOTEL_ID, p_resource: "room-ranker", p_scope: "*" }) : { error: null };
  if (invalidated.error) throw new Error("Room Ranker update awaits event acknowledgement.");
  const released = await admin.rpc("cmpri_ranker_release", { p_hotel: HOTEL_ID, p_owner: owner });
  if (released.error) throw new Error("Room Ranker write lease release was not confirmed.");
  return result;
}
