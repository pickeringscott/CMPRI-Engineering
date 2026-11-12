"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./asset-browser.css";
import StagedPdfImporter from "@/components/StagedPdfImporter";
import LocalOcrReview, { type ReviewedOcrText, type ReviewedGuideText } from "@/components/LocalOcrReview";
import { invalidateCachedResources } from "@/lib/data-cache/browser";
import { getValidSession } from "@/lib/supabase/client";
import { parseTicketHistory } from "@/lib/ticket-note-presentation";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { maximumAssetInstallYear, parseAssetInstallYear } from "@/lib/asset-install-year";
import useEmbeddedModal from "@/components/use-embedded-modal";
import { equipmentOptionLabel } from "@/lib/equipment-selection";
import { suggestionsFromReviewedOcr } from "@/lib/equipment-ocr-suggestions";
import { afterDocumentSave } from "@/lib/asset-document-version";

function AssetIcon({ name }: { name: "search" | "location" | "layers" | "status" | "equipment" | "details" | "repair" | "document" | "edit" | "move" | "external" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></>,
    location: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/></>,
    status: <path d="M2 12h4l2-7 4 14 3-10 2 3h5"/>,
    equipment: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 10c-4-8 4-7 3-2m-1 5c8-1 4 6 0 3m-4-3c-4 7-7 0-2-2"/></>,
    details: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></>,
    repair: <path d="M14 6a5 5 0 0 0-6 6L3 17a2 2 0 0 0 3 3l5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3Z"/>,
    document: <><path d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6"/></>,
    edit: <><path d="m4 16-1 5 5-1L20 8l-4-4L4 16Zm10-10 4 4"/></>,
    move: <path d="M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4"/>,
    external: <><path d="M13 4h7v7m0-7-9 9"/><path d="M18 13v6H5V6h6"/></>,
  };
  return <svg aria-hidden="true" className="asset-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

type Asset = {
  id: string;
  location_id: string | null;
  asset_type: string;
  name: string;
  asset_tag: string | null;
  binder_tag?: string | null;
  quantity?: number | null;
  active: boolean;
  status: string;
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
  serial_number: string | null;
  generation: string | null;
  install_year: number | null;
  documentation_key: string | null;
  updated_at?: string;
  documentation_revision_id?: string | null;
  documentation_verified?: boolean;
  documentation_count?: number;
};

type Doc = {
  name: string;
  id?: string;
  document_key?: string;
  document_type?: string | null;
  updated_at?: string;
  created_at?: string;
  storage_path?: string;
  url?: string | null;
  source?: "asset" | "catalog";
  verified?: boolean;
};

type Suggestions = Partial<Pick<Asset, "asset_type" | "manufacturer" | "model_family" | "model_number" | "serial_number" | "generation" | "install_year">> & {
  model_candidates?: string[];
};
type DocStatus = { state: "ready" | "reading" | "processed" | "pending" | "failed"; message?: string };

const blankAsset: Asset = {
  id: "", location_id: null, asset_type: "", name: "", asset_tag: null, active: true, status: "Active",
  manufacturer: null, model_family: null, model_number: null, serial_number: null, generation: null, install_year: null, documentation_key: null,
  documentation_verified: false, documentation_count: 0,
};

export default function ManageEquipmentPage() {
  const embedded = useEmbeddedModal();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Asset>(blankAsset);
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [assetLoadError, setAssetLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [showDocumentationDialog, setShowDocumentationDialog] = useState(false);
  const [docStatuses, setDocStatuses] = useState<Record<string, DocStatus>>({});
  const [processingKey, setProcessingKey] = useState("");
  const [extracted, setExtracted] = useState<Suggestions | null>(null);
  const [extractedDraft, setExtractedDraft] = useState<Suggestions>({});
  const [dialogMessage, setDialogMessage] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newAsset, setNewAsset] = useState<Asset>({ ...blankAsset });
  const [locations, setLocations] = useState<Array<{ id: string; name: string; active?: boolean }>>([]);
  const [photo, setPhoto] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useState("");
  const [photoVersion, setPhotoVersion] = useState(0);
  const [assetOrders, setAssetOrders] = useState<Array<{id:string; display_id:string; issue:string; status:string; room:string; notes:string | null; revision:number}>>([]);
  const [ordersError, setOrdersError] = useState("");
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const [moveOrderId, setMoveOrderId] = useState("");
  const [moveError, setMoveError] = useState("");
  const [orderVersion, setOrderVersion] = useState(0);
  const [assetPanel, setAssetPanel] = useState<"details" | "orders" | "documents">("orders");
  const [assetSearch, setAssetSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [browseLocations, setBrowseLocations] = useState<Array<{id:string; name:string; area?:string | null}>>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const createPending = useRef(false);

  async function startAdding() {
    if (!canManage || createPending.current) return;
    setNewAsset({ ...blankAsset });
    setCreateMessage("");
    setLocations([]);
    setAdding(true);
    setLoadingLocations(true);
    try {
      const access = await token();
      if (!access) throw new Error("Sign in again to load locations.");
      const response = await fetch("/api/rooms?mode=create", { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.locations)) throw new Error(payload.error || "Locations could not be loaded. Close and reopen Add Asset to retry.");
      setLocations(payload.locations.filter((location: { active?: boolean }) => location.active !== false));
    } catch (error) {
      setCreateMessage(error instanceof Error ? error.message : "Locations could not be loaded.");
    } finally {
      setLoadingLocations(false);
    }
  }

  async function createAsset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || createPending.current) return;
    if (!locations.some((location) => location.id === newAsset.location_id) || !newAsset.asset_type.trim()) {
      setCreateMessage("Select a location and enter an equipment type.");
      return;
    }
    try {
      parseAssetInstallYear(newAsset.install_year);
    } catch (error) {
      setCreateMessage(error instanceof Error ? error.message : "Install year is invalid.");
      return;
    }
    createPending.current = true;
    setCreating(true);
    setCreateMessage("");
    try {
      const access = await token();
      if (!access) throw new Error("Sign in again to add equipment.");
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({ location_id: newAsset.location_id, asset_type: newAsset.asset_type.trim(),
          asset_tag: newAsset.asset_tag, manufacturer: newAsset.manufacturer, model_family: newAsset.model_family,
          model_number: newAsset.model_number, serial_number: newAsset.serial_number,
          generation: newAsset.generation, install_year: newAsset.install_year }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Equipment could not be created.");
      if (!payload.asset?.id) throw new Error("The save response was incomplete. Reload equipment before retrying.");
      const created = payload.asset as Asset;
      setAssets((current) => [...current, created]);
      selectAsset(created);
      setAdding(false);
      setNewAsset({ ...blankAsset });
      setMessage("Asset added.");
      if (window.parent !== window) {
        window.parent.postMessage({ type: "cmpri-assets-changed", assetId: created.id,
          modalToken: new URLSearchParams(window.location.search).get("modalToken") || "" }, window.location.origin);
      }
    } catch (error) {
      setCreateMessage(error instanceof Error ? error.message : "Equipment could not be created. Check your connection and retry.");
    } finally {
      createPending.current = false;
      setCreating(false);
    }
  }

  const selected = assets.find((asset) => asset.id === selectedId);
  const verified = Boolean(selected?.documentation_verified || draft.documentation_verified);
  const editableKeys = ["name", "asset_type", "asset_tag", "manufacturer", "model_family", "model_number", "serial_number", "generation", "install_year", "documentation_key", "active"] as const;
  const unsavedEquipment = !!selected && editableKeys.some((key) => (selected[key] ?? "") !== (draft[key] ?? ""));
  const [revisionReason, setRevisionReason] = useState("");
  const [openingRevision, setOpeningRevision] = useState(false);
  async function beginRevision(reasonOverride?: string, openDocumentation = false) {
    if (!selected?.updated_at || !verified || !canManage || openingRevision) return;
    setOpeningRevision(true);
    try {
      const access = await token();
      const response = await fetch("/api/assets", { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({ id: selected.id, begin_documentation_revision: true, expected_updated_at: selected.updated_at, revision_reason: reasonOverride || revisionReason }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Revision could not be opened.");
      if (await loadAssets(selected.id)) { setEditing(true); setRevisionReason(""); if (openDocumentation) setShowDocumentationDialog(true); setMessage("Revision opened. Prior verification and files are preserved. Save your corrections, then verify the reviewed record again."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Revision could not be opened."); }
    finally { setOpeningRevision(false); }
  }

  const token = useCallback(async () => {
    const session = await getValidSession();
    return session?.access_token || "";
  }, []);

  async function loadAssets(preferId?: string): Promise<boolean> {
    setLoading(true);
    setMessage("");
    setAssetLoadError(false);
    try {
      const access = await token();
      if (!access) throw new Error("Sign in again to load equipment.");
      const response = await fetch("/api/assets?include_documentation=false", { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.assets)) {
        throw new Error(payload.error || "Could not load equipment.");
      }
      const list = payload.assets as Asset[];
      setCanManage(payload.can_manage === true);
      setAssets(list);
      const nextId = preferId || selectedId || "";
      const item = list.find((asset) => asset.id === nextId) || blankAsset;
      selectAsset(item);
      // A save/revision keeps the same selected id, so the selection effect
      // will not run again after selectAsset clears the displayed documents.
      if (item.id && item.id === selectedId) {
        const result = await loadDocuments(item.id);
        displayDocuments(result.documents, result.verified, item.id);
      }
      return true;
    } catch (error) {
      setAssetLoadError(true);
      setMessage(error instanceof Error ? error.message : "Could not load equipment.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function loadDocuments(assetId: string): Promise<{ documents: Doc[]; verified: boolean; warnings: string[] }> {
    if (!assetId) return { documents: [], verified: false, warnings: [] };
    const access = await token();
    const response = await fetch(`/api/assets/documentation?asset_id=${encodeURIComponent(assetId)}`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load documentation.");
    return {
      documents: (payload.documents || []) as Doc[],
      verified: payload.verified === true,
      warnings: Array.isArray(payload.catalog_warnings) ? payload.catalog_warnings.map(String) : [],
    };
  }

  function displayDocuments(docs: Doc[], verifiedState = false, assetId = selectedId) {
    setDocuments(docs);
    setAssets((current) => current.map((asset) => asset.id === assetId
      ? { ...asset, documentation_verified: verifiedState, documentation_count: docs.length }
      : asset));
    setDraft((current) => current.id === assetId
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
      try {
        const access = await token();
        const response = await fetch("/api/rooms?mode=create", { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
        const payload = await response.json();
        if (response.ok && Array.isArray(payload.locations)) setBrowseLocations(payload.locations);
      } catch { /* Assets remain searchable if location lookup is unavailable. */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectAsset(item: Asset) {
    if (item.id !== selectedId) { setOrdersLoading(Boolean(item.id)); setAssetOrders([]); setOrdersError(""); setPhoto(""); setPhotoMessage(""); setMoving(false); setMoveError(""); }
    setSelectedId(item.id);
    setDraft({ ...item });
    setEditing(false);
    setDocuments([]);
    setExtracted(null);
    setExtractedDraft({});
    setDialogMessage("");
    setRevisionReason("");
  }

  useEffect(() => {
    let current = true;
    void loadDocuments(selectedId).then((result) => {
      if (!current) return;
      displayDocuments(result.documents, result.verified);
      setMessage(result.warnings.length ? result.warnings.join(" ") : "");
    }).catch(() => {
      if (current) setMessage("Could not load documentation. Please retry.");
    });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    let current = true;
    if (!selectedId) return () => { current = false; };
    void (async () => {
      try {
        const access = await token();
        const response = await fetch(`/api/work-orders?mode=asset&asset_id=${encodeURIComponent(selectedId)}`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.work_orders)) throw new Error(payload.error || "Unable to load work orders.");
        if (current) setAssetOrders(payload.work_orders);
      } catch (error) { if (current) setOrdersError(error instanceof Error ? error.message : "Unable to load work orders."); }
      finally { if (current) setOrdersLoading(false); }
    })();
    return () => { current = false; };
  }, [selectedId, token, orderVersion]);

  useEffect(() => {
    let current = true;
    let url = "";
    if (!selectedId) return () => { current = false; };
    void (async () => {
      try {
        const access = await token();
        const response = await fetch(`/api/assets/photo?asset_id=${encodeURIComponent(selectedId)}`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
        if (response.status === 404) return;
        if (!response.ok) throw new Error("Photo could not be loaded.");
        const blob = await response.blob();
        if (current) { url = URL.createObjectURL(blob); setPhoto(url); }
      } catch { if (current) setPhotoMessage("Photo could not be loaded."); }
    })();
    return () => { current = false; if (url) URL.revokeObjectURL(url); };
  }, [selectedId, photoVersion, token]);

  async function uploadPhoto(file: File) {
    if (!selectedId || !canManage || photoBusy) return;
    setPhotoBusy(true); setPhotoMessage("");
    try {
      const access = await token();
      const body = new FormData(); body.set("asset_id", selectedId); body.set("file", file);
      const response = await fetch("/api/assets/photo", { method: "PUT", headers: { Authorization: `Bearer ${access}` }, body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Photo could not be saved.");
      setPhotoVersion(value => value + 1); setPhotoMessage("Photo saved.");
    } catch (error) { setPhotoMessage(error instanceof Error ? error.message : "Photo could not be saved."); }
    finally { setPhotoBusy(false); }
  }

  async function moveAsset() {
    if (!selected || !selected.updated_at || !destinationId || moveBusy) return;
    const order = assetOrders.find(item => item.id === moveOrderId);
    if (!moveOrderId || (moveOrderId !== "none" && !order)) { setMoveError("Select a linked work order or choose no work order."); return; }
    setMoveBusy(true); setMoveError("");
    try {
      const access = await token();
      const response = await fetch("/api/assets/move", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` }, body: JSON.stringify({ assetId: selected.id, destinationId, expectedAssetUpdatedAt: selected.updated_at, workOrderId: order?.id || null, expectedWorkOrderRevision: order?.revision || null }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Move failed.");
      setMoving(false); setDestinationId(""); setMoveOrderId("");
      if (await loadAssets(selected.id)) setMessage("Asset moved.");
      if (window.parent !== window) window.parent.postMessage({ type: "cmpri-assets-changed", assetId: selected.id, modalToken: new URLSearchParams(window.location.search).get("modalToken") || "" }, window.location.origin);
      setOrdersLoading(true); setOrderVersion(value => value + 1);
    } catch (error) { setMoveError(error instanceof Error ? error.message : "Move failed."); }
    finally { setMoveBusy(false); }
  }

  function setField<K extends keyof Asset>(key: K, value: Asset[K]) {
    if (!verified && canManage) setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!selectedId || verified || !canManage || saving) return;
    try {
      parseAssetInstallYear(draft.install_year);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Install year is invalid.");
      return;
    }
    setSaving(true);
    setMessage("Saving equipment…");
    const access = await token();
    const response = await fetch("/api/assets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify({
        id: selectedId,
        expected_updated_at: selected?.updated_at,
        name: draft.name,
        asset_type: draft.asset_type,
        asset_tag: draft.asset_tag,
        manufacturer: draft.manufacturer,
        model_family: draft.model_family,
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
    if (await loadAssets(selectedId)) setMessage("Equipment saved.");
  }

  function statusKey(doc: Doc) {
    return doc.storage_path || doc.name;
  }

  function applySuggestions(suggestions: Suggestions, overwriteExisting = false) {
    if (verified) return;
    setDraft((current) => ({
      ...current,
      asset_type: suggestions.asset_type && (overwriteExisting || !current.asset_type) ? suggestions.asset_type : current.asset_type,
      manufacturer: suggestions.manufacturer && (overwriteExisting || !current.manufacturer) ? suggestions.manufacturer : current.manufacturer,
      model_family: suggestions.model_family && (overwriteExisting || !current.model_family) ? suggestions.model_family : current.model_family,
      model_number: suggestions.model_number && (overwriteExisting || !current.model_number) ? suggestions.model_number : current.model_number,
      serial_number: suggestions.serial_number && (overwriteExisting || !current.serial_number) ? suggestions.serial_number : current.serial_number,
      generation: suggestions.generation && (overwriteExisting || !current.generation) ? suggestions.generation : current.generation,
      install_year: suggestions.install_year && (overwriteExisting || !current.install_year) ? suggestions.install_year : current.install_year,
    }));
  }

  async function processDocumentation(options?: { storagePath?: string; documentKey?: string; file?: File }) {
    if (!selectedId) return;
    const file = options?.file;
    const storagePath = options?.storagePath;
    const documentKey = options?.documentKey;
    if (!file && !storagePath && !documentKey) return;
    const key = storagePath || documentKey || `new:${file?.name || "document"}`;
    setProcessingKey(key);
    setDialogMessage("Reading PDF…");
    if (storagePath) setDocStatuses((current) => ({ ...current, [storagePath]: { state: "reading", message: "Reading PDF…" } }));
    const access = await token();
    const form = new FormData();
    form.append("asset_id", selectedId);
    if (file) {
      try {
        const { uploadImportFile } = await import("@/lib/import-upload");
        form.append("upload_descriptor", JSON.stringify(await uploadImportFile(file, "asset-documentation")));
      } catch (error) { setProcessingKey(""); setDialogMessage(error instanceof Error ? error.message : "PDF upload failed."); return; }
    }
    if (storagePath) form.append("storage_path", storagePath);
    if (documentKey) form.append("document_key", documentKey);
    const response = await fetch("/api/assets/documentation", { method: "POST", headers: { Authorization: `Bearer ${access}` }, body: form });
    const payload = await response.json();
    setProcessingKey("");
    if (!response.ok) {
      const reason = payload.error || "Documentation processing failed.";
      setDialogMessage(reason);
      if (storagePath) setDocStatuses((current) => ({ ...current, [storagePath]: { state: "failed", message: reason } }));
      return;
    }
    const returnedPath = String(payload.document?.storage_path || storagePath || documentKey || "");
    const state: DocStatus = ["pending_identity", "pending_guidance"].includes(payload.processing_status)
      ? { state: "pending", message: payload.processing_message }
      : ["processed", "ready"].includes(payload.processing_status)
      ? { state: "processed", message: payload.processing_message || "Processed" }
      : { state: "failed", message: payload.processing_message || "Equipment information was not loaded." };
    if (returnedPath) setDocStatuses((current) => ({ ...current, [returnedPath]: state }));
    const documentResult = await loadDocuments(selectedId);
    displayDocuments(documentResult.documents, documentResult.verified);
    if (payload.suggestions) {
      const suggestions = payload.suggestions as Suggestions;
      setExtracted(suggestions);
      setExtractedDraft(current => ({ ...suggestions, ...current }));
      // Suggestions require explicit review; never replace user-selected values on re-read.
      setDialogMessage("Suggestions extracted. Review and edit them, then use Apply Reviewed Values.");
      setMessage("PDF suggestions are ready for your review. Equipment fields have not been changed.");
    } else {
      setExtracted(null);
      setExtractedDraft({});
      setDialogMessage(payload.processing_message || "Documentation uploaded, but equipment information was not loaded.");
    }
  }

  function loadExtractedIntoEquipment() {
    if (!extracted || verified || !canManage) return;
    applySuggestions(extractedDraft, true);
    setShowDocumentationDialog(false);
    setMessage("Reviewed documentation information loaded into the equipment record. Make any final corrections, then Save Equipment.");
  }

  async function useReviewedGuide(result: ReviewedGuideText, signal: AbortSignal): Promise<string> {
    if (!selectedId || !canManage || !editing) throw new Error("Select equipment you can manage before saving guide text.");
    const access = await token();
    signal.throwIfAborted();
    if (!access) throw new Error("Sign in again to save reviewed text.");
    const response = await fetch("/api/assets/documentation/reviewed-text", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ assetId: selectedId, sha256: result.sha256, totalPages: result.totalPages, pages: result.pages, reviewConfirmed: true }),
    });
    const payload = await response.json().catch(() => ({}));
    signal.throwIfAborted();
    if (!response.ok || payload.saved !== true || !Array.isArray(payload.pages) ||
        payload.pages.length !== result.pages.length || !result.pages.every(page => payload.pages.includes(page.page))) {
      throw new Error(typeof payload.error === "string" ? payload.error : "The server did not confirm that reviewed pages were saved. Attach the same PDF to this equipment, then retry.");
    }
    try {
      await invalidateCachedResources(["reference", "orders"]);
    } catch {
      signal.throwIfAborted();
      return "Reviewed pages were saved, but open guides could not refresh. Reload the work-order guide to use the saved text.";
    }
    signal.throwIfAborted();
    return typeof payload.message === "string" && payload.message ? payload.message : "Reviewed pages saved. Reopen the work-order guide to use the updated text.";
  }

  function useReviewedOcr(result: ReviewedOcrText) {
    if (!selectedId || !canManage || verified || !editing) return;
    const suggestions = suggestionsFromReviewedOcr(result.pages);
    if (!suggestions) {
      setDialogMessage("No supported labeled equipment values were found in the reviewed text. The text is still available above for manual entry; no equipment fields were changed.");
      return;
    }
    if (extracted && !window.confirm("Replace the suggestions currently under review? Equipment fields already entered will not be changed.")) return;
    setExtracted(suggestions);
    setExtractedDraft(suggestions);
    setDialogMessage("On-device OCR suggestions are unverified. Compare them with the original equipment label or manual before applying. The OCR file has not been uploaded or attached.");
    setMessage("OCR suggestions are ready for review. Equipment fields have not been changed.");
  }

  async function verify() {
    if (!selectedId || !canManage || verifying || unsavedEquipment) { if (unsavedEquipment) setMessage("Save equipment changes before verification."); return; }
    setVerifying(true);
    setMessage("Confirming equipment against documentation…");
    const access = await token();
    const response = await fetch("/api/assets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify({ id: selectedId, verify_with_documentation: true, expected_updated_at: selected?.updated_at }),
    });
    const payload = await response.json();
    setVerifying(false);
    if (!response.ok) { setMessage(payload.error || "Verification failed."); return; }
    if (await loadAssets(selectedId)) setMessage("Verified from documentation. These equipment fields are now locked.");
  }

  const extractedFields = [
    ["asset_type", "Equipment type"],
    ["manufacturer", "Manufacturer"],
    ["model_family", "Exact model family"],
    ["model_number", "Model number"],
    ["serial_number", "Serial number"],
    ["generation", "Generation"],
  ] as const;
  const extractedConflicts = extracted
    ? extractedFields.filter(([key]) => {
        const suggestion = extracted[key];
        const current = selected?.[key];
        return suggestion !== undefined && suggestion !== null && String(current ?? "").trim()
          && String(current).trim().toLowerCase() !== String(suggestion).trim().toLowerCase();
      }).map(([, label]) => label)
    : [];
  const groupedAssets = useMemo(() => {
    const words = assetSearch.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const groups = new Map<string, Map<string, Asset[]>>();
    for (const asset of assets) {
      const location = browseLocations.find((item) => item.id === asset.location_id);
      if (locationFilter && asset.location_id !== locationFilter) continue;
      if (typeFilter && asset.asset_type !== typeFilter) continue;
      if (statusFilter && (asset.active === false ? "inactive" : "active") !== statusFilter) continue;
      const haystack = [asset.name, asset.asset_type, asset.manufacturer, asset.model_family, asset.model_number, asset.serial_number, asset.asset_tag, asset.binder_tag, location?.name, location?.area].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ");
      if (!words.every(word => haystack.includes(word))) continue;
      const area = location?.area || "Other / unassigned";
      const name = location?.name || (asset.location_id ? "Location unavailable" : "Unassigned");
      if (!groups.has(area)) groups.set(area, new Map());
      const locations = groups.get(area)!;
      if (!locations.has(name)) locations.set(name, []);
      locations.get(name)!.push(asset);
    }
    return [...groups.entries()].sort(([a],[b]) => a.localeCompare(b, undefined, {numeric:true})).map(([area, locations]) => [area, [...locations.entries()].sort(([a],[b]) => a.localeCompare(b, undefined, {numeric:true}))] as const);
  }, [assets, browseLocations, assetSearch, locationFilter, typeFilter, statusFilter]);
  const resultCount = groupedAssets.reduce((total, [, locations]) => total + locations.reduce((count, [, items]) => count + items.length, 0), 0);

  return (
    <main className="asset-workspace min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-3 py-4 sm:px-4">
        {!embedded && <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 pb-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">CMPRI Engineering</p>
            <h1 className="mt-1 text-3xl font-bold">Assets</h1>
            <p className="mt-1 text-sm text-slate-400">Equipment records, manufacturer documentation, and verified information.</p>
          </div>
        </header>}
        

        {message && <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200">{message}</div>}

        <div className="asset-layout grid gap-4 pt-2 md:grid-cols-[minmax(260px,34%)_minmax(0,1fr)]">
          <section className="asset-picker min-w-0 bg-slate-900">
            <div className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xl font-bold">All Equipment <span aria-hidden="true" className="asset-heading-chevron">⌄</span></h2>
                <span className="asset-result-count">{loading ? "Loading…" : assetLoadError ? "Unavailable" : `${resultCount} ${resultCount === 1 ? "result" : "results"}`}</span>
                {canManage && <button type="button" disabled={loading || adding} onClick={() => void startAdding()} className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-bold disabled:opacity-50">Add Asset</button>}
              </div>
              
            </div>
            <div className="px-3 pb-3">
              <label className="sr-only" htmlFor="asset-search">Search equipment</label>
              <span className="asset-search-wrap"><AssetIcon name="search" /><input id="asset-search" value={assetSearch} onChange={event => setAssetSearch(event.target.value)} placeholder="Search room, equipment, model or serial…" className="asset-search min-h-10 w-full rounded px-3 text-sm text-white" /></span>
              <div className="asset-filters mt-2 text-sm">
                <label><AssetIcon name="location" /><span className="sr-only">Location</span><select aria-label="Location" value={locationFilter} onChange={event => setLocationFilter(event.target.value)} className="bg-slate-950 p-1"><option value="">Location</option>{browseLocations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
                <label><AssetIcon name="layers" /><span className="sr-only">Type</span><select aria-label="Type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)} className="bg-slate-950 p-1"><option value="">Type</option>{[...new Set(assets.map(item => item.asset_type).filter(Boolean))].sort().map(type => <option key={type} value={type}>{type}</option>)}</select></label>
                <label><AssetIcon name="status" /><span className="sr-only">Status</span><select aria-label="Status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)} className="bg-slate-950 p-1"><option value="">Status</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
              </div>
              <div className="mt-3 max-h-[60vh] overflow-y-auto text-sm">
                {loading ? <p>Loading equipment…</p> : assetLoadError ? <button type="button" onClick={() => void loadAssets()} className="underline">Retry loading equipment</button> : !groupedAssets.length ? <p>No equipment matches this search.</p> : groupedAssets.map(([area, locations]) => <details key={area} open={assetSearch || locationFilter || typeFilter || statusFilter ? true : undefined} className="mb-1">
                  <summary className="asset-group cursor-pointer rounded px-3 py-2 font-bold"><AssetIcon name="layers" /><span className="asset-group-name">{area}</span><span className="asset-group-count text-xs font-normal text-slate-400">{locations.length} {locations.length === 1 ? 'location' : 'locations'} · {locations.reduce((total, [, items]) => total + items.length, 0)} {locations.reduce((total, [, items]) => total + items.length, 0) === 1 ? 'asset' : 'assets'}</span></summary>
                  {locations.map(([location, items]) => <details key={location} open={assetSearch || locationFilter || typeFilter || statusFilter ? true : undefined} className="ml-3">
                    <summary className="asset-location cursor-pointer rounded px-2 py-2 text-slate-300"><AssetIcon name="location" /><span className="asset-location-name">{location}</span><span className="asset-location-count">{items.length} {items.length === 1 ? "asset" : "assets"}</span></summary>
                    {items.map(item => <button type="button" key={item.id} disabled={photoBusy || moveBusy} onClick={() => { if (unsavedEquipment && !window.confirm("Discard unsaved equipment changes?")) return; selectAsset(item); }} className={`asset-result block w-full px-3 py-2 text-left ${selectedId === item.id ? "asset-result-selected font-bold" : ""}`}><AssetIcon name="equipment" /><span>{item.name || item.asset_type}{item.model_number ? ` · ${item.model_number}` : ""}</span><span className="asset-result-arrow" aria-hidden="true">›</span></button>)}
                  </details>)}
                </details>)}
              </div>
            </div>
          </section>

          <section className="asset-detail min-w-0 bg-slate-900 p-3">
            {!selected ? <p className="text-slate-400">Select equipment to review it.</p> : <>
              <div className="asset-overview flex flex-wrap items-start gap-4">
                <label className={`relative block shrink-0 ${canManage ? "cursor-pointer" : ""}`}>
                  {photo ? <img src={photo} alt={`Photo of ${selected.name}`} className="asset-photo rounded object-cover" /> : <span className="asset-photo asset-photo-placeholder flex items-center justify-center rounded text-sm text-slate-400">{canManage ? "Add photo" : "No photo"}</span>}
                  {canManage && <><span className="sr-only">{photoBusy ? "Saving photo…" : photo ? "Replace photo" : "Select a photo"}</span><input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy} className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadPhoto(file); event.target.value = ""; }} /></>}
                </label>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="asset-title font-bold">{selected.name || selected.asset_type}</h2>
                    <div className="flex flex-wrap gap-3 text-sm font-semibold">
                      {canManage && !verified && !editing && <button type="button" onClick={() => { setEditing(true); setAssetPanel("details"); }} className="asset-header-action px-2 py-1 text-cyan-200"><AssetIcon name="edit" />Edit Details</button>}
                      {canManage && !verified && editing && <button type="button" disabled={saving} onClick={() => void save()} className="px-2 py-1 text-cyan-200 disabled:opacity-50">{saving ? "Saving…" : "Save Equipment"}</button>}
                      {canManage && <button type="button" disabled={moveBusy || unsavedEquipment} onClick={() => { setMoveError(""); setMoving(value => !value); }} className="asset-header-action px-2 py-1 text-cyan-200 disabled:opacity-50"><AssetIcon name="move" />Move Asset</button>}
                    </div>
                  </div>
                  <p className="asset-meta mt-2 text-sm text-slate-300"><AssetIcon name="location" />Current location: {browseLocations.find(location => location.id === selected.location_id)?.name || (selected.location_id ? "Location unavailable" : "Unassigned")}</p>
                  <p className="asset-meta mt-1 text-sm text-slate-300"><AssetIcon name="layers" />Serial: {selected.serial_number || "Not yet recorded"}</p>
                  <p className="asset-meta asset-service-status mt-1 text-sm text-slate-300"><span aria-hidden="true">✓</span>{selected.status || (selected.active ? "Active" : "Inactive")}{verified ? " · Verified documentation" : ""}</p>
                  {photoMessage && <span role="status" className="text-sm">{photoMessage}</span>}
                  {!selected.location_id && <p role="status" className="mt-2 text-sm text-amber-200">No confirmed location is assigned. This record is available as an unassigned template for work orders.</p>}
                  {(selected.binder_tag || selected.quantity != null) && <p className="mt-2 text-sm text-slate-300">{equipmentOptionLabel(selected)}</p>}
                  <div className="sr-only">{documents.map((doc) => doc.url && (<a key={statusKey(doc)} href={doc.url}>{doc.name}</a>))}</div>
                </div>
              </div>

              {moving && <section className="mt-4 rounded bg-slate-950 p-3" aria-label="Move asset">
                <label className="block text-sm">Destination<select value={destinationId} onChange={event => setDestinationId(event.target.value)} className="mt-1 w-full rounded bg-slate-900 p-2"><option value="">Select a location</option>{browseLocations.filter(location => location.id !== selected.location_id).map(location => <option key={location.id} value={location.id}>{location.area ? `${location.area} · ` : ""}{location.name}</option>)}</select></label>
                <label className="mt-3 block text-sm">Work order to move with this asset<select value={moveOrderId} onChange={event => setMoveOrderId(event.target.value)} className="mt-1 w-full rounded bg-slate-900 p-2"><option value="">Select an option</option><option value="none">Move without a work order</option>{assetOrders.map(order => <option key={order.id} value={order.id}>#{order.display_id} · {order.issue}</option>)}</select></label>
                <p className="mt-2 text-xs text-slate-400">The selected work order will move with the asset and receive a note. Other work orders are unchanged.</p>
                {ordersLoading && <p role="status" className="mt-2 text-xs">Loading linked work orders…</p>}
                {ordersError && <p role="alert" className="mt-2 text-xs text-amber-200">Work orders could not be loaded; reload before moving.</p>}
                {moveError && <p role="alert" className="mt-2 text-sm text-amber-200">{moveError}</p>}
                <button type="button" onClick={() => void moveAsset()} disabled={!destinationId || !moveOrderId || ordersLoading || Boolean(ordersError) || moveBusy || !selected.updated_at} className="mt-3 rounded bg-cyan-700 px-3 py-2 text-sm font-bold disabled:opacity-50">{moveBusy ? "Moving…" : "Confirm Move"}</button>
              </section>}
              <nav aria-label="Asset sections" className="asset-tabs mt-3 flex flex-wrap gap-x-6 text-sm">{([['details','Details'],['orders','Work Orders & Repairs'],['documents','Documentation']] as const).map(([key,label]) => <button type="button" key={key} aria-current={assetPanel === key ? "page" : undefined} onClick={() => setAssetPanel(key)} className={`min-h-10 font-semibold ${assetPanel === key ? "border-b-2 border-[rgb(var(--cmpri-action-rgb))]" : "text-slate-400"}`}><AssetIcon name={key === "details" ? "details" : key === "orders" ? "repair" : "document"} />{label}</button>)}</nav>
              <div hidden={assetPanel !== "details"}>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {([['name','Equipment name'],['asset_type','Equipment type'],['manufacturer','Manufacturer'],['model_family','Exact model family'],['model_number','Model number'],['serial_number','Serial number'],['generation','Generation'],['asset_tag','Asset tag'],['documentation_key','Documentation key']] as const).map(([key,label]) => (
                  <label key={key} className="grid gap-1 text-sm text-slate-300">{label}<input disabled={!editing || verified || !canManage} value={String(draft[key] ?? "")} onChange={(e) => setField(key, e.target.value as never)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:cursor-not-allowed disabled:bg-slate-900 disabled:text-slate-500" /></label>
                ))}
                <label className="grid gap-1 text-sm text-slate-300">Install year<input disabled={!editing || verified || !canManage} type="number" min="1900" max={maximumAssetInstallYear()} value={draft.install_year ?? ""} onChange={(e) => setField('install_year', e.target.value ? Number(e.target.value) : null)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-3 text-white disabled:bg-slate-900 disabled:text-slate-500" /></label>
              </div>

              </div>
              <section hidden={assetPanel !== "orders"} className="mt-3" aria-label="Work orders and repairs">
                <h3 className="sr-only">Work Orders &amp; Repairs</h3>
                {ordersError ? <p role="alert" className="text-sm text-amber-200">{ordersError}</p> : ordersLoading ? <p role="status" className="text-sm text-slate-400">Loading work orders…</p> : assetOrders.length ? assetOrders.map(order => <div key={order.id} className="mt-3 text-sm">
                  <div className="asset-order rounded p-3"><div className="asset-order-heading"><AssetIcon name="document" /><strong>WO #{order.display_id} · {order.issue}</strong><span className="asset-order-status">{order.status}</span><ModalNavigationButton href={`/work-orders/${order.id}`} className="asset-open-order"><AssetIcon name="external" />Open Work Order</ModalNavigationButton></div>
                  <p className="mt-1 text-slate-400">Location: {order.room || "Not specified"}</p></div>
                  {order.notes && <><div className="asset-notes-heading"><h4>Work order notes</h4><span>Notes are saved on the work order and shown here for this asset.</span></div><ul className="asset-note-list mt-2 space-y-2">{parseTicketHistory(order.notes).map(entry => <li key={entry.id}><span className="text-xs text-slate-400">{entry.actor}{entry.timestamp ? ` · ${new Date(entry.timestamp).toLocaleString()}` : ""}</span><p className="whitespace-pre-wrap">{entry.text}</p></li>)}</ul></>}
                </div>) : <p className="mt-2 text-sm text-slate-400">No linked work orders found.</p>}
                {documents.length > 0 && !selected.serial_number && <div className="asset-manual-hint"><AssetIcon name="document" /><span>Manual: applicability needs serial number</span><button type="button" onClick={() => setAssetPanel("documents")}>View Documentation <AssetIcon name="external" /></button></div>}
              </section>

              <div hidden={assetPanel !== "details"}>
              {canManage && verified && <div className="mt-4 rounded-lg border border-amber-600/40 p-3">
                <p className="text-sm text-amber-100">To correct verified equipment, open a documented revision. Prior verification and saved files are retained; the revised record needs verification again.</p>
                <label className="mt-2 block text-sm">Revision reason<input value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} maxLength={2000} className="mt-1 w-full rounded border border-slate-600 bg-slate-950 p-2" /></label>
                <button type="button" disabled={openingRevision || revisionReason.trim().length < 5} onClick={() => void beginRevision()} className="mt-2 rounded border border-amber-500 px-3 py-2 disabled:opacity-40">{openingRevision ? "Opening revision…" : "Open Revision & Edit"}</button>
              </div>}
              {unsavedEquipment && <p className="mt-3 text-sm text-amber-200">Save equipment changes before confirming documentation.</p>}
              {selected?.documentation_revision_id && <p className="mt-3 text-sm text-amber-200">Documentation revision in progress. Previous verification remains in the audit history.</p>}
              </div>
              <div hidden={assetPanel !== "documents"} className="mt-3">
                <h3 className="font-bold">Documentation</h3>
                {canManage && !verified && <button type="button" onClick={() => { setEditing(true); setShowDocumentationDialog(true); }} className="my-2 rounded bg-cyan-700 px-3 py-2 text-sm font-bold">Add Documentation</button>}
                {verified && canManage && <div className="my-2"><p className="text-sm text-slate-400">Updating documentation opens a revision. The current files and verification history stay available; review and verify the record again when finished.</p><button type="button" disabled={openingRevision} onClick={() => void beginRevision("Update asset documentation", true)} className="mt-2 rounded bg-cyan-700 px-3 py-2 text-sm font-bold disabled:opacity-50">{openingRevision ? "Opening…" : "Update Documentation"}</button></div>}
                {documents.length ? <ul className="space-y-1">{documents.map(doc => <li key={statusKey(doc)}>{doc.url ? <a className="text-sm text-cyan-200 underline" href={doc.url} target="_blank" rel="noreferrer">{doc.name}</a> : <span>{doc.name}</span>}</li>)}</ul> : <p className="text-sm text-slate-400">No documentation attached.</p>}
              {canManage && editing && !verified && <div className="mt-4 pt-3">
                <p className="text-sm text-slate-400">Final step: after reviewing the equipment fields and saved documentation, confirm to lock the verified information.</p>
                <div className="mt-3 flex justify-end"><button type="button" disabled={!documents.length || verifying || unsavedEquipment || saving} onClick={() => void verify()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">{verifying ? "Confirming…" : "Confirm with Documentation & Lock Fields"}</button></div>
              </div>}
              </div>
            </>}
          </section>
        </div>
      </div>

      {adding && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <form onSubmit={createAsset} role="dialog" aria-modal="true" aria-labelledby="add-asset-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="add-asset-title" className="text-xl font-bold">Add Asset</h2>
            <button type="button" disabled={creating || loadingLocations} onClick={() => setAdding(false)} className="rounded-lg border border-slate-600 px-3 py-2 disabled:opacity-50">Close</button>
          </div>
          <p className="mt-2 text-sm text-slate-400">Choose a location, including storage, and enter the equipment type. Other details can be added later.</p>
          {createMessage && <p role="alert" className="mt-3 text-sm text-amber-200">{createMessage}</p>}
          <fieldset disabled={creating || loadingLocations} className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">Room / Location
              <select required value={newAsset.location_id || ""} onChange={(event) => setNewAsset((current) => ({ ...current, location_id: event.target.value || null }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3">
                <option value="">{loadingLocations ? "Loading locations…" : "Select a location"}</option>
                {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </label>
            {([["asset_type", "Equipment type"], ["asset_tag", "Equipment label (optional)"], ["serial_number", "Serial number (optional)"]] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-sm">{label}
              <input required={key === "asset_type"} maxLength={key === "serial_number" ? 300 : 200} value={newAsset[key] || ""} onChange={(event) => setNewAsset((current) => ({ ...current, [key]: event.target.value }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" />
            </label>)}
            <details className="sm:col-span-2"><summary className="cursor-pointer text-sm font-semibold">More equipment details (optional)</summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {([["manufacturer", "Manufacturer"], ["model_family", "Model family"], ["model_number", "Model number"], ["generation", "Generation"]] as const).map(([key, label]) => <label key={key} className="grid gap-1 text-sm">{label}<input maxLength={200} value={newAsset[key] || ""} onChange={(event) => setNewAsset((current) => ({ ...current, [key]: event.target.value }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>)}
                <label className="grid gap-1 text-sm">Install year<input type="number" min="1900" max={maximumAssetInstallYear()} value={newAsset.install_year ?? ""} onChange={(event) => setNewAsset((current) => ({ ...current, install_year: event.target.value ? Number(event.target.value) : null }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
              </div>
            </details>
          </fieldset>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={creating || loadingLocations} onClick={() => setAdding(false)} className="rounded-lg border border-slate-600 px-4 py-2 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={creating || loadingLocations || !locations.length} className="rounded-lg bg-cyan-600 px-4 py-2 font-bold disabled:opacity-50">{creating ? "Adding…" : "Save Asset"}</button>
          </div>
        </form>
      </div>}

      {showDocumentationDialog && selected && canManage && editing && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[120] flex items-center justify-center bg-black/75">
          <div role="dialog" aria-modal="true" className="cmpri-modal-shell border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="text-xl font-bold">Add Documentation</h2><p className="mt-1 text-sm text-slate-400">{selected.name}</p></div>
              <button type="button" onClick={() => setShowDocumentationDialog(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm">Close</button>
            </div>

            <StagedPdfImporter key={selected.id} assetId={selected.id} assetName={selected.name} token={token} onSaved={(previousUpdatedAt, savedUpdatedAt) => {
              const assetId = selected.id;
              setAssets(current => current.map(asset => afterDocumentSave(asset, assetId, previousUpdatedAt, savedUpdatedAt)));
              setDraft(current => afterDocumentSave(current, assetId, previousUpdatedAt, savedUpdatedAt));
              void loadDocuments(assetId).then(result => displayDocuments(result.documents, result.verified, assetId)).catch(() => setDialogMessage("Documentation saved, but the list could not be refreshed."));
            }} legacyUpload={file => { void processDocumentation({file}); }} legacyBusy={Boolean(processingKey)} />

            <details className="mt-4 rounded border border-slate-700 bg-slate-950 p-3">
              <summary className="cursor-pointer font-semibold">Read an equipment label or document on this device</summary>
              <p className="mt-2 text-sm text-slate-400">Review recognized text against the original. Reading a file here does not upload it or attach it to this equipment; use the PDF controls above to save documentation separately.</p>
              <LocalOcrReview key={selected.id} onUseText={useReviewedOcr} onUseGuide={useReviewedGuide} useTextLabel="Suggest equipment values" />
            </details>

            {dialogMessage && <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${/processed/i.test(dialogMessage) ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-200" : /failed|could not|not configured|not loaded/i.test(dialogMessage) ? "border-red-500/40 bg-red-950/25 text-red-200" : "border-slate-700 bg-slate-950 text-slate-300"}`}>{dialogMessage}</div>}

            {extracted && <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/15 p-4">
              <h3 className="font-bold text-amber-100">Extracted equipment information</h3>
              <p className="mt-1 text-xs text-amber-200/70">Extracted values are unverified. Existing equipment values were not replaced automatically; review conflicts before applying or saving.</p>
              {extractedConflicts.length > 0 && <p role="status" className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/25 p-2 text-xs text-amber-100">Review conflicting existing fields before applying: {extractedConflicts.join(", ")}.</p>}
              {(extracted.model_candidates?.length || 0) > 1 && (
                <label className="mt-3 grid gap-1 text-xs font-semibold text-slate-300">Multiple model candidates found; select the one confirmed from the equipment label
                  <select value={String(extractedDraft.model_number || "")} onChange={(event) => setExtractedDraft((current) => ({ ...current, model_number: event.target.value }))} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-white">
                    <option value="">Select a model</option>
                    {extracted.model_candidates?.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
              )}
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
                    <div className="min-w-0"><div className="truncate text-slate-300">{doc.name}</div><div className={`mt-1 font-semibold ${status.state === "processed" ? "text-emerald-300" : status.state === "failed" ? "text-red-300" : status.state === "reading" ? "text-cyan-300" : "text-slate-500"}`}>{status.message || (status.state === "reading" ? "Reading…" : status.state === "processed" ? "Processed" : status.state === "failed" ? "Failed" : status.state === "pending" ? "Pending" : "Ready")}</div></div>
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

