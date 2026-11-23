"use client";
import BeginnerGuide from "@/components/beginners-guide/BeginnerGuide";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { translateNotificationMessage } from "@/lib/i18n/notification-text";

import { subscribeResources } from "@/lib/events/browser";
import { HOTEL_ID } from "@/lib/constants";
import PoolStatus from "@/components/desktop/PoolStatus";
import WeatherUtilities from "@/components/desktop/WeatherUtilities";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { profileCanUseHoursTracker } from "@/lib/server/roles";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { signOutDevice } from "@/lib/supabase/client";
import { hasCapability, type CmpriClientSession } from "@/lib/auth/client-session";
import { canOpenEnseo, canOpenGss, canOpenRoomOperations, canOpenWeather } from "@/lib/dashboard/menu-access";
import { dashboardMenuGroups, WEATHER_MENU_PATH } from "@/lib/dashboard/menu-groups";
import { canUseWinterPreparedness } from "@/lib/winter-preparedness-access";
import { armWeatherWarningSound } from "@/lib/weather-warning-sound";
import { newlyAvailableTechnicianWork } from "@/lib/dashboard/technician-work-notifications";
import {
  fetchDashboardInbox,
  markServerDashboardNotificationsRead,
  unreadWorkOrderNotificationCount,
  type WorkOrderNotification,
} from "@/lib/dashboard/work-order-notifications";
import WorkOrderNotificationBanner from "@/components/WorkOrderNotificationBanner";
import DashboardNotificationBell from "@/components/DashboardNotificationBell";
import ApprovedDashboardMenus from "@/components/desktop/ApprovedDashboardMenus";

const SOUND_PREF_KEY = "cmpri:technician-work-sound:v1";
const WORK_ORDER_LIST_PATH = "/work-order-list";

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
  const { t, tt, locale } = useUiLanguage();
  const router = useRouter();
  const [orders, setOrders] = useState<AssignedWorkOrder[]>([]);
  const [newWorkQueue, setNewWorkQueue] = useState<AssignedWorkOrder[]>([]);
  const [menuSession, setMenuSession] = useState<CmpriClientSession | null>(null);
  const account = menuSession?.user;
  const [notificationError, setNotificationError] = useState("");
  const [notifications, setNotifications] = useState<WorkOrderNotification[]>([]);
  const [dashboardInbox, setDashboardInbox] = useState<WorkOrderNotification[]>([]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const loadingRef = useRef(false);
  const accountRef = useRef<CmpriClientSession | null>(null);
  const hasLoadedWorkRef = useRef(false);
  const knownOrdersRef = useRef<Map<string, string> | null>(null);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
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

  const refreshDashboardInbox = useCallback(async (accessToken: string) => {
    try {
      const result = await fetchDashboardInbox(accessToken);
      dashboardTokenRef.current = accessToken;
      const incoming = result.notifications.filter(item => item.is_read !== true && !seenNotificationIdsRef.current.has(item.id));
      result.notifications.forEach(item => seenNotificationIdsRef.current.add(item.id));
      setDashboardInbox(result.notifications);
      setNotifications(result.notifications.filter(item => item.is_read !== true && item.work_order_id !== null));
      if (incoming.length && hasLoadedWorkRef.current) playAlertTone();
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Dashboard notifications could not be loaded.");
    }
  }, [playAlertTone]);

  async function signOut() {
    window.dispatchEvent(new Event("cmpri-workspace-sign-out"));
    await signOutDevice();
    router.replace("/");
  }

  const loadAssignedWork = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const session = await getValidSession();
      if (!session) { accountRef.current = null; setMenuSession(null); setOrders([]); setDashboardInbox([]); setNotifications([]); throw new Error("Sign in again to load your technician dashboard."); }
      if (accountRef.current?.user.id !== session.user.id) {
        const accountResponse = await fetch("/api/session", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const accountPayload = await accountResponse.json().catch(() => ({}));
        if (!accountResponse.ok || !accountPayload.user) throw new Error(accountPayload.error || "Your account could not be loaded.");
        accountRef.current = accountPayload as CmpriClientSession;
        setMenuSession(accountRef.current);
      }
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
  }, [playAlertTone]);

  useEffect(() => {
    soundEnabledRef.current = readSoundPreference();
    setSoundEnabled(soundEnabledRef.current);
    const unsubscribe = subscribeResources(["orders", "rooms"], loadAssignedWork);
    return () => {
      unsubscribe();
      void audioContextRef.current?.close();
    };
  }, [loadAssignedWork]);


  useEffect(() => subscribeResources(["inbox"], async () => {
    const session = await getValidSession();
    if (!session) { setDashboardInbox([]); setNotifications([]); return; }
    await refreshDashboardInbox(session.access_token);
  }), [refreshDashboardInbox]);

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

  }

  async function toggleInbox() {
    const opening = !inboxOpen;
    setInboxOpen(opening);
    if (!opening) return;
    const unreadIds = dashboardInbox
      .filter((item) => item.is_read !== true)
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
    const roomTitle = order.room || t("No location");
    const issueText = order.issue || t("Work order");
    const statusText = order.status || "Open";
    const categoryText = order.category || "General";
    const priorityText = order.priority || "Medium";
    const dueLabel = order.due_by ? new Date(order.due_by).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }) : t("No due date");

    return (
      <Link key={order.id} href={`/work-orders/${encodeURIComponent(order.id)}`} className="grid gap-2 px-4 py-3 hover:bg-slate-800/50 md:grid-cols-[minmax(0,1fr)_minmax(22rem,auto)] md:items-center">
        <div>
          <h3 className="text-base font-semibold text-white">{roomTitle}</h3>
          <p className="mt-1 text-sm text-slate-300">{issueText}</p>
        </div>
        <div className="grid gap-1 text-xs text-slate-300 md:text-right">
          <p className="flex flex-wrap gap-x-3 gap-y-1 md:justify-end">
            <span className="font-medium text-slate-100">{t("Status → ")}{t(statusText)}</span>
            <span>{t("Category → ")}{t(categoryText)}</span>
            <span>{t("Severity/Priority → ")}{t(priorityText)}</span>
          </p>
          <p className="text-right text-slate-400">{t("Due Date → ")}{dueLabel}</p>
        </div>
      </Link>
    );
  }

  const canViewWorkOrders = hasCapability(menuSession, "view_work_orders");
  const menuActions = account ? [
    ...(canViewWorkOrders ? [{key:"work-order-list", label:"Work Order List"}] : []),
    {key:"/technician", label:"Technician Dashboard"},
    {key:"/staff-notes", label:"Staff Notes"},
    {key:"/notes", label:"Notes"},
    {key:"/engineering/room-ranking", label:"Room Ranker"},
    ...(hasCapability(menuSession, "view_pool_log") ? [{key:"/engineering/pool-log", label:"Pool Log"}] : []),
    ...(hasCapability(menuSession, "view_pm") ? [{key:"/engineering/preventive-maintenance", label:"Preventive Maintenance"}] : []),
    ...(canOpenRoomOperations(account) ? [{key:"/engineering/room-operations", label:"Daily Room Ops"}] : []),
    ...(canOpenGss(account) ? [{key:"/engineering/gss", label:"GSS Reports"}] : []),
    ...(hasCapability(menuSession, "view_locations") ? [{key:"/management/rooms", label:"Manage Locations"}] : []),
    ...(canOpenEnseo(account) ? [{key:"/engineering/enseo-assignments", label:"Enseo Assignments"}] : []),
    ...(canUseWinterPreparedness(account) ? [{key:"/engineering/winter-preparedness", label:"Winter Preparedness 2026"}] : []),
    ...(process.env.NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW === "1" && canOpenWeather(account) ? [{key:WEATHER_MENU_PATH, label:"Weather"}] : []),
    ...(profileCanUseHoursTracker(account) ? [{key:"/engineering/hours-tracker", label:"Hours Tracker"}] : []),
    {key:"sign-out", label:"Sign Out"},
  ] : [];
  const weatherAction = menuActions.find(action => action.key === WEATHER_MENU_PATH);
  function openDashboardWeather(event: React.MouseEvent<HTMLButtonElement>) {
    if (weatherAction) launchMenuAction(weatherAction, Date.now(), event.currentTarget);
  }

  function launchMenuAction(action: { key: string; label: string }, clickedAt: number, opener?: HTMLElement) {
    if (action.key === "sign-out") {
      void signOut();
      return;
    }
    if (action.key === "/technician") {
      const heading = document.getElementById("technician-assigned-work");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "center" });
      return;
    }
    let href = action.key;
    if (href === "work-order-list") href = WORK_ORDER_LIST_PATH;
    if (href === WEATHER_MENU_PATH) {
      void armWeatherWarningSound();
      href = `${WEATHER_MENU_PATH}?weather=open`;
    }
    window.dispatchEvent(new CustomEvent("cmpri-open-modal", { detail: { href, title: action.label, clickedAt, opener } }));
  }

  return (
    <main className="min-h-[100svh] bg-slate-950 text-white">
      {account && typeof window !== "undefined" && window.parent === window
        && new URLSearchParams(window.location.search).get("embedded") !== "1" && (
          <BeginnerGuide key={account.id + ":" + account.role} user={{
            id: account.id,
            name: account.name?.trim() || "",
            role: account.role,
          }} />
        )}
      <div className="mx-auto w-full px-1 pt-[8pt] pb-2 sm:px-2 lg:w-[66vw]">
        <header className="cmpri-dashboard-titlebar sticky top-0 flex flex-col gap-2 border-b border-slate-800 bg-slate-950/95 pt-2">
          <div className="cmpri-header-shelf">
            <div className="cmpri-header-identity">
              <h1 data-cmpri-menu-title="" className="flex items-center gap-1 text-[14pt] font-bold leading-none tracking-tight text-amber-300">{t("CMPRI Engineering ")}<DashboardNotificationBell count={unreadCount} label={t("{count} unread notifications", { count: unreadCount })} title={tt("Open notifications")} onClick={()=>void toggleInbox()}/></h1>
              <p data-dashboard-name className="mt-1 text-sm font-semibold">{account?.name?.trim() || t("Maintenance Technician")}</p>
              <p data-dashboard-role className="text-xs text-sky-200/90">{t("Maintenance Technician")}</p>
            </div>
            <WeatherUtilities onOpen={weatherAction ? openDashboardWeather : undefined}>
              <div className="cmpri-header-utilities"><PoolStatus controlOnly onOpen={event=>window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:'/pool',title:'Pool',opener:event.currentTarget}}))}/><button type="button" className="cmpri-header-create" onClick={event=>window.dispatchEvent(new CustomEvent('cmpri-open-modal',{detail:{href:'/work-orders',title:'Create Work Order',opener:event.currentTarget}}))}>{t("+ Work Order")}</button></div>
            </WeatherUtilities>
          </div>
          <nav aria-label={t("Open dashboard windows")} className="cmpri-dashboard-menu-rail w-full min-w-0">
            <ApprovedDashboardMenus anchored askEnabled userId={account?.id || ""} hotelId={menuSession?.hotelId || HOTEL_ID} groups={dashboardMenuGroups("technician", menuActions)} onLaunch={launchMenuAction} />
          </nav>
        </header>
        <div data-weather-desktop-bulletin-host className="relative z-20 w-full" />
        <div data-cmpri-technician-window-anchor data-can-view-work-orders={canViewWorkOrders} />

        {message && <p role="status" className="mt-4 rounded-lg border border-red-500/40 bg-red-950/30 p-3 text-sm text-red-100">{t(message)}</p>}
        {notificationError && <p role="status" className="mt-3 rounded-md border border-amber-400/40 bg-amber-950/25 p-2.5 text-sm text-amber-100">{t(notificationError)}</p>}
        {inboxOpen && <section aria-label={t("Work-order notifications")} className="mt-3 rounded-lg border border-sky-400/40 bg-sky-950/25 p-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-sky-100">{t("Active notifications · ")}{dashboardInbox.length}</h2>
            <button type="button" onClick={() => setInboxOpen(false)} className="rounded-md border border-sky-400/40 px-2.5 py-1 text-xs font-semibold text-sky-100">{t("Close")}</button>
          </div>
          {dashboardInbox.length ? <ul className="mt-2 divide-y divide-sky-400/20">
            {dashboardInbox.map((notification) => (
              <li key={notification.id}>
                <Link href={notification.target_path || (notification.work_order_id ? `/work-orders/${encodeURIComponent(notification.work_order_id)}` : "/technician")} className="block py-2 text-sm text-sky-100 hover:underline">
                  {translateNotificationMessage(notification.message, t)}
                  {notification.is_read === true && <span className="ml-2 text-xs text-slate-400">{t("Read")}</span>}
                </Link>
              </li>
            ))}
          </ul> : <p className="mt-2 text-sm text-slate-300">{t("No active notifications.")}</p>}
        </section>}
        <div id="technician-notifications">
          <WorkOrderNotificationBanner
            notifications={notifications}
            onDismiss={dismissNotifications}
            dismissLabel={t("Dismiss my alerts")}
          />
        </div>

        {newWorkQueue.length > 0 && (
          <section role="alert" aria-live="assertive" className="mt-4 rounded-lg border border-emerald-400/50 bg-emerald-950/25 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-bold text-emerald-100">
                {newWorkQueue.length === 1 ? t("{count} new work item available", { count: newWorkQueue.length }) : t("{count} new work items available", { count: newWorkQueue.length })}</p>
              <div className="flex gap-2">
                <button type="button" onClick={toggleSound} aria-pressed={soundEnabled} className="rounded-lg border border-emerald-400/50 px-3 py-1.5 text-xs font-semibold text-emerald-100">{t("Sound ")}{soundEnabled ? t("on") : t("off")}
                </button>
                <button type="button" onClick={dismissNewWork} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200">{t("Dismiss")}</button>
              </div>
            </div>
            <ul className="mt-3 divide-y divide-emerald-500/20 overflow-hidden rounded-lg border border-emerald-500/25 bg-slate-950/60">
              {newWorkQueue.slice(0, 6).map((order) => (
                <li key={order.id}>
                  <Link href={`/work-orders/${encodeURIComponent(order.id)}`} onClick={() => setNewWorkQueue((existing) => existing.filter((item) => item.id !== order.id))} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-emerald-950/40">
                    <span className="min-w-0 text-sm text-white">{order.room || t("No location")} · {order.issue || t("Work order")}</span>
                    <span className="rounded-full border border-emerald-400/50 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                      {order.technician_name?.trim() ? t("Assigned to you") : t("Unassigned coverage")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 id="technician-assigned-work" tabIndex={-1} className="text-xl font-bold">{t("Assigned Work")}</h2>
            <span className="text-sm text-slate-400">{assignedOrders.length}{t(" active")}</span>
          </div>
          {loading ? <p className="p-5 text-slate-400">{t("Loading assigned work…")}</p> : assignedOrders.length === 0 ? (
            <p className="p-5 text-slate-400">{t("No active work is assigned to you.")}</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {assignedOrders.map(renderWorkOrder)}
            </div>
          )}
        </section>

        <section className="mt-4 rounded-lg border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="text-xl font-bold">{t("Unassigned Coverage")}</h2>
            <span className="text-sm text-slate-400">{unassignedOrders.length}{t(" available")}</span>
          </div>
          {loading ? <p className="p-5 text-slate-400">{t("Loading unassigned work…")}</p> : unassignedOrders.length === 0 ? (
            <p className="p-5 text-slate-400">{t("No unassigned work is available.")}</p>
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
