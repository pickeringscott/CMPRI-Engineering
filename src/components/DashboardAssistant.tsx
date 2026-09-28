"use client";

import { FormEvent, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";

type Message = { role: "user" | "assistant"; content: string };
type Diagnostic = { ok: boolean; state: string; message: string };
type PendingImport = {
  report_date: string;
  rows: Array<{
    room: string;
    checkout_date: string;
    checkout_time: string;
    room_status: string;
    arrival_date: string;
    arrival_time: string;
    move_from: string;
    move_to: string;
    room_type: string;
    guest_arrival_date: string;
    stay_nights: number;
    reserved: boolean;
  }>;
};

export default function DashboardAssistant() {
  const pathname = usePathname();
  const isDashboard = ["/engineering", "/technician", "/work-orders"].includes(pathname);
  const [authenticated, setAuthenticated] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    if (!isDashboard) {
      setAuthenticated(false);
      return () => { current = false; };
    }
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) {
          if (current) setAuthenticated(false);
          return;
        }
        const response = await fetch("/api/session", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (current) setAuthenticated(response.ok);
      } catch {
        if (current) setAuthenticated(false);
      }
    })();
    return () => { current = false; };
  }, [isDashboard, pathname]);

  useEffect(() => {
    if (!authenticated) return;
    let current = true;
    setDiagnostic({ ok: false, state: "checking", message: "Checking AI connection…" });
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) throw new Error("Sign in again to check CMPRI AI.");
        const response = await fetch("/api/assistant", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const result = await response.json().catch(() => ({}));
        if (typeof result.message !== "string") {
          throw new Error(result.message || result.error || "CMPRI AI connection check failed.");
        }
        if (current) setDiagnostic({ ok: result.ok === true, state: String(result.state || "unknown"), message: result.message });
      } catch (error) {
        if (current) setDiagnostic({ ok: false, state: "check_failed", message: error instanceof Error ? error.message : "CMPRI AI connection check failed." });
      }
    })();
    return () => { current = false; };
  }, [authenticated]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setInput("");
    setStatus("");
    const nextMessages = [...messages, { role: "user" as const, content: prompt }].slice(-12);
    setMessages(nextMessages);
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to use CMPRI AI.");
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "CMPRI AI could not answer.");
      if (typeof result.answer !== "string" || !result.answer.trim()) throw new Error("CMPRI AI returned no answer.");
      setPendingImport(result.pending_import && typeof result.pending_import === "object" ? result.pending_import as PendingImport : null);
      setMessages((current) => [...current, { role: "assistant" as const, content: result.answer }].slice(-12));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "CMPRI AI could not answer.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRoomOperationsImport() {
    if (!pendingImport || confirmingImport) return;
    setConfirmingImport(true);
    setStatus("");
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again before importing room operations.");
      const response = await fetch("/api/room-operations", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "ai", report_date: pendingImport.report_date, rows: pendingImport.rows }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || "Room operations were not imported.");
      setPendingImport(null);
      setStatus(`${result.count || pendingImport.rows.length} room-operation rows were imported for ${result.date || pendingImport.report_date}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Room operations were not imported.");
    } finally {
      setConfirmingImport(false);
    }
  }

  if (!authenticated || !isDashboard) return null;

  return (
    <section aria-label="CMPRI AI assistant" className="cmpri-dashboard-assistant mx-auto mt-5 rounded-xl border border-slate-800 bg-slate-900 p-3 text-white sm:p-4">
      <header className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2">
        <h2 className="text-base font-bold">CMPRI AI</h2>
        {busy && <span role="status" className="text-xs text-slate-400">Working…</span>}
      </header>
      {diagnostic && <p role="status" aria-live="polite" data-ai-state={diagnostic.state} className={`mt-2 rounded-md border px-3 py-2 text-xs ${diagnostic.ok ? "border-emerald-700/50 bg-emerald-950/30 text-emerald-200" : "border-amber-700/50 bg-amber-950/30 text-amber-100"}`}>{diagnostic.message}</p>}
      <div aria-live="polite" className="mt-2 max-h-80 min-h-16 space-y-2 overflow-y-auto">
            {messages.length === 0 && <p className="py-8 text-center text-sm text-slate-400">How can I help with CMPRI?</p>}
            {messages.map((message, index) => (
              <div key={`${index}-${message.role}`} className={`max-w-[92%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${message.role === "user" ? "ml-auto bg-sky-950 text-sky-100" : "bg-slate-800 text-slate-100"}`}>
                {message.content}
              </div>
            ))}
            {pendingImport && (
              <section aria-label="Daily room-operations import preview" className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-950/20 p-2">
                <div>
                  <h3 className="text-sm font-bold text-amber-100">Daily Room Ops preview</h3>
                  <p className="mt-1 text-xs text-slate-300">{pendingImport.report_date} · {pendingImport.rows.length} rooms</p>
                </div>
                <p className="text-xs text-amber-100">Confirming replaces the entire saved daily snapshot for this date. Guest names and codes are excluded.</p>
                <div className="max-h-36 overflow-auto rounded-md border border-slate-700">
                  <table className="w-full min-w-[28rem] text-left text-xs">
                    <thead className="sticky top-0 bg-slate-900 text-slate-300"><tr><th className="p-2">Room</th><th className="p-2">Checkout</th><th className="p-2">Status</th><th className="p-2">Arrival</th><th className="p-2">Move</th><th className="p-2">Type</th><th className="p-2">Nights</th><th className="p-2">Reserved</th></tr></thead>
                    <tbody className="divide-y divide-slate-800">
                      {pendingImport.rows.map((row, index) => (
                        <tr key={`${row.room}-${index}`}><td className="p-2">{row.room}</td><td className="p-2">{[row.checkout_date, row.checkout_time].filter(Boolean).join(" ")}</td><td className="p-2">{row.room_status}</td><td className="p-2">{[row.arrival_date, row.arrival_time].filter(Boolean).join(" ")}</td><td className="p-2">{[row.move_from, row.move_to].filter(Boolean).join(" → ")}</td><td className="p-2">{row.room_type}</td><td className="p-2">{row.stay_nights}</td><td className="p-2">{row.reserved ? "Yes" : "No"}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setPendingImport(null)} disabled={confirmingImport} className="min-h-9 rounded-md border border-slate-600 px-3 text-xs font-semibold text-slate-200 disabled:opacity-50">Discard</button>
                  <button type="button" onClick={() => void confirmRoomOperationsImport()} disabled={confirmingImport} className="min-h-9 rounded-md bg-amber-400 px-3 text-xs font-bold text-slate-950 disabled:opacity-50">{confirmingImport ? "Importing…" : "Confirm import"}</button>
                </div>
              </section>
            )}
      </div>
      {status && <p role="alert" className="mt-2 rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-sm text-red-100">{status}</p>}
      <form onSubmit={send} className="mt-3 border-t border-slate-800 pt-3">
        <label className="sr-only" htmlFor="cmpri-ai-prompt">Message CMPRI AI</label>
        <textarea id="cmpri-ai-prompt" value={input} onChange={(event) => setInput(event.target.value)} maxLength={4000} rows={2} disabled={busy || diagnostic?.ok !== true} placeholder={diagnostic?.ok ? "Ask about work orders, equipment, or PM" : "AI unavailable"} className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-white placeholder:text-slate-500 disabled:opacity-60" />
        <p className="mt-1 text-[11px] text-slate-500">Omit guest names, codes, and guest-specific dates from AI messages.</p>
        <div className="mt-2 flex justify-end">
          <button type="submit" disabled={busy || diagnostic?.ok !== true || !input.trim()} className="min-h-9 rounded-lg bg-sky-600 px-4 text-sm font-bold text-white hover:bg-sky-500 disabled:opacity-50">Send</button>
        </div>
      </form>
    </section>
  );
}