import { tapTask, type PmTaskActor, type PmTaskState } from './task-review';

export type PmQueuedTask = { itemId: string; tapCount: number; expectedState: PmTaskState | null; desiredState: PmTaskState };
export type PmQueuedPeriod = { templateId: string; periodStart: string; expectedRevision: number; changes: PmQueuedTask[] };
export type PmQueueContext = { weekStart: string; frequency: string; tab: string; phoneDay: number };
export type PmQueueSnapshot = { version: 1; periods: PmQueuedPeriod[]; context: PmQueueContext };
const STATE_KEYS = ['status', 'workerId', 'workerName', 'workerChecked', 'reviewedBy', 'poolSubmitted', 'attachedFormStatus'] as const;

/** Undefined fields and absent/empty legacy states compare consistently across JSON. */
export function pmTaskStatesEqual(a: PmTaskState | null | undefined, b: PmTaskState | null | undefined) {
  return STATE_KEYS.every(key => (a?.[key] ?? (key === 'status' ? 'empty' : key === 'workerChecked' || key === 'poolSubmitted' ? false : null))
    === (b?.[key] ?? (key === 'status' ? 'empty' : key === 'workerChecked' || key === 'poolSubmitted' ? false : null)));
}
function outcomeEqual(a: PmTaskState | null | undefined, b: PmTaskState | null | undefined) {
  if ((a?.status ?? 'empty') !== (b?.status ?? 'empty') || Boolean(a?.workerChecked) !== Boolean(b?.workerChecked) || Boolean(a?.poolSubmitted) !== Boolean(b?.poolSubmitted)) return false;
  if (!a?.workerChecked && !b?.workerChecked && (a?.status ?? 'empty') === 'empty') return true;
  return a?.workerId === b?.workerId && a?.attachedFormStatus === b?.attachedFormStatus;
}
export function queuePmTask(periods: PmQueuedPeriod[], identity: Omit<PmQueuedPeriod, 'changes'>, itemId: string, baseline: PmTaskState | undefined, actor: PmTaskActor, options: Parameters<typeof tapTask>[2]) {
  const current = periods.find(period => period.templateId === identity.templateId && period.periodStart === identity.periodStart);
  const old = current?.changes.find(change => change.itemId === itemId);
  const expectedState = old ? old.expectedState : baseline ?? null;
  const desiredState = tapTask(old?.desiredState ?? baseline, actor, options);
  const changes = (current?.changes || []).filter(change => change.itemId !== itemId);
  if (!outcomeEqual(expectedState, desiredState)) {
    let replay = expectedState || undefined;
    let tapCount = 0;
    for (let count = 1; count <= 3; count += 1) {
      replay = tapTask(replay, actor, options);
      if (outcomeEqual(replay, desiredState)) { tapCount = count; break; }
    }
    if (!tapCount) throw new Error('This task could not be queued. Reload this PM period.');
    changes.push({ itemId, expectedState, desiredState, tapCount });
  }
  const rest = periods.filter(period => period !== current);
  return changes.length ? [...rest, { ...(current || identity), changes }] : rest;
}

export function pmQueueStorageKey(hotelId: string, userId: string) {
  return `cmpri:pm-task-queue:v1:${encodeURIComponent(hotelId)}:${encodeURIComponent(userId)}`;
}
export function isPmTaskState(value: unknown): value is PmTaskState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['empty', 'needs', 'approved'].includes(String(record.status))
    && Object.keys(record).every(key => STATE_KEYS.includes(key as typeof STATE_KEYS[number]))
    && ['workerId', 'workerName', 'reviewedBy'].every(key => record[key] === undefined || typeof record[key] === 'string' && String(record[key]).length <= 200)
    && ['workerChecked', 'poolSubmitted'].every(key => record[key] === undefined || typeof record[key] === 'boolean')
    && (record.attachedFormStatus === undefined || ['draft', 'final'].includes(String(record.attachedFormStatus)));
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function readPmTaskQueue(raw: string | null): PmQueueSnapshot | null {
  if (!raw || raw.length > 500_000) return null;
  try {
    const value = JSON.parse(raw) as PmQueueSnapshot;
    if (value.version !== 1 || !Array.isArray(value.periods) || value.periods.length > 128 || !value.context
      || !validDate(value.context.weekStart)
      || !['daily', 'weekly', 'monthly', 'history'].includes(value.context.frequency)
      || !['week', 'inspections', 'rooms', 'history'].includes(value.context.tab)
      || !Number.isInteger(value.context.phoneDay) || value.context.phoneDay < 0 || value.context.phoneDay > 6) return null;
    const keys = new Set<string>();
    for (const period of value.periods) {
      const key = `${period.templateId}|${period.periodStart}`;
      if (keys.has(key) || typeof period.templateId !== 'string' || period.templateId.length > 150 || !validDate(period.periodStart)
        || !Number.isSafeInteger(period.expectedRevision) || period.expectedRevision < 0 || !Array.isArray(period.changes) || !period.changes.length || period.changes.length > 200) return null;
      keys.add(key);
      const items = new Set<string>();
      for (const change of period.changes) {
        if (typeof change.itemId !== 'string' || !change.itemId || change.itemId.length > 150 || items.has(change.itemId)
          || !Number.isInteger(change.tapCount) || change.tapCount < 1 || change.tapCount > 3
          || change.expectedState !== null && !isPmTaskState(change.expectedState) || !isPmTaskState(change.desiredState)) return null;
        items.add(change.itemId);
      }
    }
    return value;
  } catch { return null; }
}
