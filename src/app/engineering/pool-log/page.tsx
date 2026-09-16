"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { getValidSession } from "@/lib/supabase/client";
import { CMPRI_POOL, poolLocationReadings, poolLocationValue, poolReadings, sampleComplete } from "@/lib/pool-log";
import SearchableSelect from "@/components/SearchableSelect";

type Facility = {
  id: string;
  facility_name: string;
  pool_name: string;
  city: string;
  sanitizer: string;
  volume_gallons: number | null;
};
type Log = Record<string, unknown> & {
  id: string;
  revision: number;
  log_date: string;
  completed_by_initials: string;
  remarks: string;
  updated_at: string;
};

function emptyForm() {
  return Object.fromEntries([
    ...poolReadings.map(([key]) => [key, ""]),
    ["main_drain_visible", ""],
    ["filter_backwashed", ""],
    ["remarks", ""],
    ["requires_attention", false],
    ["closure_condition", false],
  ]);
}

function genericReading(log: Log, key: string) {
  if (log[key] != null) return log[key];
  const match = key.match(/^(ph|sanitizer)_(am|pm)$/);
  if (!match) return null;
  const shallow = log[`${match[1]}_shallow_${match[2]}`];
  const deep = log[`${match[1]}_deep_${match[2]}`];
  if (shallow != null && deep != null && Number(shallow) === Number(deep)) return shallow;
  return shallow ?? deep ?? null;
}

function formFromLog(log: Log | null): Record<string, unknown> {
  const result = emptyForm();
  if (!log) return result;
  for (const key of Object.keys(result)) {
    const value = key.startsWith("ph_") || key.startsWith("sanitizer_") ? genericReading(log, key) : log[key];
    result[key] = typeof result[key] === "boolean" ? value === true : value == null ? "" : String(value);
  }
  return result;
}

export default function PoolLogPage() {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date()));
  const [facilityChoice, setFacilityChoice] = useState("");
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facility, setFacility] = useState<Facility | null>(null);
  const [saved, setSaved] = useState<Log | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>(emptyForm);
  const [baseline, setBaseline] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const dirty = baseline !== "" && JSON.stringify(form) !== baseline;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await Promise.resolve();
      setLoading(true);
      setMessage("");
      const session = await getValidSession();
      if (!session) { window.location.replace("/"); return; }
      const query = new URLSearchParams({ date, ...(facilityChoice ? { facility: facilityChoice } : {}) });
      const response = await fetch(`/api/pool-log?${query}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json() as { error?: string; facilities?: Facility[]; facility?: Facility; log?: Log | null; can_edit?: boolean };
      if (!response.ok) throw new Error(result.error || "Unable to load pool log.");
      if (controller.signal.aborted) return;
      const values = formFromLog(result.log || null);
      setFacilities(result.facilities || []);
      setFacility(result.facility || null);
      setSaved(result.log || null);
      setForm(values);
      setBaseline(JSON.stringify(values));
      setCanEdit(result.can_edit === true);
    })().catch((error) => {
      if (!controller.signal.aborted) {
        setFacility(null);
        setSaved(null);
        setMessage(error instanceof Error ? error.message : "Unable to load pool log.");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, facilityChoice, reload]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function change(key: string, value: unknown) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!facility || saving || loading || !canEdit) return;
    setSaving(true);
    setMessage("");
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again before saving. Your readings have not been discarded.");
      const payload: Record<string, unknown> = {
        ...form,
        log_date: date,
        pool_facility_id: facility.id,
        expected_revision: saved?.revision ?? null,
      };
      for (const [key] of poolReadings) payload[key] = form[key] === "" ? null : Number(form[key]);
      for (const key of ["main_drain_visible", "filter_backwashed"]) payload[key] = form[key] === "" ? null : form[key] === "true";
      const response = await fetch("/api/pool-log", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string; log?: Log };
      if (!response.ok || !result.log) throw new Error(result.error || "Unable to save readings.");
      const values = formFromLog(result.log);
      setSaved(result.log);
      setForm(values);
      setBaseline(JSON.stringify(values));
      setMessage("Pool log saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save readings.");
    } finally {
      setSaving(false);
    }
  }

  const fieldClass = "mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 p-2 text-white disabled:opacity-70";
  const amComplete = saved ? sampleComplete(saved, "am") : form.ph_am !== "" && form.sanitizer_am !== "";
  const pmComplete = saved ? sampleComplete(saved, "pm") : form.ph_pm !== "" && form.sanitizer_pm !== "";

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-white print:bg-white print:p-0 print:text-black">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">CMPRI — Daily Pool Log</h1>
            <p className="text-sm text-slate-300">Indoor bromine pool · {CMPRI_POOL.testKit}</p>
          </div>
          <div className="flex gap-2 print:hidden">
            <Link className="rounded-lg border border-slate-600 px-3 py-2" href="/engineering">Dashboard</Link>
            <button type="button" disabled={!saved || dirty || loading || saving} onClick={() => window.print()} className="rounded-lg bg-cyan-700 px-3 py-2 disabled:opacity-50">Print saved log</button>
          </div>
        </header>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm print:border-black print:bg-white">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div><span className="text-slate-400 print:text-black">Inspection volume</span><div className="font-bold">{CMPRI_POOL.inspectionVolumeGallons.toLocaleString()} gal</div></div>
            <div><span className="text-slate-400 print:text-black">Chemical dosing basis</span><div className="font-bold">{CMPRI_POOL.dosingBasisGallons.toLocaleString()} gal</div></div>
            <div><span className="text-slate-400 print:text-black">Required flow</span><div className="font-bold">{CMPRI_POOL.requiredFlowGpm} GPM</div></div>
            <div><span className="text-slate-400 print:text-black">Observed 06/23/2026</span><div className="font-bold">{CMPRI_POOL.observedFlowGpm20260623} GPM</div></div>
          </div>
          <p className="mt-3 text-xs text-slate-400 print:text-black">CMPRI records one physical AM sample and one physical PM sample. Each sample contains pH + bromine; the same measured result is entered in both Shallow and Deep report cells under the site&apos;s inspector direction. This page records results only—it does not calculate chemical doses or certify pool opening.</p>
        </section>

        <section className="print:hidden">
          <div className="flex flex-wrap gap-3">
            <label>Date<input type="date" value={date} disabled={saving || dirty} onChange={(event) => setDate(event.target.value)} className={fieldClass} /></label>
            {facilities.length > 1 ? <label className="min-w-56">Pool<SearchableSelect value={facilityChoice || facility?.id || ""} disabled={saving || dirty} onChange={setFacilityChoice} placeholder="Pool" options={facilities.map((item) => ({ value: item.id, label: item.pool_name }))} /></label> : null}
            <button type="button" disabled={saving || loading} className="self-end rounded-lg border border-slate-600 p-2" onClick={() => setReload((value) => value + 1)}>{dirty ? "Discard edits and reload" : "Reload"}</button>
          </div>
          {message ? <p role="status" className="my-3 rounded-lg border border-amber-400 p-3">{message}</p> : null}
          {loading ? <p className="py-4">Loading saved readings…</p> : facility ? (
            <form onSubmit={save} className="mt-4 space-y-4">
              <fieldset disabled={!canEdit || saving} className="space-y-4 disabled:opacity-80">
                <div className="grid gap-4 sm:grid-cols-2">
                  {(["am", "pm"] as const).map((period) => (
                    <section key={period} className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                      <div className="flex items-center justify-between"><h2 className="font-bold">{period.toUpperCase()} physical sample</h2><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${(period === "am" ? amComplete : pmComplete) ? "bg-emerald-900 text-emerald-200" : "bg-slate-800 text-slate-400"}`}>{(period === "am" ? amComplete : pmComplete) ? "Complete" : "Not complete"}</span></div>
                      <label className="mt-3 block text-sm">pH<input type="number" min="0" max="14" step="any" value={String(form[`ph_${period}`] ?? "")} onChange={(event) => change(`ph_${period}`, event.target.value)} className={fieldClass} /></label>
                      <label className="mt-3 block text-sm">Bromine (ppm)<input type="number" min="0" step="any" value={String(form[`sanitizer_${period}`] ?? "")} onChange={(event) => change(`sanitizer_${period}`, event.target.value)} className={fieldClass} /></label>
                      <p className="mt-2 text-xs text-slate-500">One test only. CMPRI duplicates this result into both Shallow and Deep inspector cells.</p>
                    </section>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {poolReadings.filter(([key]) => !["ph_am", "sanitizer_am", "ph_pm", "sanitizer_pm"].includes(key)).map(([key, label]) => <label key={key} className="text-sm">{label}<input type="number" min="0" step="any" value={String(form[key] ?? "")} onChange={(event) => change(key, event.target.value)} className={fieldClass} /></label>)}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[["main_drain_visible", "Main drain visible"], ["filter_backwashed", "Filter backwashed"]].map(([key, label]) => <label key={key}>{label}<SearchableSelect value={String(form[key] ?? "")} onChange={(value) => change(key, value)} placeholder={label} options={[{ value: "", label: "Not recorded" }, { value: "true", label: "Yes" }, { value: "false", label: "No" }]} /></label>)}
                </div>
                <label className="flex gap-2"><input type="checkbox" checked={form.requires_attention === true} onChange={(event) => change("requires_attention", event.target.checked)} />Attention needed</label>
                <label className="flex gap-2"><input type="checkbox" checked={form.closure_condition === true} onChange={(event) => change("closure_condition", event.target.checked)} />Closure condition recorded — describe below</label>
                <label className="block">Remarks / actions taken<textarea value={String(form.remarks ?? "")} maxLength={20000} rows={4} onChange={(event) => change("remarks", event.target.value)} className={fieldClass} /></label>
              </fieldset>
              {canEdit ? <button type="submit" disabled={saving || !dirty} className="rounded-lg bg-cyan-600 px-4 py-2 font-bold disabled:opacity-50">{saving ? "Saving…" : "Save pool log"}</button> : <p className="text-slate-300">View-only access</p>}
              {saved ? <p className="text-sm text-slate-400">Recorded by {saved.completed_by_initials} · Revision {saved.revision}</p> : null}
            </form>
          ) : null}
        </section>

        {saved ? <section className="rounded-lg border border-slate-600 p-3 print:border-black">
          <h2 className="font-semibold">Inspector shallow / deep recording</h2>
          <p className="text-sm">Each AM/PM physical sample is intentionally shown in both locations.</p>
          <table className="mt-3 w-full border-collapse text-sm"><thead><tr><th className="border p-2 text-left">Location / measurement</th><th className="border p-2 text-left">Recorded value</th></tr></thead><tbody>{poolLocationReadings.map(([key, label]) => <tr key={key}><td className="border p-2">{label}</td><td className="border p-2">{poolLocationValue(saved, key) == null ? "Not recorded" : String(poolLocationValue(saved, key))}</td></tr>)}</tbody></table>
          <p className="mt-4 whitespace-pre-wrap text-sm">Remarks: {saved.remarks || "None recorded"}</p>
          <p className="mt-2 text-sm">Recorded by: {saved.completed_by_initials} · Saved: {new Date(saved.updated_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} Central · Revision {saved.revision}</p>
        </section> : null}
      </div>
    </main>
  );
}
