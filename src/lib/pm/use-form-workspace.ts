"use client";

import { useCallback, useEffect, useRef } from 'react';
import { pmFormDraftKey, pmFormRestoreWeek, pmFormWorkspaceKey, readPmFormWorkspace, type PmFormContents, type PmFormIdentity, type PmFormOwner, type PmFormWorkspace } from './form-workspace';

type Options = {
  owner: PmFormOwner | null;
  loadedWeek: string;
  weekStart: string;
  activeForm: PmFormIdentity | null;
  contents: PmFormContents;
  canEdit: boolean;
  preferWorkOrder: boolean;
  onSelectWeek: (week: string) => void;
  onRestore: (identity: PmFormIdentity) => void;
  onError: (message: string) => void;
};

/** Restores only after the page's fresh, authorized PM request for the saved week. */
export function usePmFormWorkspace(options: Options) {
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });
  const readOwner = useRef('');
  const hydrated = useRef('');
  const pending = useRef<PmFormWorkspace | null>(null);
  const storageFailed = useRef(false);
  const ownerKey = options.owner ? pmFormWorkspaceKey(options.owner) : '';

  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (!live || !ownerKey) return;
      const current = latest.current;
      if (readOwner.current !== ownerKey) {
        readOwner.current = ownerKey;
        hydrated.current = '';
        pending.current = null;
        try { pending.current = readPmFormWorkspace(localStorage.getItem(ownerKey), current.owner!); } catch { /* Saving reports unavailable storage. */ }
      }
      if (hydrated.current === ownerKey) return;
      const saved = current.preferWorkOrder ? null : pending.current;
      if (saved?.activeForm && current.loadedWeek !== saved.weekStart) {
        current.onSelectWeek(saved.weekStart);
        return;
      }
      if (current.loadedWeek !== current.weekStart) return;
      hydrated.current = ownerKey;
      pending.current = null;
      if (saved?.activeForm) current.onRestore(saved.activeForm);
    });
    return () => { live = false; };
  }, [ownerKey, options.loadedWeek, options.weekStart, options.preferWorkOrder]);

  const persist = useCallback(() => {
    const current = latest.current;
    if (!current.owner || hydrated.current !== pmFormWorkspaceKey(current.owner)) return;
    try {
      // A legacy cmpri-pm-draft:user:entry key has no verified property. Never import or delete it.
      if (current.activeForm && current.canEdit) localStorage.setItem(pmFormDraftKey(current.owner, current.activeForm), JSON.stringify({
        version: 1, owner: current.owner, identity: current.activeForm, ...current.contents,
      }));
      localStorage.setItem(pmFormWorkspaceKey(current.owner), JSON.stringify({
        version: 1, owner: current.owner, weekStart: pmFormRestoreWeek(current.weekStart, current.activeForm), activeForm: current.activeForm,
      }));
      storageFailed.current = false;
    } catch {
      storageFailed.current = true;
      current.onError('This browser could not retain the PM form. Keep this window open and retry saving.');
    }
  }, []);

  useEffect(() => { persist(); }, [ownerKey, options.weekStart, options.activeForm, options.contents, options.canEdit, persist]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      persist();
      if (latest.current.activeForm && storageFailed.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('pagehide', persist);
    window.addEventListener('beforeunload', unload);
    return () => { persist(); window.removeEventListener('pagehide', persist); window.removeEventListener('beforeunload', unload); };
  }, [persist]);
  return { persist };
}
