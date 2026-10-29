"use client";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";

import { useState } from "react";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { formatCheckoutRoomWorkOrders, summarizeRoomOperations, type CheckoutRoomWorkOrder } from "@/lib/room-operations";
import { isPmsRoomStatus, preparePmsReportPair, parsePrintedReport, type PrintedReport } from "@/lib/room-operations-reports";
import {
  extractAndValidateRoomOperations,
  isRecoverableRoomOperationsValidationError,
  ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT,
  RoomOperationsRecoveryIssue,
} from "@/lib/room-operations-recovery";

type ImportSource = "paste" | "file";
type RoomStatusRow = {
  room: string;
  roomStatus: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  guestName: string;
  roomType: string;
  guestCode: string;
  guestArrivalDate: string;
  stayNights: number;
  reserved: boolean;
  incomingName: string;
  incomingType: string;
  incomingCode: string;
  incomingBlockIndicator: string;
  incomingReserved: boolean;
  sourcePage: string;
  moveFrom: string;
  moveTo: string;
};
type DepartureRow = {
  room: string;
  checkoutDate: string;
  checkoutTime: string;
};
type ValidatedRow = {
  next_reservation_date?: string;
  room: string;
  checkout_date: string;
  checkout_time: string;
  room_status: string;
  arrival_date: string;
  arrival_time: string;
  move_from: string;
  move_to: string;
  guest_name: string;
  room_type: string;
  guest_code: string;
  guest_arrival_date: string;
  stay_nights: number;
  reserved: boolean;
  incoming_name: string;
  incoming_type: string;
  incoming_code: string;
  incoming_block_indicator: string;
  incoming_reserved: boolean;
  source_page: string;
  checkout_from_expected_departures: boolean;
};
type SnapshotRow = ValidatedRow & { imported_at: string | null };
type ReportData = {
  room_status: PrintedReport & { pages: number[]; rows: Record<string, unknown>[] };
  expected_departures: (PrintedReport & { pages: number[]; rows: Record<string, unknown>[] }) | null;
};
type ImportPreview = { date: string; source: ImportSource; rows: ValidatedRow[]; report_data: ReportData };

function missingCurrentGuestNames(rows: ValidatedRow[]) {
  return rows
    .filter((row) =>
      /\boccupied\b/i.test(row.room_status)
      && Boolean(row.guest_code || row.guest_arrival_date || row.checkout_date)
      && !row.guest_name.trim()
    )
    .map((row) => row.room);
}

function normalizeSnapshotTime(value: string | null | undefined) {
  const text = value?.trim() || "";
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return text.toLowerCase();

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || "0");
  const meridiem = match[4]?.toUpperCase();
  if (
    minutes > 59
    || seconds > 59
    || (meridiem ? hours < 1 || hours > 12 : hours > 23)
  ) return text.toLowerCase();

  if (meridiem) hours = (hours % 12) + (meridiem === "PM" ? 12 : 0);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeSnapshotValue(value: string | null | undefined) {
  return value?.trim() || "";
}

function hotelDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOTEL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeHeader(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function parseDelimitedLine(line: string, delimiter: string) {
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

function parseReport(raw: string, label: string) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error(`${label} is required.`);
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : ",";
  const rows = lines.map((line) => parseDelimitedLine(line, delimiter));
  const headerIndex = rows.findIndex((row) => row.some((cell) =>
    ["ROOM", "ROOM #", "ROOM NUMBER", "RM #", "RM"].includes(normalizeHeader(cell))
  ));
  if (headerIndex < 0) throw new Error(`${label} is missing a Room column.`);
  const headers = rows[headerIndex].map(normalizeHeader);
  const findIndex = (...names: string[]) => {
    const normalized = names.map(normalizeHeader);
    const exact = headers.findIndex((header) => normalized.includes(header));
    if (exact >= 0) return exact;
    return headers.findIndex((header) => normalized.some((name) => name.length >= 4 && header.includes(name)));
  };
  const roomIndex = findIndex("ROOM", "ROOM #", "ROOM NUMBER", "RM #", "RM");
  if (roomIndex < 0) throw new Error(`${label} is missing a Room column.`);
  const printedReport = parsePrintedReport(raw, label);
  if (printedReport.error) throw new Error(printedReport.error);
  return {
    rows: rows.slice(headerIndex + 1),
    roomIndex,
    findIndex,
    headers,
    printedReport: printedReport.report,
    lineOffset: headerIndex + 2,
  };
}

function normalizeRoom(value: string) {
  const match = value.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "";
  return match.toUpperCase() === "MGR" ? "MGR" : match;
}

function parseRoomStatusReport(raw: string): RoomStatusRow[] {
  const { rows, roomIndex, findIndex, headers, lineOffset } = parseReport(raw, "Room Status Report");
  const statusIndex = findIndex("ROOM STATUS", "HOUSEKEEPING STATUS", "HK STATUS", "STATUS");
  const arrivalDateIndex = findIndex("INCOMING ARRIVAL DATE", "DUE IN", "CHECKIN DATE", "CHECK-IN DATE", "CHECK IN DATE", "ARRIVAL DATE");
  const arrivalTimeIndex = findIndex("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "CHECK IN TIME");
  const incomingStart = arrivalDateIndex >= 0 ? arrivalDateIndex : headers.length;
  const guestCodeIndex = findIndex("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const firstNameIndex = headers.findIndex((header, index) =>
    index > guestCodeIndex && index < incomingStart && ["GUEST NAME", "GUEST / NAME", "GUEST", "NAME"].includes(header)
  );
  const firstTypeIndex = headers.findIndex((header, index) =>
    index > roomIndex && index < incomingStart && ["ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE"].includes(header)
  );
  const incomingNameIndex = headers.findIndex((header, index) =>
    index >= incomingStart && ["INCOMING GUEST NAME", "BLOCK NAME", "GUEST NAME", "GUEST / NAME", "GUEST", "NAME"].includes(header)
  );
  const incomingTypeIndex = headers.findIndex((header, index) =>
    index >= incomingStart && ["INCOMING ROOM TYPE", "BLOCK TYPE", "ROOM TYPE", "RM TYPE", "TYPE"].includes(header)
  );
  const incomingCodeIndex = headers.findIndex((header, index) =>
    index >= incomingStart && ["INCOMING GUEST CODE", "BLOCK CODE", "GUEST CODE", "CODE"].includes(header)
  );
  const incomingBlockIndex = headers.findIndex((header, index) =>
    index >= incomingStart && ["INCOMING BLOCK INDICATOR", "BLOCK INDICATOR", "RESERVATION INDICATOR", "BLOCK", "RESERVATION", "RESERVED"].includes(header)
  );
  const guestArrivalIndex = findIndex("CURRENT GUEST ARRIVAL DATE", "GUEST ARRIVAL DATE", "GUEST ARRIVAL", "ARV DATE", "ARV");
  const stayNightsIndex = findIndex("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIndex = findIndex("RESERVED", "BLOCKED", "BLK", "BLK'D", "BLK’D", "BLKD");
  const checkoutDateIndex = findIndex("DEPARTURE DATE", "CHECKOUT DATE", "CHECK OUT DATE", "DEP DATE", "DEP");
  const checkoutTimeIndex = findIndex("DEPARTURE TIME", "CHECKOUT TIME", "CHECK OUT TIME", "DEP TIME", "DPLM");
  const pageIndex = findIndex("SOURCE PAGE", "PAGE");
  const moveFromIndex = findIndex("MOVE FROM", "MOVED FROM", "FROM ROOM");
  const moveToIndex = findIndex("MOVE TO", "MOVED TO", "TO ROOM");
  const seenRooms = new Set<string>();

  return rows.flatMap((row, index) => {
    const line = index + lineOffset;
    const rawRoom = String(row[roomIndex] || "").trim();
    if (!rawRoom || /^(?:total|grand total|occupancy|occupancy %|page)\b/i.test(rawRoom)) return [];
    const room = normalizeRoom(rawRoom);
    if (!room) throw new Error(`Room Status Report line ${line}: room was not recognized.`);
    if (seenRooms.has(room)) throw new Error(`Room Status Report contains room ${room} more than once.`);
    seenRooms.add(room);
    const nightsText = stayNightsIndex >= 0 ? String(row[stayNightsIndex] || "").trim() : "";
    const nights = nightsText ? Number(nightsText) : 0;
    if (!Number.isInteger(nights) || nights < 0 || nights > 3650) {
      throw new Error(`Room Status Report line ${line}: LOS must be a whole number from 0 to 3650.`);
    }
    const reservedText = reservedIndex >= 0 && reservedIndex < incomingStart ? String(row[reservedIndex] || "").trim().toLowerCase() : "";
    if (reservedText && !["true", "yes", "y", "1", "reserved", "blk", "blocked", "x", "✓", "✔", "false", "no", "n", "0", "not reserved", "unblocked"].includes(reservedText) && !/^\d+$/.test(reservedText)) {
      throw new Error(`Room Status Report line ${line}: reserved value '${reservedText}' is not recognized.`);
    }
    return [{
      room,
      roomStatus: statusIndex >= 0 ? String(row[statusIndex] || "").trim() : "",
      departureDate: checkoutDateIndex >= 0 ? String(row[checkoutDateIndex] || "").trim() : "",
      departureTime: checkoutTimeIndex >= 0 ? String(row[checkoutTimeIndex] || "").trim() : "",
      arrivalDate: arrivalDateIndex >= 0 ? String(row[arrivalDateIndex] || "").trim() : "",
      arrivalTime: arrivalTimeIndex >= 0 ? String(row[arrivalTimeIndex] || "").trim() : "",
      guestName: firstNameIndex >= 0 ? String(row[firstNameIndex] || "").trim() : "",
      roomType: firstTypeIndex >= 0 ? String(row[firstTypeIndex] || "").trim() : "",
      guestCode: guestCodeIndex >= 0 ? String(row[guestCodeIndex] || "").trim() : "",
      guestArrivalDate: guestArrivalIndex >= 0 ? String(row[guestArrivalIndex] || "").trim() : "",
      stayNights: nights,
      reserved: ["true", "yes", "y", "1", "reserved", "blk", "blocked", "x", "✓", "✔"].includes(reservedText)
        || (/^\d+$/.test(reservedText) && Number(reservedText) > 0),
      incomingName: incomingNameIndex >= 0 ? String(row[incomingNameIndex] || "").trim() : "",
      incomingType: incomingTypeIndex >= 0 ? String(row[incomingTypeIndex] || "").trim() : "",
      incomingCode: incomingCodeIndex >= 0 ? String(row[incomingCodeIndex] || "").trim() : "",
      incomingBlockIndicator: incomingBlockIndex >= 0 ? String(row[incomingBlockIndex] || "").trim() : "",
      incomingReserved: incomingBlockIndex >= 0
        ? /^(?:true|yes|y|1|reserved|blocked|blk|x|✓|✔)$/i.test(String(row[incomingBlockIndex] || "").trim())
          || (/^\d+$/.test(String(row[incomingBlockIndex] || "").trim()) && Number(row[incomingBlockIndex]) > 0)
        : false,
      sourcePage: pageIndex >= 0 ? String(row[pageIndex] || "").trim() : String(line),
      moveFrom: moveFromIndex >= 0 ? normalizeRoom(String(row[moveFromIndex] || "")) : "",
      moveTo: moveToIndex >= 0 ? normalizeRoom(String(row[moveToIndex] || "")) : "",
    }];
  });
}

function parseExpectedDepartures(raw: string): DepartureRow[] {
  if (!raw.trim()) return [];
  const { rows, roomIndex, findIndex, lineOffset } = parseReport(raw, "Expected Departures");
  const checkoutDateIndex = findIndex("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE", "DATE");
  const checkoutTimeIndex = findIndex("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME", "DPLM", "TIME");
  const seenRooms = new Set<string>();

  return rows.map((row, index) => {
    const line = index + lineOffset;
    const room = normalizeRoom(String(row[roomIndex] || ""));
    if (!room) throw new Error(`Expected Departures line ${line}: room was not recognized.`);
    if (seenRooms.has(room)) throw new Error(`Expected Departures contains room ${room} more than once.`);
    seenRooms.add(room);
    return {
      room,
      checkoutDate: checkoutDateIndex >= 0 ? String(row[checkoutDateIndex] || "").trim() : "",
      checkoutTime: checkoutTimeIndex >= 0 ? String(row[checkoutTimeIndex] || "").trim() : "",
    };
  });
}

function mergeRoomOperations(
  statusRows: RoomStatusRow[],
  departures: DepartureRow[],
  reportDate: string,
): ValidatedRow[] {
  const merged = new Map<string, ValidatedRow>();
  for (const row of statusRows) {
    merged.set(row.room, {
      room: row.room,
      checkout_date: row.departureDate,
      checkout_time: row.departureTime,
      room_status: row.roomStatus,
      arrival_date: row.arrivalDate,
      arrival_time: row.arrivalTime,
      move_from: row.moveFrom,
      move_to: row.moveTo,
      guest_name: row.guestName,
      room_type: row.roomType,
      guest_code: row.guestCode,
      guest_arrival_date: row.guestArrivalDate,
      stay_nights: row.stayNights,
      reserved: row.reserved,
      incoming_name: row.incomingName,
      incoming_type: row.incomingType,
      incoming_code: row.incomingCode,
      incoming_block_indicator: row.incomingBlockIndicator,
      incoming_reserved: row.incomingReserved,
      source_page: row.sourcePage,
      checkout_from_expected_departures: false,
    });
  }
  for (const departure of departures) {
    const room = merged.get(departure.room) || {
      room: departure.room,
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
      incoming_name: "",
      incoming_type: "",
      incoming_code: "",
      incoming_block_indicator: "",
      incoming_reserved: false,
      source_page: "",
      checkout_from_expected_departures: false,
    };
    room.checkout_date = departure.checkoutDate || room.checkout_date || reportDate;
    if (departure.checkoutTime) {
      room.checkout_time = departure.checkoutTime;
      room.checkout_from_expected_departures = true;
    }
    merged.set(departure.room, room);
  }
  return [...merged.values()].map((room) => ({
    ...room,
    checkout_time: room.checkout_date ? room.checkout_time || "11:00 AM" : "",
  }));
}

function snapshotMatches(expected: ValidatedRow[], actual: SnapshotRow[]) {
  const savedByRoom = new Map(actual.map((row) => [row.room, row]));
  return actual.length === expected.length && expected.every((row) => {
    const saved = savedByRoom.get(row.room);
    return !!saved
      && normalizeSnapshotValue(saved.checkout_date) === normalizeSnapshotValue(row.checkout_date)
      && normalizeSnapshotTime(saved.checkout_time) === normalizeSnapshotTime(row.checkout_time)
      && normalizeSnapshotValue(saved.room_status) === normalizeSnapshotValue(row.room_status)
      && normalizeSnapshotValue(saved.arrival_date) === normalizeSnapshotValue(row.arrival_date)
      && normalizeSnapshotTime(saved.arrival_time) === normalizeSnapshotTime(row.arrival_time)
      && normalizeSnapshotValue(saved.guest_name) === normalizeSnapshotValue(row.guest_name)
      && normalizeSnapshotValue(saved.room_type) === normalizeSnapshotValue(row.room_type)
      && normalizeSnapshotValue(saved.guest_code) === normalizeSnapshotValue(row.guest_code)
      && normalizeSnapshotValue(saved.guest_arrival_date) === normalizeSnapshotValue(row.guest_arrival_date)
      && saved.stay_nights === row.stay_nights
      && saved.reserved === row.reserved
      && normalizeSnapshotValue(saved.incoming_name) === normalizeSnapshotValue(row.incoming_name)
      && normalizeSnapshotValue(saved.incoming_type) === normalizeSnapshotValue(row.incoming_type)
      && normalizeSnapshotValue(saved.incoming_code) === normalizeSnapshotValue(row.incoming_code)
      && normalizeSnapshotValue(saved.incoming_block_indicator) === normalizeSnapshotValue(row.incoming_block_indicator)
      && saved.incoming_reserved === row.incoming_reserved
      && (!row.move_from || saved.move_from === row.move_from)
      && (!row.move_to || saved.move_to === row.move_to);
  });
}

export default function RoomOperationsImport({
  date,
  onDateChange,
  onCommitted,
  onBusyChange,
}: {
  date: string;
  onDateChange: (date: string) => void;
  onCommitted: (date: string, rows?: unknown[], importId?: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [statusText, setStatusText] = useState("");
  const [departuresText, setDeparturesText] = useState("");
  const [statusFileName, setStatusFileName] = useState("");
  const [departuresFileName, setDeparturesFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const today = hotelDate();

  async function handleImageUpload(files: FileList | File[]) {
    const pmsFiles = Array.from(files);
    if (pmsFiles.some(file => /^(?:Room status|In House Guest List Details - AR)_CMPRI_/i.test(file.name))) {
      if (pmsFiles.length !== 2 || !pmsFiles.every(file => /\.csv$/i.test(file.name))) {
        setMessage("Choose both original PMS CSV files together, or use the two report file inputs below.");
        return;
      }
      const status = pmsFiles.find(file => /^Room status_CMPRI_/i.test(file.name));
      const guests = pmsFiles.find(file => /^In House Guest List Details - AR_CMPRI_/i.test(file.name));
      if (!status || !guests) { setMessage("Choose one Room status CSV and one In House Guest List CSV."); return; }
      await loadFile(status, "status");
      await loadFile(guests, "departures");
      setMessage("PMS CSV pair loaded. Prepare the preview below to validate before saving.");
      return;
    }
    const fileList = Array.from(files);
    if (!fileList.length) return;
    if (!date) {
      setMessage("Choose the report date before uploading report images.");
      return;
    }
    setBusy(true); onBusyChange(true);
    setMessage("Sending RoomStatus image(s) to ChatGPT for extraction and validation…");
    try {
      const authHeaders = await authorizationHeaders();
      const { report: reportData, validation: validationPayload } = await extractAndValidateRoomOperations({
        onProgress(phase, recoveryAttempt, unresolved) {
          if (phase === "extract") {
            setMessage(recoveryAttempt === 0
              ? "Reading the original report images with ChatGPT…"
              : `Automatic recovery pass ${recoveryAttempt} of ${ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT}: re-examining enlarged overlapping image crops for ${unresolved}`);
          } else {
            setMessage(recoveryAttempt
              ? `Checking recovered report values and complete room coverage (recovery pass ${recoveryAttempt})…`
              : "Checking the printed report date, every active room, and all conditional report fields…");
          }
        },
        async extract({ recoveryAttempt, unresolved, previousReport }) {
          const formData = new FormData();
          fileList.forEach((file) => formData.append("images", file));
          if (recoveryAttempt > 0) {
            formData.append("recovery_context", JSON.stringify({
              unresolved,
              previous_report_data: previousReport,
            }));
          }
          let extractRes: Response;
          try {
            extractRes = await fetch("/api/room-operations/extract", {
              method: "POST",
              headers: authHeaders,
              body: formData,
            });
          } catch (error) {
            throw new RoomOperationsRecoveryIssue(
              error instanceof Error ? `Image extraction request failed: ${error.message}` : "Image extraction request failed.",
              true,
            );
          }
          const extractPayload = await extractRes.json().catch(() => ({})) as {
            ok?: boolean;
            retryable?: boolean;
            report_data?: ReportData;
            error?: string;
          };
          if (!extractRes.ok || extractPayload.ok !== true || !extractPayload.report_data) {
            const errorMessage = extractPayload.error || "ChatGPT image extraction returned no verified report data.";
            throw new RoomOperationsRecoveryIssue(
              errorMessage,
              extractPayload.retryable === true || (!extractPayload.error && extractRes.status >= 500),
            );
          }
          return extractPayload.report_data;
        },
        async validate(reportData) {
          let validationRes: Response;
          try {
            validationRes = await fetch("/api/room-operations", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders },
              body: JSON.stringify({ source: "file", report_data: reportData, validate_only: true }),
            });
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? `Room report validation request failed: ${error.message}` : "Room report validation request failed.",
              recoverable: false,
            };
          }
          const validationPayload = await validationRes.json().catch(() => ({})) as {
            ok?: boolean;
            count?: number;
            rows?: ValidatedRow[];
            error?: string;
          };
          const validatedRows = validationPayload.rows;
          if (!validationRes.ok || validationPayload.ok !== true || !Array.isArray(validatedRows)) {
            const error = validationPayload.error || "Extracted room data failed validation.";
            return {
              ok: false,
              error,
              recoverable: isRecoverableRoomOperationsValidationError(validationRes.status, error),
            };
          }
          const missingNames = missingCurrentGuestNames(validatedRows);
          if (missingNames.length) {
            return {
              ok: false,
              error: `Occupied rooms are missing current guest names: ${missingNames.join(", ")}.`,
              recoverable: true,
            };
          }
          return {
            ok: true,
            value: { count: validationPayload.count, rows: validatedRows },
          };
        },
      });
      setStatusText("Image extraction completed. Report date and room values will be checked by the shared importer.");
      setStatusFileName(`ChatGPT Extracted (${fileList.map((f) => f.name).join(", ")})`);

      setMessage(`Validated ${validationPayload.count || validationPayload.rows.length} rooms and report freshness. Saving the current room data…`);

      const importRes = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ source: "file", report_data: reportData }),
      });
      const importPayload = await importRes.json().catch(() => ({})) as {
        ok?: boolean;
        import_id?: string;
        date?: string;
        count?: number;
        notifications_recorded?: boolean;
        checkout_work_orders?: CheckoutRoomWorkOrder[] | null;
        error?: string;
      };
      if (!importRes.ok || importPayload.ok !== true || !importPayload.import_id) {
        throw new Error(importPayload.error || "Room operations import failed.");
      }

      const readback = await fetch(`/api/room-operations?date=${encodeURIComponent(importPayload.date || date)}`, { headers: authHeaders, cache: "no-store" });
      const result = await readback.json().catch(() => ({})) as { date?: string; rows?: SnapshotRow[]; error?: string };
      if (!readback.ok || typeof result.date !== "string" || !Array.isArray(result.rows)) {
        throw new Error(`Import ${importPayload.import_id} succeeded, but read-back verification failed: ${result.error || "Room operations could not be reloaded."}`);
      }
      if (result.date !== importPayload.date || !snapshotMatches(validationPayload.rows, result.rows)) {
        throw new Error(`Import ${importPayload.import_id} succeeded, but saved room data did not match the validated extraction. Reload Room Operations and verify the accepted report date.`);
      }

      const count = result.rows.length;
      const summary = summarizeRoomOperations(result.rows, result.date);
      const checkoutSummary = result.date === today
        ? `Checkouts today: ${summary.checkoutCount}.`
        : `Checkouts on report date: ${summary.checkoutCount}.`;
      const outOfOrderSummary = summary.outOfOrderRooms.length
        ? `Out of order: ${summary.outOfOrderRooms.map(({ room, status }) => `${room} (${status})`).join(", ")}.`
        : "Out of order: none.";
      const checkoutWorkOrderSummary = formatCheckoutRoomWorkOrders(importPayload.checkout_work_orders ?? null);
      setMessage(
        importPayload.notifications_recorded === false
          ? `ChatGPT successfully extracted and imported ${count} room rows for ${result.date} (import ${importPayload.import_id}), but notifications could not be saved. ${checkoutSummary} ${outOfOrderSummary} ${checkoutWorkOrderSummary}`
          : `ChatGPT successfully extracted, validated, and imported ${count} room rows for ${result.date} (import ${importPayload.import_id})! ${checkoutSummary} ${outOfOrderSummary} ${checkoutWorkOrderSummary} Room moves are active.`
      );
      setPreview(null);
      onCommitted(result.date, result.rows, importPayload.import_id);
    } catch (error) {
      setMessage(error instanceof Error ? `Image extraction & import error: ${error.message}` : "Image extraction and import failed.");
    } finally {
      setBusy(false); onBusyChange(false);
    }
  }

  async function loadFile(file: File | undefined, kind: "status" | "departures") {
    if (!file) return;
    if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|pdf)$/i.test(file.name)) {
      void handleImageUpload([file]);
      return;
    }
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setMessage("Choose a CSV, TSV, TXT, or image report file.");
      return;
    }
    try {
      const text = await file.text();
      if (kind === "status") {
        setStatusText(text);
        setStatusFileName(file.name);
      } else {
        setDeparturesText(text);
        setDeparturesFileName(file.name);
      }
      setPreview(null);
      setMessage("");
    } catch (error) {
      setMessage(`Unable to read ${kind === "status" ? "Room Status Report" : "Expected Departures"} file: ${error instanceof Error ? error.message : "file read failed."}`);
    }
  }

  async function prepareImport() {
    setPreview(null);
    setMessage("");
    if (!date) {
      setMessage("Choose the report date before preparing an import.");
      return;
    }
    try {
      if (isPmsRoomStatus(statusText)) {
        const report_data = preparePmsReportPair(statusText, departuresText, statusFileName, departuresFileName);
        const response = await fetch("/api/room-operations", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...await authorizationHeaders() },
          body: JSON.stringify({ source: "file", report_data, validate_only: true }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok || !Array.isArray(payload.rows)) throw new Error(payload.error || "PMS validation failed.");
        setPreview({ date: payload.date, source: "file", rows: payload.rows, report_data });
        setMessage(payload.rows.length + " rooms validated. Guest codes are optional. Next reservation dates do not identify incoming guests. Review before saving.");
        return;
      }
      const statusReportDate = parsePrintedReport(statusText, "Room Status Report");
      if (statusReportDate.error || !statusReportDate.report) throw new Error(statusReportDate.error || "Room Status Report printed date cannot be verified.");
      const departuresMetadata = departuresText.trim()
        ? parsePrintedReport(departuresText, "Expected Departures")
        : { report: null, error: null };
      if (departuresMetadata.error) throw new Error(departuresMetadata.error);
      const statusRows = parseRoomStatusReport(statusText);
      const departures = parseExpectedDepartures(departuresText);
      const rows = mergeRoomOperations(statusRows, departures, statusReportDate.report.printed_date);
      if (!rows.length) throw new Error("The two reports contain no room rows.");
      const source: ImportSource = statusFileName || departuresFileName ? "file" : "paste";
      const report_data: ReportData = {
        room_status: {
          ...statusReportDate.report,
          pages: [1],
          rows: statusRows.map((row) => ({
            room: row.room,
            room_status: row.roomStatus,
            room_type: row.roomType,
            guest_name: row.guestName,
            guest_code: row.guestCode,
            guest_arrival_date: row.guestArrivalDate,
            checkout_date: row.departureDate,
            checkout_time: row.departureTime,
            stay_nights: row.stayNights,
            reserved: row.reserved,
            incoming_name: row.incomingName,
            incoming_type: row.incomingType,
            incoming_code: row.incomingCode,
            incoming_arrival_date: row.arrivalDate,
            incoming_arrival_time: row.arrivalTime,
            incoming_block_indicator: row.incomingBlockIndicator,
            incoming_reserved: row.incomingReserved,
            source_page: row.sourcePage,
          })),
        },
        expected_departures: departuresMetadata.report ? {
          ...departuresMetadata.report,
          pages: [1],
          rows: departures.map((row) => ({
            room: row.room,
            checkout_date: row.checkoutDate,
            checkout_time: row.checkoutTime,
          })),
        } : null,
      };
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authorizationHeaders() },
        body: JSON.stringify({ source, report_data, validate_only: true }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; date?: string; count?: number; rows?: ValidatedRow[]; error?: string };
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.rows) || typeof payload.date !== "string") {
        throw new Error(payload.error || "Room-operations rows could not be validated.");
      }
      setPreview({ date: payload.date, source, rows: payload.rows, report_data });
      setMessage(`${payload.count || payload.rows.length} merged room rows validated. Review the preview, then commit this verified current-date report.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations validation error: ${error.message}` : "Room operations validation error.");
    }
  }

  async function commitImport() {
    if (!preview || busy) return;
    setBusy(true); onBusyChange(true);
    setMessage("");
    try {
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authorizationHeaders() },
        body: JSON.stringify({ source: preview.source, report_data: preview.report_data }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; import_id?: string; date?: string; notifications_recorded?: boolean; error?: string };
      if (!response.ok || payload.ok !== true || !payload.import_id) throw new Error(payload.error || "Room operations were not saved.");

      const headers = await authorizationHeaders();
      const readback = await fetch(`/api/room-operations?date=${encodeURIComponent(preview.date)}`, { headers, cache: "no-store" });
      const result = await readback.json().catch(() => ({})) as { date?: string; rows?: SnapshotRow[]; error?: string };
      if (!readback.ok || typeof result.date !== "string" || !Array.isArray(result.rows)) {
        throw new Error(`RPC ${payload.import_id} succeeded, but read-back verification failed: ${result.error || "Room operations could not be reloaded."}`);
      }
      const matches = result.date === preview.date && snapshotMatches(preview.rows, result.rows);
      if (!matches) {
        throw new Error(`RPC ${payload.import_id} succeeded, but the saved snapshot did not match the validated preview. Reload Room Operations and verify report date ${preview.date}.`);
      }
      setStatusText("");
      setDeparturesText("");
      setStatusFileName("");
      setDeparturesFileName("");
      setPreview(null);
      setMessage(payload.notifications_recorded === false
        ? `${result.rows.length} merged room-operation rows were saved and verified for ${result.date} (import ${payload.import_id}), but notifications could not be saved. Contact an administrator.`
        : `${result.rows.length} merged room-operation rows were saved and verified for ${result.date} (import ${payload.import_id}).`);
      onCommitted(result.date, result.rows, payload.import_id);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations commit error: ${error.message}` : "Room operations commit error: import status could not be verified.");
    } finally {
      setBusy(false); onBusyChange(false);
    }
  }

  return (
    <section aria-label="Import Daily Room Operations" className="space-y-3 rounded-xl border border-emerald-500/35 bg-slate-900/70 p-3">
      <div>
        <h2 className="text-lg font-semibold">Daily Room Ops Upload</h2>
        <p className="mt-1 text-sm text-slate-400">Upload Room Status and optional Expected Departures, or the new PMS Room status CSV together with In House Guest List Details. Keep the original PMS filenames so export dates and times can be verified. Guest code is optional; supplied codes are preserved. A missing checkout time defaults to 11:00 AM.</p>
      </div>

      <div className="rounded-xl border border-sky-500/40 bg-sky-950/25 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-sky-200">Upload RoomStatus Images (ChatGPT Auto-Import)</h3>
            <p className="text-xs text-slate-300">Upload all report pages. Printed dates, current and incoming columns, room coverage, and required details are validated before import.</p>
          </div>
          <label className="shrink-0">
            <span className={`inline-block cursor-pointer rounded-lg bg-sky-500 px-4 py-2 text-center text-xs font-bold text-slate-950 shadow hover:bg-sky-400 ${busy ? "pointer-events-none opacity-50" : ""}`}>
              {busy ? "Processing with ChatGPT…" : "Upload Images & Auto-Import"}
            </span>
            <input
              type="file"
              accept=".csv,.tsv,.txt,image/*,.pdf"
              multiple
              disabled={busy}
              onChange={(event) => {
                const files = event.target.files;
                if (files && files.length) void handleImageUpload(files);
                event.currentTarget.value = "";
              }}
              className="sr-only"
            />
          </label>
        </div>
      </div>

      <label className="block max-w-xs text-xs font-semibold text-slate-300">
        Report date
        <input type="date" required min={today} max={today} value={date} onChange={(event) => { onDateChange(event.target.value); setPreview(null); }} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
      </label>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-300">
          Room Status Report {statusFileName ? `· ${statusFileName}` : ""}
          <textarea value={statusText} onChange={(event) => { setStatusText(event.target.value); setStatusFileName(""); setPreview(null); }} rows={8} placeholder={"Printed Date: 10/10/2026\nPrinted Time: 8:15 AM\nRoom\tRoom Status\tRoom Type\tArv\tDep\tLOS\tCode\tName\tBlk'd\tDue In\tType\tName\n316\tOccupied\tKING\t10Oct\t11Oct\t1\tREG\tGuest Name\t\t\t\t"} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm font-normal text-white outline-none focus:border-amber-400" />
          <input type="file" accept=".csv,.tsv,.txt,image/*" onChange={(event) => { void loadFile(event.target.files?.[0], "status"); event.currentTarget.value = ""; }} className="mt-2 block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:font-semibold file:text-white" />
        </label>
        <label className="block text-xs font-semibold text-slate-300">
          Expected Departures / In House Guest List {departuresFileName ? `· ${departuresFileName}` : ""}
          <textarea value={departuresText} onChange={(event) => { setDeparturesText(event.target.value); setDeparturesFileName(""); setPreview(null); }} rows={8} placeholder={"Printed Date: 10/10/2026\nPrinted Time: 8:20 AM\nRoom\tCheckout Date\tCheckout Time\tGuest Name\n316\t10/11/2026\t2:00 PM\tGuest Name"} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm font-normal text-white outline-none focus:border-amber-400" />
          <input type="file" accept=".csv,.tsv,.txt,image/*" onChange={(event) => { void loadFile(event.target.files?.[0], "departures"); event.currentTarget.value = ""; }} className="mt-2 block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:font-semibold file:text-white" />
        </label>
      </div>
      <button type="button" onClick={() => void prepareImport()} disabled={busy || !date} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Preview Merged Snapshot</button>
      {message ? <p role="status" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200">{message}</p> : null}
      {preview ? (
        <section aria-label="Validated room-operations preview" className="space-y-3 rounded-xl border border-amber-500/50 bg-amber-950/15 p-3">
          <div>
            <h3 className="font-bold text-amber-100">Validated preview · {preview.date} · {preview.rows.length} rooms</h3>
            <p className="mt-1 text-xs text-amber-100">Commit replaces this day&apos;s complete snapshot. Moves will be detected by comparing today&apos;s guest rooms with yesterday&apos;s snapshot.</p>
            {preview.report_data.room_status.report_kind === "pms_room_status" ? <p className="mt-1 text-xs text-amber-100">Sources: {preview.report_data.room_status.source_filename} ({preview.report_data.room_status.printed_time}) and {preview.report_data.expected_departures?.source_filename} ({preview.report_data.expected_departures?.printed_time}). Next reservation dates, when present, are retained as partial source evidence without an incoming guest: {preview.rows.filter(row => row.next_reservation_date).map(row => `${row.room}: ${row.next_reservation_date}`).join("; ") || "none reported"}.</p> : null}
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-700">
            <table className="w-full min-w-[48rem] text-left text-xs">
              <thead className="sticky top-0 bg-slate-900 text-slate-300"><tr><th className="p-2">Room</th><th className="p-2">Checkout date</th><th className="p-2">Checkout time</th><th className="p-2">Status</th><th className="p-2">Guest</th><th className="p-2">Room type</th><th className="p-2">Reserved</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {preview.rows.map((row, index) => <tr key={`${row.room}-${index}`}><td className="p-2">{row.room}</td><td className="p-2">{row.checkout_date || "—"}</td><td className="p-2">{row.checkout_time || "—"}</td><td className="p-2">{row.room_status || "—"}</td><td className="p-2">{row.guest_name || "—"}</td><td className="p-2">{row.room_type || "—"}</td><td className="p-2">{row.reserved ? "Yes" : "No"}</td></tr>)}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => setPreview(null)} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-50">Discard preview</button>
            <button type="button" disabled={busy} onClick={() => void commitImport()} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">{busy ? "Committing…" : "Commit import"}</button>
          </div>
        </section>
      ) : null}
    </section>
  );
}
