import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID, HOTEL_TIME_ZONE } from "@/lib/constants";
import { roomKey } from "@/lib/room-availability";
import { isRailwayCnGuestName } from "@/lib/room-operations";

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
  const { data, error } = await admin.from("cmpri_room_operations")
    .select("room, room_status, checkout_date, checkout_time, guest_name")
    .eq("hotel_id", HOTEL_ID)
    .eq("report_date", date);
  if (error) return { date, statuses: null, operations: null, error };
  const statuses = new Map<string, string>();
  const operations = new Map<string, CurrentRoomOperation>();
  for (const row of data || []) {
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
