import { findPmTemplate, PM_ROOM_NUMBERS, pmWeekStart, validPmPeriod } from './catalog';

export type PmFormOwner = { hotelId: string; userId: string };
export type PmFormIdentity = { templateId: string; periodStart: string; scopeKey: string };
export type PmFormContents = {
  revision: number;
  formData: Record<string, string>;
  checklist: Record<string, 'complete' | 'follow-up' | 'na'>;
  repeatableRows: Array<Record<string, string>>;
  formNotes: string;
  deficiencyNotes: string;
  completedOn: string;
  deficiencyLocationId: string;
};
export type PmFormDraft = PmFormContents & { version: 1; owner: PmFormOwner; identity: PmFormIdentity };
export type PmFormWorkspace = { version: 1; owner: PmFormOwner; weekStart: string; activeForm: PmFormIdentity | null };

function ownerPart(owner: PmFormOwner) {
  return `${encodeURIComponent(owner.hotelId)}:${encodeURIComponent(owner.userId)}`;
}
export function pmFormWorkspaceKey(owner: PmFormOwner) {
  return `cmpri:pm-form-workspace:v1:${ownerPart(owner)}`;
}
export function pmFormDraftKey(owner: PmFormOwner, identity: PmFormIdentity) {
  return `${pmFormDraftPrefix(owner)}${encodeURIComponent(identity.templateId)}:${identity.periodStart}:${encodeURIComponent(identity.scopeKey)}`;
}
function pmFormDraftPrefix(owner: PmFormOwner) { return `cmpri:pm-form-draft:v1:${ownerPart(owner)}:`; }
export function samePmForm(a: PmFormIdentity, b: PmFormIdentity) {
  return a.templateId === b.templateId && a.periodStart === b.periodStart && a.scopeKey === b.scopeKey;
}
export function pmFormRestoreWeek(weekStart: string, identity: PmFormIdentity | null) {
  if (!identity) return weekStart;
  const days = (Date.parse(`${weekStart}T12:00:00Z`) - Date.parse(`${identity.periodStart}T12:00:00Z`)) / 86_400_000;
  return days < -6 || days > 100 ? pmWeekStart(identity.periodStart) : weekStart;
}
function sameOwner(value: unknown, owner: PmFormOwner) {
  const stored = value as PmFormOwner | null;
  return stored?.hotelId === owner.hotelId && stored?.userId === owner.userId;
}
export function validPmFormIdentity(value: unknown): value is PmFormIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as PmFormIdentity;
  if (typeof identity.templateId !== 'string' || typeof identity.periodStart !== 'string'
    || typeof identity.scopeKey !== 'string' || !identity.scopeKey || identity.scopeKey.length > 120 || /[\u0000-\u001f]/.test(identity.scopeKey)) return false;
  const template = findPmTemplate(identity.templateId);
  if (!template || template.kind === 'routine' || !validPmPeriod(template, identity.periodStart)) return false;
  if (template.scope === 'room') return PM_ROOM_NUMBERS.includes(identity.scopeKey.slice(5)) && identity.scopeKey.startsWith('room:');
  if (template.scope === 'equipment') return identity.scopeKey === 'property' || /^equipment:.+/.test(identity.scopeKey);
  if (template.scope === 'area') return identity.scopeKey === 'property' || /^area:.+/.test(identity.scopeKey);
  return identity.scopeKey === 'property';
}
function readObject(raw: string | null): Record<string, unknown> | null {
  if (!raw || raw.length > 500_000) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
function stringRecord(value: unknown) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).length <= 500 && Object.entries(value).every(([key, field]) => key.length <= 200 && typeof field === 'string' && field.length <= 50_000));
}
export function readPmFormDraft(raw: string | null, owner: PmFormOwner, identity: PmFormIdentity): PmFormDraft | null {
  const value = readObject(raw);
  if (!value || value.version !== 1 || !sameOwner(value.owner, owner) || !validPmFormIdentity(value.identity)
    || !samePmForm(value.identity, identity) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !stringRecord(value.formData) || !stringRecord(value.checklist)
    || !Object.values(value.checklist as Record<string, string>).every(state => ['complete', 'follow-up', 'na'].includes(state))
    || !Array.isArray(value.repeatableRows) || value.repeatableRows.length > 500 || !value.repeatableRows.every(stringRecord)
    || !['formNotes', 'deficiencyNotes', 'completedOn', 'deficiencyLocationId'].every(key => typeof value[key] === 'string' && String(value[key]).length <= 50_000)) return null;
  return value as unknown as PmFormDraft;
}
export function readPmFormWorkspace(raw: string | null, owner: PmFormOwner): PmFormWorkspace | null {
  const value = readObject(raw);
  if (!value || value.version !== 1 || !sameOwner(value.owner, owner) || typeof value.weekStart !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.weekStart) || pmWeekStart(value.weekStart) !== value.weekStart
    || value.activeForm !== null && !validPmFormIdentity(value.activeForm)) return null;
  // The fresh week request must cover the restored form, including a room quarter's first month.
  if (pmFormRestoreWeek(value.weekStart, value.activeForm as PmFormIdentity | null) !== value.weekStart) return null;
  return value as unknown as PmFormWorkspace;
}

/** DeviceDataCache requires reload for a server-authoritative revision read. */
export function hasPmFormRecovery(storage: Pick<Storage, 'getItem' | 'key' | 'length'>, owner: PmFormOwner, weekStart: string) {
  try {
    const view = readPmFormWorkspace(storage.getItem(pmFormWorkspaceKey(owner)), owner);
    if (view?.activeForm && view.weekStart === weekStart) return true;
    const prefix = pmFormDraftPrefix(owner);
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key), value = readObject(raw);
      if (value && validPmFormIdentity(value.identity) && pmFormRestoreWeek(weekStart, value.identity) === weekStart
        && readPmFormDraft(raw, owner, value.identity)) return true;
    }
    return false;
  } catch { return true; }
}
