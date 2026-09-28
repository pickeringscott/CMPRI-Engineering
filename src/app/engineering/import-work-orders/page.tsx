"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SearchableSelect, { type SearchableSelectOption } from "@/components/SearchableSelect";
import { authorizationHeaders, hasCapability, loadCmpriSession } from "@/lib/auth/client-session";

type ImportRow = { external_id?: string; location?: string; issue?: string; notes?: string; status?: string; category?: string; priority?: string; reported_at?: string };
type Result = { ok?: boolean; imported?: number; skipped?: { row: number; reason: string; existing_work_order_id?: string }[]; work_orders?: { id: string; display_id?: string | null }[]; error?: string };

const sourceOptions: SearchableSelectOption[] = [
  { value: "SafetyCulture", label: "SafetyCulture", group: "Import source" },
  { value: "Spreadsheet", label: "Spreadsheet / legacy issue list", group: "Import source" },
];

function parseCsvLine(line: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { values.push(value.trim()); value = ""; }
    else value += char;
  }
  values.push(value.trim());
  return values;
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fieldForHeader(header: string): keyof ImportRow | null {
  const value = normalizeHeader(header);
  if (["id", "source id", "external id", "safetyculture id", "ticket id", "issue id"].includes(value)) return "external_id";
  if (["room", "room number", "location", "room location", "area"].includes(value)) return "location";
  if (["issue", "issue description", "description", "problem", "work order", "work order issue"].includes(value)) return "issue";
  if (["notes", "note", "comments", "comment", "details"].includes(value)) return "notes";
  if (["status", "state"].includes(value)) return "status";
  if (["category", "trade"].includes(value)) return "category";
  if (["priority", "severity"].includes(value)) return "priority";
  if (["reported at", "created at", "created", "date", "reported date", "date reported"].includes(value)) return "reported_at";
  return null;
}

function parseTable(raw: string): ImportRow[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = parseCsvLine(lines[0], delimiter).map(fieldForHeader);
  if (!headers.includes("location") || !headers.includes("issue")) return [];
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    const row: ImportRow = {};
    headers.forEach((field, index) => { if (field && values[index] !== undefined) row[field] = values[index]; });
    return row;
  }).filter((row) => row.location?.trim() && row.issue?.trim());
}

export default function ImportWorkOrdersPage() {
  const router = useRouter();
  const [source, setSource] = useState("SafetyCulture");
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const session = await loadCmpriSession();
        if (!hasCapability(session, "edit_tickets")) { router.replace(session.landing || "/engineering"); return; }
      } catch { router.replace("/"); return; }
      setLoading(false);
    })();
  }, [router]);

  const preview = useMemo(() => rows.slice(0, 20), [rows]);

  function parse() {
    const parsed = parseTable(raw);
    setRows(parsed);
    setResult(null);
    setMessage(parsed.length ? `${parsed.length} row${parsed.length === 1 ? "" : "s"} parsed. CMPRI validates rooms and duplicates before saving.` : "No import rows found. Include a header row with Room/Location and Issue/Description columns.");
  }

  async function fileChosen(file?: File) {
    if (!file) return;
    setRaw(await file.text());
    setRows([]); setResult(null); setMessage(`${file.name} loaded. Review it, then click Parse Rows.`);
  }

  async function importRows() {
    if (!rows.length || saving) return;
    setSaving(true); setMessage(""); setResult(null);
    try {
      const response = await fetch("/api/work-orders/import", {
        method: "POST",
        headers: { ...(await authorizationHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ source, rows }),
      });
      const payload = await response.json() as Result;
      setResult(payload);
      if (!response.ok) throw new Error(payload.error || "Import failed.");
      setMessage(`Imported ${payload.imported || 0} work order${payload.imported === 1 ? "" : "s"}. ${payload.skipped?.length || 0} existing/duplicate row${payload.skipped?.length === 1 ? " was" : "s were"} skipped.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Import failed."); }
    finally { setSaving(false); }
  }

  if (loading) return <main className="min-h-screen bg-slate-950 p-6 text-slate-100">Loading import controls…</main>;

  return <main className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-6"><div className="mx-auto w-full">
    <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">CMPRI v1.0</p><p className="mt-2 max-w-3xl text-sm text-slate-400">Bring in SafetyCulture or spreadsheet issues without turning Duplicate into a work-order status. CMPRI validates every room, blocks repeat source IDs, and skips likely duplicates before saving.</p></div><a href="/engineering" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</a></header>
    {message && <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm">{message}</div>}

    <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-5"><div className="grid gap-4 md:grid-cols-[260px_1fr]"><label className="grid gap-1 text-xs text-slate-400">Import source<SearchableSelect value={source} options={sourceOptions} onChange={setSource} placeholder="Import source" required /></label><div className="text-xs text-slate-400"><p className="font-semibold text-slate-200">Required columns: Room/Location + Issue/Description</p><p className="mt-1">Optional: Source ID, Notes, Status, Category, Priority, Reported At. Supported imported statuses are Open, In Progress, Completed, Closed, and Will Not Do.</p></div></div>
      <textarea value={raw} onChange={(e) => { setRaw(e.target.value); setRows([]); setResult(null); }} rows={12} className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-xs outline-none focus:border-amber-400" placeholder={'Source ID\tRoom\tIssue\tNotes\tStatus\tCategory\tPriority\tReported At\nSC-12345\t409\tGarbage disposal needs replacement\tGuest reported jammed unit\tOpen\tPlumbing\tMedium\t2026-09-14 14:30'} />
      <div className="mt-3 flex flex-wrap gap-2"><button onClick={parse} disabled={!raw.trim() || saving} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">Parse Rows</button><label className="cursor-pointer rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">Load CSV / TSV / TXT<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => void fileChosen(e.target.files?.[0])} /></label>{rows.length > 0 && <button onClick={() => void importRows()} disabled={saving} className="rounded-lg border border-green-500/50 bg-green-950/30 px-4 py-2 text-sm font-bold text-green-100 disabled:opacity-50">{saving ? "Importing…" : `Validate and import ${rows.length} parsed rows`}</button>}</div>
    </section>

    {rows.length > 0 && <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-4"><div className="flex items-center justify-between"><h2 className="text-xl font-bold">Preview</h2><span className="text-xs text-slate-500">Showing {preview.length} of {rows.length}</span></div><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-2">Source ID</th><th className="pb-2">Room</th><th className="pb-2">Issue</th><th className="pb-2">Status</th><th className="pb-2">Category</th><th className="pb-2">Priority</th></tr></thead><tbody className="divide-y divide-slate-800">{preview.map((row, index) => <tr key={`${row.external_id || "row"}-${index}`}><td className="py-2 pr-3">{row.external_id || "—"}</td><td className="py-2 pr-3 font-semibold">{row.location}</td><td className="py-2 pr-3">{row.issue}</td><td className="py-2 pr-3">{row.status || "Open"}</td><td className="py-2 pr-3">{row.category || "Auto"}</td><td className="py-2">{row.priority || "Auto"}</td></tr>)}</tbody></table></div></section>}

    {result?.skipped && result.skipped.length > 0 && <section className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-950/10 p-4"><h2 className="text-xl font-bold text-amber-100">Skipped Rows</h2><div className="mt-3 space-y-2">{result.skipped.map((item) => <div key={`${item.row}-${item.existing_work_order_id || item.reason}`} className="rounded-lg border border-amber-500/20 p-3 text-sm"><b>Row {item.row}</b> · {item.reason}{item.existing_work_order_id && <a href={`/work-orders/${item.existing_work_order_id}`} className="ml-2 text-amber-300 underline">Open existing ticket</a>}</div>)}</div></section>}
  </div></main>;
}
