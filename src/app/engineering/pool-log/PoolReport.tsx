"use client";

import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { poolLogTodayDate } from "@/lib/pool-log";
import { reportMonths, type ReportLog } from "@/lib/pool-report";

export default function PoolReport({ facilityId, disabled }: { facilityId?: string; disabled: boolean }) {
  const year = poolLogTodayDate().slice(2, 4);
  const [start, setStart] = useState(`01/${year}`);
  const [end, setEnd] = useState(`12/${year}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  async function prepare() {
    setError("");
    setDownload(null);
    setBusy(true);
    try {
      const months = reportMonths(start, end);
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again to print the pool report.");
      const query = new URLSearchParams({ history: "1", facility: facilityId || "" });
      const response = await fetch(`/api/pool-log?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      const result = await response.json() as { error?: string; history?: ReportLog[] };
      if (!response.ok || !Array.isArray(result.history)) throw new Error(result.error || "The complete pool log could not be loaded.");
      const template = await fetch("/forms/swimming-facility-daily-operational-report.pdf");
      if (!template.ok) throw new Error("The official report template could not be loaded.");
      const { createPoolReport } = await import("@/lib/pool-report");
      const bytes = await createPoolReport(await template.arrayBuffer(), months, result.history);
      setDownload({ url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" })), name: `Residence-Inn-Pool-${months[0]}-to-${months.at(-1)}.pdf` });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The report could not be prepared."); }
    finally { setBusy(false); }
  }
  return <section className="rounded-lg border border-slate-600 p-3 print:hidden" aria-label="Swimming facility report">
    <h2 className="font-semibold">Swimming Facility Report</h2>
    <p className="text-sm">Official monthly form · Residence Inn · Champaign · Pool. One AM and one PM reading each cover both ends. Saved readings only; unrecorded fields stay blank.</p>
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label>From (MM/YY)<input aria-label="Report start month (MM/YY)" className="ml-2 w-24 rounded border p-2" placeholder="01/26" value={start} disabled={busy} onChange={event => { setStart(event.target.value); setDownload(null); }} /></label>
      <label>Through (MM/YY)<input aria-label="Report end month (MM/YY)" className="ml-2 w-24 rounded border p-2" placeholder="12/26" value={end} disabled={busy} onChange={event => { setEnd(event.target.value); setDownload(null); }} /></label>
      <button type="button" className="rounded-lg bg-cyan-700 px-3 py-2 disabled:opacity-50" disabled={disabled || !facilityId || busy} onClick={() => void prepare()}>{busy ? "Preparing report…" : "Prepare printable report"}</button>
      {download ? <><a href={download.url} target="_blank" rel="noopener" className="underline">Open PDF to print</a><a href={download.url} download={download.name} className="underline">Download PDF</a></> : null}
    </div>
    {error ? <p role="alert" className="mt-2 text-red-300">{error}</p> : null}
  </section>;
}
