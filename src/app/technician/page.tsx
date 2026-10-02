"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { signOutDevice } from "@/lib/supabase/client";
import type { CmpriClientSession } from "@/lib/auth/client-session";
import { newlyAvailableTechnicianWork } from "@/lib/dashboard/technician-work-notifications";
import {
  fetchWorkOrderNotifications,
  mergeWorkOrderNotifications,
  readWorkOrderNotificationCursor,
  saveWorkOrderNotificationCursor,
  unseenWorkOrderNotifications,
  type WorkOrderNotification,
} from "@/lib/dashboard/work-order-notifications";
import WorkOrderNotificationBanner from "@/components/WorkOrderNotificationBanner";
import DashboardNotificationBell from "@/components/DashboardNotificationBell";

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
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [notificationError, setNotificationError] = useState("");
  const [notifications, setNotifications] = useState<WorkOrderNotification[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const loadingRef = useRef(false);
  const knownOrdersRef = useRef<Map<string, string> | null>(null);
  const soundEnabledRef = useRef(true);
  const audioContextRef = useRef<AudioContext | null>(null);
  const notificationCursorRef = useRef<string | null>(null);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
  const pendingNotificationIdsRef = useRef<Set<string>>(new Set());
  const notificationCount = notifications.length;

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

  async function signOut() {
    await signOutDevice();
    router.replace("/");
  }

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

  const loadAssignedWork = useCallback(async (silent = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    setMessage("");
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Assigned work could not be loaded.");
    } finally {
      if (!silent) setLoading(false);
      loadingRef.current = false;
    }
  }, [playAlertTone, refreshNotifications]);

  useEffect(() => {
    soundEnabledRef.current = readSoundPreference();
    setSoundEnabled(soundEnabledRef.current);
    void loadAssignedWork();
    const interval = window.setInterval(() => { void loadAssignedWork(true); }, REFRESH_MS);
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

  const assignedOrders = orders.filter((order) => !!order.technician_name?.trim());
  const unassignedOrders = orders.filter((order) => !order.technician_name?.trim());

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
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto w-full px-1 pt-[8pt] pb-2 sm:px-2 lg:w-[66vw]">
        <div className="flex flex-col gap-3 border-b border-slate-800 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-[14pt] font-bold leading-none tracking-tight"><span className="text-amber-300">CMPRI</span>{" "}<span className="text-amber-300">Engineering</span></h1>
              <div className="mt-2 flex items-center gap-2">
                <p className="text-[14pt] font-semibold tracking-tight text-slate-100">{account?.name?.trim() || account?.role || "Maintenance Technician"}</p>
                {notificationCount > 0 && (
                  <DashboardNotificationBell
                    count={notificationCount}
                    label={`${notificationCount} work-order notification${notificationCount === 1 ? "" : "s"}`}
                    title="Go to work-order notifications"
                    onClick={() => document.getElementById("technician-notifications")?.scrollIntoView({ behavior: "smooth", block: "nearest" })}
                  />
                )}
              </div>
              <p className="mt-1 text-[9pt] font-medium text-sky-200/90">Maintenance Technician</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">
              <span>Assigned Work</span>
              <span className="text-slate-500">•</span>
              <span>Unassigned Work Available for Coverage</span>
            </div>
          </div>
          <div className="hidden flex-wrap items-center justify-end gap-2 sm:flex">
            <button type="button" onClick={() => void loadAssignedWork()} disabled={loading} className="rounded-lg border border-slate-700 px-4 py-2 text-[9pt] font-bold text-slate-200 disabled:opacity-50">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/pool-log" className="rounded-lg border border-cyan-400/50 bg-cyan-950/30 px-4 py-2 text-[9pt] font-bold text-cyan-100 hover:bg-cyan-900/40">Pool Log</button>
            <Link href="/work-orders" className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-[9pt] font-bold text-slate-100 hover:bg-slate-700">Create a Work Order</Link>
            <button type="button" onClick={() => void signOut()} className="rounded-lg border border-red-400/50 bg-red-950/30 px-4 py-2 text-[9pt] font-bold text-red-100 hover:bg-red-900/40">Sign Out</button>
          </div>
          <details className="relative ml-auto sm:hidden">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300">
              Actions <span aria-hidden="true" className="text-slate-400">⌄</span>
            </summary>
            <div role="group" aria-label="Technician dashboard actions" className="absolute right-0 top-full z-50 mt-1 flex min-w-max flex-col gap-1 rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl shadow-black/50">
              <button type="button" onClick={(event) => { void loadAssignedWork(); event.currentTarget.closest("details")?.removeAttribute("open"); }} disabled={loading} className="rounded-md px-3 py-2 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50">
                {loading ? "Refreshing…" : "Refresh"}
              </button>
              <button type="button" data-cmpri-modal-trigger="true" data-cmpri-modal-href="/engineering/pool-log" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")} className="rounded-md px-3 py-2 text-left text-sm font-semibold text-cyan-100 hover:bg-slate-800">Pool Log</button>
              <Link href="/work-orders" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")} className="rounded-md px-3 py-2 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800">Create a Work Order</Link>
              <button type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); void signOut(); }} className="rounded-md px-3 py-2 text-left text-sm font-semibold text-red-200 hover:bg-slate-800">Sign Out</button>
            </div>
          </details>
        </div>

        {notificationError && <p role="status" className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/25 p-2.5 text-sm text-amber-100">{notificationError}</p>}
        <div id="technician-notifications">
          <WorkOrderNotificationBanner
            notifications={notifications}
            onDismiss={dismissNotifications}
            dismissLabel="Dismiss my alerts"
          />
        </div>
        {message && <p role="status" className="mt-4 rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-100">{message}</p>}

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
