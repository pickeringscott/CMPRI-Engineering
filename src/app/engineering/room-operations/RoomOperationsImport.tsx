"use client";

import { useRef, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";

type ImportSource = "paste" | "file" | "photo";
type ImportInputRow = {
  room: string;
  checkoutDate: string;
  checkoutTime: string;
  roomStatus: string;
  arrivalDate: string;
  arrivalTime: string;
  moveFrom: string;
  moveTo: string;
  guestName: string;
  roomType: string;
  guestCode: string;
  guestArrivalDate: string;
  stayNights: number;
  reserved: boolean;
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

function parseImportText(raw: string): ImportInputRow[] {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
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
  const checkoutDateIndex = findIndex("CHECKOUT DATE", "CHECK OUT DATE", "DEPARTURE DATE", "DEP DATE");
  const checkoutTimeIndex = findIndex("CHECKOUT TIME", "CHECK OUT TIME", "DEPARTURE TIME", "DEP TIME");
  const roomStatusIndex = findIndex("ROOM STATUS", "HOUSEKEEPING STATUS", "HK STATUS", "STATUS");
  const arrivalDateIndex = findIndex("INCOMING ARRIVAL DATE", "CHECKIN DATE", "CHECK-IN DATE", "CHECK IN DATE");
  const arrivalTimeIndex = findIndex("INCOMING ARRIVAL TIME", "CHECKIN TIME", "CHECK-IN TIME", "CHECK IN TIME");
  const moveFromIndex = findIndex("MOVE FROM", "MOVED FROM", "ROOM MOVE FROM", "FROM ROOM", "PREVIOUS ROOM");
  const moveToIndex = findIndex("MOVE TO", "MOVED TO", "ROOM MOVE TO", "TO ROOM", "NEW ROOM");
  const guestNameIndex = findIndex("GUEST NAME", "GUEST / NAME", "GUEST", "NAME");
  const roomTypeIndex = findIndex("ROOM TYPE", "RM TYPE", "ROOM TYPE CODE", "TYPE");
  const guestCodeIndex = findIndex("GUEST CODE", "GUEST TYPE CODE", "RATE CODE", "MEMBER CODE", "CODE");
  const guestArrivalIndex = findIndex("GUEST ARRIVAL", "ARV", "ARV DATE");
  const stayNightsIndex = findIndex("LOS", "LENGTH OF STAY", "NIGHTS");
  const reservedIndex = findIndex("RESERVED", "BLOCKED", "BLK");
  if (stayNightsIndex < 0) throw new Error("The extracted table is missing a Length of Stay (LOS) column. No rows were imported.");
  if (reservedIndex < 0) throw new Error("The extracted table is missing a Reserved column. No rows were imported.");
  const start = roomIndex >= 0 ? 1 : 0;
  const parsedRows = rows.slice(start).map((row, index): ImportInputRow => {
    const sourceLine = start + index + 1;
    const stayText = String(row[stayNightsIndex] || "").trim();
    if (!stayText) throw new Error(`Line ${sourceLine}: length of stay is blank. No rows were imported.`);
    const stayNights = Number(stayText);
    if (!Number.isInteger(stayNights) || stayNights < 0 || stayNights > 3650) {
      throw new Error(`Line ${sourceLine}: length of stay must be a whole number from 0 to 3650; found '${stayText}'.`);
    }
    const reservedText = String(row[reservedIndex] || "").trim().toLowerCase();
    const trueValues = ["true", "yes", "y", "1", "reserved", "blk"];
    const falseValues = ["false", "no", "n", "0", "not reserved"];
    if (!reservedText) throw new Error(`Line ${sourceLine}: reserved value is blank. No rows were imported.`);
    if (!trueValues.includes(reservedText) && !falseValues.includes(reservedText)) {
      throw new Error(`Line ${sourceLine}: reserved value '${reservedText}' is not recognized.`);
    }
    return {
      room: String(row[roomIndex >= 0 ? roomIndex : 0] || "").match(/\b\d{2,4}\b/)?.[0] || "",
      checkoutDate: checkoutDateIndex >= 0 ? String(row[checkoutDateIndex] || "") : "",
      checkoutTime: checkoutTimeIndex >= 0 ? String(row[checkoutTimeIndex] || "") : "",
      roomStatus: roomStatusIndex >= 0 ? String(row[roomStatusIndex] || "") : "",
      arrivalDate: arrivalDateIndex >= 0 ? String(row[arrivalDateIndex] || "") : "",
      arrivalTime: arrivalTimeIndex >= 0 ? String(row[arrivalTimeIndex] || "") : "",
      moveFrom: moveFromIndex >= 0 ? String(row[moveFromIndex] || "").match(/\b\d{2,4}\b/)?.[0] || "" : "",
      moveTo: moveToIndex >= 0 ? String(row[moveToIndex] || "").match(/\b\d{2,4}\b/)?.[0] || "" : "",
      guestName: guestNameIndex >= 0 ? String(row[guestNameIndex] || "").trim() : "",
      roomType: roomTypeIndex >= 0 ? String(row[roomTypeIndex] || "").trim() : "",
      guestCode: guestCodeIndex >= 0 ? String(row[guestCodeIndex] || "").trim() : "",
      guestArrivalDate: guestArrivalIndex >= 0 ? String(row[guestArrivalIndex] || "").trim() : "",
      stayNights,
      reserved: trueValues.includes(reservedText),
    };
  });
  const missingRoomIndex = parsedRows.findIndex((row) => !row.room);
  if (missingRoomIndex >= 0) {
    throw new Error(`Line ${start + missingRoomIndex + 1}: room number was not recognized. No rows were discarded.`);
  }
  return parsedRows;
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
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  async function prepareImport(rows: ImportInputRow[], source: ImportSource) {
    setPreview(null);
    setMessage("");
    if (!rows.length) {
      setMessage("No room checkout rows were found. Paste a spreadsheet table with a Room column.");
      return;
    }
    if (!date) {
      setMessage("Choose the report date before preparing an import.");
      return;
    }
    try {
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
      setMessage(`${payload.count || payload.rows.length} rows validated. Review the preview, then commit to replace this date's snapshot.`);
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

      let saved: { date: string; rows: SnapshotRow[] };
      try {
        const headers = await authorizationHeaders();
        const readback = await fetch(`/api/room-operations?date=${encodeURIComponent(preview.date)}`, { headers, cache: "no-store" });
        const result = await readback.json().catch(() => ({})) as { date?: string; rows?: SnapshotRow[]; error?: string };
        if (!readback.ok || typeof result.date !== "string" || !Array.isArray(result.rows)) {
          throw new Error(result.error || "Room operations could not be reloaded.");
        }
        saved = { date: result.date, rows: result.rows };
      } catch (error) {
        throw new Error(`RPC ${payload.import_id} succeeded, but read-back verification failed: ${error instanceof Error ? error.message : "Room operations could not be reloaded."}`);
      }
      const savedByRoom = new Map(saved.rows.map((row) => [row.room, row]));
      const snapshotMatches = saved.date === preview.date
        && saved.rows.length === preview.rows.length
        && preview.rows.every((expected) => {
          const actual = savedByRoom.get(expected.room);
          return !!actual
            && actual.checkout_date === expected.checkout_date
            && actual.checkout_time === expected.checkout_time
            && actual.room_status === expected.room_status
            && actual.arrival_date === expected.arrival_date
            && actual.arrival_time === expected.arrival_time
            && actual.move_from === expected.move_from
            && actual.move_to === expected.move_to
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
      setInput("");
      setPreview(null);
      setMessage(`${saved.rows.length} room-operation rows were saved and verified for ${saved.date} (import ${payload.import_id}).`);
      onCommitted(saved.date);
    } catch (error) {
      setMessage(error instanceof Error ? `Room operations commit error: ${error.message}` : "Room operations commit error: import status could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  function previewText(raw: string, source: ImportSource) {
    try {
      void prepareImport(parseImportText(raw), source);
    } catch (error) {
      setPreview(null);
      setMessage(error instanceof Error ? `Room operations validation error: ${error.message}` : "Room operations validation error.");
    }
  }

  async function handleFile(file?: File | null) {
    if (!file) return;
    setPreview(null);
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setMessage("Export the checkout sheet as CSV/TSV/TXT, or paste the spreadsheet rows.");
      return;
    }
    previewText(await file.text(), "file");
  }

  async function handleImage(file?: File | null) {
    if (!file) return;
    setPreview(null);
    if (!file.type.startsWith("image/")) {
      setMessage("Choose a checkout/arrival report photo or screenshot.");
      return;
    }
    const Detector = (window as unknown as {
      TextDetector?: new () => { detect(input: ImageBitmap): Promise<Array<{ rawValue?: string; boundingBox?: DOMRectReadOnly }>> };
    }).TextDetector;
    if (!Detector) {
      setMessage("This browser does not expose local image text recognition. Use pasted rows or CSV/TSV/TXT on this device; the photo itself was not uploaded to an AI provider.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const items = (await new Detector().detect(bitmap))
        .filter((item) => String(item.rawValue || "").trim())
        .sort((a, b) => {
          const ay = a.boundingBox?.y ?? 0;
          const by = b.boundingBox?.y ?? 0;
          if (Math.abs(ay - by) > 8) return ay - by;
          return (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0);
        });
      bitmap.close();
      const grouped: Array<{ y: number; h: number; cells: typeof items }> = [];
      for (const item of items) {
        const box = item.boundingBox;
        const centerY = box ? box.y + box.height / 2 : grouped.length * 20;
        const existing = grouped.find((row) => Math.abs(row.y - centerY) <= Math.max(8, row.h * 0.65));
        if (existing) {
          existing.cells.push(item);
          existing.y = (existing.y + centerY) / 2;
          existing.h = Math.max(existing.h, box?.height ?? 12);
        } else {
          grouped.push({ y: centerY, h: box?.height ?? 12, cells: [item] });
        }
      }
      const extracted = grouped
        .sort((a, b) => a.y - b.y)
        .map((row) => row.cells
          .sort((a, b) => (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0))
          .map((item) => String(item.rawValue || "").trim())
          .join("\t"))
        .join("\n");
      setInput(extracted);
      previewText(extracted, "photo");
    } catch (error) {
      setMessage(`Photo import error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <section aria-label="Import Daily Room Operations" className="space-y-3 rounded-xl border border-emerald-500/35 bg-slate-900/70 p-3">
      <div>
        <h2 className="text-lg font-semibold">Import Daily Room Operations</h2>
        <p className="mt-1 text-sm text-slate-400">Paste spreadsheet rows, import CSV/TSV/TXT, or use a report photo/screenshot when this browser supports local text recognition. Photos are processed on-device, not sent to an AI provider.</p>
      </div>
      <label className="block max-w-xs text-xs font-semibold text-slate-300">
        Report date
        <input type="date" required value={date} onChange={(event) => { onDateChange(event.target.value); setPreview(null); }} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
      </label>
      <textarea value={input} onChange={(event) => { setInput(event.target.value); setPreview(null); }} rows={8} placeholder={"Room\tCheckout Date\tCheckout Time\tRoom Status\tCheck-in Date\tCheck-in Time\tMove From\tMove To\tGuest Name\tRoom Type\tGuest Code\tARV\tLOS\tReserved\n316\t9/15/2026\t11:00 AM\tVacant Dirty\t9/15/2026\t4:00 PM\t316\t412\tGuest Name\tKING\tCODE\t9/12/2026\t3\tYes"} className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-white outline-none focus:border-amber-400" />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => previewText(input, "paste")} disabled={busy || !date} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Preview Pasted Rows</button>
        <label className="cursor-pointer rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Import CSV / TSV / TXT<input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={(event) => { void handleFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
        <label className="cursor-pointer rounded-lg border border-sky-500/50 bg-sky-950/30 px-4 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-900/40">Import Photo / Screenshot<input ref={imageRef} type="file" accept="image/*" className="hidden" onChange={(event) => { void handleImage(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
      </div>
      {message ? <p role="status" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200">{message}</p> : null}
      {preview ? (
        <section aria-label="Validated room-operations preview" className="space-y-3 rounded-xl border border-amber-500/50 bg-amber-950/15 p-3">
          <div>
            <h3 className="font-bold text-amber-100">Validated preview · {preview.date} · {preview.rows.length} rows</h3>
            <p className="mt-1 text-xs text-amber-100">Commit replaces the entire saved snapshot for this report date.</p>
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-700">
            <table className="w-full min-w-[72rem] text-left text-xs">
              <thead className="sticky top-0 bg-slate-900 text-slate-300"><tr><th className="p-2">Room</th><th className="p-2">Checkout date</th><th className="p-2">Checkout time</th><th className="p-2">Status</th><th className="p-2">Arrival date</th><th className="p-2">Arrival time</th><th className="p-2">Move from</th><th className="p-2">Move to</th><th className="p-2">Guest</th><th className="p-2">Room type</th><th className="p-2">Guest code</th><th className="p-2">Guest arrival</th><th className="p-2">Nights</th><th className="p-2">Reserved</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {preview.rows.map((row, index) => <tr key={`${row.room}-${index}`}><td className="p-2">{row.room}</td><td className="p-2">{row.checkout_date || "—"}</td><td className="p-2">{row.checkout_time || "—"}</td><td className="p-2">{row.room_status || "—"}</td><td className="p-2">{row.arrival_date || "—"}</td><td className="p-2">{row.arrival_time || "—"}</td><td className="p-2">{row.move_from || "—"}</td><td className="p-2">{row.move_to || "—"}</td><td className="p-2">{row.guest_name || "—"}</td><td className="p-2">{row.room_type || "—"}</td><td className="p-2">{row.guest_code || "—"}</td><td className="p-2">{row.guest_arrival_date || "—"}</td><td className="p-2">{row.stay_nights}</td><td className="p-2">{row.reserved ? "Yes" : "No"}</td></tr>)}
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
