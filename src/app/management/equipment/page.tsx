"use client";

import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import SearchableSelect, { type SearchableSelectOption } from "@/components/SearchableSelect";

type Asset = {
  id: string;
  location_id: string | null;
  asset_type: string;
  name: string;
  asset_tag: string | null;
  active: boolean;
  status: string;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  generation: string | null;
  install_year: number | null;
  documentation_key: string | null;
  documentation_verified?: boolean;
  documentation_count?: number;
};

type Doc = {
  name: string;
  id?: string;
  updated_at?: string;
  created_at?: string;
  storage_path?: string;
  url?: string | null;
};

type Suggestions = Partial<Pick<Asset, "asset_type" | "manufacturer" | "model_number" | "serial_number" | "generation" | "install_year">>;
type DocStatus = { state: "ready" | "reading" | "processed" | "failed"; message?: string };

const blankAsset: Asset = {
  id: "", location_id: null, asset_type: "", name: "", asset_tag: null, active: true, status: "Active",
  manufacturer: null, model_number: null, serial_number: null, generation: null, install_year: null, documentation_key: null,
  documentation_verified: false, documentation_count: 0,
};

export default function ManageEquipmentPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Asset>(blankAsset);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [showDocumentationDialog, setShowDocumentationDialog] = useState(false);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docStatuses, setDocStatuses] = useState<Record<string, DocStatus>>({});
  const [processingKey, setProcessingKey] = useState("");
  const [extracted, setExtracted] = useState<Suggestions | null>(null);
  const [extractedDraft, setExtractedDraft] = useState<Suggestions>({});
  const [dialogMessage, setDialogMessage] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [editing, setEditing] = useState(false);

  const selected = assets.find((asset) => asset.id === selectedId);
  const verified = Boolean(selected?.documentation_verified || draft.documentation_verified);

  async function token() {
    const session = await getValidSession();
    return session?.access_token || "";
  }

  async function loadAssets(preferId?: string) {
    setLoading(true);
    const access = await token();
    const response = await fetch("/api/assets?include_documentation=false", { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Could not load equipment.");
      setLoading(false);
      return;
    }
    const list = (payload.assets || []) as Asset[];
    setCanManage(payload.can_manage === true);
    setAssets(list);
    const nextId = preferId || selectedId || "";
    const item = list.find((asset) => asset.id === nextId) || blankAsset;
    selectAsset(item);
    setLoading(false);
  }

  async function loadDocuments(assetId: string): Promise<{ documents: Doc[]; verified: boolean }> {
    if (!assetId) return { documents: [], verified: false };
    const access = await token();
    const response = await fetch(`/api/assets/documentation?asset_id=${encodeURIComponent(assetId)}`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load documentation.");
    return { documents: (payload.documents || []) as Doc[], verified: payload.verified === true };
  }

  function displayDocuments(docs: Doc[], verifiedState = false) {
    setDocuments(docs);
    setAssets((current) => current.map((asset) => asset.id === selectedId
      ? { ...asset, documentation_verified: verifiedState, documentation_count: docs.length }
      : asset));
    setDraft((current) => current.id === selectedId
      ? { ...current, documentation_verified: verifiedState, documentation_count: docs.length }
      : current);
    setDocStatuses((current) => {
      const next = { ...current };
      for (const doc of docs) if (!next[doc.storage_path || doc.name]) next[doc.storage_path || doc.name] = { state: "ready" };
      return next;
    });
  }

  useEffect(() => {
    (async () => {
      const allowed = await enforceSessionPreference();
      if (!allowed) { window.location.replace("/"); return; }
      await loadAssets();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectAsset(item: Asset) {
    setSelectedId(item.id);
    setDraft({ ...item });
    setEditing(false);
    setDocuments([]);
    setExtracted(null);
    setExtractedDraft({});
    setDialogMessage("");
    setDocFile(null);
  }

  useEffect(() => {
    let current = true;
    void loadDocuments(selectedId).then((result) => { if (current) displayDocuments(result.documents, result.verified); }).catch(() => {
      if (current) setMessage("Could not load documentation. Please retry.");
    });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function setField<K extends keyof Asset>(key: K, value: Asset[K]) {
    if (!verified && canManage) setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!selectedId || verified || !canManage || saving) return;
    setSaving(true);
    setMessage("Saving equipment…");
    const access = await token();
    const response = await fetch("/api/assets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify({
        id: selectedId,
        name: draft.name,
        asset_type: draft.asset_type,
        asset_tag: draft.asset_tag,
        manufacturer: draft.manufacturer,
        model_number: draft.model_number,
        serial_number: draft.serial_number,
        generation: draft.generation,
        install_year: draft.install_year,
        documentation_key: draft.documentation_key,
        active: draft.active,
      }),
    });
    const payload = await response.json();
    setSaving(false);
    if (!response.ok) { setMessage(payload.error || "Save failed."); return; }
    setMessage("Equipment saved.");
    await loadAssets(selectedId);
  }

  function statusKey(doc: Doc) {
    return doc.storage_path || doc.name;
  }

  function applySuggestions(suggestions: Suggestions) {
    if (verified) return;
    setDraft((current) => ({
      ...current,
      asset_type: suggestions.asset_type || current.asset_type,
      manufacturer: suggestions.manufacturer || current.manufacturer,
      model_number: suggestions.model_number || current.model_number,
      serial_number: suggestions.serial_number || current.serial_number,
      generation: suggestions.generation || current.generation,
      install_year: suggestions.install_year || current.install_year,
    }));
  }

  async function processDocumentation(options?: { storagePath?: string; file?: File }) {
    if (!selectedId) return;
    const file = options?.file;
    const storagePath = options?.storagePath;
    if (!file && !storagePath) return;
    const key = storagePath || `new:${file?.name || "document"}`;
    setProcessingKey(key);
    setDialogMessage("Reading PDF…");
    if (storagePath) setDocStatuses((current) => ({ ...current, [storagePath]: { state: "reading", message: "Reading PDF…" } }));
    const access = await token();
    const form = new FormData();
    form.append("asset_id", selectedId);
    if (file) form.append("file", file);
    if (storagePath) form.append("storage_path", storagePath);
    const response = await fetch("/api/assets/documentation", { method: "POST", headers: { Authorization: `Bearer ${access}` }, body: form });
    const payload = await response.json();
    setProcessingKey("");
    if (!response.ok) {
      const reason = payload.error || "Documentation processing failed.";
      setDialogMessage(reason);
      if (storagePath) setDocStatuses((current) => ({ ...current, [storagePath]: { state: "failed", message: reason } }));
      return;
    }
    const returnedPath = String(payload.document?.storage_path || storagePath || "");
    const state: DocStatus = payload.processing_status === "processed"
      ? { state: "processed", message: payload.processing_message || "Processed" }
      : { state: "failed", message: payload.processing_message || "Equipment information was not loaded." };
    if (returnedPath) setDocStatuses((current) => ({ ...current, [returnedPath]: state }));
    const documentResult = await loadDocuments(selectedId);
    displayDocuments(documentResult.documents, documentResult.verified);
    setDocFile(null);
    if (payload.suggestions) {
      const suggestions = payload.suggestions as Suggestions;
      setExtracted(suggestions);
      setExtractedDraft(suggestions);
      applySuggestions(suggestions);
      setDialogMessage("Processed. Extracted information was loaded into the equipment fields automatically. Review or correct it, then Save Equipment.");
      setMessage("PDF information loaded into the equipment fields. Review the values and Save Equipment when ready.");
    } else {
      setExtracted(null);
      setExtractedDraft({});
      setDialogMessage(payload.processing_message || "Documentation uploaded, but equipment information was not loaded.");
    }
  }

  function loadExtractedIntoEquipment() {
    if (!extracted || verified || !canManage) return;
    applySuggestions(extractedDraft);
    setShowDocumentationDialog(false);
    setMessage("Reviewed documentation information loaded into the equipment record. Make any final corrections, then Save Equipment.");
  }

  async function verify() {
    if (!selectedId || !canManage || verifying) return;
    setVerifying(true);
    setMessage("Confirming equipment against documentation…");
    const access = await token();
    const response = await fetch("/api/assets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify({ id: selectedId, verify_with_documentation: true }),
    });
    const payload = await response.json();
    setVerifying(false);
    if (!response.ok) { setMessage(payload.error || "Verification failed."); return; }
    setMessage("Verified from documentation. These equipment fields are now locked.");
    await loadAssets(selectedId);
  }

  const extractedFields = [
    ["asset_type", "Equipment type"],
    ["manufacturer", "Manufacturer"],
    ["model_number", "Model number"],
    ["serial_number", "Serial number"],
    ["generation", "Generation"],
  ] as const;
  const assetOptions: SearchableSelectOption[] = assets.map((asset) => ({
    value: asset.id,
    label: asset.name || asset.asset_type || "Unnamed equipment",
    group: asset.asset_type || "Equipment",
    keywords: [asset.asset_type, asset.manufacturer, asset.model_number, asset.serial_number, asset.asset_tag].filter(Boolean) as string[],
  }));

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-3 py-4 sm:px-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">CMPRI Engineering</p>
            <h1 className="mt-1 text-3xl font-bold">Manage Equipment</h1>
            <p className="mt-1 text-sm text-slate-400">Equipment records, manufacturer documentation, and verified information.</p>
          </div>
          <a href="/engineering" className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">← Dashboard</a>
        </header>

        {message && <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200">{message}</div>}

        <div className="mt-5 grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
            <div className="border-b border-slate-800 px-4 py-3">
              <h2 className="font-bold">All Equipment</h2>
              <p className="text-xs text-slate-500">{loading ? "Loading…" : `${assets.length} records`}</p>
            </div>
            <div className="p-4">
              <SearchableSelect
                value={selectedId}
                options={assetOptions}
                onChange={(value) => {
                  const item = assets.find((asset) => asset.id === value);
                  if (item) selectAsset(item);
                }}
                placeholder={loading ? "Loading equipment…" : "Search all equipment…"}
                topSuggestions={3}
                noMatchesText="No equipment matches this search."
                disabled={loading || !assets.length}
              />
              <p className="mt-2 text-xs text-slate-500">Search by equipment name, type, manufacturer, model, serial number, or asset tag.</p>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            {!selected ? <p className="text-slate-400">Select equipment to review it.</p> : <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold">{selected.name}</h2>
                  <p className="mt-1 text-sm text-slate-400">{verified ? "Verified fields are locked against casual edits." : "Review and save the equipment record before final documentation verification."}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {verified && <span className="rounded-full border border-emerald-500/40 bg-emerald-950/40 px-3 py-1 text-xs font-bold text-emerald-200">Verified documentation</span>}
                  {canManage && !verified && !editing && <button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-cyan-500/50 bg-cyan-950/30 px-4 py-2 text-sm font-bold text-cyan-100 hover:bg-cyan-900/40">Edit Equipment</button>}
                  {canManage && !verified && editing && <button type="button" onClick={() => setShowDocumentationDialog(true)} className="rounded-md border border-cyan-500/50 bg-cyan-950/30 px-3 py-1.5 text-xs font-bold text-cyan-100">Choose PDF</button>}
                  {canManage && !verified && editing && <button type="button" disabled={saving} onClick={() => void save()} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-bold disabled:opacity-50">{saving ? "Saving…" : "Save Equipment"}</button>}
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {([['name','Equipment name'],['asset_type','Equipment type'],['manufacturer','Manufacturer'],['model_number','Model number'],['serial_number','Serial number'],['generation','Generation'],['asset_tag','Asset tag'],['documentation_key','Documentation key']] as const).map(([key,label]) => (
                  <label key={key} className="grid gap-1 text-sm text-slate-300">{label}<input disabled={!editing || verified || !canManage} value={String(draft[key] ?? "")} onChange={(e) => setField(key, e.target.value as never)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:cursor-not-allowed disabled:bg-slate-900 disabled:text-slate-500" /></label>
                ))}
                <label className="grid gap-1 text-sm text-slate-300">Install year<input disabled={!editing || verified || !canManage} type="number" min="1900" max="2200" value={draft.install_year ?? ""} onChange={(e) => setField('install_year', e.target.value ? Number(e.target.value) : null)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:bg-slate-900 disabled:text-slate-500" /></label>
              </div>

              <div className="mt-6 border-t border-slate-800 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><h3 className="text-xl font-bold">Documentation</h3><p className="mt-1 text-sm text-slate-400">Stored once for this equipment and available for review or retry.</p></div>
                  {canManage && editing && !verified && <button type="button" onClick={() => setShowDocumentationDialog(true)} className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-bold text-slate-200">Add PDF</button>}
                </div>
                <div className="mt-3 space-y-2">
                  {documents.length ? documents.map((doc) => {
                    const key = statusKey(doc);
                    const status = docStatuses[key] || { state: "ready" as const };
                    return <div key={key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-300">
                      <div className="min-w-0"><div className="truncate">{doc.name}</div><div className={`mt-1 text-[11px] font-semibold ${status.state === "processed" ? "text-emerald-300" : status.state === "failed" ? "text-red-300" : status.state === "reading" ? "text-cyan-300" : "text-slate-500"}`}>{status.state === "reading" ? "Reading…" : status.state === "processed" ? "Processed" : status.state === "failed" ? `Failed${status.message ? ` · ${status.message}` : ""}` : "Ready"}</div></div>
                      <div className="flex gap-2">
                        {doc.url && <a href={doc.url} target="_blank" rel="noreferrer" className="rounded-md border border-slate-700 px-2 py-1 text-xs font-semibold hover:bg-slate-800">Open PDF</a>}
                        {status.state === "failed" && doc.storage_path && <button type="button" onClick={() => { setShowDocumentationDialog(true); void processDocumentation({ storagePath: doc.storage_path }); }} className="rounded-md border border-red-500/40 px-2 py-1 text-xs font-semibold text-red-200">Try Again</button>}
                      </div>
                    </div>;
                  }) : <p className="text-sm text-slate-500">No uploaded documentation for this equipment.</p>}
                </div>
              </div>

              {canManage && editing && !verified && <div className="mt-8 border-t border-slate-700 pt-6">
                <p className="text-sm text-slate-400">Final step: after reviewing the equipment fields and saved documentation, confirm to lock the verified information.</p>
                <div className="mt-3 flex justify-end"><button type="button" disabled={!documents.length || verifying} onClick={() => void verify()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">{verifying ? "Confirming…" : "Confirm with Documentation & Lock Fields"}</button></div>
              </div>}
            </>}
          </section>
        </div>
      </div>

      {showDocumentationDialog && selected && canManage && editing && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-1">
          <div role="dialog" aria-modal="true" className="cmpri-modal-shell rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-xl font-bold">Add Documentation</h2><p className="mt-1 text-sm text-slate-400">{selected.name}</p></div>
              <button type="button" onClick={() => setShowDocumentationDialog(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm">Close</button>
            </div>

            <div className="mt-5 rounded-xl border border-slate-700 bg-slate-950 p-4">
              <label className="block text-sm font-semibold text-slate-200">Choose manufacturer/equipment PDF</label>
              <input type="file" accept="application/pdf,.pdf" onChange={(e) => setDocFile(e.target.files?.[0] || null)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-sm file:mr-2 file:rounded file:border-0 file:bg-cyan-800 file:px-3 file:py-1.5 file:text-white" />
              <div className="mt-3 flex justify-end"><button type="button" disabled={!docFile || Boolean(processingKey)} onClick={() => docFile && void processDocumentation({ file: docFile })} className={`rounded-lg border px-4 py-2 text-sm font-bold ${processingKey ? "border-cyan-700 bg-cyan-950/60 text-cyan-200" : "border-cyan-500/50 bg-cyan-950/30 text-cyan-100"} disabled:opacity-40`}>{processingKey ? "Reading PDF…" : "Upload & Read"}</button></div>
            </div>

            {dialogMessage && <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${/processed/i.test(dialogMessage) ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-200" : /failed|could not|not configured|not loaded/i.test(dialogMessage) ? "border-red-500/40 bg-red-950/25 text-red-200" : "border-slate-700 bg-slate-950 text-slate-300"}`}>{dialogMessage}</div>}

            {extracted && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/15 p-4">
              <h3 className="font-bold text-amber-100">Extracted equipment information</h3>
              <p className="mt-1 text-xs text-amber-200/70">These values were loaded into the equipment fields automatically. Make corrections here if needed; saving and final verification remain separate steps.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {extractedFields.map(([key, label]) => <label key={key} className="grid gap-1 text-xs font-semibold text-slate-300">{label}<input value={String(extractedDraft[key] ?? "")} onChange={(e) => setExtractedDraft((current) => ({ ...current, [key]: e.target.value || null }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white" /></label>)}
                <label className="grid gap-1 text-xs font-semibold text-slate-300">Install year<input type="number" value={extractedDraft.install_year ?? ""} onChange={(e) => setExtractedDraft((current) => ({ ...current, install_year: e.target.value ? Number(e.target.value) : null }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white" /></label>
              </div>
              <div className="mt-4 flex justify-end"><button type="button" onClick={loadExtractedIntoEquipment} className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white">Apply Reviewed Values</button></div>
            </div>}

            <div className="mt-5 border-t border-slate-800 pt-4">
              <h3 className="text-sm font-bold">Already uploaded</h3>
              <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                {documents.length ? documents.map((doc) => {
                  const key = statusKey(doc);
                  const status = docStatuses[key] || { state: "ready" as const };
                  return <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs">
                    <div className="min-w-0"><div className="truncate text-slate-300">{doc.name}</div><div className={`mt-1 font-semibold ${status.state === "processed" ? "text-emerald-300" : status.state === "failed" ? "text-red-300" : status.state === "reading" ? "text-cyan-300" : "text-slate-500"}`}>{status.state === "reading" ? "Reading…" : status.state === "processed" ? "Processed" : status.state === "failed" ? "Failed" : "Ready"}</div></div>
                    {doc.storage_path && <button type="button" disabled={Boolean(processingKey)} onClick={() => void processDocumentation({ storagePath: doc.storage_path })} className="rounded-md border border-slate-600 px-2 py-1 font-bold text-slate-200 disabled:opacity-40">{status.state === "failed" ? "Try Again" : "Read Again"}</button>}
                  </div>;
                }) : <p className="text-xs text-slate-500">No documents uploaded yet.</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
