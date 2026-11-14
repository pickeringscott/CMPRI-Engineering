"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import DashboardNotificationBell from "./DashboardNotificationBell";
import { getValidSession } from "@/lib/supabase/client";
import { subscribeResources } from "@/lib/events/browser";
import { fetchDashboardInbox, markServerDashboardNotificationsRead, unreadWorkOrderNotificationCount, type WorkOrderNotification } from "@/lib/dashboard/work-order-notifications";

/** Roles landing on submission/profile pages retain the same personal inbox. */
export default function ProfileNotificationInbox() {
  const path = usePathname();
  const ownedByDashboard = ["/engineering", "/front-desk", "/technician"].includes(path);
  // Ticket and notebook views use the dashboard inbox; floating controls obscure editing.
  const hideInbox = ownedByDashboard || path.startsWith("/work-orders/") || path === "/notes";
  const [signedIn, setSignedIn] = useState(false);
  const [items, setItems] = useState<WorkOrderNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (hideInbox || window.self !== window.top) return;
    let active = true;
    const stop = subscribeResources(["inbox", "session"], async () => {
      try {
        const session = await getValidSession();
        if (!session) { if (active) { setSignedIn(false); setItems([]); } return; }
        if (active) setSignedIn(true);
        const result = await fetchDashboardInbox(session.access_token);
        if (active) { setSignedIn(true); setItems(result.notifications); setError(""); }
      } catch { if (active) setError("Notifications could not be loaded."); }
    });
    return () => { active = false; stop(); };
  }, [hideInbox]);
  if (hideInbox || !signedIn) return null;
  const count = unreadWorkOrderNotificationCount(items);
  async function markRead(item: WorkOrderNotification) {
    const session = await getValidSession();
    if (!session) return;
    try {
      await markServerDashboardNotificationsRead(session.access_token, [item.id]);
      setItems(current => current.map(row => row.id === item.id ? { ...row, is_read: true } : row));
    } catch { setError("The notification could not be marked read."); }
  }
  return <aside className="fixed bottom-3 left-3 z-[90] rounded-lg border border-slate-700 bg-slate-950 p-2 text-white" aria-label="Your notifications">
    <DashboardNotificationBell count={count} label={`${count} unread notifications`} title="Your notifications" onClick={() => setOpen(value => !value)} />
    {open && <div className="max-h-64 w-80 max-w-[calc(100vw-3rem)] overflow-y-auto text-sm">
      {!items.length && <p>No notifications.</p>}
      {items.map(item => <p key={item.id} className="border-t border-slate-700 py-2"><Link href={item.target_path || `/work-orders/${encodeURIComponent(item.work_order_id || "")}`} onClick={() => void markRead(item)}>{item.message}</Link></p>)}
      {error && <p role="alert">{error}</p>}
    </div>}
  </aside>;
}
