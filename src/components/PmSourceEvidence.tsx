"use client";
import { useCallback, useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { findPmTemplate } from "@/lib/pm/catalog";
import type { PmSourcePage } from "@/lib/pm/source-evidence";

type Source = { source_id: string; source_name: string; page_count: number; pages: PmSourcePage[]; confirmed_by_name: string; confirmed_at: string };
type Preview = { action: string; pageCount: number; previewDigest: string; applied: boolean; inserted: number; skipped: number };
export default function PmSourceEvidence({ canReview = false, templateId }: { canReview?: boolean; templateId?: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("");
  const [draftPages, setDraftPages] = useState<PmSourcePage[]>([]);
  const load = useCallback(async () => {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to view source evidence.");
      const response = await fetch("/api/preventive-maintenance/source-evidence", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Source evidence could not be loaded.");
      return result.sources as Source[];
  }, []);
  useEffect(() => {
    let current = true;
    void load().then(result => { if (current) setSources(result); }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "Source evidence could not be loaded."); });
    return () => { current = false; };
  }, [load]);
  async function run(apply: boolean) {
    setBusy(true); setError("");
    try {
      const parsed = JSON.parse(input);
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again.");
      const response = await fetch("/api/preventive-maintenance/source-evidence", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action: apply ? "apply" : "preview", input: parsed, previewDigest: preview?.previewDigest }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Source import failed.");
      setPreview(result); setDraftPages(parsed.pages);
      if (apply) setSources(await load());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Source import failed."); setPreview(null); }
    finally { setBusy(false); }
  }
  function pageDetails(page: PmSourcePage) {
    return <details key={page.page} className="rounded border border-slate-700 bg-slate-950 p-3">
      <summary className="cursor-pointer font-semibold">Page {page.page} · {page.category} · {page.location} · {page.kind === "blank-template" ? "Blank template" : page.kind === "room-history-reference" ? "Room history reference" : page.findings.length ? "Recorded findings" : "Source observations"}</summary>
      <dl className="mt-3 space-y-2 text-sm"><dt>Existing form</dt><dd>{page.templateId ? findPmTemplate(page.templateId)?.title : "Unmatched — review needed"}</dd><dt>Frequency</dt><dd>{page.frequency}</dd><dt>Source date as written</dt><dd>{page.rawDate || "No date recorded"}</dd><dt>Verified observation date</dt><dd>{page.observedOn || "Unknown / unresolved"}</dd><dt>Source evidence</dt><dd className="whitespace-pre-wrap">{page.evidence}</dd></dl>
      {page.findings.length > 0 && <div className="mt-3 rounded border border-amber-700 p-3"><p className="font-semibold text-amber-200">Defects and contradictory evidence</p><ul className="list-disc pl-5 text-sm">{page.findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul></div>}
      {page.unresolved.length > 0 && <div className="mt-3"><p className="font-semibold">Unresolved source questions</p><ul className="list-disc pl-5 text-sm">{page.unresolved.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
      <p className="mt-3 text-xs text-slate-400">Source evidence preserves what was recorded. It does not set checklist answers, declare repairs, mark a new inspection complete, or create work orders.</p>
    </details>;
  }
  const categories = [...new Set(sources.flatMap(source => source.pages.filter(page => !templateId || page.templateId === templateId).map(page => page.category)))].sort();
  return <section className="my-4 space-y-3" aria-label="PM source evidence">
    <h3 className="text-lg font-bold">Scanned PM source evidence</h3>
    <p className="text-sm text-slate-400">Blank forms, recorded observations, defects, and uncertain dates are retained separately from confirmed completions.</p>
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {canReview && !templateId && <details className="rounded border border-slate-700 p-3"><summary className="cursor-pointer font-semibold">Import reviewed source coverage</summary>
      <label className="my-3 block">Source evidence JSON file<input type="file" accept=".json,application/json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; setPreview(null); if (file.size > 4_000_000) { setError("File is too large."); return; } setInput(await file.text()); }} /></label>
      <label>Source evidence JSON<textarea className="my-2 w-full rounded bg-slate-950 p-3 font-mono text-xs" rows={4} disabled={busy} value={input} onChange={event => { setInput(event.target.value); setPreview(null); }} /></label>
      <button className="rounded border p-2 disabled:opacity-40" disabled={busy || !input.trim()} onClick={() => void run(false)}>Preview source coverage</button>
      {preview && <div className="mt-3"><p role="status">{preview.applied ? `Saved ${preview.inserted} source pages; already present ${preview.skipped}.` : `${preview.pageCount} pages accounted for; ${preview.action === "conflict" ? "conflict: existing evidence differs" : preview.action === "skip" ? "all already present" : "new source"}. No completion or checklist changes.`}</p>
        <div className="my-3 max-h-80 space-y-2 overflow-auto">{draftPages.map(pageDetails)}</div>
        {!preview.applied && <button className="rounded bg-emerald-400 p-2 font-bold text-slate-950 disabled:opacity-40" disabled={busy || preview.action === "conflict"} onClick={() => void run(true)}>Confirm source evidence import</button>}
      </div>}
    </details>}
    {!templateId && categories.length > 0 && <label>Source category<select className="ml-3 rounded bg-slate-950 p-2" value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>}
    {sources.map(source => {
      const pages = source.pages.filter(page => (!templateId || page.templateId === templateId) && (!category || page.category === category));
      if (!pages.length) return null;
      return <div key={source.source_id} className="space-y-2"><p className="font-semibold">{source.source_name} · {source.page_count}/{source.page_count} source pages accounted for · {pages.length} shown</p><p className="text-xs text-slate-400">{source.source_id} · Reviewed by {source.confirmed_by_name}</p>{pages.map(pageDetails)}</div>;
    })}
    {!sources.length && !error && <p className="text-sm text-slate-400">No scanned source evidence imported yet.</p>}
  </section>;
}
