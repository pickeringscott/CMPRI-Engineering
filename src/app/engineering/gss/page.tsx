"use client";

import { useCallback, useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";

type Report = { id: string; report_week: string; subject?: string | null; scores?: Record<string, number | string>; updated_at?: string | null };

export default function GssPage() {
  const embedded = useEmbeddedModal();
  const [reports, setReports] = useState<Report[]>([]);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const session = await getValidSession();
    const token = session?.access_token;
    if (!token) return;
    const response = await fetch("/api/engineering/operations", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = await response.json();
    if (!response.ok) setMessage(body.error || "Could not load GSS reports.");
    else setReports(body.gss || []);
  }, []);
  useEffect(() => { (async () => { if (await enforceSessionPreference()) await load(); })(); }, [load]);
  const latest = reports[0];
  const previous = reports[1];
  const keys = Array.from(new Set([...(latest ? Object.keys(latest.scores || {}) : []), ...(previous ? Object.keys(previous.scores || {}) : [])]));

  return <main className="min-h-screen bg-slate-950 text-white"><div className="mx-auto w-full px-3 py-4 sm:px-4">{!embedded && <header className="flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.22em] text-sky-400">CMPRI v1.0</p><h1 className="mt-1 text-3xl font-bold">Weekly GSS Reports</h1><p className="mt-2 text-sm text-slate-400">Monday GSS score reports only. No guest-comment automation is enabled.</p></div><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink></header>}{embedded && <div className="mb-4"><ModalDashboardLink className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold">← Dashboard</ModalDashboardLink></div>}{message && <div className="mt-4 rounded-xl border border-red-500/30 bg-red-950/20 p-3 text-sm text-red-200">{message}</div>}
  <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-5 py-4"><h2 className="text-2xl font-bold">Latest Score Report</h2><p className="text-sm text-slate-400">{latest ? `Week of ${new Date(`${latest.report_week}T12:00:00`).toLocaleDateString()}` : "No GSS email has been imported yet."}</p></div>{latest && <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">{keys.map(key => { const current = Number(latest.scores?.[key]); const old = Number(previous?.scores?.[key]); const comparable = Number.isFinite(current) && Number.isFinite(old); const delta = comparable ? current - old : null; return <div key={key} className="rounded-xl border border-slate-800 bg-slate-950 p-4"><p className="text-sm text-slate-400">{key}</p><p className="mt-1 text-3xl font-bold">{String(latest.scores?.[key] ?? "—")}</p>{delta !== null && <p className={`mt-1 text-xs font-semibold ${delta > 0 ? "text-green-300" : delta < 0 ? "text-red-300" : "text-slate-400"}`}>{delta > 0 ? "+" : ""}{delta.toFixed(1)} vs. prior week</p>}</div>; })}</div>}</section>
  <section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900"><div className="border-b border-slate-800 px-5 py-4"><h2 className="text-xl font-bold">History</h2></div><div className="divide-y divide-slate-800">{reports.map(report => <div key={report.id} className="px-5 py-3"><div className="font-semibold">Week of {new Date(`${report.report_week}T12:00:00`).toLocaleDateString()}</div><div className="mt-1 text-xs text-slate-500">{report.subject || "GSS report"} · {Object.keys(report.scores || {}).length} score fields captured</div></div>)}</div></section>
  </div></main>;
}
