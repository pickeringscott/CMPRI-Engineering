import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { isIntegrationsSafeMode, requireIntegrationConfig, safeModeBlocked } from "@/lib/server/integrations-safe-mode";

export type RoomRankerRow = {
  rowNumber: number;
  room: string;
  notes?: string | null;
  [key: string]: unknown;
};

export async function callRoomRanker(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = String(payload.action || "").trim().toLowerCase();
  if (action !== "read" && isIntegrationsSafeMode()) {
    return safeModeBlocked("Room Ranker", action || "write") as unknown as Record<string, unknown>;
  }
  const { url, apiKey } = requireIntegrationConfig(
    "Room Ranker",
    process.env.CMPRI_ROOM_RANKER_API_URL,
    process.env.CMPRI_ROOM_RANKER_API_KEY,
    "CMPRI_ROOM_RANKER_API_URL",
    "CMPRI_ROOM_RANKER_API_KEY",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, apiKey }),
    cache: "no-store",
    redirect: "follow",
  });
  const text = await response.text();
  let result: Record<string, unknown>;
  try { result = JSON.parse(text) as Record<string, unknown>; }
  catch {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Room Ranker endpoint rejected CMPRI with HTTP ${response.status}. Verify CMPRI_ROOM_RANKER_API_URL points to the current deployed Apps Script /exec URL, external server requests are allowed by that deployment, and its expected API key matches Vercel Production.`);
    }
    throw new Error(`Room Ranker returned an unreadable response (${response.status}).`);
  }
  if (!response.ok || result.ok !== true) {
    throw new Error(String(result.error || `Room Ranker request failed (${response.status}).`));
  }
  return result;
}

function roomNumber(value: unknown) {
  return String(value || "").match(/\b\d{2,4}\b/)?.[0] || "";
}

function markerLine(displayId: string, issue: string) {
  const normalizedIssue = issue.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `[${displayId}] ${normalizedIssue}`.trim();
}

function isRankerActiveStatus(status: unknown) {
  const value = String(status || "Open").trim().toLowerCase();
  return !["closed", "will not do", "duplicate", "cancelled", "canceled"].includes(value);
}

async function syncSnapshot(snapshot: { display_id?: unknown; room?: unknown; issue?: unknown; status?: unknown }) {
  const displayId = String(snapshot.display_id || "").trim();
  const room = roomNumber(snapshot.room);
  if (!displayId || !room) return { skipped: true, reason: "not-a-ranked-guest-room" } as const;

  const read = await callRoomRanker({ action: "read" });
  const rooms = Array.isArray(read.rooms) ? read.rooms as RoomRankerRow[] : [];
  const target = rooms.find((row) => String(row.room || "").trim() === room);
  if (!target || !Number.isSafeInteger(Number(target.rowNumber)) || Number(target.rowNumber) < 1) {
    return { skipped: true, reason: "room-not-present-in-ranker" } as const;
  }

  const prefix = `[${displayId}]`;
  const existingLines = String(target.notes || "").split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !line.trimStart().startsWith(prefix));

  if (isRankerActiveStatus(snapshot.status)) {
    existingLines.push(markerLine(displayId, String(snapshot.issue || "Work order")));
  }

  // Keep unrelated Room Ranker notes intact. Only the exact tagged ticket line is
  // added/replaced/removed. The Apps Script input contract limits notes to 10,000 chars.
  let notes = existingLines.filter(Boolean).join("\n");
  if (notes.length > 10_000) {
    if (isRankerActiveStatus(snapshot.status)) {
      const marker = markerLine(displayId, String(snapshot.issue || "Work order"));
      const keep = Math.max(0, 9_999 - marker.length);
      notes = `${existingLines.filter((line) => !line.startsWith(prefix)).join("\n").slice(0, keep).trimEnd()}\n${marker}`.trim();
    } else {
      notes = notes.slice(0, 10_000).trimEnd();
    }
  }

  await callRoomRanker({
    action: "update",
    rowNumber: Number(target.rowNumber),
    expectedRoom: String(target.room),
    notes,
  });
  return { skipped: false, room, rowNumber: Number(target.rowNumber) } as const;
}

export async function processRoomRankerSyncForWorkOrder(admin: SupabaseClient, workOrderId: string) {
  const { data: queue, error: queueError } = await admin
    .from("cmpri_room_ranker_sync_queue")
    .select("id, work_order_id, attempts")
    .eq("hotel_id", HOTEL_ID)
    .eq("work_order_id", workOrderId)
    .maybeSingle();
  if (queueError || !queue) return { processed: false, reason: "queue-unavailable" } as const;

  const { data: workOrder, error: workOrderError } = await admin
    .from("work_orders")
    .select("id, display_id, room, issue, status")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", workOrderId)
    .maybeSingle();
  if (workOrderError || !workOrder) {
    await admin.from("cmpri_room_ranker_sync_queue").update({
      processed_at: new Date().toISOString(),
      last_error: workOrderError ? "Work order could not be loaded." : "Work order no longer exists.",
      updated_at: new Date().toISOString(),
    }).eq("id", queue.id);
    return { processed: false, reason: "work-order-unavailable" } as const;
  }

  try {
    const result = await syncSnapshot(workOrder);
    await admin.from("cmpri_room_ranker_sync_queue").update({
      processed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", queue.id);
    return { processed: true, ...result } as const;
  } catch (error) {
    const attempts = Number(queue.attempts || 0) + 1;
    const delayMinutes = Math.min(60, Math.max(1, 2 ** Math.min(attempts - 1, 6)));
    await admin.from("cmpri_room_ranker_sync_queue").update({
      attempts,
      last_error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
      next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", queue.id);
    return { processed: false, reason: "room-ranker-error" } as const;
  }
}

export async function processDueRoomRankerSync(admin: SupabaseClient, limit = 25) {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("cmpri_room_ranker_sync_queue")
    .select("work_order_id")
    .eq("hotel_id", HOTEL_ID)
    .is("processed_at", null)
    .lte("next_attempt_at", now)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) throw new Error("Room Ranker sync queue could not be loaded.");
  const results = [];
  for (const row of data || []) {
    results.push(await processRoomRankerSyncForWorkOrder(admin, String(row.work_order_id)));
  }
  return results;
}
