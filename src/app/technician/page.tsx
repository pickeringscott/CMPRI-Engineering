"use client";
import PoolStatus from "@/components/desktop/PoolStatus";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { profileCanUseHoursTracker } from "@/lib/server/roles";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { signOutDevice } from "@/lib/supabase/client";
import type { CmpriClientSession } from "@/lib/auth/client-session";
import { newlyAvailableTechnicianWork } from "@/lib/dashboard/technician-work-notifications";
import {
  fetchWorkOrderNotifications,
  mergeWorkOrderNotifications,
  readWorkOrderNotificationCursor,
  fetchDashboardInbox,
  markServerDashboardNotificationsRead,
  unreadWorkOrderNotificationCount,
  saveWorkOrderNotificationCursor,
  unseenWorkOrderNotifications,
  type WorkOrderNotification,
} from "@/lib/dashboard/work-order-notifications";
import WorkOrderNotificationBanner from "@/components/WorkOrderNotificationBanner";
import DashboardNotificationBell from "@/components/DashboardNotificationBell";
import { roomRankerProfileCanView } from "@/lib/room-ranker-access";

const REFRESH_MS = 30_000;
const SOUND_PREF_KEY = "cmpri:technician-work-sound:v1";

type AssignedWorkOrder = {
  id: string;
  display_id: string;
  room: string | null;
  asset_name: string | null;
  category: string | null;
  issue: string | null;
  priority: string | null;
  technician_name: string | null;
  status: string | null;
  due_by: string | null;
};

function readSoundPreference() {
  try {
    return window.localStorage.getItem(SOUND_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export default function TechnicianDashboard() {
  const router = useRouter();
  const [orders, setOrders] = useState<AssignedWorkOrder[]>([]);
  const [newWorkQueue, setNewWorkQueue] = useState<AssignedWorkOrder[]>([]);
  const [account, setAccount] = useState<CmpriClientSession["user"] | null>(null);
  const [notificationError, setNotificationError] = useState("");
  const [notifications, setNotifications] = useState<WorkOrderNotification[]>([]);
  const [dashboardInbox, setDashboardInbox] = useState<WorkOrderNotification[]>([]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const loadingRef = useRef(false);
  const hasLoadedWorkRef = useRef(false);
  const knownOrdersRef = useRef<Map<string, string> | null>(null);
  const notificationCursorRef = useRef<string | null>(null);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
  const pendingNotificationIdsRef = useRef<Set<string>>(new Set());
  const dashboardTokenRef = useRef("");
  const soundEnabledRef = useRef(true);
  const audioContextRef = useRef<AudioContext | null>(null);

  const playAlertTone = useCallback(() => {
    if (!soundEnabledRef.current) return;
    try {
      if (!audioContextRef.current) audioContextRef.current = new AudioContext();
      const context = audioContextRef.current;
      if (context.state === "suspended") void context.resume();
      const now = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.55);
      gain.connect(context.destination);
      [880, 1320].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, now + index * 0.22);
        oscillator.connect(gain);
        oscillator.start(now + index * 0.22);
        oscillator.stop(now + index * 0.22 + 0.2);
      });
    } catch {}
  }, []);

  const refreshNotifications = useCallback(async (accessToken: string, userId: string) => {
    try {
      const cursor = notificationCursorRef.current || readWorkOrderNotificationCursor(userId, "technician");
      const result = await fetchWorkOrderNotifications(accessToken, cursor);
      notificationCursorRef.current = result.checked_at;
      const unseen = unseenWorkOrderNotifications(seenNotificationIdsRef.current, result.notifications);
      if (unseen.length) {
        unseen.forEach((notification) => pendingNotificationIdsRef.current.add(notification.id));
        setNotifications((existing) => mergeWorkOrderNotifications(existing, unseen));
        playAlertTone();
      }
      if (!result.notifications.length && pendingNotificationIdsRef.current.size === 0) {
        saveWorkOrderNotificationCursor(userId, "technician", result.checked_at);
      }
      setNotificationError("");
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Work-order notifications could not be loaded.");
    }
  }, [playAlertTone]);

  const refreshDashboardInbox = useCallback(async (accessToken: string) => {
    try {
      const result = await fetchDashboardInbox(accessToken);
      dashboardTokenRef.current = accessToken;
      setDashboardInbox(result.notifications);
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Dashboard notifications could not be loaded.");
    }
  }, []);

  async function signOut() {
    await signOutDevice();
    router.replace("/");
  }

  const loadAssignedWork = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const session = await getValidSession();
      if (!session) throw new Error("Sign in again to load your technician dashboard.");
      const accountResponse = await fetch("/api/session", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const accountPayload = await accountResponse.json().catch(() => ({}));
      if (!accountResponse.ok || !accountPayload.user) throw new Error(accountPayload.error || "Your account could not be loaded.");
      const currentAccount = accountPayload.user as CmpriClientSession["user"];
      setAccount(currentAccount);
      void refreshNotifications(session.access_token, currentAccount.id);
      void refreshDashboardInbox(session.access_token);
      const response = await fetch("/api/work-orders?mode=technician", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Assigned work could not be loaded.");
      const fetched = (payload.work_orders || []) as AssignedWorkOrder[];
      const arrivals = newlyAvailableTechnicianWork(knownOrdersRef.current, fetched);
      if (arrivals.length) {
        setNewWorkQueue((existing) => Array.from(new Map(
          [...existing, ...arrivals].map((order) => [order.id, order]),
        ).values()));
        playAlertTone();
      }
      knownOrdersRef.current = new Map(fetched.map((order) => [order.id, order.technician_name?.trim() || ""]));
      setOrders(fetched);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Assigned work could not be loaded.");
    } finally {
      if (!hasLoadedWorkRef.current) setLoading(false);
      hasLoadedWorkRef.current = true;
      loadingRef.current = false;
    }
  }, [playAlertTone, refreshDashboardInbox, refreshNotifications]);

  useEffect(() => {
    soundEnabledRef.current = readSoundPreference();
    setSoundEnabled(soundEnabledRef.current);
    void loadAssignedWork();
    const interval = window.setInterval(() => { void loadAssignedWork(); }, REFRESH_MS);
    return () => {
      window.clearInterval(interval);
      void audioContextRef.current?.close();
    };
  }, [loadAssignedWork]);

  function toggleSound() {
    const next = !soundEnabledRef.current;
    soundEnabledRef.current = next;
    setSoundEnabled(next);
    try {
      window.localStorage.setItem(SOUND_PREF_KEY, next ? "on" : "off");
    } catch {}
    if (next) playAlertTone();
  }

  function dismissNewWork() {
    setNewWorkQueue([]);
  }

  function dismissNotifications() {
    setNotifications([]);
    pendingNotificationIdsRef.current.clear();
    if (account?.id && notificationCursorRef.current) {
      saveWorkOrderNotificationCursor(account.id, "technician", notificationCursorRef.current);
    }
  }

  async function toggleInbox() {
    const opening = !inboxOpen;
    setInboxOpen(opening);
    if (!opening) return;
    const unreadIds = dashboardInbox
      .filter((item) => item.work_order_id === null && item.is_read !== true)
      .map((item) => item.id);
    if (!unreadIds.length || !dashboardTokenRef.current) return;
    try {
      await markServerDashboardNotificationsRead(dashboardTokenRef.current, unreadIds);
      setDashboardInbox((current) => current.map((item) => unreadIds.includes(item.id) ? { ...item, is_read: true } : item));
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Notifications could not be marked read.");
    }
  }

  const assignedOrders = orders.filter((order) => !!order.technician_name?.trim());
  const unassignedOrders = orders.filter((order) => !order.technician_name?.trim());
  const unreadCount = unreadWorkOrderNotificationCount(dashboardInbox);

  function renderWorkOrder(order: AssignedWorkOrder) {
    const roomTitle = order.room || "No location";
    const issueText = order.issue || "Work order";
    const statusText = order.status || "Open";
    const categoryText = order.category || "General";
    const priorityText = order.priority || "Medium";
    const dueLabel = order.due_by ? new Date(order.due_by).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "No due date";

    return (
      <Link key={order.id} href={`/work-orders/${encodeURIComponent(order.id)}`} className="grid gap-2 px-4 py-3 hover:bg-slate-800/50 md:grid-cols-[minmax(0,1fr)_minmax(22rem,auto)] md:items-center">
        <div>
          <h3 className="text-base font-semibold text-white">{roomTitle}</h3>
          <p className="mt-1 text-sm text-slate-300">{issueText}</p>
        </div>
        <div className="grid gap-1 text-xs text-slate-300 md:text-right">
          <p className="flex flex-wrap gap-x-3 gap-y-1 md:justify-end">
            <span className="font-medium text-slate-100">Status → {statusText}</span>
            <span>Category → {categoryText}</span>
            <span>Severity/Priority → {priorityText}</span>
          </p>
          <p className="text-right text-slate-400">Due Date → {dueLabel}</p>
        </div>
      </Link>
    );
  }

  return (
    <main className="min-h-[100svh] bg-slate-950 text-white">
      <div className="mx-auto w-full px-1 pt-[8pt] pb-2 sm:px-2 lg:w-[66vw]">
        <div className="sticky top-0 z-20 flex flex-col gap-3 border-b border-slate-800 bg-slate-950/95 pb-3 pt-1 backdrop-blur sm:static sm:flex-row sm:items-center sm:justify-between sm:bg-transparent sm:pt-0 sm:backdrop-blur-0">
          <div className="flex w-full min-w-0 items-center gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-[14pt] font-bold leading-none tracking-tight"><span className="text-amber-300">CMPRI</span>{" "}<span className="text-amber-300">Engineering</span></h1>
              <div className="mt-2 flex items-center gap-2">
                <p className="text-[14pt] font-semibold tracking-tight text-slate-100">{account?.name?.trim() || account?.role || "Maintenance Technician"}</p>
                {notifications.length > 0 && <DashboardNotificationBell
                  count={notifications.length}
                  label={`${notifications.length} work-order update${notifications.length === 1 ? "" : "s"}`}
                  title="Go to work-order updates"
                  onClick={() => document.getElementById("technician-notifications")?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
                />}
                {dashboardInbox.length > 0 && <DashboardNotificationBell
                  count={unreadCount}
                  label={`${unreadCount} unread active notification${unreadCount === 1 ? "" : "s"}`}
                  title="Open active work-order notifications"
                  onClick={() => void toggleInbox()}
                />}
              </div>
              <p className="mt-1 text-[9pt] font-medium text-sky-200/90">Maintenance Technician</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">
              <span>Assigned Work</span>
              <span className="text-slate-500">•</span>
              <span>Unassigned Work Available for Coverage</span>
            </div>
            </div>
            <div className="sm:hidden"><PoolStatus controlOnly/></div><Link href="/work-orders" className="ml-auto min-h-10 shrink-0 rounded-full border border-amber-400/60 bg-amber-500 px-3 py-2 text-xs font-bold text-slate-950 shadow-sm sm:hidden">Create Work Order</Link>
          <div className="hidden flex-wrap items-center justify-end gap-2 sm:flex">
            <button type="button" onClick={() => void loadAssignedWork()} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2 text-[9pt] font-bold text-slate-200 disabled:opacity-50">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/pool-log" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-4 py-2 text-[9pt] font-bold text-cyan-100 hover:bg-cyan-900/40">Pool Log</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/staff-notes" className="rounded-lg border border-amber-400/50 bg-slate-900 px-3 py-2 text-xs font-bold text-amber-300">Staff Notes</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/preventive-maintenance" className="rounded-lg border border-emerald-400/50 bg-emerald-950/30 px-4 py-2 text-[9pt] font-bold text-emerald-100 hover:bg-emerald-900/40">Preventive Maintenance</button>
            <PoolStatus controlOnly/><Link href="/pool" className="rounded border border-cyan-400/50 px-3 py-2 text-xs">Pool</Link><Link href="/work-orders" className="rounded-full border border-slate-600 bg-slate-800 px-4 py-2 text-[9pt] font-bold text-slate-100 hover:bg-slate-700">Create a Work Order</Link>
            <button type="button" onClick={() => void signOut()} className="rounded-lg border border-red-400/50 bg-red-950/30 px-4 py-2 text-[9pt] font-bold text-red-100 hover:bg-red-900/40">Sign Out</button>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:hidden">
            <button type="button" onClick={() => void loadAssignedWork()} disabled={loading} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-200 disabled:opacity-50">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/pool-log" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-3 py-2 text-xs font-bold text-cyan-100 hover:bg-cyan-900/40">Pool Log</button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/preventive-maintenance" className="rounded-lg border border-emerald-400/50 bg-emerald-950/30 px-3 py-2 text-xs font-bold text-emerald-100 hover:bg-emerald-900/40">Preventive Maintenance</button>
            <button type="button" onClick={() => void signOut()} className="rounded-lg border border-red-400/50 bg-red-950/30 px-3 py-2 text-xs font-bold text-red-100 hover:bg-red-900/40">Sign Out</button>
          </div>
          {account && profileCanUseHoursTracker(account) && (
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/hours-tracker" className="rounded-lg border border-amber-400/50 bg-slate-900 px-3 py-2 text-xs font-bold text-amber-300">Hours Tracker</button>
          )}
          <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/room-ranking" className="rounded-lg border border-amber-400/50 bg-slate-900 px-3 py-2 text-xs font-bold text-amber-300">Room Ranker</button>
          {account && roomRankerProfileCanView(account, account.email) && (
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/room-ranker" className="rounded-lg border border-amber-400/50 bg-amber-950/30 px-3 py-2 text-xs font-bold text-amber-100 hover:bg-amber-900/40">Room Ranker old</button>
          )}
        </div>

        <Link href="/engineering" className="mt-2 inline-flex rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200">All Work Orders</Link>
        {message && <p role="status" className="mt-4 rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-100">{message}</p>}
        {notificationError && <p role="status" className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/25 p-2.5 text-sm text-amber-100">{notificationError}</p>}
        {inboxOpen && <section aria-label="Work-order notifications" className="mt-3 rounded-lg border border-sky-400/40 bg-sky-950/25 p-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-sky-100">Active notifications · {dashboardInbox.length}</h2>
            <button type="button" onClick={() => setInboxOpen(false)} className="rounded-md border border-sky-400/40 px-2.5 py-1 text-xs font-semibold text-sky-100">Close</button>
          </div>
          {dashboardInbox.length ? <ul className="mt-2 divide-y divide-sky-400/20">
            {dashboardInbox.map((notification) => (
              <li key={notification.id}>
                <Link href={notification.target_path || (notification.work_order_id ? `/work-orders/${encodeURIComponent(notification.work_order_id)}` : "/technician")} className="block py-2 text-sm text-sky-100 hover:underline">
                  {notification.message}
                  {notification.is_read === true && <span className="ml-2 text-xs text-slate-400">Read</span>}
                </Link>
              </li>
            ))}
          </ul> : <p className="mt-2 text-sm text-slate-300">No active notifications.</p>}
        </section>}
        <div id="technician-notifications">
          <WorkOrderNotificationBanner
            notifications={notifications}
            onDismiss={dismissNotifications}
            dismissLabel="Dismiss my alerts"
          />
        </div>

        {newWorkQueue.length > 0 && (
          <section role="alert" aria-live="assertive" className="mt-4 rounded-lg border border-emerald-400/50 bg-emerald-950/25 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-bold text-emerald-100">
                {newWorkQueue.length} new work item{newWorkQueue.length === 1 ? "" : "s"} available
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={toggleSound} aria-pressed={soundEnabled} className="rounded-lg border border-emerald-400/50 px-3 py-1.5 text-xs font-semibold text-emerald-100">
                  Sound {soundEnabled ? "on" : "off"}
                </button>
                <button type="button" onClick={dismissNewWork} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200">
                  Dismiss
                </button>
              </div>
            </div>
            <ul className="mt-3 divide-y divide-emerald-500/20 overflow-hidden rounded-lg border border-emerald-500/25 bg-slate-950/60">
              {newWorkQueue.slice(0, 6).map((order) => (
                <li key={order.id}>
                  <Link href={`/work-orders/${encodeURIComponent(order.id)}`} onClick={() => setNewWorkQueue((existing) => existing.filter((item) => item.id !== order.id))} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-emerald-950/40">
                    <span className="min-w-0 text-sm text-white">{order.room || "No location"} · {order.issue || "Work order"}</span>
                    <span className="rounded-full border border-emerald-400/50 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                      {order.technician_name?.trim() ? "Assigned to you" : "Unassigned coverage"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="text-xl font-bold">Assigned Work</h2>
            <span className="text-sm text-slate-400">{assignedOrders.length} active</span>
          </div>
          {loading ? <p className="p-5 text-slate-400">Loading assigned work…</p> : assignedOrders.length === 0 ? (
            <p className="p-5 text-slate-400">No active work is assigned to you.</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {assignedOrders.map(renderWorkOrder)}
            </div>
          )}
        </section>

        <section className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="text-xl font-bold">Unassigned Coverage</h2>
            <span className="text-sm text-slate-400">{unassignedOrders.length} available</span>
          </div>
          {loading ? <p className="p-5 text-slate-400">Loading unassigned work…</p> : unassignedOrders.length === 0 ? (
            <p className="p-5 text-slate-400">No unassigned work is available.</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {unassignedOrders.map(renderWorkOrder)}
            </div>
          )}
        </section>

      </div>
    </main>
  );
}
