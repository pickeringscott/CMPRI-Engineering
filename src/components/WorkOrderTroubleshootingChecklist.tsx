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
  isOpen?: boolean;
  onRestartRevision?: (revision: number) => void;
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

function chartParts(label: string): { context: string; detail: string } | null {
  const parts = label.split(" — ");
  if (parts.length < 3 || !/^(?:yes|no):/i.test(parts.at(-1) || "")) return null;
  return { context: parts.slice(0, -2).join(" — "), detail: parts.slice(-2).join(" — ") };
}

/** PM completion/review visuals with explicit work-order ownership for clearing. */
export default function WorkOrderTroubleshootingChecklist({ workOrderId, session, expectedContextIdentity, ticketRevision, disabledReason, manualUrl, sourceFileName, assetId, sourceSha256, visitId, isOpen = true, onRestartRevision, registerExitFlush, previewSteps }: Props) {
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

  const [handoffChoice, setHandoffChoice] = useState("");
  const showHandoff = Boolean(isOpen && handoffChoice !== visitId && data?.actor.role === "technician" && Object.values(data.taskStates).some(state => state.workerChecked && state.workerId && state.workerId !== session.user.id));
  const startNew = async () => {
    if (!data?.contextKey || busy) return;
    setBusyState({ scope: busyScope, itemId: "restart" });
    try {
      const auth = await getValidSession();
      if (!auth?.access_token || auth.user.id !== session.user.id) throw new Error("Sign in again to start a new checklist.");
      const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/troubleshooting`, {
        method: "POST", headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_new", contextKey: data.contextKey, expectedRevision: data.revision }), cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !Number.isSafeInteger(payload.workOrderRevision)) throw new Error(payload.error || "A new checklist could not be started.");
      setResult(null); setHandoffChoice(visitId); onRestartRevision?.(payload.workOrderRevision);
    } catch (failure) { setError({ scope, message: failure instanceof Error ? failure.message : "A new checklist could not be started." }); }
    finally { setBusyState(null); }
  };

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
      {sourceFileName && <p className="text-xs text-slate-300" data-guide-source-file={sourceFileName}>Source: {manualUrl ? <a href={manualUrl} target="_blank" rel="noreferrer" className="text-sky-300 underline">{sourceFileName}</a> : sourceFileName}</p>}
      {preview && <p role="status" className="text-xs text-amber-200">Preview for the edited issue — save the work order to record checks.</p>}
      {disabledReason && <p role="status" className="text-xs text-amber-200">{disabledReason}</p>}
      {busy === "load" && <p role="status" className="text-xs text-slate-400">Loading saved checklist…</p>}
      {message && <div role="alert" className="text-xs text-amber-200">{message} <button type="button" disabled={!!busy || !!disabledReason} onClick={() => void request()} className="underline">Reload checklist</button></div>}
      {data?.pendingVisits?.filter(earlier => earlier.visitId !== visitId).map(earlier => <p key={earlier.visitId} className="text-xs text-slate-400">An earlier troubleshooting summary is pending. <button type="button" disabled={!!busy} onClick={() => void recoverEarlier(earlier.visitId)} className="underline">Recover earlier summary</button></p>)}
      {display && !display.steps.length && <div className="space-y-0 text-sm leading-tight text-slate-400">
        <p>{display.reason || "The uploaded document has no instructions matching this description yet."}</p>
      </div>}
      {showHandoff && <div role="group" aria-label="Previous technician progress" className="rounded border border-amber-500/40 p-2 text-sm text-amber-100">
        <p>Another technician has checked steps. Continue their progress or start a new checklist?</p>
        <div className="flex gap-2"><button type="button" disabled={!!busy} onClick={() => setHandoffChoice(visitId)} className="underline">Continue</button><button type="button" disabled={!!busy} onClick={() => void startNew()} className="underline">Start new</button></div>
      </div>}
      {display && !showHandoff && <ol className="divide-y divide-slate-800">
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
          const chart = chartParts(step.label);
          const previous = index > 0 ? display.steps[index - 1] : undefined;
          const previousChart = previous ? chartParts(previous.label) : null;
          const showChart = !!chart && (chart.context !== previousChart?.context || step.sourcePages?.[0] !== previous?.sourcePages?.[0]);
          return <li key={step.id} className="py-0">
            {showChart && <div className="text-xs font-semibold text-sky-300" data-chart-context>
              {chart.context}
              {manualUrl && step.sourcePages?.length ? <details className="font-normal">
                <summary className="cursor-pointer">Source page {step.sourcePages[0]}</summary>
                <iframe title={`Manual source page ${step.sourcePages[0]}`} src={`${manualUrl}#page=${step.sourcePages[0]}&toolbar=0`} loading="lazy" className="h-64 w-full border-0" />
              </details> : null}
            </div>}
            <div className="flex items-start gap-0.5">
              <button type="button" role="checkbox" aria-checked={visual !== "empty"} aria-label={`Step ${index + 1}: ${step.label}`} aria-describedby={`troubleshooting-status-${step.id}`} data-step-id={step.id} data-preview-status={visual} data-task-status={state?.status || "empty"} title={action === "clear" ? "Uncheck completed step" : nextAction(display, state)} disabled={disabled} onClick={() => void request(step.id, display, action)} className="grid h-6 w-6 shrink-0 place-items-center rounded-sm outline-offset-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:cursor-default">
                <span aria-hidden="true" className="grid h-4 w-4 place-items-center rounded-sm border text-[10px] font-bold leading-none" style={{ borderColor: color, color, backgroundColor: visual === "empty" ? "transparent" : `${color}18` }}>{visual !== "empty" ? "✓" : ""}</span>
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-4 text-slate-200">{chart?.detail || step.label}{semantics && <span data-source-semantics={semantics.kind} aria-label={`Source label: ${semantics.label}`} className="ml-1 inline-block rounded-sm border px-1 align-middle text-[10px] leading-3" style={{ color: semantics.color, borderColor: semantics.color }}>{semantics.label}</span>}</p>
                <p id={`troubleshooting-status-${step.id}`} className={showStatus ? "text-[10px] leading-3 text-slate-400" : "sr-only"}>{busy === step.id ? "Saving…" : status}{state?.workerName ? ` · Completed by ${state.workerName}` : ""}{state?.reviewedBy ? ` · Reviewed by ${state.reviewedBy}` : ""}</p>
                {!!step.media?.length && assetId && sourceSha256 && expectedContextIdentity && <WorkOrderStepMedia media={step.media} assetId={assetId} sourceSha256={sourceSha256} userId={session.user.id} contextIdentity={expectedContextIdentity} />}
                {!chart && !step.media?.length && manualUrl && step.sourcePages?.length ? <details className="text-xs text-sky-300">
                  <summary className="cursor-pointer">Source page {step.sourcePages[0]}</summary>
                  <iframe title={`Manual source page ${step.sourcePages[0]}`} src={`${manualUrl}#page=${step.sourcePages[0]}&toolbar=0`} loading="lazy" className="h-64 w-full border-0" />
                </details> : null}
              </div>
            </div>
          </li>;
        })}
      </ol>}
    </section>
  );
}
