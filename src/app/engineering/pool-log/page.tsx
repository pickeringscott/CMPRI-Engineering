"use client";

import { useUiLanguage } from "@/components/UiLanguageProvider";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { subscribeResources } from "@/lib/events/browser";
import { inventoryUnitOptions } from "@/lib/inventory";
import { invalidateCachedResources } from "@/lib/data-cache/browser";
import { chemicalRemark, type PoolChemicalUse, type PoolSupply } from "@/lib/pool-chemicals";
import PoolSpecs from "./PoolSpecs";
import PoolReport from "./PoolReport";
import PoolDailyHistory, { type PoolDailyEntry } from "./PoolDailyHistory";
import "./pool-log.css";
import { getValidSession } from "@/lib/supabase/client";
import { loadCmpriSession } from "@/lib/auth/client-session";
import { clearPoolDraft, poolDraftMatchesSaved, poolRemarksForSave, readPoolDraft, readPoolSelection, savePoolDraft, savePoolSelection, type PoolDraft, type PoolDraftScope } from "@/lib/pool-log-draft";
import {
  bromineBands,
  CMPRI_POOL,
  dailyPoolChecks,
  MAX_POOL_TEMPERATURE_F,
  phReadings,
  poolClosureReasons,
  poolCurrentClosureReasons,
  applyPoolTestStatus,
  poolReadingWarnings,
  poolLogTodayDate,
  sampleLocationLabel,
} from "@/lib/pool-log";
import SearchableSelect from "@/components/SearchableSelect";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import useEmbeddedModal from "@/components/use-embedded-modal";

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

const periods = ["am", "pm"] as const;
const numericFields = ["ph_am", "ph_pm", "flow_rate_gpm", "temperature_f"] as const;

function emptyForm() {
  return Object.fromEntries([
    ["ph_am", ""],
    ["ph_pm", ""],
    ["sanitizer_band_am", ""],
    ["sanitizer_band_pm", ""],
    ["sample_location_am", ""],
    ["sample_location_pm", ""],
    ["flow_rate_gpm", ""],
    ["temperature_f", ""],
    ["main_drain_visible", ""],
    ["filter_backwashed", ""],
    ["remarks", ""],
    ["closure_reason", ""],
    ["requires_attention", false],
    ["closure_condition", false],
    ["manual_closure", false],
    ["retest_id", ""],
    ["retest_ph", ""],
    ["retest_band", ""],
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
    const bandMatch = key.match(/^sanitizer_band_(am|pm)$/);
    const legacySanitizer = bandMatch ? genericReading(log, `sanitizer_${bandMatch[1]}`) : null;
    const value = bandMatch
      ? log[key] ?? (legacySanitizer == null ? null : `legacy:${legacySanitizer}`)
      : key.startsWith("ph_") ? genericReading(log, key) : log[key];
    result[key] = typeof result[key] === "boolean" ? value === true : value == null ? "" : String(value);
  }
  result.manual_closure = log.manual_closure ?? (log.closure_condition === true ? null : false);
  // Notes belong to the next test. Saved notes remain in the day's history.
  result.remarks = "";
  return result;
}

/** A value already saved on the day's log. Only System Administrators can change it. */
function savedValue(log: Log | null, key: string) {
  if (!log) return false;
  const bandMatch = key.match(/^sanitizer_band_(am|pm)$/);
  if (bandMatch) return log[key] != null || genericReading(log, `sanitizer_${bandMatch[1]}`) != null;
  if (key.startsWith("ph_")) return genericReading(log, key) != null;
  return log[key] != null && log[key] !== "";
}

function filled(value: unknown) {
  return typeof value === "string" ? value.trim() !== "" : value != null;
}

/** Everything still required before this save can be submitted, as [field id, label]. */
function missingFields(form: Record<string, unknown>) {
  const missing: [string, string][] = [];
  let completeSample = false;
  for (const period of periods) {
    const label = period.toUpperCase();
    const parts = [
      [`ph_${period}`, `${label} pH`],
      [`sanitizer_band_${period}`, `${label} bromine`],
    ] as const;
    const started = parts.some(([key]) => filled(form[key]));
    if (!started) continue;
    const absent = parts.filter(([key]) => !filled(form[key]));
    if (absent.length) missing.push(...absent.map(([key, text]) => [`pool-${key}`, text] as [string, string]));
    else completeSample = true;
  }
  if (filled(form.retest_id)) {
    if (!filled(form.retest_ph)) missing.push(["pool-retest_ph", "Retest pH"]);
    if (!filled(form.retest_band)) missing.push(["pool-retest_band", "Retest bromine"]);
  }
  if (!completeSample && !missing.length) {
    missing.push(["pool-ph_am", "AM or PM water sample (pH and bromine)"]);
  }
  for (const [key, label] of dailyPoolChecks) {
    if (!filled(form[key])) missing.push([`pool-${key}`, `${label} (daily check)`]);
  }
  return missing;
}

function phOutOfRange(value: unknown) {
  const ph = Number(value);
  return filled(value) && Number.isFinite(ph) && (ph < 7.2 || ph > 7.8);
}

function bromineOutOfRange(value: unknown) {
  if (!filled(value)) return false;
  const band = String(value);
  return poolClosureReasons({ sanitizer_band_am: band }).length > 0;
}

function formPayload(form: Record<string, unknown>, date: string, facilityId: string, savedRemarks: unknown = "") {
  const payload: Record<string, unknown> = { ...form, log_date: date, pool_facility_id: facilityId };
  payload.remarks = poolRemarksForSave(savedRemarks, form.remarks);
  for (const key of numericFields) payload[key] = form[key] === "" ? null : Number(form[key]);
  for (const period of periods) {
    const band = String(form[`sanitizer_band_${period}`] ?? "");
    payload[`sanitizer_${period}`] = band.startsWith("legacy:") ? Number(band.slice("legacy:".length)) : null;
    payload[`sanitizer_band_${period}`] = band && !band.startsWith("legacy:") ? band : null;
    payload[`sample_location_${period}`] = form[`sample_location_${period}`] || null;
  }
  for (const key of ["main_drain_visible", "filter_backwashed"]) payload[key] = form[key] === "" ? null : form[key] === "true";
  if (form.retest_id) payload.retest = { id: form.retest_id, ph: form.retest_ph === "" ? null : Number(form.retest_ph), sanitizer_band: form.retest_band };
  for (const key of ["retest_id", "retest_ph", "retest_band"]) delete payload[key];
  return payload;
}

function subscribePoolDate(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
function poolDateFromUrl() {
  const requested = new URLSearchParams(window.location.search).get("date");
  if (!requested || !/^\d{4}-\d{2}-\d{2}$/.test(requested)) return null;
  const parsed = new Date(`${requested}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === requested ? requested : null;
}

export default function PoolLogPage() {
  const { t, locale } = useUiLanguage();
  const embedded = useEmbeddedModal();
  const requestedDate = useSyncExternalStore(subscribePoolDate, poolDateFromUrl, () => null);
  const [chosenDate, setDate] = useState<string | null>(null);
  const date = chosenDate || requestedDate || poolLogTodayDate();
  const [facilityChoice, setFacilityChoice] = useState("");
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facility, setFacility] = useState<Facility | null>(null);
  const [saved, setSaved] = useState<Log | null>(null);
  const [dailyActivity, setDailyActivity] = useState<{ date: string; facilityId: string; entries: PoolDailyEntry[]; error: string } | null>(null);
  const [activityRefresh, setActivityRefresh] = useState(0);
  const requestedActivityRefresh = useRef(0);
  const [form, setForm] = useState<Record<string, unknown>>(emptyForm);
  const [baseline, setBaseline] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [canEditSavedLog, setCanEditSavedLog] = useState(false);
  const [editingSavedLog, setEditingSavedLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const [history, setHistory] = useState<Log[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMessage, setHistoryMessage] = useState("");
  const [chemicalOpen,setChemicalOpen]=useState(false);
  const [poolSupplyLocation,setPoolSupplyLocation]=useState<{id:string;name:string}|null>(null);
  const [supplies, setSupplies] = useState<PoolSupply[]>([]);
  const [supplyError, setSupplyError] = useState("");
  const [chemicalItem, setChemicalItem] = useState("");
  const [chemicalQuantity, setChemicalQuantity] = useState("");
  const [chemicalUnit, setChemicalUnit] = useState("");
  const [chemicalUses, setChemicalUses] = useState<PoolChemicalUse[]>([]);
  const [uncertainChemicalSave, setUncertainChemicalSave] = useState(false);
  const [draftScope, setDraftScope] = useState<PoolDraftScope | null>(null);
  const [retainedDraft, setRetainedDraft] = useState<PoolDraft | null>(null);
  const [storageProblem, setStorageProblem] = useState("");
  const savePromise = useRef<Promise<boolean> | null>(null);
  const saveOnClose = useRef<() => Promise<boolean>>(async () => false);
  const closing = useRef(false);
  const latest = useRef({ dirty: false, loading: true, saving: false });
  const selectedChemical = supplies.find(item => item.id === chemicalItem);
  const dirty = chemicalUses.length > 0 || baseline !== "" && JSON.stringify(form) !== baseline;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setMessage("");
      setEditingSavedLog(false);
      setChemicalUses([]); setChemicalItem(""); setChemicalQuantity(""); setUncertainChemicalSave(false);
      const [session, verified] = await Promise.all([getValidSession(), loadCmpriSession()]);
      if (!session) { window.location.replace("/"); return; }
      if (!verified.hotelId || verified.user.id !== session.user.id) throw new Error("The account and property could not be verified. Your retained readings have not been changed.");
      const owner = { hotelId: verified.hotelId, userId: verified.user.id };
      let selection: ReturnType<typeof readPoolSelection> = null;
      try { selection = readPoolSelection(window.localStorage, owner, poolLogTodayDate()); } catch {}
      if (chosenDate === null && !requestedDate) {
        if (selection && (selection.date !== date || !facilityChoice && selection.facilityId)) {
          setDate(selection.date);
          setFacilityChoice(selection.facilityId);
          return;
        }
      }
      // Retained edits need an authoritative revision before being restored.
      // Other opens may reuse a still-valid response from the shared cache.
      let hasRetainedEdits = false;
      const draftFacility = facilityChoice || selection?.facilityId;
      if (draftFacility) {
        try { hasRetainedEdits = !!readPoolDraft(window.localStorage, { ...owner, facilityId: draftFacility, date }); } catch {}
      }
      const query = new URLSearchParams({ date, ...(facilityChoice ? { facility: facilityChoice } : {}) });
      const response = await fetch(`/api/pool-log?${query}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: hasRetainedEdits ? "reload" : "no-store",
        signal: controller.signal,
      });
      const result = await response.json() as { error?: string; facilities?: Facility[]; facility?: Facility; log?: Log | null; retests?: Record<string, unknown>[]; daily_entries?: PoolDailyEntry[] | null; daily_entries_error?: string; can_edit?: boolean; can_edit_saved?: boolean };
      if (!response.ok) throw new Error(result.error || "Unable to load pool log.");
      if (controller.signal.aborted) return;
      const values = formFromLog(result.log || null);
      const savedValues = JSON.stringify(values);
      const scope = result.facility?.id ? { ...owner, facilityId: result.facility.id, date } : null;
      let draft: PoolDraft | null = null;
      let conflict: PoolDraft | null = null;
      if (scope) {
        try {
          savePoolSelection(window.localStorage, scope);
          const retained = result.can_edit === true ? readPoolDraft(window.localStorage, scope) : null;
          if (retained && poolDraftMatchesSaved(retained, result.log || null, owner.userId)) clearPoolDraft(window.localStorage, scope);
          else if (retained && retained.baseRevision === (result.log?.revision ?? null)) draft = retained;
          else conflict = retained;
        } catch { setStorageProblem("This browser could not retain pool readings. Keep this window open until saving succeeds."); }
      }
      setFacilities(result.facilities || []);
      setFacility(result.facility || null);
      setSaved(result.log || null);
      if (result.facility?.id) setDailyActivity({ date, facilityId: result.facility.id, entries: result.daily_entries || [], error: Array.isArray(result.daily_entries) ? "" : result.daily_entries_error || "Pool activity could not be loaded." });
      setDraftScope(scope);
      setRetainedDraft(conflict);
      setForm(draft?.form || values);
      setChemicalUses(draft?.chemicalUses || []);
      setUncertainChemicalSave(draft?.uncertainSave === true);
      setEditingSavedLog(draft?.editingSavedLog === true && result.can_edit_saved === true);
      if (draft) setMessage("Unsaved pool readings restored from this device.");
      setBaseline(savedValues);
      setCanEdit(result.can_edit === true);
      setCanEditSavedLog(result.can_edit_saved === true);
    })().catch((error) => {
      if (!controller.signal.aborted) {
        setFacility(null);
        setSaved(null);
        setMessage(error instanceof Error ? error.message : "Unable to load pool log.");
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [date, facilityChoice, reload, chosenDate, requestedDate]);

  useEffect(() => {
    if (!facility?.id) return;
    const controller = new AbortController();
    let pending: Promise<void> | null = null;
    const loadActivity = () => {
      if (pending) return pending;
      pending = (async () => {
        const session = await getValidSession();
        if (!session) throw new Error("Sign in again to view pool activity.");
        const query = new URLSearchParams({ date, facility: facility.id });
        const response = await fetch(`/api/pool-log?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store", signal: controller.signal });
        const result = await response.json() as { error?: string; daily_entries?: PoolDailyEntry[] | null; daily_entries_error?: string };
        if (!response.ok || !Array.isArray(result.daily_entries)) throw new Error(result.daily_entries_error || result.error || "Pool activity could not be loaded.");
        if (!controller.signal.aborted) setDailyActivity({ date, facilityId: facility.id, entries: result.daily_entries, error: "" });
      })().catch(error => { if (!controller.signal.aborted) setDailyActivity({ date, facilityId: facility.id, entries: [], error: error instanceof Error ? error.message : "Pool activity could not be loaded." }); })
        .finally(() => { pending = null; });
      return pending;
    };
    const refreshRequested = requestedActivityRefresh.current !== activityRefresh;
    requestedActivityRefresh.current = activityRefresh;
    const stop = subscribeResources(["pool"], loadActivity, false);
    if (refreshRequested) void loadActivity();
    return () => { controller.abort(); stop(); };
  }, [date, facility?.id, activityRefresh]);

  useEffect(() => {
    if(!chemicalOpen||!canEdit)return;
    const controller=new AbortController();let running:Promise<void>|null=null;
    const loadSupplies=()=>{
      if(running)return running;
      running=(async()=>{
        setSupplyError("");
        const session=await getValidSession();if(!session)return;
        const response=await fetch("/api/pool-log/supplies",{headers:{Authorization:`Bearer ${session.access_token}`},cache:"reload",signal:controller.signal});
        const result=await response.json();if(!response.ok)throw Error(result.error||"Pool Pump Room chemicals could not be loaded.");
        if(!controller.signal.aborted){setSupplies(result.items||[]);setPoolSupplyLocation(result.location||null);}
      })().catch(error=>{if(!controller.signal.aborted){setSupplies([]);setPoolSupplyLocation(null);setSupplyError(error.message);}}).finally(()=>{running=null;});return running;
    };
    const stop=subscribeResources(["reference"],loadSupplies);
    return()=>{controller.abort();stop();};
  },[chemicalOpen,canEdit,reload]);

  function addChemical() {
    const quantity = Number(chemicalQuantity);
    if (!selectedChemical || !Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.0001 || chemicalUses.length >= 100) {
      setMessage("Choose the chemical and quantity actually used."); return;
    }
    const use = {id:crypto.randomUUID(),item:selectedChemical.id,quantity,unit:chemicalUnit || selectedChemical.unit_of_measure,name:selectedChemical.item_name};
    setChemicalUses(current => [...current,use]);
    change("remarks", [String(form.remarks || "").trim(),chemicalRemark(use,selectedChemical.item_name)].filter(Boolean).join("\n"));
    setChemicalQuantity(""); setMessage("Chemical added to Remarks. Inventory updates when the pool log is saved.");
  }

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Write locally while editing, rather than trying to save a network request
  // during browser shutdown. Only this verified account and pool can read it.
  useLayoutEffect(() => {
    latest.current = { dirty, loading, saving };
    if (!draftScope || loading || !canEdit || retainedDraft) return;
    try {
      if (dirty) savePoolDraft(window.localStorage, draftScope, { version: 1, baseRevision: saved?.revision ?? null, savedRemarks: saved?.remarks || "", form, chemicalUses, editingSavedLog, uncertainSave: uncertainChemicalSave });
      else clearPoolDraft(window.localStorage, draftScope);
    } catch { queueMicrotask(() => setStorageProblem("This browser could not retain pool readings. Keep this window open until saving succeeds.")); }
  }, [dirty, loading, saving, draftScope, canEdit, saved?.revision, saved?.remarks, form, chemicalUses, editingSavedLog, uncertainChemicalSave, retainedDraft]);

  useEffect(() => {
    const requestClose = (event: Event) => {
      if (!latest.current.dirty && !latest.current.saving) return;
      event.preventDefault();
      if (closing.current) return;
      closing.current = true;
      void saveOnClose.current().then(confirmed => {
        if (!confirmed) return;
        const modalToken = new URLSearchParams(window.location.search).get("modalToken") || "";
        if (window.parent !== window) window.parent.postMessage({ type: "cmpri-modal-close", modalToken }, window.location.origin);
      }).finally(() => { closing.current = false; });
    };
    document.addEventListener("cmpri-modal-cancel-request", requestClose);
    return () => document.removeEventListener("cmpri-modal-cancel-request", requestClose);
  }, []);

  function change(key: string, value: unknown) {
    setForm((current) => {
      const updated = { ...current, [key]: value };
      return updated;
    });
  }

  function chooseFacility(value: string) {
    setFacilityChoice(value);
    setHistory([]);
    setShowHistory(false);
    setHistoryMessage("");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void saveChanges();
  }

  function saveChanges(): Promise<boolean> {
    if (savePromise.current) return savePromise.current;
    if (!dirty) return Promise.resolve(true);
    if (!facility || loading || !canEdit || retainedDraft) return Promise.resolve(false);
    const stillNeeded = missingFields(form);
    if (stillNeeded.length) {
      setMessage(`Not saved yet. Still needed: ${stillNeeded.map(([, label]) => label).join("; ")}.`);
      document.getElementById(stillNeeded[0][0])?.focus();
      return Promise.resolve(false);
    }
    setSaving(true);
    setMessage("");
    const pending = (async () => { try {
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again before saving. Your readings have not been discarded.");
      const payload = formPayload(form, date, facility.id, saved?.remarks);
      if (chemicalUses.length) payload.chemical_uses = chemicalUses;
      payload.expected_revision = saved?.revision ?? null;
      if (saved && editingSavedLog) payload.edit_mode = "replace";
      const submission: PoolDraft = { version: 1, baseRevision: saved?.revision ?? null, savedRemarks: saved?.remarks || "", form, chemicalUses, editingSavedLog, uncertainSave: true };
      setUncertainChemicalSave(true);
      if (draftScope) {
        try { savePoolDraft(window.localStorage, draftScope, submission); }
        catch { setStorageProblem("This browser could not retain pool readings. Keep this window open until saving succeeds."); }
      }
      const response = await fetch("/api/pool-log", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string; log?: Log; unchanged?: boolean; closure_reasons?: string[]; closure_required?: boolean; warnings?: string[]; notifications_recorded?: boolean };
      if (!response.ok || !result.log) { if (response.status < 500) setUncertainChemicalSave(false); throw new Error(result.error || "Unable to save readings."); }
      if (!poolDraftMatchesSaved(submission, result.log, session.user.id)) throw new Error("The response did not confirm all submitted pool entries. Your entries are still on screen; retry saving before closing.");
      setChemicalUses([]); setUncertainChemicalSave(false);
      if (chemicalUses.length) void invalidateCachedResources(["pool","reference","orders"]).catch(()=>{});
      const values = formFromLog(result.log);
      setSaved(result.log);
      setActivityRefresh(value => value + 1);
      setForm(values);
      setBaseline(JSON.stringify(values));
      if (draftScope) {
        try { clearPoolDraft(window.localStorage, draftScope); } catch { setStorageProblem("The saved readings are confirmed, but this browser could not clear its retained copy."); }
      }
      setEditingSavedLog(false);
      setHistory([]);
      setShowHistory(false);
      const notes = [result.unchanged ? "No new readings to save; the pool log is unchanged." : "Pool log saved to the database."];
      if (result.closure_required) notes.push(`THE POOL MUST BE CLOSED${result.closure_reasons?.length ? `: ${result.closure_reasons.join("; ")}` : ""}.`);
      if (result.closure_required && result.notifications_recorded === false) notes.push("Pool-closure notifications could not be recorded; contact the Chief Engineer.");
      if (result.closure_required === false) notes.push("Current status for this log: open.");
      if (result.warnings?.length) notes.push(`Out of range: ${result.warnings.join("; ")}.`);
      setMessage(notes.join(" "));
      if (payload.retest) setReload((value) => value + 1);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save readings.");
      return false;
    } finally {
      setSaving(false);
      savePromise.current = null;
    } })();
    savePromise.current = pending;
    return pending;
  }
  useLayoutEffect(() => { saveOnClose.current = saveChanges; });

  async function toggleHistory() {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    if (!facility || historyLoading) return;
    setHistoryLoading(true);
    setHistoryMessage("");
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again to view the complete pool log.");
      const query = new URLSearchParams({ history: "1", facility: facility.id });
      const response = await fetch(`/api/pool-log?${query}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const result = await response.json() as { error?: string; history?: Log[] };
      if (!response.ok || !Array.isArray(result.history)) {
        throw new Error(result.error || "Unable to load the complete pool log.");
      }
      setHistory(result.history);
      setShowHistory(true);
    } catch (error) {
      setHistoryMessage(error instanceof Error ? error.message : "Unable to load the complete pool log.");
    } finally {
      setHistoryLoading(false);
    }
  }

  const fieldClass = "mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 p-2 text-white disabled:opacity-70";
  const preview = formPayload(form, date, facility?.id ?? "");
  try { applyPoolTestStatus(preview, preview, saved); }
  catch { preview.latest_test = saved?.latest_test; preview.closure_condition = saved?.closure_condition; }
  const stillNeeded = missingFields(form);
  const assessed = stillNeeded.length ? saved || {} : preview;
  const closureReasons = poolCurrentClosureReasons(assessed);
  const readingWarnings = poolReadingWarnings(assessed);
  const canEditForm = canEdit;
  const closureRequired = closureReasons.length > 0 || assessed.closure_condition === true;
  const locked = (key: string) => !canEditForm || saving || (savedValue(saved, key) && !editingSavedLog);
  const flagClass = "mt-1 text-xs font-bold text-red-300";
  const warnClass = "mt-1 text-xs font-bold text-amber-300";

  return (
    <main data-pool-log data-cmpri-action-surface className="min-h-screen bg-slate-950 p-4 text-white print:bg-white print:p-0 print:text-black">
      <div className="mx-auto w-full space-y-2">
        {!embedded && <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t("CMPRI — Daily Pool Log")}</h1>
            <p className="text-sm text-slate-300">{t("Indoor bromine pool ·")}{" "}{CMPRI_POOL.testKit}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <ModalDashboardLink className="rounded-lg border border-slate-600 px-3 py-2">{t("Dashboard")}</ModalDashboardLink>
            <PoolSpecs />
            {saved && canEditSavedLog ? <button type="button" disabled={loading || saving || editingSavedLog || dirty} onClick={() => setEditingSavedLog(true)} className="rounded-lg border border-amber-400/60 px-3 py-2 text-amber-100 disabled:opacity-50">{editingSavedLog ? t("Editing saved log") : t("Edit saved log")}</button> : null}
            <button type="button" disabled={!facility || loading || historyLoading} onClick={() => void toggleHistory()} className="rounded-lg border border-cyan-400/50 px-3 py-2 text-cyan-100 disabled:opacity-50">{historyLoading ? t("Loading pool log…") : showHistory ? t("Hide entire pool log") : t("View entire pool log")}</button>
          </div>
        </header>}
        {embedded && <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <ModalDashboardLink className="rounded-lg border border-slate-600 px-3 py-2">{t("← Dashboard")}</ModalDashboardLink>
          <div className="flex flex-wrap items-center gap-2">
            <PoolSpecs />
            {saved && canEditSavedLog ? <button type="button" disabled={loading || saving || editingSavedLog || dirty} onClick={() => setEditingSavedLog(true)} className="rounded-lg border border-amber-400/60 px-3 py-2 text-amber-100 disabled:opacity-50">{editingSavedLog ? t("Editing saved log") : t("Edit saved log")}</button> : null}
            <button type="button" disabled={!facility || loading || historyLoading} onClick={() => void toggleHistory()} className="rounded-lg border border-cyan-400/50 px-3 py-2 text-cyan-100 disabled:opacity-50">{historyLoading ? t("Loading pool log…") : showHistory ? t("Hide entire pool log") : t("View entire pool log")}</button>
          </div>
        </div>}

        <section className="print:hidden">
          <div className="pool-date-actions">
            <input aria-label={t("Date")} type="date" max={poolLogTodayDate()} value={date} disabled={saving || dirty} onChange={(event) => setDate(event.target.value)} className="pool-date-input rounded-lg border border-slate-600 bg-slate-950 p-2 text-white disabled:opacity-70" />
            {facilities.length > 1 ? <label className="min-w-40 flex-1">{t("Pool")}<SearchableSelect value={facilityChoice || facility?.id || ""} disabled={saving || dirty || historyLoading} onChange={chooseFacility} placeholder={t("Pool")} options={facilities.map((item) => ({ value: item.id, label: item.pool_name }))} /></label> : null}
            {canEditForm ? <button type="submit" form="pool-log-form" data-cmpri-primary disabled={saving || loading || !facility || !dirty} className="pool-top-save rounded-lg px-3 py-2 font-bold disabled:opacity-50">{saving ? t("Saving…") : uncertainChemicalSave ? t("Retry Save Pool Log") : t("Save Pool Log")}</button> : <span className="text-sm text-slate-300">{t("View-only access")}</span>}
          </div>
          {message ? <p role="alert" aria-live="assertive" className="my-3 whitespace-pre-wrap rounded-lg border border-amber-400 p-3">{t(message)}</p> : null}
          {storageProblem ? <p role="alert" className="my-2 rounded-lg border border-amber-400 p-3">{t(storageProblem)}</p> : null}
          {retainedDraft ? <section className="my-2 rounded-lg border border-amber-400 p-3 text-sm">
            <p>{t("Saved readings changed while these entries were pending. The retained entries remain on this device and have not replaced the saved log.")}</p>
            <details className="mt-2"><summary className="cursor-pointer font-semibold">{t("Review Retained Entries")}</summary><dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">{Object.entries(retainedDraft.form).filter(([, value]) => value !== "" && value !== false && value !== null).map(([key, value]) => <div key={key} className="contents"><dt>{key.replaceAll("_", " ")}</dt><dd className="whitespace-pre-wrap break-words">{String(value)}</dd></div>)}</dl></details>
            <button type="button" className="mt-2 underline" onClick={() => {
              if (!draftScope) return;
              try { clearPoolDraft(window.localStorage, draftScope); setRetainedDraft(null); } catch { setStorageProblem("This browser could not clear its retained entries."); }
            }}>{t("Discard Retained Entries And Use Saved Readings")}</button>
          </section> : null}
          {loading ? <p className="py-4">{t("Loading saved readings…")}</p> : facility ? (
            <form id="pool-log-form" onSubmit={save} noValidate className="mt-2 space-y-2">
              <PoolDailyHistory entries={dailyActivity?.date === date && dailyActivity.facilityId === facility.id ? dailyActivity.entries : []} error={dailyActivity?.date === date && dailyActivity.facilityId === facility.id ? dailyActivity.error : undefined} loading={dailyActivity?.date !== date || dailyActivity.facilityId !== facility.id} onRetry={() => setActivityRefresh(value => value + 1)} />
              {closureRequired ? <section role="alert" aria-live="assertive" className="rounded-xl border-4 border-red-500 bg-red-950 p-4 text-red-50">
                <h2 className="text-2xl font-black uppercase tracking-wide">{t("⚠ The pool must be closed")}</h2>
                <p className="mt-1 font-semibold">{t("Current readings or an unresolved closure keep the pool closed. A complete passing test updates status automatically when daily checks pass and no separate hold remains. Earlier failed readings stay in the history.")}</p>
                {closureReasons.length ? <ul className="mt-2 list-inside list-disc">{closureReasons.map((reason) => <li key={reason}>{t(reason)}</li>)}</ul> : <p className="mt-2">{t("A closure condition is recorded on this log.")}</p>}
              </section> : null}
              {readingWarnings.length ? <section role="alert" className="rounded-xl border-2 border-amber-400 bg-amber-950 p-4 text-amber-50">
                <h2 className="text-lg font-bold">{t("Out-of-range reading")}</h2>
                <ul className="mt-2 list-inside list-disc">{readingWarnings.map((warning) => <li key={warning}>{t(warning)}</li>)}</ul>
              </section> : null}
              <fieldset disabled={!canEditForm || saving || uncertainChemicalSave || !!retainedDraft} className="space-y-2 disabled:opacity-80">
                <label className="block text-sm">{t("Notes / actions taken")}<textarea aria-label={t("Notes / actions taken")} disabled={uncertainChemicalSave} value={String(form.remarks ?? "")} maxLength={20000} rows={2} onChange={(event) => change("remarks", event.target.value)} className={fieldClass} /></label>
                <div className="pool-water-samples">
                  {periods.map((period) => {
                    const label = period.toUpperCase();
                    const ph = form[`ph_${period}`];
                    const band = form[`sanitizer_band_${period}`];
                    const complete = filled(ph) && filled(band);
                    return <section key={period} className="pool-water-sample rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <div className="flex items-center justify-between">
                        <h2 className="font-bold">{t("{period} water sample", { period: label })}</h2>
                        <span className={complete ? "rounded-full bg-emerald-900 px-2 py-0.5 text-xs font-bold text-emerald-200" : "rounded-full bg-slate-800 px-2 py-0.5 text-xs font-bold text-slate-400"}>{complete ? (savedValue(saved, `ph_${period}`) ? t("Saved") : t("Complete")) : t("Not recorded")}</span>
                      </div>
                      <label className="mt-3 block text-sm">{t("pH (required for this sample)")}<select id={`pool-ph_${period}`} aria-label={t("{label} pH", { label: label })} disabled={locked(`ph_${period}`)} value={String(ph ?? "")} onChange={(event) => change(`ph_${period}`, event.target.value)} className={fieldClass}>
                          <option value="">{t("Select pH")}</option>
                          {String(ph ?? "") && !phReadings.some((value) => value === String(ph))
                            ? <option value={String(ph)}>{String(ph)}{" "}{t("(saved reading)")}</option>
                            : null}
                          {phReadings.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </label>
                      {phOutOfRange(ph) ? <p className={flagClass}>{t("Outside 7.2–7.8. This result remains in the history.")}</p> : null}
                      <label className="mt-3 block text-sm">{t("Bromine (ppm, required for this sample)")}<select id={`pool-sanitizer_band_${period}`} aria-label={t("{label} bromine (ppm)", { label: label })} disabled={locked(`sanitizer_band_${period}`)} value={String(band ?? "")} onChange={(event) => change(`sanitizer_band_${period}`, event.target.value)} className={fieldClass}>
                          <option value="">{t("Select bromine")}</option>
                          {String(band ?? "").startsWith("legacy:")
                            ? <option value={String(band)}>{String(band).slice("legacy:".length)}{" "}{t("ppm (saved reading)")}</option>
                            : null}
                          {bromineBands.map(([value, text]) => <option key={value} value={value}>{t(text)}</option>)}
                        </select>
                      </label>
                      {bromineOutOfRange(band) ? <p className={flagClass}>{t("Outside the configured bromine range. This result remains in the history.")}</p> : null}
                      <p className="mt-2 text-xs text-slate-500">{t("New {period} readings use one shared water sample for both shallow and deep, with collection location unspecified.", { period: label })}</p>
                    </section>;
                  })}
                </div>
                {saved ? <section className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                  <h2 className="font-bold">{t("Additional shared test")}</h2>
                  {!form.retest_id ? <button type="button" className="mt-2 rounded-lg bg-cyan-700 px-3 py-2" onClick={() => change("retest_id", crypto.randomUUID())}>{t("Record another test")}</button> : <>
                    <p className="mt-2 text-sm">{t("A new paired sample updates current status automatically. AM/PM readings and earlier retests are retained.")}</p>
                    <label className="mt-3 block text-sm">{t("Retest pH")}<select id="pool-retest_ph" value={String(form.retest_ph)} onChange={(event) => change("retest_ph", event.target.value)} className={fieldClass}><option value="">{t("Select pH")}</option>{phReadings.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                    <label className="mt-3 block text-sm">{t("Retest bromine")}<select id="pool-retest_band" value={String(form.retest_band)} onChange={(event) => change("retest_band", event.target.value)} className={fieldClass}><option value="">{t("Select bromine")}</option>{bromineBands.map(([value, text]) => <option key={value} value={value}>{t(text)}</option>)}</select></label>
                    <button type="button" className="mt-2 underline" onClick={() => setForm((current) => ({ ...current, retest_id: "", retest_ph: "", retest_band: "" }))}>{t("Cancel additional test")}</button>
                  </>}
                </section> : null}
                <section className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                  <h2 className="font-bold">{t("Daily checks")}{" "}<span className="text-xs font-normal text-slate-400">{t("(required once per day)")}</span></h2>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">{t("Water temperature (°F, required)")}<input id="pool-temperature_f" type="number" min="0" step="any" required disabled={locked("temperature_f")} value={String(form.temperature_f ?? "")} onChange={(event) => change("temperature_f", event.target.value)} className={fieldClass} />
                      {filled(form.temperature_f) && Number(form.temperature_f) > MAX_POOL_TEMPERATURE_F ? <p className={flagClass}>{t("Above")}{" "}{MAX_POOL_TEMPERATURE_F}{t("°F: the pool must be closed.")}</p> : null}
                    </label>
                    <label className="text-sm">{t("Flow rate (GPM, required)")}<input id="pool-flow_rate_gpm" type="number" min="0" step="any" required disabled={locked("flow_rate_gpm")} value={String(form.flow_rate_gpm ?? "")} onChange={(event) => change("flow_rate_gpm", event.target.value)} className={fieldClass} />
                      {filled(form.flow_rate_gpm) && Number(form.flow_rate_gpm) < CMPRI_POOL.requiredFlowGpm ? <p className={warnClass}>{t("Below the required")}{" "}{CMPRI_POOL.requiredFlowGpm}{" "}{t("GPM.")}</p> : null}
                    </label>
                    {([["main_drain_visible", "Main drain visible (required)"], ["filter_backwashed", "Filter backwashed (required)"]] as const).map(([key, text]) => <label key={key} className="text-sm">{t(text)}
                      <select id={`pool-${key}`} aria-label={t(text)} required disabled={locked(key)} value={String(form[key] ?? "")} onChange={(event) => change(key, event.target.value)} className={fieldClass}>
                        <option value="">{t("Select Yes or No")}</option>
                        <option value="true">{t("Yes")}</option>
                        <option value="false">{t("No")}</option>
                      </select>
                      {key === "main_drain_visible" && form[key] === "false" ? <p className={flagClass}>{t("Main drain not visible: the pool must be closed.")}</p> : null}
                    </label>)}
                  </div>
                </section>
                <div className="pool-flags">
                  <label><input type="checkbox" disabled={saved?.requires_attention === true && !editingSavedLog} checked={form.requires_attention === true} onChange={(event) => change("requires_attention", event.target.checked)} /><span>{t("Attention Needed")}</span></label>
                </div>
                {saved?.closure_condition === true && saved.manual_closure == null ? <p className="text-amber-200">{t("This older closure has no recorded source. Its reason must be classified before a passing test can clear it automatically.")}</p> : null}
                <details className="pool-chemical-usage" onToggle={event=>setChemicalOpen(event.currentTarget.open)}>
                  <summary className="cursor-pointer text-sm font-semibold">{t("Chemical usage")}</summary>
                  <div className="mt-1 space-y-1 text-sm">
                    <p className="text-xs"><strong>{poolSupplyLocation?.name||t("Pool Pump Room")}</strong>{" "}{t("· Chemical items stored here only")}</p>
                    {chemicalOpen&&!supplyError&&!supplies.length&&<p className="text-xs">{t("No eligible chemicals. Inventory must mark the item Chemical and assign it to Pool Pump Room.")}</p>}
                    <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-1">{t("Supply")}<select aria-label={t("Pool chemical supply")} className={fieldClass} value={chemicalItem} disabled={saving || uncertainChemicalSave || !supplies.length} onChange={event => {setChemicalItem(event.target.value);setChemicalUnit("");}}>
                      <option value="">{t("Choose supply")}</option>{supplies.map(item => <option key={item.id} value={item.id}>{item.item_name} · {Number(item.quantity_on_hand)-Number(item.quantity_reserved)} {item.unit_of_measure}{" "}{t("available")}</option>)}
                    </select></label>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-xs">{t("Quantity used")}<input aria-label={t("Pool chemical quantity used")} className={fieldClass} style={{width:96}} type="number" min="0.001" max="999999999" step="0.001" value={chemicalQuantity} disabled={saving || uncertainChemicalSave} onChange={event=>setChemicalQuantity(event.target.value)}/></label>
                      <label className="text-xs">{t("Unit")}<select aria-label={t("Pool chemical usage unit")} className={fieldClass} style={{width:96}} value={chemicalUnit} disabled={saving || uncertainChemicalSave} onChange={event=>setChemicalUnit(event.target.value)}><option value="">{selectedChemical?.unit_of_measure || t("Inventory unit")}</option>{inventoryUnitOptions(selectedChemical?.unit_of_measure||"EA").map(unit=><option key={unit}>{unit}</option>)}</select></label>
                      <button type="button" className="rounded-lg border border-current px-2 py-1 text-xs disabled:opacity-50" disabled={saving || uncertainChemicalSave || !selectedChemical || !(Number(chemicalQuantity)>0)} onClick={addChemical}>{t("Add chemical use")}</button>
                    </div>
                    {chemicalUses.map(use => <div key={use.id} className="flex items-center justify-between gap-2 text-xs"><span>{chemicalRemark(use,use.name || supplies.find(item=>item.id===use.item)?.item_name || "Chemical")}</span><button type="button" className="underline" disabled={saving || uncertainChemicalSave} onClick={()=>{
                      setChemicalUses(current=>current.filter(entry=>entry.id!==use.id));
                      const name=use.name || supplies.find(item=>item.id===use.item)?.item_name || "Chemical";
                      const lines=String(form.remarks || "").split("\n");const index=lines.indexOf(chemicalRemark(use,name));if(index>=0)lines.splice(index,1);change("remarks",lines.join("\n"));
                    }}>{t("Remove")}</button></div>)}
                    {chemicalUses.length ? <p className="text-xs">{chemicalUses.length}{" "}{t("chemical usage(s) pending. Save the pool log to update inventory.")}</p> : null}
                    {uncertainChemicalSave ? <p role="status" className="text-xs">{t("Save not yet confirmed. Retry Save Pool Log to confirm the same readings and chemical usage.")}</p> : null}
                    {supplyError ? <p role="status" className="text-xs">{t(supplyError)}</p> : null}
                  </div>
                </details>
              </fieldset>
              {canEditForm && dirty && stillNeeded.length ? <section aria-live="polite" className="rounded-xl border border-amber-400/70 bg-amber-950/40 p-3 text-sm text-amber-100">
                <h2 className="font-bold">{t("Still needed before saving")}</h2>
                <ul className="mt-1 list-inside list-disc">{stillNeeded.map(([id, text]) => <li key={id + text}><button type="button" className="underline" onClick={() => document.getElementById(id)?.focus()}>{t(text)}</button></li>)}</ul>
              </section> : null}
              {saved && canEditForm ? <p className="text-sm text-slate-400">{t("Saved readings are locked.")}{canEditSavedLog ? t(" Select Edit saved log to correct them.") : t(" Only a System Administrator, General Manager or Assistant General Manager can change them.")}{" "}{t("Empty fields (such as the PM sample) can still be added.")}</p> : null}
              {saved ? <p className="text-sm text-slate-400">{t("Recorded by")}{" "}{saved.completed_by_initials}{" "}{t("· Revision")}{" "}{saved.revision}</p> : null}
            </form>
          ) : null}
        </section>

        {historyMessage ? <p role="status" className="rounded-lg border border-amber-400 p-3 print:hidden">{t(historyMessage)}</p> : null}
        {showHistory ? <section className="rounded-xl border border-cyan-700 bg-slate-900 p-4 print:border-black print:bg-white">
          <h2 className="text-xl font-bold">{t("Entire pool log ·")}{" "}{facility?.pool_name}</h2>
          <p className="mt-1 text-sm text-slate-300 print:text-black">{history.length}{" "}{t("saved entries, newest first.")}</p>
          {history.length ? <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1550px] border-collapse text-sm">
              <thead><tr>{["Date", "AM pH", "AM bromine", "PM pH", "PM bromine", "Sample location", "Flow rate (GPM)", "Water temp (°F)", "Main drain visible", "Filter backwashed", "Attention needed", "Closure / reason", "Remarks", "Recorded by", "Last updated"].map((heading) => <th key={heading} className="border border-slate-700 p-2 text-left print:border-black">{t(heading)}</th>)}</tr></thead>
              <tbody>{history.map((entry) => {
                const bandLabel = (period: "am" | "pm") => {
                  const band = entry[`sanitizer_band_${period}`];
                  return bromineBands.find(([value]) => value === band)?.[1] ?? entry[`sanitizer_${period}`] ?? "—";
                };
                const amLocation = entry.sample_location_am;
                const pmLocation = entry.sample_location_pm;
                const location = amLocation === pmLocation
                  ? t(sampleLocationLabel(amLocation || pmLocation))
                  : `AM: ${t(sampleLocationLabel(amLocation))}; PM: ${t(sampleLocationLabel(pmLocation))}`;
                const closure = entry.closure_condition === true
                  ? `${t("Closed")}: ${entry.closure_reason || t("Reason not recorded")}`
                  : entry.closure_condition === false ? t("Open") : t("Not recorded");
                return <tr key={entry.id}>
                  <td className="border border-slate-700 p-2 print:border-black">{entry.log_date}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(entry.ph_am ?? "—")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(bandLabel("am"))}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(entry.ph_pm ?? "—")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(bandLabel("pm"))}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{t(location)}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(entry.flow_rate_gpm ?? "—")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(entry.temperature_f ?? "—")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{entry.main_drain_visible === true ? t("Yes") : entry.main_drain_visible === false ? t("No") : t("Not recorded")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{entry.filter_backwashed === true ? t("Yes") : entry.filter_backwashed === false ? t("No") : t("Not recorded")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{entry.requires_attention === true ? t("Yes") : entry.requires_attention === false ? t("No") : t("Not recorded")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{closure}</td>
                  <td className="whitespace-pre-wrap border border-slate-700 p-2 print:border-black">{String(entry.remarks || "—")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{String(entry.completed_by_initials || "—")}</td>
                  <td className="border border-slate-700 p-2 print:border-black">{entry.updated_at ? new Date(String(entry.updated_at)).toLocaleString(locale, { timeZone: "America/Chicago" }) : "—"}</td>
                </tr>;
              })}</tbody>
            </table>
          </div> : <p className="mt-3">{t("No saved pool-log entries were found.")}</p>}
        </section> : null}

        <PoolReport key={facility?.id || "unselected"} facilityId={facility?.id} disabled={loading || saving || dirty} />
      </div>
    </main>
  );
}
