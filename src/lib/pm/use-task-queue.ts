"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { getValidSession } from '@/lib/supabase/client';
import { loadCmpriSession } from '@/lib/auth/client-session';
import { findPmTemplate, pmWeekStart, validPmPeriod, type PmTemplate } from './catalog';
import { type PmTaskActor, type PmTaskState } from './task-review';
import { pmQueueStorageKey, pmTaskStatesEqual, queuePmTask, readPmTaskQueue, type PmQueueContext, type PmQueuedPeriod } from './task-queue';

type TaskEntry = { template_id: string; period_start: string; revision: number; status?: string; task_states?: Record<string, PmTaskState>; responses?: Record<string, unknown>; submitted_by?: string | null; submitted_by_name?: string | null };
export function pmEntryTaskState(entry: TaskEntry | undefined, template: PmTemplate, itemId: string): PmTaskState | undefined {
  const state = entry?.task_states?.[itemId];
  if (state) return { ...state, workerId: state.workerId ?? undefined, workerName: state.workerName ?? undefined, reviewedBy: state.reviewedBy ?? undefined };
  if (entry?.responses?.[itemId] === true) return { status: entry.status === 'approved' ? 'approved' : 'needs', workerChecked: true, workerId: entry.submitted_by ?? undefined, workerName: entry.submitted_by_name ?? undefined, poolSubmitted: /log pool readings/i.test(template.checklist.find(item => item.id === itemId)?.label || '') };
  return undefined;
}
type Options<E extends TaskEntry> = {
  owner: { hotelId: string; userId: string } | null; actor: PmTaskActor; canEdit: boolean;
  context: PmQueueContext; onRestoreContext: (context: PmQueueContext) => void;
  onSaved: (entry: E) => void; onError: (message: string) => void; onPoolRequired: (date: string) => void;
};

/** Durable user/property intents, flushed once per period through the existing CAS API. */
export function usePmTaskQueue<E extends TaskEntry>(options: Options<E>) {
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const [periods, setPeriods] = useState<PmQueuedPeriod[]>([]);
  const pending = useRef<PmQueuedPeriod[]>([]);
  const hydrated = useRef('');
  const ownerKey = options.owner ? pmQueueStorageKey(options.owner.hotelId, options.owner.userId) : '';
  const [flushing, setFlushing] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const storageFailed = useRef(false);
  const closing = useRef(false);

  const persist = useCallback((next: PmQueuedPeriod[], key = hydrated.current) => {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, periods: next, context: latest.current.context }));
      storageFailed.current = false;
    } catch {
      storageFailed.current = true;
      latest.current.onError('This browser could not retain the PM changes. Keep this window open and retry saving.');
    }
  }, []);
  const replace = useCallback((next: PmQueuedPeriod[]) => {
    pending.current = next;
    persist(next);
    setPeriods(next);
  }, [persist]);

  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (!live || !ownerKey || hydrated.current === ownerKey) return;
      let restored = null;
      try { restored = readPmTaskQueue(localStorage.getItem(ownerKey)); } catch { /* Saving reports blocked browser storage. */ }
      hydrated.current = ownerKey;
      const next = (restored?.periods || []).filter(period => {
        const template = findPmTemplate(period.templateId);
        return template?.kind === 'routine' && validPmPeriod(template, period.periodStart)
          && period.changes.every(change => template.checklist.some(item => item.id === change.itemId));
      });
      pending.current = next;
      setPeriods(next);
      if (restored) latest.current.onRestoreContext(restored.context);
    });
    return () => { live = false; };
  }, [ownerKey]);
  useEffect(() => { if (ownerKey && hydrated.current === ownerKey) persist(pending.current); }, [ownerKey, options.context.weekStart, options.context.frequency, options.context.tab, options.context.phoneDay, persist]);

  const queue = useCallback((template: PmTemplate, periodStart: string, itemId: string, entry: E | undefined) => {
    const current = latest.current;
    if (!current.canEdit || !hydrated.current || inFlight.current) return;
    try {
      const item = template.checklist.find(task => task.id === itemId)!;
      replace(queuePmTask(pending.current, { templateId: template.id, periodStart, expectedRevision: entry?.status === 'pending' ? entry.revision : 0 }, itemId,
        pmEntryTaskState(entry, template, itemId), current.actor,
        { pool: /log pool readings/i.test(item.label), poolLogFilled: true, attachedForm: template.cadence === 'weekly' && Boolean(item.source?.endsWith('.pdf')) }));
    } catch (cause) { current.onError(cause instanceof Error ? cause.message : 'The PM change could not be queued.'); }
  }, [replace]);

  const flush = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    if (!pending.current.length) return Promise.resolve();
    setFlushing(true);
    const work = (async () => {
      const owner = latest.current.owner;
      const verified = await loadCmpriSession();
      if (!owner || verified.user.id !== owner.userId || verified.hotelId !== owner.hotelId || !verified.capabilities.includes('view_pm')) throw new Error('Sign in with the same account and property before saving these PM changes.');
      const session = await getValidSession();
      if (!session?.access_token) throw new Error('Sign in again before saving PM.');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
      for (const period of [...pending.current]) {
        // A fresh read also recognizes an earlier successful write whose reply was lost.
        const check = await fetch(`/api/preventive-maintenance?week=${encodeURIComponent(pmWeekStart(period.periodStart))}`, { headers, cache: 'reload' });
        const current = await check.json().catch(() => ({}));
        if (!check.ok || !Array.isArray(current.entries)) throw new Error(current.error || 'The PM changes could not be verified. Retry saving.');
        const entry = current.entries.find((candidate: E) => candidate.template_id === period.templateId && candidate.period_start === period.periodStart) as E | undefined;
        const template = findPmTemplate(period.templateId)!;
        if (period.changes.every(change => pmTaskStatesEqual(pmEntryTaskState(entry, template, change.itemId), change.desiredState))) {
          if (entry) latest.current.onSaved(entry);
          replace(pending.current.filter(candidate => candidate !== period));
          continue;
        }
        if ((entry?.status === 'pending' ? entry.revision : 0) !== period.expectedRevision
          || period.changes.some(change => !pmTaskStatesEqual(pmEntryTaskState(entry, template, change.itemId), change.expectedState))) throw new Error('This PM period changed elsewhere. Your queued changes are kept here. Review the latest record before discarding or retrying them.');
        const response = await fetch('/api/preventive-maintenance/task', { method: 'PATCH', headers, body: JSON.stringify({ templateId: period.templateId, periodStart: period.periodStart, expectedRevision: period.expectedRevision, changes: period.changes.map(({ itemId, tapCount, expectedState }) => ({ itemId, tapCount, expectedState })) }) });
        const result = await response.json().catch(() => ({}));
        if (result.poolRequired) latest.current.onPoolRequired(period.periodStart);
        if (!response.ok || !result.entry) throw new Error(result.error || 'PM changes could not be saved. They are kept here for retry.');
        latest.current.onSaved(result.entry as E);
        replace(pending.current.filter(candidate => candidate !== period));
      }
    })();
    inFlight.current = work;
    void work.finally(() => { inFlight.current = null; setFlushing(false); }).catch(() => {});
    return work;
  }, [replace]);

  useEffect(() => {
    const close = (event: Event) => {
      if (!pending.current.length) return;
      event.preventDefault();
      if (closing.current) return;
      closing.current = true;
      void flush().then(() => {
        if (window.parent !== window) window.parent.postMessage({ type: 'cmpri-modal-close', modalToken: new URLSearchParams(window.location.search).get('modalToken') || '' }, window.location.origin);
      }).catch(cause => latest.current.onError(cause instanceof Error ? cause.message : 'PM changes could not be saved.')).finally(() => { closing.current = false; });
    };
    const hide = () => persist(pending.current);
    const unload = (event: BeforeUnloadEvent) => { if (pending.current.length && storageFailed.current) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('cmpri-modal-cancel-request', close);
    window.addEventListener('pagehide', hide);
    window.addEventListener('beforeunload', unload);
    return () => { document.removeEventListener('cmpri-modal-cancel-request', close); window.removeEventListener('pagehide', hide); window.removeEventListener('beforeunload', unload); };
  }, [flush, persist]);
  return { periods, flushing, queue, flush, discard: () => replace([]) };
}
