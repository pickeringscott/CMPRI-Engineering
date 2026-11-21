"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import WorkOrderMediaControl from "./WorkOrderMediaControl";
import { createClient, getValidSession } from "@/lib/supabase/client";
import { loadCmpriSession } from "@/lib/auth/client-session";
import { uploadWorkOrderAttachment } from "@/lib/work-order-attachment-upload";
import { clearAttachmentDraft, readAttachmentDraft, saveAttachmentDraft, type AttachmentDraft, type AttachmentDraftScope } from "@/lib/work-orders/attachment-draft";

type Pending = { file: File; url: string; id: string };
export type MediaRecoveryActions = { flush: () => Promise<boolean>; discard: () => Promise<boolean> };
export default function WorkOrderMediaComposer({ workOrderId, revision, disabled, hasNote, onSubmitNote, onUploaded, onPendingChange, onBusyChange, onRecoveryActions }: {
  workOrderId: string; revision: number; disabled: boolean; hasNote: boolean; onSubmitNote: () => Promise<boolean | undefined>;
  onUploaded: () => Promise<unknown>; onPendingChange: (pending: boolean) => void; onBusyChange: (busy: boolean) => void;
  onRecoveryActions?: (actions: MediaRecoveryActions | null) => void;
}) {
  const { t } = useUiLanguage();
  const [files, setFiles] = useState<Pending[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [ready, setReady] = useState(false), [conflict, setConflict] = useState<AttachmentDraft | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const pending = useRef<Pending[]>([]), active = useRef(true), inFlight = useRef(false);
  const owner = useRef<AttachmentDraftScope | null>(null), identity = useRef("");
  const persistence = useRef<Promise<boolean>>(Promise.resolve(true));
  const recoveryConflict = useRef<AttachmentDraft | null>(null);
  const hydrated = useRef(false), hasStoredWork = useRef(false);
  const callbacks = useRef({ onPendingChange, onRecoveryActions });
  useLayoutEffect(() => { callbacks.current = { onPendingChange, onRecoveryActions }; });

  function reportFailure(cause: unknown) {
    if (active.current) setError(cause instanceof Error ? cause.message : "Selected attachments could not be retained. Keep this window open until they are uploaded.");
  }
  function persist() {
    const scope = owner.current;
    if (!scope || !hydrated.current) return Promise.resolve(false);
    if (recoveryConflict.current || (!pending.current.length && !hasStoredWork.current)) return Promise.resolve(true);
    const rows = pending.current.map(item => ({ file: item.file, uploadId: item.id }));
    const operation = rows.length ? saveAttachmentDraft(scope, { files: rows, draftIdentity: identity.current }) : clearAttachmentDraft(scope);
    const result = operation.then(() => { hasStoredWork.current = !!rows.length; return true; }, cause => { reportFailure(cause); return false; });
    persistence.current = result;
    return result;
  }
  function replace(next: Pending[], save = true) {
    pending.current = next;
    if (next.length) hasStoredWork.current = true;
    if (active.current) { setFiles(next); callbacks.current.onPendingChange(!!next.length || !!recoveryConflict.current); }
    if (save) void persist();
  }
  async function remove(id: string, acknowledged = false) {
    if (!acknowledged && inFlight.current) return false;
    const scope = owner.current;
    const previous = pending.current;
    const next = previous.filter(item => item.id !== id);
    const item = previous.find(item => item.id === id);
    if (!acknowledged) { inFlight.current = true; setBusy(true); onBusyChange(true); }
    // Lifecycle flushes must see the intended remaining set while the delete
    // commits, so they cannot resurrect the removed file after that transaction.
    pending.current = next;
    try {
      const retained = await persist();
      if (!active.current || owner.current !== scope) return false;
      if (!retained) { pending.current = previous; return false; }
      if (item) URL.revokeObjectURL(item.url);
      replace(next, false);
      return true;
    } finally {
      if (!acknowledged) { inFlight.current = false; if (active.current) { setBusy(false); onBusyChange(false); } }
    }
  }
  function restored(draft: AttachmentDraft) {
    const rows = draft.files.map(item => ({ file: item.file, id: item.uploadId, url: URL.createObjectURL(item.file) }));
    replace(rows, false);
  }

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      void persist();
      owner.current = null;
      for (const item of pending.current) URL.revokeObjectURL(item.url);
      pending.current = [];
      recoveryConflict.current = null;
      if (active.current) { setFiles([]); setConflict(null); setReady(false); callbacks.current.onPendingChange(false); }
    };
    const subscription = createClient().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (owner.current && session && session.user.id !== owner.current.userId)) stop();
    });
    window.addEventListener("cmpri-workspace-sign-out", stop);
    const hide = () => { if (document.hidden) void persist(); };
    const flush = () => { void persist(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hide);
    void (async () => {
      const session = await loadCmpriSession();
      const token = await getValidSession();
      if (!token || token.user.id !== session.user.id) throw new Error("Sign in again before restoring attachments.");
      const response = await fetch(`/api/work-orders/${workOrderId}`, { headers: { Authorization: `Bearer ${token.access_token}` }, cache: "reload" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.workOrder?.id !== workOrderId || !Number.isSafeInteger(payload.workOrder.revision)) throw new Error("The ticket could not be verified. Reopen it to recover selected attachments.");
      const scope = { hotelId: session.hotelId, userId: session.user.id, editorId: workOrderId };
      if (cancelled || !active.current) return;
      owner.current = scope;
      identity.current = `ticket:${workOrderId}:${payload.workOrder.revision}`;
      const retained = await readAttachmentDraft(scope);
      const current = await getValidSession();
      if (cancelled || !active.current || !current || current.user.id !== scope.userId) return;
      hydrated.current = true; setError("");
      if (retained?.files.length) {
        if (retained.draftIdentity !== identity.current) {
          recoveryConflict.current = retained; setConflict(retained); callbacks.current.onPendingChange(true);
        } else { restored(retained); setError("Recovered selected attachments from this device. Submit Note to upload them."); }
      }
      setReady(true);
    })().catch(reportFailure);
    callbacks.current.onRecoveryActions?.({
      flush: async () => { if (recoveryConflict.current) return true; return persist(); },
      discard: async () => {
        const scope = owner.current;
        if (!scope) return !pending.current.length && !recoveryConflict.current;
        try {
          await clearAttachmentDraft(scope);
          for (const item of pending.current) URL.revokeObjectURL(item.url);
          recoveryConflict.current = null; replace([], false); setConflict(null); return true;
        } catch (cause) { reportFailure(cause); return false; }
      },
    });
    return () => {
      cancelled = true;
      void persist();
      active.current = false;
      owner.current = null;
      subscription.data.subscription.unsubscribe();
      window.removeEventListener("cmpri-workspace-sign-out", stop);
      window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hide);
      for (const item of pending.current) URL.revokeObjectURL(item.url);
      callbacks.current.onRecoveryActions?.(null);
    };
    // The ticket owns this composer instance; revision changes from acknowledged text saves keep the same selected bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workOrderId, recoveryAttempt]);
  useEffect(() => {
    if (owner.current && !recoveryConflict.current && Number.isSafeInteger(revision)) {
      identity.current = `ticket:${workOrderId}:${revision}`;
      if (pending.current.length) void persist();
    }
    // Revision changes follow an acknowledgement; selected bytes stay bound to this ticket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workOrderId, revision]);

  async function submit() {
    if (inFlight.current || disabled || !ready || recoveryConflict.current) return;
    const scope = owner.current;
    if (!scope) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError("");
    try {
      const verified = await loadCmpriSession();
      const session = await getValidSession();
      if (!session || session.user.id !== scope.userId || verified.user.id !== scope.userId || verified.hotelId !== scope.hotelId || owner.current !== scope) throw new Error("The account changed. Your attachments were kept for their owner.");
      if (pending.current.length) {
        await persist();
        for (const item of [...pending.current]) {
          if (!active.current || owner.current !== scope) return;
          const result = await uploadWorkOrderAttachment(workOrderId, item.file, session.access_token, item.id);
          if (!active.current || owner.current !== scope) return;
          if (!result.ok) throw new Error(result.message);
          if (!await remove(item.id, true)) throw new Error("Attachment saved, but its device recovery could not be cleared. Retry to confirm cleanup before closing.");
        }
        if (active.current) await onUploaded();
      }
      if (active.current && owner.current === scope && hasNote) await onSubmitNote();
    } catch (cause) { if (active.current && owner.current === scope) { reportFailure(cause); await onUploaded(); } }
    finally { inFlight.current = false; if (active.current) { setBusy(false); onBusyChange(false); } }
  }
  return <>
    {conflict && <div role="alert" className="rounded border border-amber-500 p-2 text-xs text-amber-100">
      <p>{t("This work order changed after {count} attachments were selected. Your files are retained separately.", { count: conflict.files.length })}</p>
      <p>{conflict.files.map(item => item.file.name).join(", ")}</p>
      <button type="button" className="mt-1 underline" onClick={() => { recoveryConflict.current = null; setConflict(null); restored(conflict); void persist(); }}>{t("Use Recovered Attachments")}</button>
      <button type="button" className="ml-3 underline" onClick={() => {
        const scope = owner.current;
        if (!scope || !window.confirm(t("Discard the recovered attachments from this device?"))) return;
        void clearAttachmentDraft(scope).then(() => { if (owner.current !== scope || !active.current) return; recoveryConflict.current = null; hasStoredWork.current = false; setConflict(null); replace([], false); }, reportFailure);
      }}>{t("Discard Recovered Attachments")}</button>
    </div>}
    {!ready && error && <button type="button" className="my-1 text-xs underline" onClick={() => setRecoveryAttempt(value => value + 1)}>{t("Retry Attachment Recovery")}</button>}
    <div className="preview-note-actions"><div className="preview-note-thumbnails">{[...files].reverse().map(item => <span className="preview-note-thumbnail" key={item.id}>{item.file.type.startsWith("video/") ? <video src={item.url} muted preload="metadata" /> : <picture style={{ display: "contents" }}><img src={item.url} alt={item.file.name} /></picture>}<button type="button" disabled={busy || disabled} onClick={() => remove(item.id)} aria-label={t("Remove {name}", { name: item.file.name })}>×</button></span>)}</div>
      <WorkOrderMediaControl disabled={busy || disabled || !ready || !!conflict} onSelect={chosen => { if (!owner.current || !ready || disabled || busy || recoveryConflict.current) return; hydrated.current = true; replace([...pending.current, ...chosen.map(file => ({ file, id: crypto.randomUUID(), url: URL.createObjectURL(file) }))]); }} />
      <button type="button" onClick={() => void submit()} disabled={busy || disabled || !ready || !!conflict || (!hasNote && !files.length)} className="rounded-lg bg-sky-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40">{busy ? t("Saving…") : t("Submit Note")}</button>
    </div>{error && <p role="alert" className="text-xs text-amber-200">{t(error)}</p>}
  </>;
}
