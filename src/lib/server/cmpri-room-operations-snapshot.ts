import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID, HOTEL_TIME_ZONE } from "@/lib/constants";
import { checkoutDeadlinePassed, hotelDateAt, normalizePrintedTime } from "@/lib/room-operations-reports";

type SnapshotImport = {
  id: string;
  report_date: string;
  source_type: string;
  source_rows: unknown;
  uploaded_at: string;
};

type CheckoutTransition = {
  room: string;
  departing_guest_name: string;
  checkout_date: string;
  checkout_time: string;
};

type RoomOperationRow = Record<string, unknown> & {
  room?: string;
  room_status?: string;
  guest_name?: string;
  checkout_date?: string | null;
  checkout_time?: string | null;
  report_date?: string;
  source_import_id?: string | null;
};

export type EffectiveRoomOperationsSnapshot = {
  requested_date: string;
  source_date: string | null;
  source_type: string | null;
  carried_over: boolean;
  rows: RoomOperationRow[];
  error: unknown | null;
};

export function applyRoomOperationCheckoutTransitions(
  rows: RoomOperationRow[],
  transitions: CheckoutTransition[],
  importId: string,
) {
  const transitionByRoom = new Map(transitions.map((transition) => [String(transition.room), transition]));
  return rows.map((row) => {
    const transition = transitionByRoom.get(String(row.room || ""));
    if (!transition || (row.source_import_id && row.source_import_id !== importId)) return row;
    if (!/\boccupied\b/i.test(String(row.room_status || ""))) return row;
    if (row.checkout_date !== transition.checkout_date) return row;
    if (normalizePrintedTime(String(row.checkout_time || "")) !== normalizePrintedTime(transition.checkout_time)) return row;
    if (transition.departing_guest_name && row.guest_name !== transition.departing_guest_name) return row;
    return {
      ...row,
      room_status: "Vacant Dirty",
      guest_name: "",
      room_type: "",
      guest_code: "",
      guest_arrival_date: null,
      stay_nights: 0,
      checkout_date: null,
      checkout_time: null,
      default_checkout_time: true,
      deadline: null,
    };
  });
}

export function applyExpiredRoomOperationCheckouts(
  rows: RoomOperationRow[],
  sourceRows: RoomOperationRow[],
  importId: string,
  requestedDate: string,
  now: Date,
) {
  if (requestedDate !== hotelDateAt(now, HOTEL_TIME_ZONE)) return rows;
  const sourceByRoom = new Map(sourceRows.map((row) => [String(row.room || ""), row]));
  return rows.map((row) => {
    const source = sourceByRoom.get(String(row.room || ""));
    if (!source || (row.source_import_id && row.source_import_id !== importId)) return row;
    if (row.guest_name !== source.guest_name || row.room_status !== source.room_status) return row;
    if (row.checkout_date !== source.checkout_date) return row;
    if (normalizePrintedTime(String(row.checkout_time || "")) !== normalizePrintedTime(String(source.checkout_time || ""))) return row;
    if (!/\boccupied\b/i.test(String(row.room_status || ""))) return row;
    if (!row.checkout_date || !row.checkout_time || !checkoutDeadlinePassed(row.checkout_date, row.checkout_time, now, HOTEL_TIME_ZONE)) return row;
    return {
      ...row,
      room_status: "Vacant Dirty",
      guest_name: "",
      room_type: "",
      guest_code: "",
      guest_arrival_date: null,
      stay_nights: 0,
      checkout_date: null,
      checkout_time: null,
      default_checkout_time: true,
      deadline: null,
    };
  });
}

function historyRows(snapshot: SnapshotImport): RoomOperationRow[] | null {
  if (!Array.isArray(snapshot.source_rows)) return null;
  return snapshot.source_rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const stored = value as RoomOperationRow & { source_row?: unknown };
    const sourceRow = stored.source_row && typeof stored.source_row === "object" && !Array.isArray(stored.source_row)
      ? stored.source_row as RoomOperationRow
      : {};
    return [{
      ...stored,
      ...sourceRow,
      report_date: snapshot.report_date,
      imported_at: stored.imported_at || snapshot.uploaded_at,
    }];
  });
}

export async function loadEffectiveRoomOperationsSnapshot(
  admin: SupabaseClient,
  requestedDate: string,
): Promise<EffectiveRoomOperationsSnapshot> {
  const { data: imports, error: importsError } = await admin.from("cmpri_room_operation_imports")
    .select("id, report_date, source_type, source_rows, uploaded_at")
    .eq("hotel_id", HOTEL_ID)
    .lte("report_date", requestedDate)
    .order("report_date", { ascending: false })
    .order("uploaded_at", { ascending: false })
    .limit(1);
  if (importsError) {
    return { requested_date: requestedDate, source_date: null, source_type: null, carried_over: false, rows: [], error: importsError };
  }
  const snapshot = imports?.[0] as SnapshotImport | undefined;
  if (!snapshot) {
    return { requested_date: requestedDate, source_date: null, source_type: null, carried_over: false, rows: [], error: null };
  }

  const rows = historyRows(snapshot);
  if (!rows) return {requested_date:requestedDate,source_date:snapshot.report_date,source_type:snapshot.source_type,carried_over:snapshot.report_date<requestedDate,rows:[],error:new Error("Accepted snapshot has no source rows.")};

  return {requested_date:requestedDate,source_date:snapshot.report_date,source_type:snapshot.source_type,carried_over:snapshot.report_date<requestedDate,rows,error:null};
}
