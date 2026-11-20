import { draftFieldsKey, type DraftFields, type PendingDraftSave, type SavedDraft } from "./draft-save";

type Identity = { hotelId: string; userId: string };
export type CreationRecovery = {
  version: 1;
  hotelId: string;
  userId: string;
  fields: DraftFields;
  active: { id: string; revision: number } | null;
  baseline: string;
  pending: PendingDraftSave | null;
  pendingReceipt: string;
  attachmentCount: number;
  submissionUncertain: boolean;
  created?: { workOrders: { id: string; displayId: string }[]; uploads: { workOrderId: string; displayId: string; uploadId: string }[] };
};
const LIMIT = 96 * 1024;
const fieldLimits = { staff_first_name: 80, location_id: 100, issue: 4000, notes: 20000,
  asset_id: 100, asset_name: 500, category: 500, priority: 100 };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function fields(value: unknown): DraftFields | null {
  const row = record(value);
  if (!row) return null;
  const result: Record<string, string | null> = {};
  for (const [key, max] of Object.entries(fieldLimits)) {
    const value = row[key];
    if (key === "asset_id" && value === null) result[key] = null;
    else if (typeof value === "string" && value.length <= max && !value.includes("\0")) result[key] = value;
    else return null;
  }
  return result as DraftFields;
}
function active(value: unknown) {
  const row = record(value);
  return row && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 100
    && Number.isSafeInteger(row.revision) && Number(row.revision) >= 0
    ? { id: row.id, revision: Number(row.revision) } : null;
}
export function creationRecoveryKey(identity: Identity) {
  return `cmpri:work-order-creation:v1:${encodeURIComponent(identity.hotelId)}:${encodeURIComponent(identity.userId)}`;
}
export function readCreationRecovery(storage: Pick<Storage, "getItem">, identity: Identity): CreationRecovery | null {
  try {
    const raw = storage.getItem(creationRecoveryKey(identity));
    if (!raw || raw.length > LIMIT) return null;
    const row = record(JSON.parse(raw)), normalized = fields(row?.fields);
    if (!row || row.version !== 1 || row.hotelId !== identity.hotelId || row.userId !== identity.userId || !normalized
      || typeof row.baseline !== "string" || row.baseline.length > 30000
      || typeof row.pendingReceipt !== "string" || row.pendingReceipt.length > 256
      || !Number.isSafeInteger(row.attachmentCount) || Number(row.attachmentCount) < 0 || Number(row.attachmentCount) > 100
      || typeof row.submissionUncertain !== "boolean") return null;
    const draft = row.active === null ? null : active(row.active);
    if (row.active !== null && !draft) return null;
    let pending: PendingDraftSave | null = null;
    if (row.pending !== null) {
      const request = record(row.pending), values = fields(request?.fields);
      if (!request || !values || (request.method !== "POST" && request.method !== "PATCH")
        || typeof request.id !== "string" || !request.id || request.id.length > 100
        || (request.method === "PATCH" && !active(request))) return null;
      pending = { method: request.method, id: request.id, fields: values, uncertain: true,
        ...(request.method === "PATCH" ? { revision: Number(request.revision) } : {}) };
    }
    let created: CreationRecovery["created"];
    if (row.created !== undefined) {
      const acknowledgement = record(row.created);
      const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
      const display = (value: unknown): value is string => typeof value === "string" && /^[a-z\d_-]{1,100}$/i.test(value);
      if (!acknowledgement || !Array.isArray(acknowledgement.workOrders) || !acknowledgement.workOrders.length || acknowledgement.workOrders.length > 100 || !Array.isArray(acknowledgement.uploads) || acknowledgement.uploads.length > 250) return null;
      const workOrders: NonNullable<CreationRecovery["created"]>["workOrders"] = [];
      for (const value of acknowledgement.workOrders) {
        const item = record(value);
        if (!item || typeof item.id !== "string" || !uuid.test(item.id) || !display(item.displayId)) return null;
        workOrders.push({ id: item.id, displayId: item.displayId });
      }
      const uploads: NonNullable<CreationRecovery["created"]>["uploads"] = [];
      for (const value of acknowledgement.uploads) {
        const item = record(value);
        if (!item || typeof item.workOrderId !== "string" || !workOrders.some(order => order.id === item.workOrderId) || !display(item.displayId) || typeof item.uploadId !== "string" || !uuid.test(item.uploadId)) return null;
        uploads.push({ workOrderId: item.workOrderId, displayId: item.displayId, uploadId: item.uploadId });
      }
      created = { workOrders, uploads };
    }
    return { version: 1, ...identity, fields: normalized, active: draft, baseline: row.baseline, pending,
      pendingReceipt: row.pendingReceipt, attachmentCount: Number(row.attachmentCount), submissionUncertain: row.submissionUncertain, ...(created ? { created } : {}) };
  } catch { return null; }
}
/** Whitelist text/compare metadata only: never serialize files, sessions, HTML or arbitrary properties. */
export function saveCreationRecovery(storage: Pick<Storage, "getItem" | "setItem">, identity: Identity, snapshot: CreationRecovery): boolean {
  try {
    const candidate = JSON.stringify({ version: 1, ...identity, fields: snapshot.fields, active: snapshot.active,
      baseline: snapshot.baseline, pending: snapshot.pending, pendingReceipt: snapshot.pendingReceipt,
      attachmentCount: snapshot.attachmentCount, submissionUncertain: snapshot.submissionUncertain, ...(snapshot.created ? { created: snapshot.created } : {}) });
    const safe = readCreationRecovery({ getItem: () => candidate }, identity);
    if (!safe) return false;
    storage.setItem(creationRecoveryKey(identity), JSON.stringify(safe));
    return true;
  } catch { return false; }
}
export function clearCreationRecovery(storage: Pick<Storage, "removeItem">, identity: Identity): boolean {
  try { storage.removeItem(creationRecoveryKey(identity)); return true; } catch { return false; }
}
/** A changed/deleted server draft is compared explicitly, never silently rebased. */
export function canRestoreCreationRecovery(recovery: CreationRecovery, remote: SavedDraft | null, requestedDraftId = ""): boolean {
  if (recovery.created) return !requestedDraftId || requestedDraftId === recovery.active?.id;
  if (requestedDraftId && requestedDraftId !== recovery.active?.id && requestedDraftId !== recovery.pending?.id) return false;
  if (!recovery.active) return true;
  return !!remote && remote.id === recovery.active.id && remote.revision === recovery.active.revision
    && draftFieldsKey(remote) === recovery.baseline;
}
export function hasCreationRecoveryWork(snapshot: CreationRecovery): boolean {
  const { fields } = snapshot;
  return Boolean(fields.staff_first_name || fields.location_id || fields.issue || fields.notes || fields.asset_id
    || snapshot.active || snapshot.pending || snapshot.attachmentCount || snapshot.submissionUncertain || snapshot.created);
}
