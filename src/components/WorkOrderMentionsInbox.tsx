"use client";
import Link from "next/link";
import { getValidSession } from "@/lib/supabase/client";
import { useCallback, useEffect, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { formatWorkOrderNotification } from "@/lib/work-order-reference.js";

type MentionNotification = { notification_key: string; work_order_id: string; message: string; recorded_at: string };
/** Targeted ticket mentions are available even to staff without a dashboard. */
export default function WorkOrderMentionsInbox() {
  const [notifications, setNotifications] = useState<MentionNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (document.hidden || window.self !== window.top) return;
    try {
      const session = await getValidSession();
      if (!session) { setNotifications([]); return; }
      const response = await fetch("/api/work-orders/mentions", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      if (response.status === 401 || response.status === 403) { setNotifications([]); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error("Ticket mention notifications could not be refreshed.");
      setNotifications(payload.notifications || []); setError("");
    } catch { /* Preserve the last confirmed inbox during a temporary disconnect. */ }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const poll = setInterval(() => void load(), 5000);
    document.addEventListener("visibilitychange", load); window.addEventListener("online", load);
    return () => { clearTimeout(first); clearInterval(poll); document.removeEventListener("visibilitychange", load); window.removeEventListener("online", load); };
  }, [load]);
  async function read(ids: string[]) {
    try {
      const response = await fetch("/api/work-orders/mentions", { method: "PATCH", headers: { ...await authorizationHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      if (!response.ok) throw new Error();
      setNotifications(previous => previous.filter(item => !ids.includes(item.notification_key)));
    } catch { setError("The mention could not be marked read. Try again."); }
  }
  if (!notifications.length && !error) return null;
  return <aside aria-label="Work order mentions" className="fixed bottom-3 right-3 z-[90] max-w-[calc(100vw-1.5rem)] rounded-xl border border-sky-500/50 bg-slate-950 p-2 text-sm text-white shadow-xl">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-lg px-2 py-1 font-semibold text-sky-200">@ Ticket mentions ({notifications.length})</button>
    {open && <div className="max-h-64 w-80 max-w-full overflow-y-auto">
      <ul>{notifications.map(item => <li key={item.notification_key} className="border-t border-slate-800 py-2">
        <Link href={`/work-orders/${encodeURIComponent(item.work_order_id)}`} onClick={() => { void read([item.notification_key]); setOpen(false); }} className="text-sky-200 hover:underline">{formatWorkOrderNotification(item)}</Link>
      </li>)}</ul>
      <button type="button" onClick={() => void read(notifications.map(item => item.notification_key))} className="text-xs underline">Mark mentions read</button>
    </div>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </aside>;
}
