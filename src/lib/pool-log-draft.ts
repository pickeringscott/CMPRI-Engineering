import type { PoolChemicalUse } from "./pool-chemicals";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type PoolDraftScope = { hotelId: string; userId: string; facilityId: string; date: string };
export type PoolDraft = {
  version: 1;
  baseRevision: number | null;
  savedRemarks: string;
  form: Record<string, unknown>;
  chemicalUses: PoolChemicalUse[];
  editingSavedLog: boolean;
  uncertainSave: boolean;
};

const fields = ["ph_am", "ph_pm", "sanitizer_band_am", "sanitizer_band_pm", "sample_location_am", "sample_location_pm", "flow_rate_gpm", "temperature_f", "main_drain_visible", "filter_backwashed", "remarks", "closure_reason", "requires_attention", "closure_condition", "manual_closure", "retest_id", "retest_ph", "retest_band"];
const flags = new Set(["requires_attention", "closure_condition", "manual_closure"]);
const maxDraftBytes = 120_000;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
function validDate(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function scopePart(value: string) { return encodeURIComponent(value); }
export function poolDraftKey(scope: PoolDraftScope) {
  return `cmpri:pool-log-draft:v1:${[scope.hotelId, scope.userId, scope.facilityId, scope.date].map(scopePart).join(":")}`;
}
function normalizeDraft(value: unknown): PoolDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || typeof source.savedRemarks !== "string" || source.savedRemarks.length > 20_000 || !(source.baseRevision === null || Number.isSafeInteger(source.baseRevision) && Number(source.baseRevision) >= 0)
    || !source.form || typeof source.form !== "object" || Array.isArray(source.form) || !Array.isArray(source.chemicalUses) || source.chemicalUses.length > 100) return null;
  const form: Record<string, unknown> = {};
  for (const key of fields) {
    const entry = (source.form as Record<string, unknown>)[key];
    if (flags.has(key) ? entry !== true && entry !== false && entry !== null : typeof entry !== "string" || entry.length > (key === "remarks" ? 20_000 : key === "closure_reason" ? 2_000 : 100)) return null;
    form[key] = entry;
  }
  const chemicalUses: PoolChemicalUse[] = [];
  for (const entry of source.chemicalUses) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !uuid.test(entry.id) || typeof entry.item !== "string" || !uuid.test(entry.item)
      || !Number.isFinite(entry.quantity) || entry.quantity <= 0 || entry.quantity > 999999999 || typeof entry.unit !== "string" || entry.unit.length > 40
      || entry.name !== undefined && (typeof entry.name !== "string" || entry.name.length > 500)) return null;
    chemicalUses.push({ id: entry.id, item: entry.item, quantity: entry.quantity, unit: entry.unit, ...(entry.name ? { name: entry.name } : {}) });
  }
  return { version: 1, baseRevision: source.baseRevision as number | null, savedRemarks: source.savedRemarks, form, chemicalUses, editingSavedLog: source.editingSavedLog === true, uncertainSave: source.uncertainSave === true };
}
export function readPoolDraft(storage: Storage, scope: PoolDraftScope): PoolDraft | null {
  if (!validDate(scope.date)) return null;
  const raw = storage.getItem(poolDraftKey(scope));
  if (!raw || raw.length > maxDraftBytes) return null;
  try { return normalizeDraft(JSON.parse(raw)); } catch { return null; }
}
export function savePoolDraft(storage: Storage, scope: PoolDraftScope, draft: PoolDraft) {
  const normalized = normalizeDraft(draft);
  if (!validDate(scope.date) || !normalized) throw new Error("Pool readings could not be kept on this device.");
  const raw = JSON.stringify(normalized);
  if (raw.length > maxDraftBytes) throw new Error("Pool readings are too large to retain on this device.");
  storage.setItem(poolDraftKey(scope), raw);
}
export function clearPoolDraft(storage: Storage, scope: PoolDraftScope) { storage.removeItem(poolDraftKey(scope)); }

/** The editor is for this test; the immutable audit record retains the full day's notes. */
export function poolRemarksForSave(previous: unknown, next: unknown) {
  return [typeof previous === "string" ? previous.trim() : "", typeof next === "string" ? next.trim() : ""].filter(Boolean).join("\n");
}

/** Reconcile a retained submission only when every entered reading and note is confirmed. */
export function poolDraftMatchesSaved(draft: PoolDraft, log: Record<string, unknown> | null, userId: string) {
  if (!log || log.updated_by !== userId || poolRemarksForSave(draft.savedRemarks, draft.form.remarks) !== String(log.remarks || "")) return false;
  const form = draft.form;
  for (const key of ["ph_am", "ph_pm", "flow_rate_gpm", "temperature_f"]) {
    if (form[key] !== "" && (log[key] == null || log[key] === "" || Number(form[key]) !== Number(log[key]))) return false;
  }
  for (const period of ["am", "pm"]) {
    const band = String(form[`sanitizer_band_${period}`] || "");
    if (band && (band.startsWith("legacy:") ? log[`sanitizer_${period}`] == null || Number(band.slice(7)) !== Number(log[`sanitizer_${period}`]) : band !== log[`sanitizer_band_${period}`])) return false;
  }
  for (const key of ["main_drain_visible", "filter_backwashed"]) {
    if (form[key] !== "" && (form[key] === "true") !== log[key]) return false;
  }
  if (form.retest_id) {
    const retest = log.retest_submission as Record<string, unknown> | null;
    if (retest?.id !== form.retest_id || retest?.ph !== Number(form.retest_ph) || retest?.sanitizer_band !== form.retest_band) return false;
  }
  if (form.requires_attention !== log.requires_attention || form.closure_reason && !String(log.closure_reason || "").includes(String(form.closure_reason))) return false;
  const uses = Array.isArray(log.chemical_uses) ? log.chemical_uses : [];
  if (!draft.chemicalUses.every(use => uses.some(prior => prior.id === use.id && prior.item === use.item && Number(prior.quantity) === use.quantity && prior.unit === use.unit && prior.actor === userId))) return false;
  return true;
}

/** Navigation metadata only, scoped independently from the retained readings. */
export function poolSelectionKey(scope: Pick<PoolDraftScope, "hotelId" | "userId">) {
  return `cmpri:pool-log-selection:v1:${scopePart(scope.hotelId)}:${scopePart(scope.userId)}`;
}
export function readPoolSelection(storage: Storage, scope: Pick<PoolDraftScope, "hotelId" | "userId">, today: string) {
  try {
    const value = JSON.parse(storage.getItem(poolSelectionKey(scope)) || "null");
    if (value && validDate(value.date) && value.date <= today && typeof value.facilityId === "string" && uuid.test(value.facilityId)) return { date: value.date as string, facilityId: value.facilityId as string };
  } catch {}
  return null;
}
export function savePoolSelection(storage: Storage, scope: PoolDraftScope) {
  if (validDate(scope.date) && uuid.test(scope.facilityId)) storage.setItem(poolSelectionKey(scope), JSON.stringify({ date: scope.date, facilityId: scope.facilityId }));
}
