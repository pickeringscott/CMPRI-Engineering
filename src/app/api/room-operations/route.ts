import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID, HOTEL_TIME_ZONE } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { detectRoomMoves } from "@/lib/room-operations";

function hotelDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: HOTEL_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce<Record<string, string>>((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function yesterdayDate(today = hotelDate()) {
  return new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
}

function isRetainedDate(value: string, today = hotelDate()) {
  return value === today || value === yesterdayDate(today);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizedDate(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const text = value.trim();
  const us = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    const iso = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    if (!validDate(iso)) throw new Error(`${label} '${text}' is invalid.`);
    return iso;
  }
  if (validDate(text.slice(0, 10))) return text.slice(0, 10);
  throw new Error(`${label} '${text}' is invalid.`);
}

function roomValue(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const room = value.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "";
  if (!room) throw new Error(`${label} must contain a room number.`);
  return room.toUpperCase() === "MGR" ? "MGR" : room;
}

function shortText(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > max) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function stayNights(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required; supply the extracted value instead of guessing.`);
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a whole number from 0 to 3650.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > 3650) throw new Error(`${label} must be a whole number from 0 to 3650.`);
  return parsed;
}

function reserved(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required; supply the extracted Yes/No value instead of guessing.`);
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} is invalid.`);
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1", "reserved", "blk"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "not reserved"].includes(normalized)) return false;
  throw new Error(`${label} value '${normalized}' is not recognized.`);
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "view_dashboard");
  if (!auth) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  const date = request.nextUrl.searchParams.get("date") || hotelDate();
  if (!validDate(date)) return NextResponse.json({ error: "Room-operations date is invalid." }, { status: 400 });
  const today = hotelDate();
  if (!isRetainedDate(date, today)) return NextResponse.json({ error: "Only today's and yesterday's room-operations snapshots are retained." }, { status: 400 });
  const { error: pruneError } = await auth.admin.from("cmpri_room_operation_imports")
    .delete().eq("hotel_id", HOTEL_ID).lt("report_date", yesterdayDate(today));
  if (pruneError) return NextResponse.json({ error: "Expired room-operations snapshots could not be removed." }, { status: 503 });

  const { data, error } = await auth.admin.from("cmpri_room_operations")
    .select("room, checkout_date, checkout_time, room_status, arrival_date, arrival_time, move_from, move_to, guest_name, room_type, guest_code, guest_arrival_date, stay_nights, reserved, imported_at")
    .eq("hotel_id", HOTEL_ID).eq("report_date", date).order("room");
  if (error) return NextResponse.json({ error: "Shared room-operations data is not configured." }, { status: 503 });
  if (date !== today) {
    const rows = (data || []).map((row) => ({ ...row, move_from: "", move_to: "" }));
    return NextResponse.json({ date, rows }, { headers: { "Cache-Control": "no-store" } });
  }

  const { data: yesterdayRows, error: yesterdayError } = await auth.admin.from("cmpri_room_operations")
    .select("room, guest_name, move_from, move_to")
    .eq("hotel_id", HOTEL_ID).eq("report_date", yesterdayDate(today));
  if (yesterdayError) return NextResponse.json({ error: "Yesterday's room snapshot could not be loaded to compare room moves." }, { status: 503 });
  const rows = detectRoomMoves(yesterdayRows || [], data || []);
  return NextResponse.json({ date, rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "edit_tickets");
  if (!auth) return NextResponse.json({ error: "Engineering ticket-edit permission is required to import room operations." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch { return NextResponse.json({ error: "A valid JSON import is required." }, { status: 400 }); }
  const source = shortText(body.source, "Import source", 20) || "paste";
  if (!["paste", "file"].includes(source)) return NextResponse.json({ error: "Room operations can only be imported from a manual paste or file upload." }, { status: 400 });
  const reportDate = typeof body.report_date === "string" && body.report_date ? body.report_date : hotelDate();
  if (!validDate(reportDate)) return NextResponse.json({ error: "Report date is invalid." }, { status: 400 });
  if (!isRetainedDate(reportDate)) return NextResponse.json({ error: "Room operations can only be uploaded for today or yesterday." }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 500) return NextResponse.json({ error: "Import between 1 and 500 room rows." }, { status: 400 });

  const { data: locations, error: locationError } = await auth.admin.from("locations")
    .select("room_number, name").eq("hotel_id", HOTEL_ID).eq("active", true).limit(2000);
  if (locationError || !locations || locations.length >= 2000) return NextResponse.json({ error: "CMPRI room list could not be verified. Nothing was imported." }, { status: 503 });
  const knownRooms = new Set(locations.map((location) => {
    const value = String(location.room_number || location.name?.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "").trim();
    return value.toUpperCase() === "MGR" ? "MGR" : value;
  }).filter(Boolean));
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  try {
    body.rows.forEach((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Row ${index + 1} is invalid.`);
      const row = value as Record<string, unknown>;
      const room = roomValue(row.room, `Row ${index + 1} room`);
      if (room !== "MGR" && !knownRooms.has(room)) throw new Error(`Row ${index + 1}: Room ${room} is not an active CMPRI room.`);
      if (seen.has(room)) throw new Error(`Room ${room} appears more than once in this import.`);
      seen.add(room);
      rows.push({
        room,
        checkout_date: normalizedDate(row.checkoutDate ?? row.checkout_date, `Row ${index + 1} checkout date`),
        checkout_time: normalizedDate(row.checkoutDate ?? row.checkout_date, `Row ${index + 1} checkout date`)
          ? shortText(row.checkoutTime ?? row.checkout_time, `Row ${index + 1} checkout time`, 80) || "11:00 AM"
          : "",
        room_status: shortText(row.roomStatus ?? row.room_status, `Row ${index + 1} room status`, 200),
        arrival_date: normalizedDate(row.arrivalDate ?? row.arrival_date, `Row ${index + 1} arrival date`),
        arrival_time: shortText(row.arrivalTime ?? row.arrival_time, `Row ${index + 1} arrival time`, 80),
        move_from: "",
        move_to: "",
        guest_name: shortText(row.guestName ?? row.guest_name, `Row ${index + 1} guest name`, 200),
        room_type: shortText(row.roomType ?? row.room_type, `Row ${index + 1} room type`, 80),
        guest_code: shortText(row.guestCode ?? row.guest_code, `Row ${index + 1} guest code`, 80),
        guest_arrival_date: normalizedDate(row.guestArrivalDate ?? row.guest_arrival_date, `Row ${index + 1} guest arrival date`),
        stay_nights: stayNights(row.stayNights ?? row.stay_nights, `Row ${index + 1} length of stay`),
        reserved: reserved(row.reserved, `Row ${index + 1} reserved`),
      });
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Room-operations validation failed." }, { status: 400 }); }

  if (body.validate_only === true) {
    return NextResponse.json({ ok: true, date: reportDate, count: rows.length, rows }, { headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" } });
  }

  const actorName = auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI Engineering";
  const { data: importId, error } = await auth.admin.rpc("cmpri_replace_room_operations", {
    p_hotel_id: HOTEL_ID,
    p_report_date: reportDate,
    p_actor_id: auth.principal.identity.id,
    p_actor_name: actorName,
    p_source_type: source,
    p_rows: rows,
  });
  if (error) return NextResponse.json({ error: `Room operations were not saved: ${error.message}` }, { status: 409 });
  return NextResponse.json({ ok: true, import_id: importId, date: reportDate, count: rows.length });
}
