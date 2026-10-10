import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { roomKey } from "@/lib/room-availability";
import { isRailwayCnGuestName } from "@/lib/room-operations";
import { loadEffectiveRoomOperationsSnapshot } from "@/lib/server/cmpri-room-operations-snapshot";

export type CurrentRoomOperation = {
  checkout_date: string | null;
  checkout_time: string | null;
  cn_room: boolean;
};

function hotelDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOTEL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date()).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function loadCurrentRoomStatuses(admin: SupabaseClient) {
  const date = hotelDate();
  const { error: reconcileError } = await admin.rpc("cmpri_reconcile_room_operations");
  if (reconcileError) return { date, statuses: null, operations: null, error: reconcileError };
  const snapshot = await loadEffectiveRoomOperationsSnapshot(admin, date);
  if (snapshot.error) return { date, statuses: null, operations: null, error: snapshot.error };
  const statuses = new Map<string, string>();
  const operations = new Map<string, CurrentRoomOperation>();
  for (const row of snapshot.rows) {
    const key = roomKey(row.room);
    const status = typeof row.room_status === "string" ? row.room_status.trim() : "";
    if (key && status) statuses.set(key, status);
    if (key) {
      operations.set(key, {
        checkout_date: typeof row.checkout_date === "string" ? row.checkout_date : null,
        checkout_time: typeof row.checkout_time === "string" ? row.checkout_time : null,
        cn_room: isRailwayCnGuestName(typeof row.guest_name === "string" ? row.guest_name : null),
      });
    }
  }
  return { date, statuses, operations, error: null };
}

export function currentRoomStatus(statuses: Map<string, string>, room: unknown) {
  const key = roomKey(room);
  return key ? statuses.get(key) || null : null;
}

export function currentRoomOperation(operations: Map<string, CurrentRoomOperation>, room: unknown) {
  const key = roomKey(room);
  return key ? operations.get(key) || null : null;
}
