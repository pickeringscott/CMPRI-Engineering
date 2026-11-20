import { normalizeProfilePreferences, type ProfilePreferences } from "./profile-preferences";
export type ProfileScope = { hotelId: string; userId: string };
export type ProfileSettingsDraft = { name: string; preferences: ProfilePreferences };
export type ProfileRecovery = { version: 1; hotelId: string; userId: string; fields: ProfileSettingsDraft; baseline: ProfileSettingsDraft };
export const profileRecoveryKey = (scope: ProfileScope) => `cmpri:profile-draft:v1:${encodeURIComponent(scope.hotelId)}:${encodeURIComponent(scope.userId)}`;
function fields(value: unknown): ProfileSettingsDraft | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string' || row.name.length > 200 || row.name.includes('\0') || !row.preferences || typeof row.preferences !== 'object') return null;
  return { name: row.name, preferences: normalizeProfilePreferences(row.preferences) };
}
export const profileFieldsKey = (value: ProfileSettingsDraft) => JSON.stringify({ name: value.name, preferences: normalizeProfilePreferences(value.preferences) });
export function readProfileRecovery(storage: Pick<Storage, 'getItem'>, scope: ProfileScope): ProfileRecovery | null {
  try {
    const raw = storage.getItem(profileRecoveryKey(scope));
    if (!raw || raw.length > 8192) return null;
    const row = JSON.parse(raw), values = fields(row.fields), baseline = fields(row.baseline);
    return row.version === 1 && row.hotelId === scope.hotelId && row.userId === scope.userId && values && baseline
      ? { version: 1, hotelId: scope.hotelId, userId: scope.userId, fields: values, baseline } : null;
  } catch { return null; }
}
export function saveProfileRecovery(storage: Pick<Storage, 'getItem' | 'setItem'>, scope: ProfileScope, values: ProfileSettingsDraft, baseline: ProfileSettingsDraft): boolean {
  try {
    const raw = JSON.stringify({ version: 1, hotelId: scope.hotelId, userId: scope.userId, fields: values, baseline });
    const safe = readProfileRecovery({ getItem: () => raw }, scope);
    if (!safe) return false;
    storage.setItem(profileRecoveryKey(scope), JSON.stringify(safe));
    return true;
  } catch { return false; }
}
export function clearProfileRecovery(storage: Pick<Storage, 'removeItem'>, scope: ProfileScope): boolean {
  try { storage.removeItem(profileRecoveryKey(scope)); return true; } catch { return false; }
}
export const canRestoreProfileRecovery = (saved: ProfileRecovery, remote: ProfileSettingsDraft) => profileFieldsKey(saved.baseline) === profileFieldsKey(remote);

export type PhoneScheduleDraft = { timezone: string; schedule: Record<string, { enabled: boolean; start: string; end: string }> };
export type PhoneScheduleRecovery = { version: 1; hotelId: string; userId: string; fields: PhoneScheduleDraft; baseline: PhoneScheduleDraft; configured: boolean };
export const phoneScheduleRecoveryKey = (scope: ProfileScope) => `${profileRecoveryKey(scope)}:schedule`;
function phoneFields(value: unknown): PhoneScheduleDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as PhoneScheduleDraft;
  if (typeof row.timezone !== 'string' || row.timezone.length > 100 || row.timezone.includes('\0') || !row.schedule || typeof row.schedule !== 'object') return null;
  const schedule: PhoneScheduleDraft['schedule'] = {};
  for (const day of ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']) {
    const item = row.schedule[day];
    if (!item || typeof item.enabled !== 'boolean' || typeof item.start !== 'string' || typeof item.end !== 'string' || !/^\d{2}:\d{2}$/.test(item.start) || !/^\d{2}:\d{2}$/.test(item.end)) return null;
    schedule[day] = { enabled: item.enabled, start: item.start, end: item.end };
  }
  return { timezone: row.timezone, schedule };
}
export const phoneScheduleKey = (value: PhoneScheduleDraft) => JSON.stringify(phoneFields(value));
export function readPhoneScheduleRecovery(storage: Pick<Storage,'getItem'>, scope: ProfileScope): PhoneScheduleRecovery | null {
  try {
    const raw = storage.getItem(phoneScheduleRecoveryKey(scope));
    if (!raw || raw.length > 8192) return null;
    const row = JSON.parse(raw), values = phoneFields(row.fields), baseline = phoneFields(row.baseline);
    return row.version === 1 && row.hotelId === scope.hotelId && row.userId === scope.userId && typeof row.configured === 'boolean' && values && baseline
      ? { version: 1, hotelId: scope.hotelId, userId: scope.userId, fields: values, baseline, configured: row.configured } : null;
  } catch { return null; }
}
export function savePhoneScheduleRecovery(storage: Pick<Storage,'setItem'>, snapshot: PhoneScheduleRecovery): boolean {
  try {
    const safe = readPhoneScheduleRecovery({ getItem: () => JSON.stringify(snapshot) }, snapshot);
    if (!safe) return false;
    storage.setItem(phoneScheduleRecoveryKey(snapshot), JSON.stringify(safe)); return true;
  } catch { return false; }
}
export function clearPhoneScheduleRecovery(storage: Pick<Storage,'removeItem'>, scope: ProfileScope): boolean {
  try { storage.removeItem(phoneScheduleRecoveryKey(scope)); return true; } catch { return false; }
}
