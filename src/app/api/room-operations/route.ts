import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { HOTEL_ID, HOTEL_TIME_ZONE } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { detectRoomMoves } from "@/lib/room-operations";
import { roomOperationsNotification } from "@/lib/dashboard/room-operations-notifications";
import { profileHasRole } from "@/lib/server/roles";
import { normalizePrintedTime, parsePrintedReport, reportReplacementError, hotelDateAt, type AcceptedReportVersion, type PrintedReport } from "@/lib/room-operations-reports";
import { loadEffectiveRoomOperationsSnapshot } from "@/lib/server/cmpri-room-operations-snapshot";

function hotelDate() {
  return hotelDateAt(new Date(), HOTEL_TIME_ZONE);
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

function normalizedDate(value: unknown, referenceDate = hotelDate()): string {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!text) return "";
  const isoMatch = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (isoMatch) {
    const iso = `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    return validDate(iso) ? iso : "";
  }
  const shortDate = text.match(/^(\d{1,2})([A-Za-z]{3})(\d{2}|\d{4})?$/);
  if (shortDate) {
    const month = new Date(`${shortDate[2]} 1, 2000`).getMonth() + 1;
    if (!month) return "";
    const day = Number(shortDate[1]);
    const explicitYear = shortDate[3]
      ? Number(shortDate[3].length === 2 ? `20${shortDate[3]}` : shortDate[3])
      : null;
    const years = explicitYear
      ? [explicitYear]
      : [Number(referenceDate.slice(0, 4)) - 1, Number(referenceDate.slice(0, 4)), Number(referenceDate.slice(0, 4)) + 1];
    const candidates = years
      .map((year) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
      .filter(validDate);
    if (candidates.length) {
      return candidates.sort((a, b) =>
        Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${referenceDate}T12:00:00Z`))
        - Math.abs(Date.parse(`${b}T12:00:00Z`) - Date.parse(`${referenceDate}T12:00:00Z`))
      )[0];
    }
    return "";
  }
  const us = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4}|\d{2})/);
  if (us) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    const iso = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    return validDate(iso) ? iso : "";
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
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return text;
}

function stayNights(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/[^\d]/g, "") : "";
  if (!text) return 0;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > 3650) return -1;
  return parsed;
}

function reserved(value: unknown, label = "reservation indicator") {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (
    ["true", "yes", "y", "1", "reserved", "blk", "blocked", "x", "✓", "✔"].includes(normalized)
    || (/^\d+$/.test(normalized) && Number(normalized) > 0)
  ) return true;
  if (["false", "no", "n", "0", "not reserved", "unblocked", "none"].includes(normalized)) return false;
  throw new Error(`${label} '${String(value)}' is not a verified yes/no value.`);
}

function missingCurrentGuestFields(rows: Record<string, unknown>[]) {
  const requiredFields = [
    ["guest_name", "guest name"],
    ["guest_code", "guest code"],
    ["room_type", "room type"],
    ["guest_arrival_date", "current guest arrival date"],
    ["checkout_date", "current guest departure date"],
    ["stay_nights", "length of stay"],
  ] as const;
  return rows.flatMap((row) => {
    if (!/\boccupied\b/i.test(String(row.room_status || ""))) return [];
    const missing = requiredFields
      .filter(([field]) => !String(row[field] ?? "").trim() || String(row[field]).trim() === "[UNREADABLE]")
      .map(([, label]) => label);
    return missing.length
      ? [`Room ${String(row.room)}${row.source_page ? ` (source page ${row.source_page})` : ""}: ${missing.join(", ")}`]
      : [];
  });
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
      return norm === "ROOM" || norm === "ROOM #" || norm === "RM #" || norm === "RM" || norm === "ROOM NUMBER";
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

  const roomIdx = findCol("ROOM", "ROOM #", "ROOM NUMBER", "RM #", "RM");
  if (roomIdx < 0) return [];
  const statusIdx = findCol("ROOM STATUS", "HOUSEKEEPING STATUS", "HK STATUS", "ROOM CONDITION", "CONDITION", "STATUS");
  const guestNameIdx = findCol("GUEST NAME", "GUEST / NAME", "GUEST", "NAME");
  const roomTypeIdx = findCol("ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE");
  const losIdx = findCol("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIdx = findCol("RESERVED", "BLOCKED", "BLK", "BLK'D", "BLK’D", "BLKD");
  const checkoutDateIdx = findCol("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE", "DEP");
  const checkoutTimeIdx = findCol("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME", "DPLM", "TIME");
  const arrivalDateIdx = headers.includes("INCOMING ARRIVAL DATE")
    ? headers.indexOf("INCOMING ARRIVAL DATE")
    : findCol("DUE IN", "CHECKIN DATE", "CHECK-IN DATE", "ARRIVAL DATE");
  const arrivalTimeIdx = findCol("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "ARRIVAL TIME");
  const guestCodeIdx = findCol("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const guestArrivalDateIdx = findCol("CURRENT GUEST ARRIVAL DATE", "GUEST ARRIVAL DATE", "GUEST ARRIVAL", "ARV DATE", "ARV");
  const incomingNameIdx = findCol("INCOMING GUEST NAME", "BLOCK NAME", "INCOMING NAME");
  const incomingTypeIdx = findCol("INCOMING ROOM TYPE", "BLOCK TYPE", "INCOMING TYPE");
  const incomingCodeIdx = findCol("INCOMING GUEST CODE", "BLOCK CODE", "INCOMING CODE");
  const incomingIndicatorIdx = findCol("INCOMING BLOCK INDICATOR", "BLOCK INDICATOR", "RESERVATION INDICATOR");
  const incomingReservedIdx = findCol("INCOMING RESERVED", "INCOMING BLOCKED", "INCOMING BLOCK", "RESERVATION");
  const sourcePageIdx = findCol("SOURCE PAGE", "PAGE");
  const moveFromIdx = findCol("MOVE FROM", "MOVED FROM", "FROM ROOM");
  const moveToIdx = findCol("MOVE TO", "MOVED TO", "TO ROOM");

  const rows: Record<string, unknown>[] = [];
  for (let i = headerRowIdx + 1; i < parsedLines.length; i += 1) {
    const line = parsedLines[i];
    const rawRoom = line[roomIdx] || "";
    const match = rawRoom.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0];
    if (!match && (!rawRoom.trim() || /^(?:total|grand total|occupancy|occupancy %|page)\b/i.test(rawRoom.trim()))) continue;
    if (!match) throw new Error(`Report line ${i + 1}: room identifier '${rawRoom}' could not be mapped.`);
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
      checkout_time: checkoutDate ? checkoutTime : "",
      room_status: roomStatus,
      arrival_date: arrivalDate,
      arrival_time: arrivalTime,
      guest_name: guestName,
      room_type: roomType,
      guest_code: guestCode,
      guest_arrival_date: guestArrivalDate,
      stay_nights: rawStay,
      reserved: rawRes,
      incoming_name: incomingNameIdx >= 0 ? line[incomingNameIdx] || "" : "",
      incoming_type: incomingTypeIdx >= 0 ? line[incomingTypeIdx] || "" : "",
      incoming_code: incomingCodeIdx >= 0 ? line[incomingCodeIdx] || "" : "",
      incoming_arrival_date: arrivalDate,
      incoming_arrival_time: arrivalTime,
      incoming_block_indicator: incomingIndicatorIdx >= 0 ? line[incomingIndicatorIdx] || "" : "",
      incoming_reserved: incomingReservedIdx >= 0 ? line[incomingReservedIdx] || "" : "",
      source_page: sourcePageIdx >= 0 ? line[sourcePageIdx] || "" : String(i + 1),
      checkout_from_expected_departures: false,
      move_from: moveFromIdx >= 0 ? line[moveFromIdx] || "" : "",
      move_to: moveToIdx >= 0 ? line[moveToIdx] || "" : "",
    });
  }
  return rows;
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "view_engineering_operations");
  if (!auth) return NextResponse.json({ error: "Engineering operations access is required." }, { status: 403 });
  const date = request.nextUrl.searchParams.get("date") || hotelDate();
  if (!validDate(date)) return NextResponse.json({ error: "Room-operations date is invalid." }, { status: 400 });
  const today = hotelDate();
  if (!isRetainedDate(date, today)) return NextResponse.json({ error: "Only today's and yesterday's room-operations snapshots are retained." }, { status: 400 });
  const { error: reconcileError } = await auth.admin.rpc("cmpri_reconcile_room_operations");
  if (reconcileError) return NextResponse.json({ error: `Scheduled room checkout transitions could not be reconciled: ${reconcileError.message}` }, { status: 503 });
  const snapshot = await loadEffectiveRoomOperationsSnapshot(auth.admin, date);
  if (snapshot.error) return NextResponse.json({ error: "Effective room-operations snapshot could not be loaded." }, { status: 503 });
  const legacy = snapshot.source_type === "legacy";
  const provenance = snapshot.source_date
    ? legacy
      ? `Legacy room snapshot from ${snapshot.source_date}; original report metadata is unavailable.`
      : snapshot.carried_over
        ? `Carried over from the accepted report dated ${snapshot.source_date}.`
        : `Accepted room report dated ${snapshot.source_date}.`
    : null;
  return NextResponse.json({
    date,
    source_date: snapshot.source_date,
    source_type: snapshot.source_type,
    carried_over: snapshot.carried_over,
    provenance,
    rows: snapshot.rows,
  }, { headers: { "Cache-Control": "no-store" } });
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
  let reportData = body.report_data && typeof body.report_data === "object" && !Array.isArray(body.report_data)
    ? body.report_data as Record<string, unknown>
    : null;
  if (!reportData) {
    const statusCsv = typeof body.status_csv === "string" ? body.status_csv : "";
    const departuresCsv = typeof body.departures_csv === "string" ? body.departures_csv : "";
    const csvContent = statusCsv || departuresCsv
      ? statusCsv
      : typeof body.csv === "string"
      ? body.csv
      : typeof body.text === "string"
      ? body.text
      : typeof body.content === "string"
      ? body.content
      : typeof body.file === "string"
      ? body.file
      : "";
    const statusMeta = parsePrintedReport(statusCsv || csvContent, "Room Status Report");
    if (statusMeta.error || !statusMeta.report) {
      return NextResponse.json({ error: statusMeta.error || "Room Status Report printed date cannot be verified. Nothing was replaced." }, { status: 422 });
    }
    let departureMeta: PrintedReport | null = null;
    let departureRows: Record<string, unknown>[] = [];
    if (departuresCsv) {
      const parsedDepartureMeta = parsePrintedReport(departuresCsv, "Expected Departures");
      if (parsedDepartureMeta.error || !parsedDepartureMeta.report) {
        return NextResponse.json({ error: parsedDepartureMeta.error || "Expected Departures printed date cannot be verified. Nothing was replaced." }, { status: 422 });
      }
      departureMeta = parsedDepartureMeta.report;
      departureRows = parseCsvToRows(departuresCsv);
    }
    reportData = {
      room_status: { ...statusMeta.report, pages: [1], rows: parseCsvToRows(statusCsv || csvContent) },
      expected_departures: departureMeta ? { ...departureMeta, pages: [1], rows: departureRows } : null,
    };
  }

  const roomStatusReport = reportData.room_status && typeof reportData.room_status === "object" && !Array.isArray(reportData.room_status)
    ? reportData.room_status as Record<string, unknown>
    : null;
  if (!roomStatusReport || !Array.isArray(roomStatusReport.rows)) {
    return NextResponse.json({ error: "Room Status Report identity or room rows are missing. Nothing was replaced." }, { status: 422 });
  }
  const normalizeReportMetadata = (value: Record<string, unknown>, label: string): { report: PrintedReport | null; error: string | null } => {
    const date = typeof value.printed_date === "string" ? value.printed_date.trim() : "";
    const timeValue = typeof value.printed_time === "string" ? value.printed_time.trim() : "";
    if (!validDate(date)) return { report: null, error: `${label} printed date is missing or invalid. Nothing was replaced.` };
    if (timeValue && !normalizePrintedTime(timeValue)) return { report: null, error: `${label} printed generation time is present but cannot be verified. Nothing was replaced.` };
    return { report: { printed_date: date, printed_time: normalizePrintedTime(timeValue) }, error: null };
  };
  const statusMetadata = normalizeReportMetadata(roomStatusReport, "Room Status Report");
  if (statusMetadata.error || !statusMetadata.report) return NextResponse.json({ error: statusMetadata.error }, { status: 422 });
  const reportDate = statusMetadata.report.printed_date;
  const today = hotelDate();
  if (typeof body.report_date === "string" && body.report_date && body.report_date !== reportDate) {
    return NextResponse.json({ error: `Selected report date ${body.report_date} does not match the report's printed date ${reportDate}. Nothing was replaced.` }, { status: 422 });
  }
  if (reportDate !== today) {
    return NextResponse.json({ error: `Room Status Report is printed for ${reportDate}; a new daily replacement requires the current hotel date ${today}. Nothing was replaced.` }, { status: 422 });
  }

  let expectedReport: Record<string, unknown> | null = null;
  if (reportData.expected_departures !== null && reportData.expected_departures !== undefined) {
    if (typeof reportData.expected_departures !== "object" || Array.isArray(reportData.expected_departures)) {
      return NextResponse.json({ error: "Expected Departures report data is invalid. Nothing was replaced." }, { status: 422 });
    }
    expectedReport = reportData.expected_departures as Record<string, unknown>;
    if (!Array.isArray(expectedReport.rows)) return NextResponse.json({ error: "Expected Departures rows are incomplete. Nothing was replaced." }, { status: 422 });
  }
  let expectedMetadata: PrintedReport | null = null;
  if (expectedReport) {
    const parsedExpectedMetadata = normalizeReportMetadata(expectedReport, "Expected Departures");
    if (parsedExpectedMetadata.error || !parsedExpectedMetadata.report) return NextResponse.json({ error: parsedExpectedMetadata.error }, { status: 422 });
    expectedMetadata = parsedExpectedMetadata.report;
    if (expectedMetadata.printed_date !== today) {
      return NextResponse.json({ error: `Expected Departures is printed for ${expectedMetadata.printed_date}; a new replacement requires a current-date report printed for ${today}. Nothing was replaced.` }, { status: 422 });
    }
  }
  const statusFingerprint = createHash("sha256").update(JSON.stringify({
    report: statusMetadata.report,
    pages: roomStatusReport.pages,
    rows: (roomStatusReport.rows as Record<string, unknown>[])
      .slice()
      .sort((a, b) => String(a.room || "").localeCompare(String(b.room || ""), undefined, { numeric: true })),
  })).digest("hex");
  const { data: latestImports, error: latestImportsError } = await auth.admin.from("cmpri_room_operation_imports")
    .select("report_date, status_printed_time, status_fingerprint, expected_departures_printed_date, expected_departures_printed_time, expected_departures_uploaded_at, departures_fingerprint, departures_rows, uploaded_at, source_type")
    .neq("source_type", "legacy")
    .eq("hotel_id", HOTEL_ID).order("uploaded_at", { ascending: false }).limit(1);
  if (latestImportsError) return NextResponse.json({ error: "Latest accepted room report could not be checked. Nothing was replaced." }, { status: 503 });
  const latestImport = latestImports?.[0] || null;
  const latestStatus: AcceptedReportVersion | null = latestImport ? {
    printed_date: String(latestImport.report_date),
    printed_time: normalizePrintedTime(latestImport.status_printed_time),
    fingerprint: String(latestImport.status_fingerprint || ""),
  } : null;
  const statusFreshnessError = reportReplacementError("Room Status Report", statusMetadata.report, latestStatus, today, statusFingerprint);
  if (statusFreshnessError) return NextResponse.json({ error: statusFreshnessError }, { status: 409 });

  let expectedWasCarried = false;
  let expectedUploadedAt = "";
  if (!expectedReport && latestImport?.expected_departures_printed_date === today && Array.isArray(latestImport.departures_rows)) {
    expectedReport = {
      printed_date: String(latestImport.expected_departures_printed_date),
      printed_time: latestImport.expected_departures_printed_time,
      pages: [1],
      rows: latestImport.departures_rows,
    };
    expectedMetadata = {
      printed_date: String(latestImport.expected_departures_printed_date),
      printed_time: normalizePrintedTime(latestImport.expected_departures_printed_time),
    };
    expectedWasCarried = true;
    expectedUploadedAt = String(latestImport.expected_departures_uploaded_at || latestImport.uploaded_at || "");
  }
  let departuresFingerprint = "";
  if (expectedReport && expectedMetadata) {
    departuresFingerprint = String(expectedWasCarried ? latestImport?.departures_fingerprint || "" : createHash("sha256").update(JSON.stringify({
      report: expectedMetadata,
      pages: expectedReport.pages,
      rows: (expectedReport.rows as Record<string, unknown>[])
        .slice()
        .sort((a, b) => String(a.room || "").localeCompare(String(b.room || ""), undefined, { numeric: true })),
    })).digest("hex"));
    if (!expectedWasCarried) {
      const { data: latestExpectedImports, error: latestExpectedError } = await auth.admin.from("cmpri_room_operation_imports")
        .select("expected_departures_printed_date, expected_departures_printed_time, departures_fingerprint")
        .neq("source_type", "legacy")
        .eq("hotel_id", HOTEL_ID).not("expected_departures_printed_date", "is", null)
        .order("uploaded_at", { ascending: false }).limit(1);
      if (latestExpectedError) return NextResponse.json({ error: "Latest accepted Expected Departures report could not be checked. Nothing was replaced." }, { status: 503 });
      const latestExpectedImport = latestExpectedImports?.[0];
      const latestExpected: AcceptedReportVersion | null = latestExpectedImport ? {
        printed_date: String(latestExpectedImport.expected_departures_printed_date),
        printed_time: normalizePrintedTime(latestExpectedImport.expected_departures_printed_time),
        fingerprint: String(latestExpectedImport.departures_fingerprint || ""),
      } : null;
      const expectedFreshnessError = reportReplacementError("Expected Departures", expectedMetadata, latestExpected, today, departuresFingerprint);
      if (expectedFreshnessError) return NextResponse.json({ error: expectedFreshnessError }, { status: 409 });
    }
  }
  const reportedPages = roomStatusReport.pages;
  if (!Array.isArray(reportedPages) || !reportedPages.length || reportedPages.some((page) => !Number.isInteger(page) || Number(page) < 1)) {
    return NextResponse.json({ error: "Room Status Report pages could not be verified. Nothing was replaced." }, { status: 422 });
  }
  if (expectedReport && (!Array.isArray(expectedReport.pages) || !(expectedReport.pages as unknown[]).length)) {
    return NextResponse.json({ error: "Expected Departures pages could not be verified. Nothing was replaced." }, { status: 422 });
  }

  const rawRows = roomStatusReport.rows as unknown[];
  if (rawRows.length < 1 || rawRows.length > 500) return NextResponse.json({ error: "Import between 1 and 500 room rows." }, { status: 400 });

  const { data: locations, error: locationError } = await auth.admin.from("locations")
    .select("room_number, name").eq("hotel_id", HOTEL_ID).eq("active", true).limit(2000);
  if (locationError || !locations || locations.length >= 2000) return NextResponse.json({ error: "CMPRI room list could not be verified. Nothing was imported." }, { status: 503 });
  const knownRooms = new Set(locations.map((location) => {
    const value = String(location.room_number || location.name?.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "").trim();
    return value.toUpperCase() === "MGR" ? "MGR" : value;
  }).filter(Boolean));
  const rows: Record<string, unknown>[] = [];
  try {
    const statusRooms = new Set<string>();
    const expectedByRoom = new Map<string, Record<string, unknown>>();
    if (expectedReport) {
      for (const [index, value] of (expectedReport.rows as unknown[]).entries()) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected Departures row ${index + 1} is invalid.`);
        const departure = value as Record<string, unknown>;
        const room = roomValue(departure.room ?? departure["Room Number"], `Expected Departures row ${index + 1} room`);
        if (room !== "MGR" && !knownRooms.has(room)) throw new Error(`Expected Departures row ${index + 1}: Room ${room} is not an active CMPRI room.`);
        if (expectedByRoom.has(room)) throw new Error(`Expected Departures maps Room ${room} more than once (source page ${String(departure.source_page || index + 1)}).`);
        expectedByRoom.set(room, departure);
      }
    }
    for (const [index, value] of rawRows.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Room Status row ${index + 1} is invalid.`);
      const row = value as Record<string, unknown>;
      const rawRoom = row.room ?? row.Room ?? row["Room Number"] ?? row["room_number"];
      const room = roomValue(rawRoom, `Room Status row ${index + 1} room`);
      const sourcePage = shortText(row.source_page ?? row.sourcePage, `Room ${room} source page`, 40) || String(index + 1);
      if (statusRooms.has(room)) throw new Error(`Room Status Report maps Room ${room} more than once (source page ${sourcePage}).`);
      statusRooms.add(room);
      if (room !== "MGR" && !knownRooms.has(room)) throw new Error(`Room Status source page ${sourcePage}: Room ${room} is not an active CMPRI room.`);

      const expected = expectedByRoom.get(room);
      const expectedDateRaw = expected?.checkout_date ?? expected?.checkoutDate;
      const departureDateRaw = expectedDateRaw || row.checkout_date || row.checkoutDate || row["Departure Date"] || row.Dep;
      const checkoutDate = departureDateRaw
        ? normalizedDate(departureDateRaw, reportDate)
        : expected ? reportDate : "";
      if (departureDateRaw && !checkoutDate) throw new Error(`Room ${room} checkout date on source page ${sourcePage} could not be read as a valid date.`);
      const expectedTimeRaw = expected?.checkout_time ?? expected?.checkoutTime;
      const statusTimeRaw = row.checkout_time ?? row.checkoutTime ?? row["Departure Time"] ?? row.Dplm;
      const timeSource = expectedTimeRaw || statusTimeRaw;
      const parsedCheckoutTime = timeSource ? normalizePrintedTime(String(timeSource)) : null;
      if (timeSource && !parsedCheckoutTime) throw new Error(`Room ${room} checkout time on source page ${String(expected?.source_page || sourcePage)} could not be verified.`);
      const checkoutTime = checkoutDate ? parsedCheckoutTime || "11:00:00" : "";
      const roomStatus = shortText(row.room_status ?? row.roomStatus ?? row["Room Status"] ?? row.status, `Room ${room} status`, 200);
      const arrivalDateRaw = row.incoming_arrival_date ?? row.arrival_date ?? row.arrivalDate ?? row["Incoming Arrival Date"] ?? row["Due In"];
      const arrivalDate = normalizedDate(arrivalDateRaw, reportDate);
      if (arrivalDateRaw && !arrivalDate) throw new Error(`Room ${room} incoming arrival date on source page ${sourcePage} could not be verified.`);
      const arrivalTimeRaw = row.incoming_arrival_time ?? row.arrival_time ?? row.arrivalTime ?? row["Arrival Time"];
      const arrivalTimeText = shortText(arrivalTimeRaw, `Room ${room} incoming arrival time`, 80);
      const arrivalTime = arrivalTimeText ? normalizePrintedTime(arrivalTimeText) : null;
      if (arrivalTimeText && !arrivalTime) throw new Error(`Room ${room} incoming arrival time on source page ${sourcePage} could not be verified.`);
      const guestName = shortText(row.guest_name ?? row.guestName ?? row["Guest Name"], `Room ${room} guest name`, 200);
      const roomType = shortText(row.room_type ?? row.roomType ?? row["Room Type"], `Room ${room} room type`, 80);
      const guestCode = shortText(row.guest_code ?? row.guestCode ?? row["Guest Code"] ?? row.Code, `Room ${room} guest code`, 80);
      const guestArrivalRaw = row.guest_arrival_date ?? row.guestArrivalDate ?? row["Guest Arrival"] ?? row["Guest Arrival Date"] ?? row["ARV Date"] ?? row.ARV;
      const guestArrivalDate = normalizedDate(guestArrivalRaw, reportDate);
      if (guestArrivalRaw && !guestArrivalDate) throw new Error(`Room ${room} current guest arrival date on source page ${sourcePage} could not be verified.`);
      const rawNights = row.stay_nights ?? row.stayNights ?? row.LOS ?? row.los;
      const stayNightsVal = stayNights(rawNights);
      if (rawNights !== undefined && rawNights !== null && String(rawNights).trim() && !stayNightsVal && String(rawNights).trim() !== "0") {
        throw new Error(`Room ${room} length of stay on source page ${sourcePage} must be a whole number.`);
      }
      const reservedRaw = row.reserved ?? row.Reserved ?? row.blocked ?? row["BLK'D"] ?? row["BLK’D"] ?? row.BLK;
      const reservedVal = reserved(reservedRaw);
      const incomingName = shortText(row.incoming_name ?? row.incomingName ?? row["Incoming Guest Name"], `Room ${room} incoming guest name`, 200);
      const incomingType = shortText(row.incoming_type ?? row.incomingType ?? row["Incoming Room Type"], `Room ${room} incoming room type`, 80);
      const incomingCode = shortText(row.incoming_code ?? row.incomingCode ?? row["Incoming Guest Code"], `Room ${room} incoming guest code`, 80);
      const incomingIndicator = shortText(row.incoming_block_indicator ?? row.incomingBlockIndicator ?? row["Incoming Block Indicator"], `Room ${room} incoming block indicator`, 80);
      const incomingReserved = reserved(row.incoming_reserved ?? row.incomingReserved);
      if ([incomingName, incomingType, incomingCode, incomingIndicator].some((value) => value === "[UNREADABLE]")) {
        throw new Error(`Room ${room} incoming reservation detail on source page ${sourcePage} is unreadable. Nothing was replaced.`);
      }
      const hasIncomingReservation = incomingReserved || Boolean(incomingIndicator || incomingName || incomingType || incomingCode || arrivalDate || arrivalTime);
      if (hasIncomingReservation && (!incomingName || incomingName === "[UNREADABLE]")) {
        throw new Error(`Room ${room} incoming guest name on source page ${sourcePage} is required for the reported reservation. Nothing was replaced.`);
      }
      const moveFromRaw = shortText(row.move_from ?? row.moveFrom ?? row["Move From"] ?? row["Moved From"], `Room ${room} move from`, 20);
      const moveToRaw = shortText(row.move_to ?? row.moveTo ?? row["Move To"] ?? row["Moved To"], `Room ${room} move to`, 20);
      const moveFrom = moveFromRaw ? roomValue(moveFromRaw, `Room ${room} move from`) : "";
      const moveTo = moveToRaw ? roomValue(moveToRaw, `Room ${room} move to`) : "";
      if (roomStatus === "[UNREADABLE]") throw new Error(`Room ${room} status on source page ${sourcePage} is unreadable.`);
      if (/\boccupied\b/i.test(roomStatus)) {
        const required = [
          ["guest name", guestName],
          ["guest code", guestCode],
          ["room type", roomType],
          ["current guest arrival date", guestArrivalDate],
          ["current guest departure date", checkoutDate],
          ["length of stay", rawNights === undefined || rawNights === null ? "" : String(rawNights).trim()],
        ].filter(([, value]) => !value || value === "[UNREADABLE]").map(([label]) => label);
        if (required.length) {
          throw new Error(`Room ${room} current guest details on source page ${sourcePage} are incomplete or unreadable: ${required.join(", ")}. Nothing was replaced.`);
        }
      }

      rows.push({
        room,
        checkout_date: checkoutDate,
        checkout_time: checkoutTime,
        checkout_time_explicit: Boolean(parsedCheckoutTime),
        checkout_from_expected_departures: Boolean(expectedTimeRaw),
        checkout_source_report_date: expectedDateRaw || expectedTimeRaw ? expectedMetadata?.printed_date || reportDate : reportDate,
        checkout_source_is_expected: Boolean(expectedDateRaw || expectedTimeRaw),
        room_status: roomStatus,
        arrival_date: arrivalDate,
        arrival_time: arrivalTime,
        move_from: moveFrom,
        move_to: moveTo,
        guest_name: guestName,
        room_type: roomType,
        guest_code: guestCode,
        guest_arrival_date: guestArrivalDate,
        stay_nights: stayNightsVal,
        reserved: reservedVal,
        incoming_name: incomingName,
        incoming_type: incomingType,
        incoming_code: incomingCode,
        incoming_block_indicator: incomingIndicator,
        incoming_reserved: incomingReserved,
        source_page: sourcePage,
      });
    }
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Room-operations validation failed." }, { status: 422 }); }

  const importedRooms = new Set(rows.map((row) => String(row.room)));
  const missingRooms = [...knownRooms].filter((room) => !importedRooms.has(room)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const missingStatuses = rows.filter((row) => !String(row.room_status || "").trim()).map((row) => String(row.room));
  const pagesWithRows = new Set(rows.map((row) => String(row.source_page || "")));
  const pagesWithoutRows = reportedPages
    .map((page) => String(page))
    .filter((page) => !pagesWithRows.has(page) && ![...pagesWithRows].some((reported) => new RegExp(`\\b${page}\\b`).test(reported)));
  if (pagesWithoutRows.length) {
    return NextResponse.json({ error: `Room Status Report page(s) ${pagesWithoutRows.join(", ")} contain no verified room rows. Nothing was replaced.` }, { status: 422 });
  }
  if (missingRooms.length || missingStatuses.length) {
    const details = [
      missingRooms.length ? `missing rooms: ${missingRooms.slice(0, 20).join(", ")}${missingRooms.length > 20 ? ` and ${missingRooms.length - 20} more` : ""}` : "",
      missingStatuses.length ? `missing room status: ${missingStatuses.slice(0, 20).join(", ")}${missingStatuses.length > 20 ? ` and ${missingStatuses.length - 20} more` : ""}` : "",
    ].filter(Boolean).join("; ");
    return NextResponse.json({
      error: `Room snapshot is incomplete (${details}). Nothing was saved. Include every active room and its reported room status, then retry.`,
    }, { status: 422 });
  }

  const missingGuestFields = missingCurrentGuestFields(rows);
  if (missingGuestFields.length) {
    const details = missingGuestFields.slice(0, 20).join("; ");
    return NextResponse.json({
      error: `Current guest details are incomplete for occupied rooms (${details}${missingGuestFields.length > 20 ? `; and ${missingGuestFields.length - 20} more rooms` : ""}). Nothing was saved. Include the current guest's name, code, arrival date, and departure date, then retry.`,
    }, { status: 422 });
  }

  if (body.validate_only === true) {
    return NextResponse.json({
      ok: true,
      date: reportDate,
      count: rows.length,
      rows,
      report_metadata: { room_status: statusMetadata.report, expected_departures: expectedMetadata },
    }, { headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" } });
  }

  const actorName = auth.principal.profile.full_name || auth.principal.identity.email || "CMPRI Engineering";
  const { data: acceptedHistory, error: historyError } = await auth.admin.from("cmpri_room_operation_imports")
    .select("source_rows, status_fingerprint, departures_fingerprint")
    .neq("source_type", "legacy")
    .eq("hotel_id", HOTEL_ID).order("uploaded_at", { ascending: false }).limit(2);
  if (historyError) return NextResponse.json({ error: "Accepted room-report history could not be loaded to compare room moves. Nothing was imported." }, { status: 503 });
  const previousImport = (acceptedHistory || []).find((item) =>
    item.status_fingerprint !== statusFingerprint || item.departures_fingerprint !== departuresFingerprint
  );
  const previousRows = Array.isArray(previousImport?.source_rows)
    ? previousImport.source_rows as Array<Record<string, unknown> & {
      room: string;
      guest_name: string | null;
      guest_code: string | null;
      move_from?: string | null;
      move_to?: string | null;
      room_status?: string | null;
      checkout_source_is_expected?: boolean;
    }>
    : [];
  const rowsWithMoves = detectRoomMoves(previousRows, rows.map((row) => ({
    ...row,
    room: String(row.room),
    room_status: String(row.room_status || ""),
    guest_name: String(row.guest_name || ""),
    guest_code: String(row.guest_code || ""),
    move_from: String(row.move_from || ""),
    move_to: String(row.move_to || ""),
  })));
  const uploadedAt = new Date().toISOString();
  const rowsForStorage = rowsWithMoves.map((row) => ({
    ...row,
    source_row: row,
    source_report_date: reportDate,
    source_uploaded_at: uploadedAt,
    checkout_source_uploaded_at: row.checkout_source_is_expected
      ? expectedWasCarried ? expectedUploadedAt : uploadedAt
      : uploadedAt,
    status_printed_date: reportDate,
    status_printed_time: statusMetadata.report?.printed_time || "",
    expected_departures_printed_date: expectedMetadata?.printed_date || "",
    expected_departures_printed_time: expectedMetadata?.printed_time || "",
    expected_departures_uploaded_at: expectedWasCarried ? expectedUploadedAt : expectedMetadata ? uploadedAt : "",
    status_fingerprint: statusFingerprint,
    departures_fingerprint: departuresFingerprint,
    expected_departures_rows: expectedReport?.rows || [],
    report_pages: reportedPages,
  }));
  const { data: importId, error } = await auth.admin.rpc("cmpri_replace_room_operations", {
    p_hotel_id: HOTEL_ID,
    p_report_date: reportDate,
    p_actor_id: auth.principal.identity.id,
    p_actor_name: actorName,
    p_source_type: source,
    p_rows: rowsForStorage,
  });
  if (error) return NextResponse.json({ error: `Room operations were not saved: ${error.message}` }, { status: 409 });

  const checkoutRooms = [...new Set(rows
    .filter((row) => row.checkout_date === reportDate)
    .map((row) => String(row.room)))];
  let checkoutWorkOrders: Array<{
    room: string;
    display_id: string | null;
    issue: string;
    status: string;
  }> | null = [];
  if (checkoutRooms.length) {
    const { data: workOrders, error: workOrdersError } = await auth.admin.from("work_orders")
      .select("display_id, room, issue, status")
      .eq("hotel_id", HOTEL_ID)
      .in("room", checkoutRooms)
      .in("status", ["Open", "In Progress"])
      .limit(500);
    if (workOrdersError) {
      checkoutWorkOrders = null;
    } else {
      checkoutWorkOrders = (workOrders || []).map((workOrder) => ({
        room: String(workOrder.room || ""),
        display_id: typeof workOrder.display_id === "string" ? workOrder.display_id : null,
        issue: String(workOrder.issue || ""),
        status: String(workOrder.status || ""),
      }));
    }
  }

  const notification = roomOperationsNotification(
    String(importId),
    reportDate,
    rows.map((row) => ({
      room: String(row.room),
      room_status: typeof row.room_status === "string" ? row.room_status : "",
      guest_name: typeof row.guest_name === "string" ? row.guest_name : "",
      guest_code: typeof row.guest_code === "string" ? row.guest_code : "",
    })),
    previousRows.map((row) => ({ ...row, room_status: null })),
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
    checkout_work_orders: checkoutWorkOrders,
  });
}
