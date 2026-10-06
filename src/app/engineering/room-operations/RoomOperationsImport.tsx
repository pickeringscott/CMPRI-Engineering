"use client";

import { useState } from "react";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { formatCheckoutRoomWorkOrders, summarizeRoomOperations, type CheckoutRoomWorkOrder } from "@/lib/room-operations";

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
  moveFrom: string;
  moveTo: string;
};
type DepartureRow = {
  room: string;
  checkoutDate: string;
  checkoutTime: string;
};
type ValidatedRow = {
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
};
type SnapshotRow = ValidatedRow & { imported_at: string | null };
type ImportPreview = { date: string; source: ImportSource; rows: ValidatedRow[] };

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
  const headers = rows[0].map(normalizeHeader);
  const findIndex = (...names: string[]) => {
    const normalized = names.map(normalizeHeader);
    const exact = headers.findIndex((header) => normalized.includes(header));
    if (exact >= 0) return exact;
    return headers.findIndex((header) => normalized.some((name) => name.length >= 4 && header.includes(name)));
  };
  const roomIndex = findIndex("ROOM", "ROOM #", "ROOM NUMBER", "RM #", "RM");
  if (roomIndex < 0) throw new Error(`${label} is missing a Room column.`);
  return { rows: rows.slice(1), roomIndex, findIndex };
}

function normalizeRoom(value: string) {
  const match = value.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "";
  return match.toUpperCase() === "MGR" ? "MGR" : match;
}

function parseRoomStatusReport(raw: string): RoomStatusRow[] {
  const { rows, roomIndex, findIndex } = parseReport(raw, "Room Status Report");
  const statusIndex = findIndex("ROOM STATUS", "HOUSEKEEPING STATUS", "HK STATUS", "STATUS");
  const arrivalDateIndex = findIndex("INCOMING ARRIVAL DATE", "DUE IN", "CHECKIN DATE", "CHECK-IN DATE", "CHECK IN DATE", "ARRIVAL DATE");
  const arrivalTimeIndex = findIndex("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "CHECK IN TIME");
  const guestNameIndex = findIndex("GUEST NAME", "GUEST / NAME", "GUEST", "NAME");
  const roomTypeIndex = findIndex("ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE");
  const guestCodeIndex = findIndex("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const guestArrivalIndex = findIndex("CURRENT GUEST ARRIVAL DATE", "GUEST ARRIVAL DATE", "GUEST ARRIVAL", "ARV DATE", "ARV");
  const stayNightsIndex = findIndex("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIndex = findIndex("RESERVED", "BLOCKED", "BLK", "BLK'D", "BLK’D", "BLKD");
  const checkoutDateIndex = findIndex("DEPARTURE DATE", "CHECKOUT DATE", "CHECK OUT DATE", "DEP DATE", "DEP");
  const checkoutTimeIndex = findIndex("DEPARTURE TIME", "CHECKOUT TIME", "CHECK OUT TIME", "DEP TIME", "DPLM");
  const moveFromIndex = findIndex("MOVE FROM", "MOVED FROM", "FROM ROOM");
  const moveToIndex = findIndex("MOVE TO", "MOVED TO", "TO ROOM");
  const seenRooms = new Set<string>();

  return rows.map((row, index) => {
    const line = index + 2;
    const room = normalizeRoom(String(row[roomIndex] || ""));
    if (!room) throw new Error(`Room Status Report line ${line}: room was not recognized.`);
    if (seenRooms.has(room)) throw new Error(`Room Status Report contains room ${room} more than once.`);
    seenRooms.add(room);
    const nightsText = stayNightsIndex >= 0 ? String(row[stayNightsIndex] || "").trim() : "";
    const nights = nightsText ? Number(nightsText) : 0;
    if (!Number.isInteger(nights) || nights < 0 || nights > 3650) {
      throw new Error(`Room Status Report line ${line}: LOS must be a whole number from 0 to 3650.`);
    }
    const reservedText = reservedIndex >= 0 ? String(row[reservedIndex] || "").trim().toLowerCase() : "";
    if (reservedText && !["true", "yes", "y", "1", "reserved", "blk", "blocked", "x", "✓", "✔", "false", "no", "n", "0", "not reserved", "unblocked"].includes(reservedText) && !/^\d+$/.test(reservedText)) {
      throw new Error(`Room Status Report line ${line}: reserved value '${reservedText}' is not recognized.`);
    }
    return {
      room,
      roomStatus: statusIndex >= 0 ? String(row[statusIndex] || "").trim() : "",
      departureDate: checkoutDateIndex >= 0 ? String(row[checkoutDateIndex] || "").trim() : "",
      departureTime: checkoutTimeIndex >= 0 ? String(row[checkoutTimeIndex] || "").trim() : "",
      arrivalDate: arrivalDateIndex >= 0 ? String(row[arrivalDateIndex] || "").trim() : "",
      arrivalTime: arrivalTimeIndex >= 0 ? String(row[arrivalTimeIndex] || "").trim() : "",
      guestName: guestNameIndex >= 0 ? String(row[guestNameIndex] || "").trim() : "",
      roomType: roomTypeIndex >= 0 ? String(row[roomTypeIndex] || "").trim() : "",
      guestCode: guestCodeIndex >= 0 ? String(row[guestCodeIndex] || "").trim() : "",
      guestArrivalDate: guestArrivalIndex >= 0 ? String(row[guestArrivalIndex] || "").trim() : "",
      stayNights: nights,
      reserved: ["true", "yes", "y", "1", "reserved", "blk", "blocked", "x", "✓", "✔"].includes(reservedText)
        || (/^\d+$/.test(reservedText) && Number(reservedText) > 0),
      moveFrom: moveFromIndex >= 0 ? normalizeRoom(String(row[moveFromIndex] || "")) : "",
      moveTo: moveToIndex >= 0 ? normalizeRoom(String(row[moveToIndex] || "")) : "",
    };
  });
}

function parseExpectedDepartures(raw: string): DepartureRow[] {
  const { rows, roomIndex, findIndex } = parseReport(raw, "Expected Departures");
  const checkoutDateIndex = findIndex("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE", "DATE");
  const checkoutTimeIndex = findIndex("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME", "DPLM", "TIME");
  const seenRooms = new Set<string>();

  return rows.map((row, index) => {
    const line = index + 2;
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
      checkout_time: row.departureDate ? row.departureTime || "11:00 AM" : "",
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
    };
    room.checkout_date = departure.checkoutDate || room.checkout_date || reportDate;
    room.checkout_time = departure.checkoutTime || room.checkout_time || "11:00 AM";
    merged.set(departure.room, room);
  }
  return [...merged.values()];
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
      && (!row.move_from || saved.move_from === row.move_from)
      && (!row.move_to || saved.move_to === row.move_to);
  });
}

export default function RoomOperationsImport({
  date,
  onDateChange,
  onCommitted,
}: {
  date: string;
  onDateChange: (date: string) => void;
  onCommitted: (date: string) => void;
}) {
  const [statusText, setStatusText] = useState("");
  const [departuresText, setDeparturesText] = useState("");
  const [statusFileName, setStatusFileName] = useState("");
  const [departuresFileName, setDeparturesFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const today = hotelDate();
  const yesterday = new Date(new Date(`${today}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

  async function handleImageUpload(files: FileList | File[]) {
    const fileList = Array.from(files);
    if (!fileList.length) return;
    if (!date) {
      setMessage("Choose the report date before uploading report images.");
      return;
    }
    setBusy(true);
    setMessage("Sending RoomStatus image(s) to ChatGPT for extraction and validation…");
    try {
      const authHeaders = await authorizationHeaders();
      const formData = new FormData();
      fileList.forEach((file) => formData.append("images", file));

      const extractRes = await fetch("/api/room-operations/extract", {
        method: "POST",
        headers: authHeaders,
        body: formData,
      });
      const extractPayload = await extractRes.json().catch(() => ({})) as { ok?: boolean; csv?: string; error?: string };
      if (!extractRes.ok || extractPayload.ok !== true || !extractPayload.csv) {
        throw new Error(extractPayload.error || "ChatGPT image extraction failed.");
      }

      const extractedCsv = extractPayload.csv;
      setStatusText(extractedCsv);
      setStatusFileName(`ChatGPT Extracted (${fileList.map((f) => f.name).join(", ")})`);

      setMessage("Checking that the extraction contains every active room and its room status…");
      const validationRes = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ source: "file", report_date: date, csv: extractedCsv, validate_only: true }),
      });
      const validationPayload = await validationRes.json().catch(() => ({})) as {
        ok?: boolean;
        count?: number;
        rows?: ValidatedRow[];
        error?: string;
      };
      if (!validationRes.ok || validationPayload.ok !== true || !Array.isArray(validationPayload.rows)) {
        throw new Error(validationPayload.error || "Extracted room data failed validation.");
      }
      const missingNames = missingCurrentGuestNames(validationPayload.rows);
      if (missingNames.length) {
        throw new Error(
          `ChatGPT did not extract current guest names for occupied rooms ${missingNames.slice(0, 20).join(", ")}${missingNames.length > 20 ? ` and ${missingNames.length - 20} more` : ""}. Nothing was saved. Use clearer Room Status images or paste the report data and retry.`,
        );
      }
      setMessage(`Validated ${validationPayload.count || validationPayload.rows.length} rooms and their status values. Saving the daily snapshot…`);

      const importRes = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ source: "file", report_date: date, rows: validationPayload.rows }),
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

      const readback = await fetch(`/api/room-operations?date=${encodeURIComponent(date)}`, { headers: authHeaders, cache: "no-store" });
      const result = await readback.json().catch(() => ({})) as { date?: string; rows?: SnapshotRow[]; error?: string };
      if (!readback.ok || typeof result.date !== "string" || !Array.isArray(result.rows)) {
        throw new Error(`Import ${importPayload.import_id} succeeded, but read-back verification failed: ${result.error || "Room operations could not be reloaded."}`);
      }
      if (result.date !== date || !snapshotMatches(validationPayload.rows, result.rows)) {
        throw new Error(`Import ${importPayload.import_id} succeeded, but saved room statuses did not match the validated extraction. Reload Room Operations and verify report date ${date}.`);
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
      onCommitted(result.date);
    } catch (error) {
      setMessage(error instanceof Error ? `Image extraction & import error: ${error.message}` : "Image extraction and import failed.");
    } finally {
      setBusy(false);
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
      const rows = mergeRoomOperations(
        parseRoomStatusReport(statusText),
        parseExpectedDepartures(departuresText),
        date,
      );
      if (!rows.length) throw new Error("The two reports contain no room rows.");
      const source: ImportSource = statusFileName || departuresFileName ? "file" : "paste";
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authorizationHeaders() },
        body: JSON.stringify({ source, report_date: date, rows, validate_only: true }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; date?: string; count?: number; rows?: ValidatedRow[]; error?: string };
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.rows) || typeof payload.date !== "string") {
        throw new Error(payload.error || "Room-operations rows could not be validated.");
      }
      setPreview({ date: payload.date, source, rows: payload.rows });
      setMessage(`${payload.count || payload.rows.length} merged room rows validated. Review the preview, then commit to replace this date's snapshot.`);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations validation error: ${error.message}` : "Room operations validation error.");
    }
  }

  async function commitImport() {
    if (!preview || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authorizationHeaders() },
        body: JSON.stringify({ source: preview.source, report_date: preview.date, rows: preview.rows }),
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
      onCommitted(result.date);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations commit error: ${error.message}` : "Room operations commit error: import status could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Import Daily Room Operations" className="space-y-3 rounded-xl border border-emerald-500/35 bg-slate-900/70 p-3">
      <div>
        <h2 className="text-lg font-semibold">Daily Room Ops Upload</h2>
        <p className="mt-1 text-sm text-slate-400">Upload today&apos;s Room Status Report and Expected Departures photos or CSV files. When images are uploaded, CMPRI sends them to ChatGPT to extract, validate, and import them with zero manual CSV steps. Expected departures without a checkout time default to 11:00 AM.</p>
      </div>

      <div className="rounded-xl border border-sky-500/40 bg-sky-950/25 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-sky-200">Upload RoomStatus Images (ChatGPT Auto-Import)</h3>
            <p className="text-xs text-slate-300">Take or upload photos of Room Status & Departures reports. ChatGPT extracts and validates the exact CSV format and imports it automatically.</p>
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
        <input type="date" required min={yesterday} max={today} value={date} onChange={(event) => { onDateChange(event.target.value); setPreview(null); }} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
      </label>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-300">
          Room Status Report {statusFileName ? `· ${statusFileName}` : ""}
          <textarea value={statusText} onChange={(event) => { setStatusText(event.target.value); setStatusFileName(""); setPreview(null); }} rows={8} placeholder={"Room\tRoom Status\tGuest Name\tRoom Type\n316\tOccupied\tGuest Name\tKING\nMGR\tOut of Order\t\t"} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm font-normal text-white outline-none focus:border-amber-400" />
          <input type="file" accept=".csv,.tsv,.txt,image/*" onChange={(event) => { void loadFile(event.target.files?.[0], "status"); event.currentTarget.value = ""; }} className="mt-2 block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:font-semibold file:text-white" />
        </label>
        <label className="block text-xs font-semibold text-slate-300">
          Expected Departures {departuresFileName ? `· ${departuresFileName}` : ""}
          <textarea value={departuresText} onChange={(event) => { setDeparturesText(event.target.value); setDeparturesFileName(""); setPreview(null); }} rows={8} placeholder={"Room\tCheckout Date\tCheckout Time\tGuest Name\n316\t9/30/2026\t\tGuest Name"} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm font-normal text-white outline-none focus:border-amber-400" />
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
