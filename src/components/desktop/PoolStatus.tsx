"use client";

import { useState } from "react";
import { usePoolState, updatePoolState } from "@/lib/events/pool-store";
import { authorizationHeaders } from "@/lib/auth/client-session";

export default function PoolStatus({ canReopen = false, noticeOnly = false, controlOnly = false, onOpen }: {
  canReopen?: boolean;
  noticeOnly?: boolean;
  controlOnly?: boolean;
  onOpen?: () => void;
}) {
  const { state, error: loadError } = usePoolState();
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (controlOnly) return <button type="button" onClick={onOpen} data-cmpri-modal-trigger={onOpen ? undefined : "true"} data-cmpri-modal-href={onOpen ? undefined : "/pool"} aria-haspopup="dialog" aria-live="polite" aria-atomic="true" data-closed={state?.closed || false} className="cmpri-header-status-pill shrink-0 rounded-full border px-3 py-1 text-xs font-bold text-black" style={{ color: "#000", background: state ? state.closed ? "#ef4444" : "#22c55e" : "#94a3b8", borderColor: state ? state.closed ? "#ef4444" : "#22c55e" : "#94a3b8" }}>Pool Status: {state ? state.closed ? "CLOSED" : "OPEN" : "LOADING"}</button>;
  if (noticeOnly) {
    const latest = state?.notifications.at(-1);
    return latest ? <button type="button" onClick={onOpen} className="rounded border border-red-400 bg-red-950 px-2 py-1 text-xs text-amber-300" aria-label={`Pool closure notification: ${latest.reason}`}>Pool closure: {latest.reason}</button> : null;
  }

  const update = async (closed: boolean) => {
    if (!state || busy) return;
    const closureReason = reason.trim();
    if (closed && !closureReason) { setError("Enter a reason for closing the pool."); return; }
    if (!closed && !window.confirm(state.manual_closed
      ? "Clear the manual closure and reopen the pool? The pool will remain closed if required tests do not pass."
      : "Reopen the pool? The pool will remain closed if required tests do not pass.")) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pool-status", {
        method: "POST",
        headers: { ...await authorizationHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pool-status", id: crypto.randomUUID(), closed, reason: closed ? closureReason : "", expectedRevision: state.revision }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "The pool status could not be saved.");
      updatePoolState(data);
      setReason("");
      if (data.warning) setError(String(data.warning));
    } catch (error) {
      setError(error instanceof Error ? error.message : "The pool status could not be saved.");
    } finally { setBusy(false); }
  };

  return <div data-pool-state={state?.closed ? "closed" : "open"} className="flex h-full flex-col gap-2 bg-slate-900 p-2.5">
    <div style={{ border: `2px solid ${state?.closed ? "#ef4444" : "#22c55e"}`, borderRadius: 8, background: "var(--cmpri-modal-surface,#020617)", padding: 12, textAlign: "center" }} className="flex flex-1 flex-col items-center justify-center">
      <strong style={{ background: state?.closed ? "#ef4444" : "#22c55e", color: "#000", borderRadius: 999, padding: "6px 22px", fontSize: 40, letterSpacing: 4 }}>{state ? state.closed ? "CLOSED" : "OPEN" : "…"}</strong>
      {state?.closed && <p style={{ color: "#fcd34d", background: "transparent", fontSize: 14, marginTop: 6 }}>{state.reason}</p>}
    </div>
    <form onSubmit={event => { event.preventDefault(); void update(true); }} className="flex flex-wrap gap-1">
      <input aria-label="Closure reason" placeholder="Closure reason" value={reason} onChange={event => setReason(event.target.value)} required maxLength={1000} className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-950 px-1 text-xs" />
      <button disabled={busy || !state || state.hours_closed} type="submit" className="rounded border border-red-400 px-1 text-xs disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-800 disabled:text-slate-500">Close pool</button>
      {canReopen && <button disabled={busy || !state || state.hours_closed} type="button" onClick={() => void update(false)} className="rounded border border-green-400 px-1 text-xs disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-800 disabled:text-slate-500">Open pool</button>}
    </form>
    {(error || loadError) && <p role="alert" className="text-xs text-amber-300">{error || loadError}</p>}
  </div>;
}
