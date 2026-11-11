"use client";
import { readImportResponse } from '@/lib/import-response';
import { uploadImportFile, type ImportUploadDescriptor } from '@/lib/import-upload';
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { guestReportName, type GuestRoom } from "@/lib/room-guest-reports";
import LocalOcrReview from "@/components/LocalOcrReview";
import styles from './GuestReportsImport.module.css';
type ReportFile = ImportUploadDescriptor;
type Preview = { date: string; rows: GuestRoom[]; previousId: string | null };
export type GuestReportsImportHandle = { fetchDrive: () => void; chooseFiles: () => void };
export default forwardRef<GuestReportsImportHandle, {
 open: boolean; date: string; onDateChange: (date: string) => void;
 onCommitted: (date: string, rows?: unknown[], importId?: string) => void; onBusyChange?: (busy: boolean) => void;
}>(function GuestReportsImport({ open, date, onDateChange, onCommitted, onBusyChange }, ref) {
 const [files, setFiles] = useState<ReportFile[]>([]);
 const [selectedFiles,setSelectedFiles]=useState<File[]>([]);
 const [preview, setPreview] = useState<Preview | null>(null);
 const [ocrOpen, setOcrOpen] = useState(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
 const inFlight = useRef(false);
 const picker=useRef<HTMLInputElement>(null);
 useImperativeHandle(ref, () => ({
  fetchDrive: () => { void fetchDriveReports(); },
  chooseFiles: () => { if (!inFlight.current) picker.current?.click(); },
 }));
 async function run(action: () => Promise<void>) {
  if (inFlight.current) return;
  inFlight.current = true; setBusy(true); onBusyChange?.(true); setError(""); setNotice("");
  try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "The reports could not be processed."); }
  finally { inFlight.current = false; setBusy(false); onBusyChange?.(false); }
 }
 async function request(reports: ReportFile[], validateOnly: boolean, previousId?: string | null) {
  const response = await fetch("/api/room-operations/guest-reports", { method: "POST",
   headers: { ...await authorizationHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ uploads: reports, validateOnly, previousId }) });
  const result = await readImportResponse(response);
  if (!response.ok) throw Error(result.error || "The reports were not accepted.");
  return result as Preview & { import_id: string };
 }
 function choose(selected:File[]){
  if(inFlight.current||!selected.length)return;
  setError('');setNotice('');
  try{
   const next=[...selectedFiles,...selected];
   if(next.length>3)throw Error('Choose one to three different reports.');
   if(next.some(file=>!/\.csv$/i.test(file.name)))throw Error('Choose CSV report files. Use the local OCR tool below to review text from images or PDFs.');
   const kinds=next.map(file=>guestReportName(file.name).kind);
   if(new Set(kinds).size!==kinds.length)throw Error('Choose only one file for each report type.');
   for(const file of next)if(file.size>100*1024*1024)throw Error(`${file.name}: use a file no larger than 100 MB.`);
   next.sort((a,b)=>["guests","departures","arrivals"].indexOf(guestReportName(a.name).kind)-["guests","departures","arrivals"].indexOf(guestReportName(b.name).kind));
   setSelectedFiles(next);setPreview(null);setFiles([]);
  }catch(e){setError(e instanceof Error?e.message:'The files could not be added.')}
 }
 async function fetchDriveReports(){
  if (inFlight.current) return;
  setPreview(null); setFiles([]); setSelectedFiles([]);
  await run(async () => {
   const response = await fetch("/api/room-operations/guest-reports/drive", { headers: await authorizationHeaders(), method: "POST", cache: "no-store" });
   const result = await readImportResponse(response);
   if (!response.ok) throw Error(result.error || "The Drive reports could not be fetched.");
   if (result.imported === false) { setNotice(result.message); return; }
   onCommitted(result.date, result.rows, result.import_id);
   if (date !== result.date) onDateChange(result.date);
   const duration = Number(response.headers.get("X-CMPRI-Import-Duration-Ms"));
   setNotice(duration > 0 ? `Room Reports Imported. (${(duration / 1000).toFixed(1)} seconds)` : "Room Reports Imported.");
  });
 }
 async function submit(){
  if(inFlight.current||!selectedFiles.length)return;
  setPreview(null);setFiles([]);
  await run(async () => {
   const reports: ReportFile[] = [];
   for (const file of selectedFiles) {
    if (!/\.csv$/i.test(file.name)) throw Error('Choose CSV report files. Use the local OCR tool below to review text from images or PDFs.');
    reports.push(await uploadImportFile(file, 'guest-report'));
   }
   setFiles(reports); setPreview(await request(reports, true));
  });
 }
 const feedback = <>
  {busy && <p role="status">Processing Reports...</p>}
  {error && <p role="alert" className="text-red-300">{error}</p>}
  {notice && <p role="status" className="text-green-300">{notice}</p>}
 </>;
 return <>
 {!open && <div className="text-sm">{feedback}</div>}
 <section id="room-ops-upload-form" hidden={!open} className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 space-y-3" aria-label="Upload Room Operations">
  <p className="text-sm text-slate-300"><strong>In-House Guest List Details</strong> is required first. <strong>Housekeeping Departures</strong> and <strong>Housekeeping Arrivals</strong> are optional and may also be added after today’s guest list is accepted.</p>
  <p className="text-xs text-slate-400">Upload CSV reports with their original timestamped names. Updated reports must be newer than the accepted report of the same type. Review the preview before confirming.</p>
  <div className={styles.picker} role="group" aria-label="Report files" onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy'}} onDrop={event=>{event.preventDefault();choose(Array.from(event.dataTransfer.files))}}>
   <button type="button" disabled={busy} className={styles.add} onClick={()=>picker.current?.click()}>Drag/add files here</button>
   <input ref={picker} type="file" multiple accept=".csv,text/csv" hidden disabled={busy} onChange={event=>{choose(Array.from(event.target.files||[]));event.target.value=''}}/>
   {selectedFiles.length>0&&<div className={styles.selection}><span>{selectedFiles.length} {selectedFiles.length===1?"report":"reports"} selected</span><button type="button" disabled={busy} onClick={()=>{setSelectedFiles([]);setFiles([]);setPreview(null);setError("");setNotice("")}}>Clear</button></div>}
   <button type="button" className={styles.submit} disabled={busy||!selectedFiles.length} onClick={()=>void submit()}>Submit</button>
  </div>
  {open && feedback}
  <details className="rounded-xl border border-slate-700 p-3" onToggle={event=>setOcrOpen(event.currentTarget.open)}>
   <summary className="cursor-pointer text-sm font-semibold">Read a report image or PDF locally</summary>
   <p className="mt-2 text-xs text-slate-400">OCR text is a reference, not an import. Review every page and value against the source, then prepare a supported CSV and use the file import above. OCR cannot confirm that every source row was recognized.</p>
   {open && ocrOpen && <LocalOcrReview />}
  </details>
  {preview && <>
   <h3 className="font-bold">Review {preview.date} — {preview.rows.length} Rooms</h3>
   <div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{["Room", "Guest", "Company", "Pets", "VIP", "Arrival", "Departure", "Incoming"].map(title => <th key={title} className="p-2">{title}</th>)}</tr></thead>
    <tbody>{preview.rows.map(row => <tr key={row.room} className="border-t border-slate-800">{[row.room, row.guest_name, row.company, row.pets, row.vip ? "VIP" : "", row.guest_arrival_date, [row.checkout_date, row.checkout_time].filter(Boolean).join(" "), row.incoming_name].map((value, index) => <td key={index} className="p-2">{String(value ?? "")}</td>)}</tr>)}</tbody></table></div>
   <button type="button" disabled={busy} className="rounded-lg bg-amber-400 px-4 py-2 font-bold text-black disabled:opacity-60" onClick={() => void run(async () => {
    const result = await request(files, false, preview.previousId);
    onCommitted(result.date, result.rows, result.import_id);
    if (date !== result.date) onDateChange(result.date);
    setPreview(null); setFiles([]); setSelectedFiles([]); setNotice("Room Reports Imported.");
   })}>Confirm Import</button>
  </>}
 </section>
 </>;
});
