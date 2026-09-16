"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import SearchableSelect from "@/components/SearchableSelect";

type SheetResult = {
  ok: boolean;
  can_edit?: boolean;
  safeMode?: boolean;
  sheet: string;
  lastRow: number;
  lastColumn: number;
  values: string[][];
  formulas: string[][];
  timestamp?: string;
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"];

export default function PreventiveMaintenancePage() {
  const currentMonth = MONTHS[new Date().getMonth()];
  const [sheet, setSheet] = useState(currentMonth);
  const [data, setData] = useState<SheetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCell, setSavingCell] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const loadSequence = useRef(0);
  const saveInFlight = useRef(false);
  const invalidateLoad = useCallback(() => { loadSequence.current++; }, []);

  const token = useCallback(async () => {
    const session = await getValidSession();
    return session?.access_token || "";
  }, []);

  const load = useCallback(async (target: string) => {
    const sequence = ++loadSequence.current;
    setLoading(true); setData(null); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/corporate-pm?sheet=${encodeURIComponent(target)}`, {
        headers: { Authorization: `Bearer ${await token()}` },
        cache: "no-store",
      });
      const result = await response.json();
      if (sequence !== loadSequence.current) return;
      if (!response.ok) throw new Error(result.error || "Unable to load Corporate PM tracker.");
      if (result.sheet !== target || !Array.isArray(result.values) || !result.values.every((row: unknown) => Array.isArray(row) && row.every(value => typeof value === "string")) || !Array.isArray(result.formulas) || !result.formulas.every((row: unknown) => Array.isArray(row) && row.every(value => typeof value === "string"))) throw new Error("The PM response did not match the requested sheet or checklist format. Refresh to retry.");
      setData(result);
    } catch (cause) { if (sequence === loadSequence.current) { setData(null); setError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [token]);

  useEffect(() => {
    let current = true;
    const sequenceAtMount = loadSequence.current;
    (async () => {
      const allowed = await enforceSessionPreference();
      if (!current) return;
      if (!allowed) return window.location.replace("/");
      if (loadSequence.current !== sequenceAtMount) return;
      await load(currentMonth);
    })().catch(() => { if (current) { setError("Unable to verify your session. Please sign in again."); setLoading(false); } });
    return () => { current = false; invalidateLoad(); };
  }, [load, currentMonth, invalidateLoad]);

  async function toggle(row: number, column: number, checked: boolean) {
    if (data?.can_edit !== true || data.sheet !== sheet || loading || savingCell || saveInFlight.current) return;
    if (data.formulas[row - 1]?.[column - 1] !== "" || !["TRUE", "FALSE"].includes(data.values[row - 1]?.[column - 1])) return;
    saveInFlight.current = true;
    const key = `${row}:${column}`;
    setSavingCell(key); setError(""); setMessage("");
    try {
      const response = await fetch("/api/corporate-pm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ action: "setcheckbox", sheet, row, column, checked }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to update Corporate PM tracker.");
      const wasBlocked = result?.safeMode === true && result?.blocked === true;
      await load(sheet);
      if (wasBlocked) {
        setMessage(`Safe mode is on: ${sheet} cell ${columnName(column)}${row} was captured here but NOT sent to the corporate PM tracker.`);
      } else {
        setMessage(`Saved ${sheet} cell ${columnName(column)}${row} to the live corporate PM tracker.`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { saveInFlight.current = false; setSavingCell(""); }
  }

  const visibleRows = (data?.values || [])
    .map((row, index) => ({ row, rowNumber: index + 1, formulas: data?.formulas?.[index] || [] }))
    .filter(({ row }) => row.some((value) => String(value || "").trim() !== ""));

  return <main className="min-h-screen bg-slate-950 text-white">
    <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
      <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.22em] text-emerald-400">Live Corporate Google Sheet</p>
          <h1 className="mt-1 text-3xl font-bold">Preventive Maintenance</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">Review the corporate PM checklist and record completion. Formula cells are read-only.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/engineering" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-bold">Dashboard</a>
          <div className="min-w-44">
            <SearchableSelect
              value={sheet}
              disabled={!!savingCell}
              placeholder="PM month"
              topSuggestions={4}
              options={MONTHS.map((month) => ({ value: month, label: month }))}
              onChange={(next) => { setSheet(next); void load(next); }}
            />
          </div>
          <button disabled={!!savingCell} onClick={() => load(sheet)} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-bold text-slate-950">Refresh Live PM</button>
        </div>
      </header>

      {error && <div className="mt-4 rounded-xl border border-red-500/40 bg-red-950/30 p-4 text-red-200">{error}</div>}
      {data?.safeMode && <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-950/30 p-4 text-amber-200"><strong>Safe mode is on.</strong> You can view the live corporate PM tracker and click checkboxes here, but nothing is sent back to the corporate spreadsheet. Turn safe mode off in the environment to go live.</div>}
      {message && <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-4 text-emerald-200">{message}</div>}

      <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="font-bold">{sheet} Corporate PM Checklist</h2><p className="text-xs text-slate-500">{data?.timestamp ? `Live API response ${new Date(data.timestamp).toLocaleString()}` : ""}</p></div>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-950/20 px-3 py-1 text-xs font-bold text-emerald-300">{data?.can_edit === true ? "Completion checklist" : "View only"}</span>
        </div>

        {loading ? <p className="p-6 text-slate-400">Loading live corporate PM tracker…</p> :
          <div className="max-h-[72vh] overflow-auto rounded-xl border border-slate-800">
            <table className="min-w-max border-collapse text-xs">
              <tbody>
                {visibleRows.map(({ row, rowNumber, formulas }) => <tr key={rowNumber} className="border-b border-slate-800 align-top">
                  <td className="sticky left-0 z-10 w-12 border-r border-slate-700 bg-slate-900 px-2 py-2 text-right font-mono text-slate-500">{rowNumber}</td>
                  {row.map((value, index) => {
                    const column = index + 1;
                    const formula = Boolean(formulas[index]);
                    const bool = !formula && (value === "TRUE" || value === "FALSE");
                    const cellKey = `${rowNumber}:${column}`;
                    return <td key={column} className={`max-w-[340px] border-r border-slate-800 px-2 py-2 ${formula ? "bg-slate-950/50 text-slate-500" : "text-slate-200"}`}>
                      {bool ? <button disabled={data?.can_edit !== true || loading || !!savingCell} onClick={() => toggle(rowNumber, column, value !== "TRUE")} className={`min-w-16 rounded-md border px-2 py-1 font-bold ${value === "TRUE" ? "border-emerald-500/50 bg-emerald-950/40 text-emerald-200" : "border-slate-600 bg-slate-950 text-slate-400"} disabled:opacity-50`}>{savingCell === cellKey ? "Saving…" : value === "TRUE" ? "✓ Done" : "○ Open"}</button> : <span className="whitespace-pre-wrap">{value}</span>}
                    </td>;
                  })}
                </tr>)}
              </tbody>
            </table>
          </div>}
      </section>
    </div>
  </main>;
}

function columnName(column: number) {
  let n = column;
  let name = "";
  while (n > 0) {
    n -= 1;
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26);
  }
  return name;
}
