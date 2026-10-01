import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID, HOTEL_TIME_ZONE } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { detectRoomMoves } from "@/lib/room-operations";
import { roomOperationsNotification } from "@/lib/dashboard/room-operations-notifications";
import { profileHasRole } from "@/lib/server/roles";

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

function normalizedDate(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (isoMatch) {
    const iso = `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    if (validDate(iso)) return iso;
  }
  const us = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    const iso = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    if (validDate(iso)) return iso;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const iso = parsed.toISOString().slice(0, 10);
    if (validDate(iso)) return iso;
  }
  return "";
}

function roomValue(value: unknown, label: string) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} is invalid.`);
  const room = String(value).match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "";
  if (!room) throw new Error(`${label} must contain a room number.`);
  return room.toUpperCase() === "MGR" ? "MGR" : room;
}

function shortText(value: unknown, label: string, max: number) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  if (text.length > max) return text.slice(0, max);
  return text;
}

function stayNights(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/[^\d]/g, "") : "";
  if (!text) return 0;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > 3650) return 0;
  return parsed;
}

function reserved(value: unknown) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1", "reserved", "blk"].includes(normalized)) return true;
  return false;
}

function parseDelimitedCells(line: string, delimiter: string) {
  if (delimiter === "\t") return line.split("\t").map((cell) => cell.trim());
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCsvToRows(rawCsv: string): Record<string, unknown>[] {
  const cleaned = rawCsv.replace(/^```(?:csv|tsv|text)?\r?\n?/i, "").replace(/\r?\n?```\s*$/i, "").trim();
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const parsedLines = lines.map((line) => parseDelimitedCells(line, delimiter));

  const headerRowIdx = parsedLines.findIndex((row) =>
    row.some((cell) => {
      const norm = cell.toUpperCase().replace(/\s+/g, " ");
      return norm === "ROOM" || norm === "ROOM #" || norm === "RM" || norm === "ROOM NUMBER";
    })
  );
  if (headerRowIdx < 0) return [];
  const headers = parsedLines[headerRowIdx].map((h) => h.toUpperCase().replace(/\s+/g, " "));
  const findCol = (...names: string[]) => {
    const normNames = names.map((n) => n.toUpperCase().replace(/\s+/g, " "));
    const exact = headers.findIndex((h) => normNames.includes(h));
    if (exact >= 0) return exact;
    return headers.findIndex((h) => normNames.some((n) => n.length >= 4 && h.includes(n)));
  };

  const roomIdx = findCol("ROOM", "ROOM #", "ROOM NUMBER", "RM");
  if (roomIdx < 0) return [];
  const statusIdx = findCol("ROOM STATUS", "HOUSEKEEPING STATUS", "HK STATUS", "STATUS");
  const guestNameIdx = findCol("GUEST NAME", "GUEST / NAME", "GUEST", "NAME");
  const roomTypeIdx = findCol("ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE");
  const losIdx = findCol("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIdx = findCol("RESERVED", "BLOCKED", "BLK");
  const checkoutDateIdx = findCol("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE");
  const checkoutTimeIdx = findCol("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME", "TIME");
  const arrivalDateIdx = findCol("INCOMING ARRIVAL DATE", "CHECKIN DATE", "CHECK-IN DATE", "ARRIVAL DATE");
  const arrivalTimeIdx = findCol("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "ARRIVAL TIME");
  const guestCodeIdx = findCol("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const guestArrivalDateIdx = findCol("GUEST ARRIVAL", "ARV", "ARV DATE", "GUEST ARRIVAL DATE");

  const rows: Record<string, unknown>[] = [];
  for (let i = headerRowIdx + 1; i < parsedLines.length; i += 1) {
    const line = parsedLines[i];
    const rawRoom = line[roomIdx] || "";
    const match = rawRoom.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0];
    if (!match) continue;
    const room = match.toUpperCase() === "MGR" ? "MGR" : match;

    const checkoutDate = checkoutDateIdx >= 0 ? line[checkoutDateIdx] || "" : "";
    const checkoutTime = checkoutTimeIdx >= 0 ? line[checkoutTimeIdx] || "" : "";
    const arrivalDate = arrivalDateIdx >= 0 ? line[arrivalDateIdx] || "" : "";
    const arrivalTime = arrivalTimeIdx >= 0 ? line[arrivalTimeIdx] || "" : "";
    const guestName = guestNameIdx >= 0 ? line[guestNameIdx] || "" : "";
    const roomStatus = statusIdx >= 0 ? line[statusIdx] || "" : "";
    const roomType = roomTypeIdx >= 0 ? line[roomTypeIdx] || "" : "";
    const guestCode = guestCodeIdx >= 0 ? line[guestCodeIdx] || "" : "";
    const guestArrivalDate = guestArrivalDateIdx >= 0 ? line[guestArrivalDateIdx] || "" : "";
    const rawStay = losIdx >= 0 ? line[losIdx] || "" : "";
    const rawRes = reservedIdx >= 0 ? line[reservedIdx] || "" : "";

    rows.push({
      room,
      checkout_date: checkoutDate,
      checkout_time: checkoutDate ? (checkoutTime || "11:00 AM") : "",
      room_status: roomStatus,
      arrival_date: arrivalDate,
      arrival_time: arrivalTime,
      guest_name: guestName,
      room_type: roomType,
      guest_code: guestCode,
      guest_arrival_date: guestArrivalDate,
      stay_nights: rawStay,
      reserved: rawRes,
    });
  }
  return rows;
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
    .select("room, guest_name, guest_code, move_from, move_to")
    .eq("hotel_id", HOTEL_ID).eq("report_date", yesterdayDate(today));
  if (yesterdayError) return NextResponse.json({ error: "Yesterday's room snapshot could not be loaded to compare room moves." }, { status: 503 });
  const rows = detectRoomMoves(yesterdayRows || [], data || []);
  return NextResponse.json({ date, rows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "edit_tickets");
  if (!auth) return NextResponse.json({ error: "Engineering ticket-edit permission is required to import room operations." }, { status: 403 });
  let body: Record<string, unknown> = {};
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
    const text = await request.text();
    body = { csv: text, source: "file" };
  } else {
    try {
      const parsed: unknown = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      } else if (typeof parsed === "string") {
        body = { csv: parsed, source: "file" };
      } else {
        throw new Error();
      }
    } catch {
      try {
        const text = await request.text();
        if (text && text.trim()) {
          body = { csv: text, source: "file" };
        } else {
          return NextResponse.json({ error: "A valid JSON import is required." }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: "A valid JSON import is required." }, { status: 400 });
      }
    }
  }
  const rawSource = shortText(body.source, "Import source", 20) || "file";
  const source = ["paste", "file"].includes(rawSource) ? rawSource : "file";
  if (!["paste", "file"].includes(source)) return NextResponse.json({ error: "Room operations can only be imported from a manual paste or file upload." }, { status: 400 });
  const reportDate = typeof body.report_date === "string" && body.report_date ? body.report_date : hotelDate();
  if (!validDate(reportDate)) return NextResponse.json({ error: "Report date is invalid." }, { status: 400 });
  if (!isRetainedDate(reportDate)) return NextResponse.json({ error: "Room operations can only be uploaded for today or yesterday." }, { status: 400 });

  if (!Array.isArray(body.rows) || !body.rows.length) {
    const csvContent = typeof body.csv === "string"
      ? body.csv
      : typeof body.text === "string"
      ? body.text
      : typeof body.content === "string"
      ? body.content
      : typeof body.file === "string"
      ? body.file
      : "";
    if (csvContent) {
      body.rows = parseCsvToRows(csvContent);
    } else if (typeof body.status_csv === "string" || typeof body.departures_csv === "string") {
      const sRows = typeof body.status_csv === "string" ? parseCsvToRows(body.status_csv) : [];
      const dRows = typeof body.departures_csv === "string" ? parseCsvToRows(body.departures_csv) : [];
      const mergedMap = new Map<string, Record<string, unknown>>();
      for (const row of sRows) {
        const r = String(row.room || "");
        if (r) mergedMap.set(r, { ...row });
      }
      for (const d of dRows) {
        const r = String(d.room || "");
        if (!r) continue;
        const existing = mergedMap.get(r) || {
          room: r,
          checkout_date: "",
          checkout_time: "",
          room_status: "",
          arrival_date: "",
          arrival_time: "",
          move_from: "",
          move_to: "",
          guest_name: "",
          room_type: "",
          guest_code: "",
          guest_arrival_date: "",
          stay_nights: 0,
          reserved: false,
        };
        existing.checkout_date = d.checkout_date || reportDate;
        existing.checkout_time = d.checkout_time || "11:00 AM";
        mergedMap.set(r, existing);
      }
      body.rows = [...mergedMap.values()];
    }
  }

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
      const rawRoom = row.room ?? row.Room ?? row["Room Number"] ?? row["room_number"];
      const match = typeof rawRoom === "string" || typeof rawRoom === "number"
        ? String(rawRoom).match(/\b(?:\d{2,4}|MGR)\b/i)?.[0]
        : null;
      if (!match) return;
      const room = roomValue(rawRoom, `Row ${index + 1} room`);
      if (room !== "MGR" && !knownRooms.has(room)) throw new Error(`Row ${index + 1}: Room ${room} is not an active CMPRI room.`);

      const checkoutDate = normalizedDate(row.checkoutDate ?? row.checkout_date ?? row["Checkout Date"]);
      const checkoutTime = normalizedDate(row.checkoutDate ?? row.checkout_date ?? row["Checkout Date"])
        ? shortText(row.checkoutTime ?? row.checkout_time ?? row["Checkout Time"], `Row ${index + 1} checkout time`, 80) || "11:00 AM"
        : "";
      const roomStatus = shortText(row.roomStatus ?? row.room_status ?? row["Room Status"] ?? row.status, `Row ${index + 1} room status`, 200);
      const arrivalDate = normalizedDate(row.arrivalDate ?? row.arrival_date ?? row["Arrival Date"]);
      const arrivalTime = shortText(row.arrivalTime ?? row.arrival_time ?? row["Arrival Time"], `Row ${index + 1} arrival time`, 80);
      const guestName = shortText(row.guestName ?? row.guest_name ?? row["Guest Name"], `Row ${index + 1} guest name`, 200);
      const roomType = shortText(row.roomType ?? row.room_type ?? row["Room Type"], `Row ${index + 1} room type`, 80);
      const guestCode = shortText(row.guestCode ?? row.guest_code ?? row["Guest Code"], `Row ${index + 1} guest code`, 80);
      const guestArrivalDate = normalizedDate(row.guestArrivalDate ?? row.guest_arrival_date ?? row["Guest Arrival"]);
      const stayNightsVal = stayNights(row.stayNights ?? row.stay_nights ?? row.LOS ?? row.los);
      const reservedVal = reserved(row.reserved ?? row.Reserved);

      const existingIdx = rows.findIndex((r) => r.room === room);
      if (existingIdx >= 0) {
        const existing = rows[existingIdx];
        if (checkoutDate) existing.checkout_date = checkoutDate;
        if (checkoutTime) existing.checkout_time = checkoutTime;
        if (roomStatus && !existing.room_status) existing.room_status = roomStatus;
        if (guestName && !existing.guest_name) existing.guest_name = guestName;
        if (roomType && !existing.room_type) existing.room_type = roomType;
        if (arrivalDate && !existing.arrival_date) existing.arrival_date = arrivalDate;
        if (arrivalTime && !existing.arrival_time) existing.arrival_time = arrivalTime;
        if (guestCode && !existing.guest_code) existing.guest_code = guestCode;
        if (guestArrivalDate && !existing.guest_arrival_date) existing.guest_arrival_date = guestArrivalDate;
        if (stayNightsVal > 0) existing.stay_nights = stayNightsVal;
        if (reservedVal) existing.reserved = true;
      } else {
        seen.add(room);
        rows.push({
          room,
          checkout_date: checkoutDate,
          checkout_time: checkoutTime,
          room_status: roomStatus,
          arrival_date: arrivalDate,
          arrival_time: arrivalTime,
          move_from: "",
          move_to: "",
          guest_name: guestName,
          room_type: roomType,
          guest_code: guestCode,
          guest_arrival_date: guestArrivalDate,
          stay_nights: stayNightsVal,
          reserved: reservedVal,
        });
      }
    });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Room-operations validation failed." }, { status: 400 }); }

  if (body.validate_only === true) {
    return NextResponse.json({ ok: true, date: reportDate, count: rows.length, rows }, { headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" } });
  }

  const actorName = auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI Engineering";
  let yesterdayRows: Array<{ room: string; guest_name: string | null; guest_code: string | null }> = [];
  if (reportDate === hotelDate()) {
    const { data, error: previousRowsError } = await auth.admin.from("cmpri_room_operations")
      .select("room, guest_name, guest_code")
      .eq("hotel_id", HOTEL_ID).eq("report_date", yesterdayDate(reportDate));
    if (previousRowsError) {
      return NextResponse.json({ error: "Yesterday's room snapshot could not be loaded to detect room moves. Nothing was imported." }, { status: 503 });
    }
    yesterdayRows = data || [];
  }
  const { data: importId, error } = await auth.admin.rpc("cmpri_replace_room_operations", {
    p_hotel_id: HOTEL_ID,
    p_report_date: reportDate,
    p_actor_id: auth.principal.identity.id,
    p_actor_name: actorName,
    p_source_type: source,
    p_rows: rows,
  });
  if (error) return NextResponse.json({ error: `Room operations were not saved: ${error.message}` }, { status: 409 });

  const notification = roomOperationsNotification(
    String(importId),
    reportDate,
    rows.map((row) => ({
      room: String(row.room),
      room_status: typeof row.room_status === "string" ? row.room_status : "",
      guest_name: typeof row.guest_name === "string" ? row.guest_name : "",
      guest_code: typeof row.guest_code === "string" ? row.guest_code : "",
    })),
    yesterdayRows.map((row) => ({ ...row, room_status: null })),
  );
  let notificationsRecorded = true;
  if (notification) {
    const { data: profiles, error: profilesError } = await auth.admin.from("profiles")
      .select("id, role, secondary_roles, active")
      .eq("active", true);
    if (profilesError) {
      notificationsRecorded = false;
    } else {
      const engineers = (profiles || [])
        .filter((profile) => profileHasRole(profile, "engineer"))
        .map((profile) => profile.id);
      const { data: memberships, error: membershipError } = engineers.length
        ? await auth.admin.from("hotel_members")
          .select("user_id")
          .eq("hotel_id", HOTEL_ID)
          .eq("active", true)
          .in("user_id", engineers)
        : { data: [], error: null };
      if (membershipError) notificationsRecorded = false;
      const recipients = new Set(
        (memberships || []).map((membership) => membership.user_id),
      );
      if (profileHasRole(auth.principal.profile, "engineer")) {
        recipients.add(auth.principal.identity.id);
      }
      if (!recipients.size) notificationsRecorded = false;
      if (recipients.size) {
        const { error: notificationError } = await auth.admin.from("cmpri_dashboard_notifications")
          .upsert([...recipients].map((recipient_user_id) => ({
            hotel_id: HOTEL_ID,
            recipient_user_id,
            notification_key: notification.id,
            work_order_id: null,
            target_path: notification.target_path,
            message: notification.message,
            recorded_at: notification.recorded_at,
          })), { onConflict: "hotel_id,recipient_user_id,notification_key", ignoreDuplicates: true });
        if (notificationError) notificationsRecorded = false;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    import_id: importId,
    date: reportDate,
    count: rows.length,
    notifications_recorded: notificationsRecorded,
  });
}
