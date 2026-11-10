import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "@/lib/server/paginated-query";

type PoolRow = Record<string, unknown>;
type ReadingHistory = { id: string; actor_id: string | null; recorded_at: string; snapshot: PoolRow | null };
type ControlHistory = { id: string; actor_id: string | null; recorded_at: string; action: string; request: PoolRow | null };

/** Retest consumers can distinguish unavailable readings from other activity errors. */
export class PoolActivityUnavailable extends Error {
  constructor(readonly readingHistory: ReadingHistory[] | null) {
    super("The day's pool activity could not be loaded.");
  }
}

export type PoolDailyEntry = {
  id: string;
  kind: "reading" | "open" | "close" | "clear-manual";
  recorded_at: string;
  actor_id: string | null;
  actor_name: string;
  snapshot?: PoolRow;
  previous_snapshot?: PoolRow | null;
  reason?: string;
  source?: "audit" | "current";
};

/** Daily log snapshots belong to the log date; control actions use the property's local day. */
export async function loadPoolDailyEntries(admin: SupabaseClient, hotelId: string, facilityId: string, date: string, log: PoolRow | null) {
  // Chicago is behind UTC. This bounded window includes its full local day on
  // both sides of DST changes; local-date filtering below excludes adjacent days.
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 48 * 60 * 60 * 1000);
  const [readings, controls] = await Promise.all([
    log?.id ? fetchAllPages<ReadingHistory>((from, to) => admin.from("cmpri_pool_log_history")
      .select("id,actor_id,recorded_at,snapshot").eq("hotel_id", hotelId).eq("pool_log_id", log.id)
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(from, to))
      : Promise.resolve({ data: [] as ReadingHistory[], error: null }),
    fetchAllPages<ControlHistory>((from, to) => admin.from("cmpri_pool_control_history")
      .select("id,actor_id,recorded_at,action,request").eq("hotel_id", hotelId).eq("facility_id", facilityId)
      .gte("recorded_at", start.toISOString()).lt("recorded_at", end.toISOString())
      .order("recorded_at", { ascending: true }).order("id", { ascending: true }).range(from, to)),
  ]);
  if (readings.error) throw new PoolActivityUnavailable(null);
  if (controls.error) throw new PoolActivityUnavailable(readings.data || []);

  const localDate = (timestamp: string) => {
    const value = new Date(timestamp);
    return Number.isFinite(value.getTime())
      ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(value) : "";
  };
  const readingHistory = [...(readings.data || [])].sort((a, b) => {
    const revisionA = Number(a.snapshot?.revision), revisionB = Number(b.snapshot?.revision);
    if (Number.isFinite(revisionA) && Number.isFinite(revisionB) && revisionA !== revisionB) return revisionA - revisionB;
    return a.recorded_at.localeCompare(b.recorded_at) || String(a.id).localeCompare(String(b.id));
  });
  let previousSnapshot: PoolRow | null = null;
  const rows: PoolDailyEntry[] = [];
  for (const entry of readingHistory) {
    if (!entry.snapshot || typeof entry.snapshot !== "object") continue;
    rows.push({ id: `reading:${entry.id}`, kind: "reading", recorded_at: entry.recorded_at,
      actor_id: entry.actor_id || null, actor_name: "Staff", snapshot: entry.snapshot,
      previous_snapshot: previousSnapshot, source: "audit" });
    previousSnapshot = entry.snapshot;
  }
  // Older records may predate audit snapshots. Show the actual current saved
  // readings rather than inventing a history or hiding the only known values.
  if (!rows.length && log && typeof log.id === "string") {
    const recorded = typeof log.updated_at === "string" ? log.updated_at : typeof log.created_at === "string" ? log.created_at : "";
    if (recorded) rows.push({ id: `current:${log.id}`, kind: "reading", recorded_at: recorded,
      actor_id: typeof log.updated_by === "string" ? log.updated_by : typeof log.created_by === "string" ? log.created_by : null,
      actor_name: "Staff", snapshot: log, source: "current" });
  }
  for (const entry of controls.data || []) {
    if (localDate(entry.recorded_at) !== date || !["open", "close", "clear-manual"].includes(entry.action)) continue;
    rows.push({ id: `control:${entry.id}`, kind: entry.action as "open" | "close" | "clear-manual", recorded_at: entry.recorded_at,
      actor_id: entry.actor_id || null, actor_name: "Staff",
      reason: typeof entry.request?.reason === "string" ? entry.request.reason : "" });
  }
  const actorIds = [...new Set(rows.flatMap(entry => entry.actor_id ? [entry.actor_id] : []))];
  const names = new Map<string, string>();
  for (let offset = 0; offset < actorIds.length; offset += 100) {
    const { data, error } = await admin.from("profiles").select("id,full_name").in("id", actorIds.slice(offset, offset + 100));
    if (error) throw new PoolActivityUnavailable(readings.data || []);
    for (const person of data || []) if (typeof person.id === "string" && typeof person.full_name === "string" && person.full_name.trim()) names.set(person.id, person.full_name.trim());
  }
  for (const entry of rows) if (entry.actor_id && names.has(entry.actor_id)) entry.actor_name = names.get(entry.actor_id)!;
  rows.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id));
  return { entries: rows, readingHistory: readings.data || [] };
}
