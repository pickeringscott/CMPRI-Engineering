"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createClient, getValidSession } from "@/lib/supabase/client";
import type { CmpriClientSession } from "@/lib/auth/client-session";
import { taskEditable, type PmTaskState } from "@/lib/pm/task-review";
import { troubleshootingTaskVisual, type TroubleshootingChecklist, type TroubleshootingChecklistStep } from "@/lib/work-orders/troubleshooting-checklist";
import { subscribeResources } from "@/lib/events/browser";
import { invalidateCachedResources } from "@/lib/data-cache/browser";
import { troubleshootingVisit } from "@/lib/work-orders/troubleshooting-visits";
import WorkOrderStepMedia from "@/components/WorkOrderStepMedia";
import { sourceSemantics } from "@/lib/work-orders/source-semantics";

export type TroubleshootingChecklistResponse = TroubleshootingChecklist;

type Props = {
  workOrderId: string;
  session: CmpriClientSession;
  expectedContextIdentity: string | null;
  ticketRevision: number;
  disabledReason?: string;
  manualUrl?: string;
  reportedIssue: string;
  equipmentName: string;
  sourceFileName?: string;
  assetId: string;
  sourceSha256: string;
  visitId: string;
  registerExitFlush?: (flush: () => Promise<void>) => () => void;
  previewSteps?: TroubleshootingChecklistStep[];
};

function canClear(data: TroubleshootingChecklistResponse, state?: PmTaskState) {
  return !!state && (state.workerChecked === true || state.status !== "empty")
    && (data.canClearAll || data.canClearOwn && state.workerId === data.actor.id);
}

function checkboxAction(data: TroubleshootingChecklistResponse, state?: PmTaskState): "toggle" | "clear" {
  return canClear(data, state) && (!data.canSeePendingReview || state?.status === "approved" || !data.canEdit) ? "clear" : "toggle";
}

function nextAction(data: TroubleshootingChecklistResponse, state?: PmTaskState) {
  if (!taskEditable(state, data.actor)) return "This completion is read-only";
  return data.canSeePendingReview && state?.status === "needs" ? "Verify completed step" : "Mark completed";
}

/** PM completion/review visuals with explicit work-order ownership for clearing. */
export default function WorkOrderTroubleshootingChecklist({ workOrderId, session, expectedContextIdentity, ticketRevision, disabledReason, manualUrl, reportedIssue, equipmentName, sourceFileName, assetId, sourceSha256, visitId, registerExitFlush, previewSteps }: Props) {
  const scope = JSON.stringify([workOrderId, session.hotelId, session.user.id, expectedContextIdentity, ticketRevision]);
  const identity = useRef({ scope, generation: 0 });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; identity.current.generation++; };
  }, []);
  useLayoutEffect(() => {
    identity.current = { scope, generation: identity.current.generation + 1 };
  }, [scope]);
  const [result, setResult] = useState<{ scope: string; value: TroubleshootingChecklistResponse } | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const busyScope = JSON.stringify([scope, disabledReason || ""]);
  const [busyState, setBusyState] = useState<{ scope: string; itemId: string } | null>(null);
  const busy = busyState?.scope === busyScope ? busyState.itemId : null;
  const inFlight = useRef(false);
  const refreshPending = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const activeWrite = useRef(false);
  const data = result?.scope === scope && result.value.contextIdentity === expectedContextIdentity ? result.value : null;
  const getVisit = useCallback(() => troubleshootingVisit(visitId, workOrderId, session.user.id, session.hotelId), [session.hotelId, session.user.id, visitId, workOrderId]);

  useEffect(() => registerExitFlush?.(() => getVisit().flush()), [getVisit, registerExitFlush]);

  const request = useCallback(async function fetchChecklist(itemId?: string, current?: TroubleshootingChecklistResponse, action: "toggle" | "clear" = "toggle") {
    if (inFlight.current) { if (!itemId) refreshPending.current = true; return; }
    if (disabledReason || !expectedContextIdentity) return;
    inFlight.current = true;
    let releaseWrite: (() => void) | undefined;
    if (itemId) getVisit().track(new Promise<void>(resolve => { releaseWrite = resolve; }));
    const generation = identity.current.generation;
    const controller = new AbortController();
    activeRequest.current = controller;
    activeWrite.current = !!itemId;
    const isCurrent = () => mounted.current && !controller.signal.aborted && identity.current.scope === scope && identity.current.generation === generation;
    const checkSession = async () => {
      const auth = await getValidSession();
      if (!isCurrent() || !auth?.access_token || auth.user.id !== session.user.id) throw new Error("Your account changed. Reopen the work order to continue.");
      return auth.access_token;
    };
    try {
      const token = await checkSession();
      setBusyState({ scope: busyScope, itemId: itemId || "load" });
      setError(null);
      if (itemId) {
        if (!current || (action === "clear" ? !canClear(current, current.taskStates[itemId]) : !current.canEdit || !taskEditable(current.taskStates[itemId], current.actor))) throw new Error("This completion cannot be changed by this user.");
        getVisit().remember();
      }
      const init: RequestInit = {
        method: itemId ? "PATCH" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(itemId ? { "Content-Type": "application/json" } : {}) },
        ...(itemId ? { body: JSON.stringify({ contextKey: current!.contextKey, expectedRevision: current!.revision, itemId, action, visitId, mutationId: crypto.randomUUID() }), keepalive: true } : {}),
        cache: "no-store",
        signal: controller.signal,
      };
      const send = () => fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/troubleshooting`, init);
      let response: Response;
      try { response = await send(); }
      catch (failure) {
        if (!itemId || !isCurrent()) throw failure;
        await checkSession();
        // Replay the same mutation ID if its response was lost after commit.
        response = await send();
      }
      const payload = await response.json();
      await checkSession();
      if (!response.ok) {
        if (response.status === 409) setResult(null);
        throw new Error(payload.error || "The checklist could not be saved. Reload it before trying again.");
      }
      if (payload.contextIdentity !== expectedContextIdentity) {
        setResult(null);
        throw new Error("The issue, equipment, or verified guidance changed. Reload this work order before using the checklist.");
      }
      if (payload.actor?.id !== session.user.id || !Array.isArray(payload.steps) || !payload.taskStates || !Number.isSafeInteger(payload.revision)) throw new Error("The checklist response could not be verified. Reload it before continuing.");
      if (!itemId) await getVisit().recoverLocal();
      await checkSession();
      setResult({ scope, value: payload as TroubleshootingChecklistResponse });
      if (itemId) void invalidateCachedResources(["orders"]);
    } catch (failure) {
      if (isCurrent()) setError({ scope, message: failure instanceof Error ? failure.message : "The checklist could not be loaded. Try again." });
    } finally {
      releaseWrite?.();
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        inFlight.current = false;
        activeWrite.current = false;
        if (identity.current.scope === scope) setBusyState(null);
        if (refreshPending.current && isCurrent()) {
          refreshPending.current = false;
          queueMicrotask(() => { void fetchChecklist(); });
        }
      }
    }
  }, [busyScope, disabledReason, expectedContextIdentity, getVisit, scope, session.user.id, visitId, workOrderId]);

  useEffect(() => {
    const { data: subscription } = createClient().auth.onAuthStateChange((_event, auth) => {
      if (auth?.user.id === session.user.id) return;
      identity.current.generation++;
      activeRequest.current?.abort();
      activeRequest.current = null;
      inFlight.current = false;
      setResult(null);
      setBusyState(null);
      setError({ scope, message: "Your account changed. Reopen the work order to continue." });
    });
    return () => subscription.subscription.unsubscribe();
  }, [scope, session.user.id]);

  useEffect(() => {
    const stop = subscribeResources(["orders", "reference"], async () => { await request(); });
    return () => {
      stop();
      if (!activeWrite.current) activeRequest.current?.abort();
      activeRequest.current = null;
      inFlight.current = false;
      refreshPending.current = false;
    };
  }, [request]);

  const message = error?.scope === scope ? error.message : "";
  const preview = previewSteps !== undefined;
  const display: TroubleshootingChecklistResponse | null = preview ? {
    contextKey: null, contextIdentity: expectedContextIdentity, revision: 0, actor: data?.actor || { id: session.user.id, name: session.user.name || "", role: "manager" },
    canEdit: false, canClearAll: false, canClearOwn: false, canSeePendingReview: false, steps: previewSteps, taskStates: {}, pendingVisits: [],
  } : data;
  const recoverEarlier = async (earlierVisitId: string) => {
    const generation = identity.current.generation;
    const current = () => mounted.current && identity.current.scope === scope && identity.current.generation === generation;
    setBusyState({ scope: busyScope, itemId: "recover" });
    try { await getVisit().recover(earlierVisitId); await request(); }
    catch (failure) { if (current()) setError({ scope, message: failure instanceof Error ? failure.message : "The earlier summary could not be confirmed." }); }
    finally { if (current()) setBusyState(null); }
  };
  return (
    <section aria-label="Work-order troubleshooting checklist" className="mt-1 space-y-0 [&>p]:leading-tight">
      <h3 className="text-xs font-semibold leading-tight text-sky-300">Troubleshooting checklist</h3>
      <p className="text-sm text-slate-200"><span className="font-semibold">For:</span> {reportedIssue} <span className="text-slate-400">· {equipmentName}</span></p>
      <p className="text-xs text-slate-400">Reads this asset’s uploaded document directly. No AI-generated instructions. Completion and Chief Engineer review are saved with this work order.</p>
      {sourceFileName && <p className="text-xs text-slate-300" data-guide-source-file={sourceFileName}>Source: {manualUrl ? <a href={manualUrl} target="_blank" rel="noreferrer" className="text-sky-300 underline">{sourceFileName}</a> : sourceFileName}</p>}
      {data && <p className="text-xs text-slate-400">{data.canSeePendingReview ? "Chief Engineer: blank → red → green → blank. Red means needs verification; green means verified." : "Green means completed. Select your checked step again to clear it."}</p>}
      {preview && <p role="status" className="text-xs text-amber-200">Preview for the edited issue — save the work order to record checks.</p>}
      {disabledReason && <p role="status" className="text-xs text-amber-200">{disabledReason}</p>}
      {busy === "load" && <p role="status" className="text-xs text-slate-400">Loading saved checklist…</p>}
      {message && <div role="alert" className="text-xs text-amber-200">{message} <button type="button" disabled={!!busy || !!disabledReason} onClick={() => void request()} className="underline">Reload checklist</button></div>}
      {data?.pendingVisits?.filter(earlier => earlier.visitId !== visitId).map(earlier => <p key={earlier.visitId} className="text-xs text-slate-400">An earlier troubleshooting summary is pending. <button type="button" disabled={!!busy} onClick={() => void recoverEarlier(earlier.visitId)} className="underline">Recover earlier summary</button></p>)}
      {display && !display.steps.length && <div className="space-y-0 text-sm leading-tight text-slate-400">
        <p>{display.reason || "The uploaded document has no instructions matching this description yet."}</p>
        <p>Describe what you see or hear, such as “it won’t turn on,” “it leaks,” or “it makes a loud noise.” A fault code is not required.</p>
      </div>}
      {data && !data.canEdit && data.steps.length > 0 && <p className="text-xs text-slate-400">New completion and verification marks are unavailable. You can still clear saved checks when permitted.</p>}
      {display && <ol className="divide-y divide-slate-800">
        {display.steps.map((step, index) => {
          const state = display.taskStates[step.id];
          const visual = troubleshootingTaskVisual(state, display.canSeePendingReview);
          const action = checkboxAction(display, state);
          const allowed = action === "clear" ? canClear(display, state) : display.canEdit && taskEditable(state, display.actor);
          const blocked = preview || !!disabledReason || !!busy || !!message;
          const disabled = blocked || !allowed;
          const status = state?.status === "approved" ? "Approved" : state?.status === "needs" ? "Completed · Needs approval" : state?.workerChecked ? "Completed · Review mark cleared" : "Not checked";
          const showStatus = busy === step.id || state?.workerChecked || state?.status === "needs" || state?.status === "approved";
          const color = visual === "needs" ? "#ef4444" : visual === "approved" ? "#34d399" : "#64748b";
          const semantics = sourceSemantics(step.label);
          return <li key={step.id} className="py-0">
            <div className="flex items-start gap-0.5">
              <button type="button" role="checkbox" aria-checked={visual !== "empty"} aria-label={`Step ${index + 1}: ${step.label}`} aria-describedby={`troubleshooting-status-${step.id}`} data-step-id={step.id} data-preview-status={visual} data-task-status={state?.status || "empty"} title={action === "clear" ? "Uncheck completed step" : nextAction(display, state)} disabled={disabled} onClick={() => void request(step.id, display, action)} className="grid h-6 w-6 shrink-0 place-items-center rounded-sm outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:cursor-default">
                <span aria-hidden="true" className="grid h-4 w-4 place-items-center rounded-sm border text-[10px] font-bold leading-none" style={{ borderColor: color, color, backgroundColor: visual === "empty" ? "transparent" : `${color}18` }}>{visual !== "empty" ? "✓" : ""}</span>
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-4 text-slate-200">{step.label}{semantics && <span data-source-semantics={semantics.kind} aria-label={`Source label: ${semantics.label}`} className="ml-1 inline-block rounded-sm border px-1 align-middle text-[10px] leading-3" style={{ color: semantics.color, borderColor: semantics.color }}>{semantics.label}</span>}</p>
                <p id={`troubleshooting-status-${step.id}`} className={showStatus ? "text-[10px] leading-3 text-slate-400" : "sr-only"}>{busy === step.id ? "Saving…" : status}{state?.workerName ? ` · Completed by ${state.workerName}` : ""}{state?.reviewedBy ? ` · Reviewed by ${state.reviewedBy}` : ""}</p>
                {!!step.media?.length && assetId && sourceSha256 && expectedContextIdentity && <WorkOrderStepMedia media={step.media} assetId={assetId} sourceSha256={sourceSha256} userId={session.user.id} contextIdentity={expectedContextIdentity} />}
              </div>
            </div>
          </li>;
        })}
      </ol>}
    </section>
  );
}
