"use client";
import { useRef, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { guestReportName, type GuestRoom } from "@/lib/room-guest-reports";
type ReportFile = { name: string; text: string };
type Preview = { date: string; rows: GuestRoom[]; previousId: string | null };
export default function RoomOperationsImport({ date, onDateChange, onCommitted, onBusyChange }: {
 date: string; onDateChange: (date: string) => void;
 onCommitted: (date: string, rows?: unknown[], importId?: string) => void; onBusyChange?: (busy: boolean) => void;
}) {
 const [files, setFiles] = useState<ReportFile[]>([]);
 const [preview, setPreview] = useState<Preview | null>(null);
 const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
 const inFlight = useRef(false);
 async function run(action: () => Promise<void>) {
  if (inFlight.current) return;
  inFlight.current = true; setBusy(true); onBusyChange?.(true); setError(""); setNotice("");
  try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "The reports could not be processed."); }
  finally { inFlight.current = false; setBusy(false); onBusyChange?.(false); }
 }
 async function request(reports: ReportFile[], validateOnly: boolean, previousId?: string | null) {
  const response = await fetch("/api/room-operations/guest-reports", { method: "POST",
   headers: { ...await authorizationHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ files: reports, validateOnly, previousId }) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "The reports were not accepted.");
  return result as Preview & { import_id: string };
 }
 async function choose(selected: File[]) {
  setPreview(null); setFiles([]);
  await run(async () => {
   if (!selected.length || selected.length > 3) throw Error("Choose one to three different reports.");
   const kinds = selected.map(file => guestReportName(file.name).kind);
   if (new Set(kinds).size !== kinds.length) throw Error("Choose only one file for each report type.");
   const reports: ReportFile[] = [];
   for (const file of selected) {
    if (file.size > 3 * 1024 * 1024) throw Error(`${file.name}: use a file no larger than 3 MB.`);
    if (/\.csv$/i.test(file.name)) reports.push({ name: file.name, text: await file.text() });
    else {
     const form = new FormData(); form.append("file", file);
     const response = await fetch("/api/room-operations/guest-reports/extract", { method: "POST", headers: await authorizationHeaders(), body: form });
     const result = await response.json();
     if (!response.ok) throw Error(result.error || "The scan could not be read.");
     reports.push({ name: file.name, text: result.text });
    }
   }
   setFiles(reports); setPreview(await request(reports, true));
  });
 }
 return <section className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 space-y-3" aria-label="Upload Room Operations">
  <h2 className="text-lg font-bold">Upload Room Operations</h2>
  <p className="text-sm text-slate-300">In Agilysys Dynamic Reporting, export today’s <strong>In House Guest List Details</strong>. You may include <strong>Housekeeping Arrivals</strong> and <strong>Housekeeping Departures</strong>, or add them later after today’s guest list is accepted.</p>
  <p className="text-sm text-slate-400">Keep the original CMPRI timestamped filenames. Updated reports must be newer than their accepted versions. Optional reports may be up to five minutes earlier than the guest list. CSV is preferred; PNG, JPEG and WebP scans up to 3 MB are also accepted. Review every extracted value before importing.</p>
  <label className="block text-sm font-semibold">Choose Reports<input type="file" multiple accept=".csv,.png,.jpg,.jpeg,.webp" disabled={busy} className="mt-2 block w-full" onChange={event => { const selected = Array.from(event.target.files || []); event.target.value = ""; if (selected.length) void choose(selected); }} /></label>
  {busy && <p role="status">Processing Reports...</p>}
  {error && <p role="alert" className="text-red-300">{error}</p>}
  {notice && <p role="status" className="text-green-300">{notice}</p>}
  {preview && <>
   <h3 className="font-bold">Review {preview.date} — {preview.rows.length} Rooms</h3>
   <ul className="text-xs text-slate-400">{files.map(file => <li key={file.name}>{file.name}</li>)}</ul>
   <div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{["Room", "Guest", "Company", "Pets", "VIP", "Arrival", "Departure", "Incoming"].map(title => <th key={title} className="p-2">{title}</th>)}</tr></thead>
    <tbody>{preview.rows.map(row => <tr key={row.room} className="border-t border-slate-800">{[row.room, row.guest_name, row.company, row.pets, row.vip ? "VIP" : "", row.guest_arrival_date, [row.checkout_date, row.checkout_time].filter(Boolean).join(" "), row.incoming_name].map((value, index) => <td key={index} className="p-2">{String(value ?? "")}</td>)}</tr>)}</tbody></table></div>
   <button type="button" disabled={busy} className="rounded-lg bg-amber-400 px-4 py-2 font-bold text-black disabled:opacity-60" onClick={() => void run(async () => {
    const result = await request(files, false, preview.previousId);
    onCommitted(result.date, result.rows, result.import_id);
    if (date !== result.date) onDateChange(result.date);
    setPreview(null); setFiles([]); setNotice("Room Reports Imported.");
   })}>Confirm Import</button>
  </>}
 </section>;
}
