"use client";

import { useState } from "react";
import { HOTEL_TIME_ZONE } from "@/lib/constants";
import { authorizationHeaders } from "@/lib/auth/client-session";

type ImportSource = "paste" | "file";
type RoomStatusRow = {
  room: string;
  roomStatus: string;
  arrivalDate: string;
  arrivalTime: string;
  guestName: string;
  roomType: string;
  guestCode: string;
  guestArrivalDate: string;
  stayNights: number;
  reserved: boolean;
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
  const roomIndex = findIndex("ROOM", "ROOM #", "ROOM NUMBER", "RM");
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
  const arrivalDateIndex = findIndex("INCOMING ARRIVAL DATE", "CHECKIN DATE", "CHECK-IN DATE", "CHECK IN DATE");
  const arrivalTimeIndex = findIndex("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "CHECK IN TIME");
  const guestNameIndex = findIndex("GUEST NAME", "GUEST / NAME", "GUEST", "NAME");
  const roomTypeIndex = findIndex("ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE");
  const guestCodeIndex = findIndex("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const guestArrivalIndex = findIndex("GUEST ARRIVAL", "ARV", "ARV DATE");
  const stayNightsIndex = findIndex("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIndex = findIndex("RESERVED", "BLOCKED", "BLK");
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
    if (reservedText && !["true", "yes", "y", "1", "reserved", "blk", "false", "no", "n", "0", "not reserved"].includes(reservedText)) {
      throw new Error(`Room Status Report line ${line}: reserved value '${reservedText}' is not recognized.`);
    }
    return {
      room,
      roomStatus: statusIndex >= 0 ? String(row[statusIndex] || "").trim() : "",
      arrivalDate: arrivalDateIndex >= 0 ? String(row[arrivalDateIndex] || "").trim() : "",
      arrivalTime: arrivalTimeIndex >= 0 ? String(row[arrivalTimeIndex] || "").trim() : "",
      guestName: guestNameIndex >= 0 ? String(row[guestNameIndex] || "").trim() : "",
      roomType: roomTypeIndex >= 0 ? String(row[roomTypeIndex] || "").trim() : "",
      guestCode: guestCodeIndex >= 0 ? String(row[guestCodeIndex] || "").trim() : "",
      guestArrivalDate: guestArrivalIndex >= 0 ? String(row[guestArrivalIndex] || "").trim() : "",
      stayNights: nights,
      reserved: ["true", "yes", "y", "1", "reserved", "blk"].includes(reservedText),
    };
  });
}

function parseExpectedDepartures(raw: string): DepartureRow[] {
  const { rows, roomIndex, findIndex } = parseReport(raw, "Expected Departures");
  const checkoutDateIndex = findIndex("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE", "DATE");
  const checkoutTimeIndex = findIndex("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME", "TIME");
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
      checkout_date: "",
      checkout_time: "",
      room_status: row.roomStatus,
      arrival_date: row.arrivalDate,
      arrival_time: row.arrivalTime,
      move_from: "",
      move_to: "",
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
    room.checkout_date = departure.checkoutDate || reportDate;
    room.checkout_time = departure.checkoutTime || "11:00 AM";
    merged.set(departure.room, room);
  }
  return [...merged.values()];
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

  async function loadFile(file: File | undefined, kind: "status" | "departures") {
    if (!file) return;
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setMessage("Choose a CSV, TSV, or TXT report file.");
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
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; import_id?: string; date?: string; error?: string };
      if (!response.ok || payload.ok !== true || !payload.import_id) throw new Error(payload.error || "Room operations were not saved.");

      const headers = await authorizationHeaders();
      const readback = await fetch(`/api/room-operations?date=${encodeURIComponent(preview.date)}`, { headers, cache: "no-store" });
      const result = await readback.json().catch(() => ({})) as { date?: string; rows?: SnapshotRow[]; error?: string };
      if (!readback.ok || typeof result.date !== "string" || !Array.isArray(result.rows)) {
        throw new Error(`RPC ${payload.import_id} succeeded, but read-back verification failed: ${result.error || "Room operations could not be reloaded."}`);
      }
      const savedByRoom = new Map(result.rows.map((row) => [row.room, row]));
      const snapshotMatches = result.date === preview.date
        && result.rows.length === preview.rows.length
        && preview.rows.every((expected) => {
          const actual = savedByRoom.get(expected.room);
          return !!actual
            && actual.checkout_date === expected.checkout_date
            && actual.checkout_time === expected.checkout_time
            && actual.room_status === expected.room_status
            && actual.arrival_date === expected.arrival_date
            && actual.arrival_time === expected.arrival_time
            && actual.guest_name === expected.guest_name
            && actual.room_type === expected.room_type
            && actual.guest_code === expected.guest_code
            && actual.guest_arrival_date === expected.guest_arrival_date
            && actual.stay_nights === expected.stay_nights
            && actual.reserved === expected.reserved;
        });
      if (!snapshotMatches) {
        throw new Error(`RPC ${payload.import_id} succeeded, but the saved snapshot did not match the validated preview. Reload Room Operations and verify report date ${preview.date}.`);
      }
      setStatusText("");
      setDeparturesText("");
      setStatusFileName("");
      setDeparturesFileName("");
      setPreview(null);
      setMessage(`${result.rows.length} merged room-operation rows were saved and verified for ${result.date} (import ${payload.import_id}).`);
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
        <h2 className="text-lg font-semibold">Manual Daily Room Ops Upload</h2>
        <p className="mt-1 text-sm text-slate-400">Upload today&apos;s Room Status Report and Expected Departures. They are merged by room; expected departures without a checkout time default to 11:00 AM. No automated integrations or AI extraction are used.</p>
      </div>
      <label className="block max-w-xs text-xs font-semibold text-slate-300">
        Report date
        <input type="date" required min={yesterday} max={today} value={date} onChange={(event) => { onDateChange(event.target.value); setPreview(null); }} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
      </label>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-semibold text-slate-300">
          Room Status Report {statusFileName ? `· ${statusFileName}` : ""}
          <textarea value={statusText} onChange={(event) => { setStatusText(event.target.value); setStatusFileName(""); setPreview(null); }} rows={8} placeholder={"Room\tRoom Status\tGuest Name\tRoom Type\n316\tOccupied\tGuest Name\tKING\nMGR\tOut of Order\t\t"} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm font-normal text-white outline-none focus:border-amber-400" />
          <input type="file" accept=".csv,.tsv,.txt" onChange={(event) => { void loadFile(event.target.files?.[0], "status"); event.currentTarget.value = ""; }} className="mt-2 block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:font-semibold file:text-white" />
        </label>
        <label className="block text-xs font-semibold text-slate-300">
          Expected Departures {departuresFileName ? `· ${departuresFileName}` : ""}
          <textarea value={departuresText} onChange={(event) => { setDeparturesText(event.target.value); setDeparturesFileName(""); setPreview(null); }} rows={8} placeholder={"Room\tCheckout Date\tCheckout Time\tGuest Name\n316\t9/30/2026\t\tGuest Name"} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm font-normal text-white outline-none focus:border-amber-400" />
          <input type="file" accept=".csv,.tsv,.txt" onChange={(event) => { void loadFile(event.target.files?.[0], "departures"); event.currentTarget.value = ""; }} className="mt-2 block w-full text-xs text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:font-semibold file:text-white" />
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
