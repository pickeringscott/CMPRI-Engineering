"use client";
import { useState } from "react";
import { getValidSession } from "@/lib/supabase/client";

type Preview = { previewDigest: string; conflicts: number; inserted: number; skipped: number; applied: boolean; rows: Array<{ room: string; periodStart: string; completedOn: string | null; sourceReference: string; action: string; reason: string }> };
export default function RoomPmHistoryImport({ onImported }: { onImported: () => Promise<void> }) {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(apply: boolean) {
    setBusy(true); setError("");
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again.");
      const response = await fetch("/api/preventive-maintenance/history", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action: apply ? "apply" : "preview", input: JSON.parse(input), previewDigest: preview?.previewDigest }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Import failed.");
      setPreview(result);
      if (apply) await onImported();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed."); setPreview(null); }
    finally { setBusy(false); }
  }
  return <details className="my-4 rounded-xl border border-slate-700 p-4">
    <summary className="cursor-pointer font-semibold">Import historical room completions</summary>
    <p className="my-3 text-sm text-slate-300">Reviewer confirmation records whole-room completion without changing checklist answers. Unknown dates remain unknown. Existing records are never overwritten; conflicts must be reconciled first.</p>
    <p className="text-xs text-slate-400">JSON fields: sourceId (stable source identifier), sourceName, rows: room, periodStart (quarter start), completedOn (date or null), sourceReference (page or reconciliation reference).</p>
    <label className="my-3 block">Reconciled JSON file<input type="file" accept=".json,application/json" disabled={busy} className="ml-3" onChange={async event => { const file = event.target.files?.[0]; setPreview(null); if (!file) return; if (file.size > 2_000_000) { setError("File is too large."); return; } setInput(await file.text()); setError(""); }} /></label>
    <label className="block text-sm">Import JSON<textarea rows={6} value={input} disabled={busy} onChange={event => { setInput(event.target.value); setPreview(null); }} className="mt-1 w-full rounded bg-slate-950 p-3 font-mono text-xs" /></label>
    <button type="button" disabled={busy || !input.trim()} onClick={() => void run(false)} className="my-3 rounded border border-slate-600 px-3 py-2 disabled:opacity-40">Preview import</button>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {preview && <div>
      <p role="status">{preview.applied ? `Imported ${preview.inserted}; already present ${preview.skipped}.` : `${preview.rows.filter(row => row.action === "insert").length} new; ${preview.skipped} already present; ${preview.conflicts} conflicts.`}</p>
      <div className="my-3 max-h-80 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th>Room</th><th>Quarter start</th><th>Completed</th><th>Source reference</th><th>Action</th></tr></thead><tbody>{preview.rows.map(row => <tr key={`${row.room}:${row.periodStart}`} className="border-t border-slate-800"><td>{row.room}</td><td>{row.periodStart}</td><td>{row.completedOn || "Date unknown"}</td><td>{row.sourceReference}</td><td>{row.action}{row.reason && `: ${row.reason}`}</td></tr>)}</tbody></table></div>
      {!preview.applied && <button type="button" disabled={busy || preview.conflicts > 0} onClick={() => void run(true)} className="rounded bg-emerald-400 px-4 py-2 font-bold text-slate-950 disabled:opacity-40">Confirm historical import</button>}
    </div>}
  </details>;
}
