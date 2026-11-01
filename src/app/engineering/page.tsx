"use client";
import ThanksgivingBackground from "@/components/desktop/ThanksgivingBackground";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";
import { subscribeResource } from "@/lib/events/browser";
import { canReviewEmployment } from "@/lib/employment-access";
import { canUseWinterPreparedness } from "@/lib/winter-preparedness-access";
import {mergeConfirmedWorkOrder,reconcileWorkOrderList} from "@/lib/work-order-list-sync";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getValidSession, signOutDevice } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { usesChiefEngineerMobileLayout } from "@/lib/dashboard/chief-engineer-mobile";
import { accountRoleDisplayName, roleDisplayName } from "@/lib/account-display";
import {
  clearServerDashboardNotifications,
  forgetLocalDashboardInbox,
  importServerDashboardNotifications,
  readDashboardInbox,
  markServerDashboardNotificationsRead,
  unreadWorkOrderNotificationCount,
  type WorkOrderNotification,
} from "@/lib/dashboard/work-order-notifications";
import {
  COMPACT_DESKTOP_WIDTH,
  defaultWindowRect,
  desktopFrameHref,
  desktopWindowKeyForHref,
  isDesktopRoute,
  raiseWindow,
  readDesktopLayouts,
  saveDesktopLayout,
  windowLayoutKey,
  type DesktopBounds,
  type WindowRect,
  type WindowSize,
} from "@/lib/ui/desktop-windows";
import { profileCanUseHoursTracker, roleAllows, roleKey } from "@/lib/server/roles";
import { subscribeDashboardRefresh } from "@/lib/dashboard/browser-refresh";
import { parseDashboardInbox } from "@/lib/dashboard/work-order-notifications";
import PoolStatus from "@/components/desktop/PoolStatus";
import MobileDashboardMenus from "@/components/desktop/MobileDashboardMenus";
import DesktopWindow from "@/components/desktop/DesktopWindow";
import DesktopFrame from "@/components/desktop/DesktopFrame";
import DashboardNotificationBell from "@/components/DashboardNotificationBell";
import TroubleshootingGuideDropdown from "@/components/TroubleshootingGuideDropdown";
import WorkOrderListWindow, { isPendingApproval, type DesktopWorkOrder, type DesktopWorkOrderDraft } from "@/components/desktop/WorkOrderListWindow";
import WorkOrderApprovalsWindow from "@/components/desktop/WorkOrderApprovalsWindow";
import { canAccessTroubleshootingGuides, roomRankerProfileCanView } from "@/lib/room-ranker-access";
import { likelyDuplicate } from "@/lib/work-order-duplicates";


const NEW_ORDER_SOUND_PREF_KEY = "cmpri:new-order-sound:v1";
const LAUNCHER_CLOSE_WINDOW_MS = 5_000;
const WORK_ORDER_LIST_KEY = "work-order-list";
const APPROVALS_KEY = "work-order-approvals";
const DEFAULT_WINDOW_SIZE: WindowSize = { width: 1040, height: 720 };

type DesktopWindowEntry = {
  key: string;
  title: string;
  kind: "frame" | "list" | "approvals" | "pool-status";
  src?: string;
  accent: string;
  preferred: WindowSize;
};

type Launcher = {
  key: string;
  label: string;
  href?: string;
  action?: "work-order-list" | "sign-out";
  tone: string;
  accent: string;
  preferred?: WindowSize;
};

type LauncherGroup = { label: string; items: Array<Launcher | false> };

function DashboardLauncherButton({
  launcher,
  open,
  onLaunch,
  className,
}: {
  launcher: Launcher;
  open: boolean;
  onLaunch: (launcher: Launcher, clickedAt: number) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-cmpri-desktop-launch={launcher.key}
      data-open={open ? "true" : "false"}
      title={launcher.label}
      onClick={() => onLaunch(launcher, Date.now())}
      className={className || `cmpri-desktop-launch shrink-0 whitespace-nowrap rounded border px-1 py-0.5 font-semibold shadow-sm shadow-black/20 ${launcher.tone}`}
    >
      {launcher.label}
    </button>
  );
}

const ROUTE_WINDOWS: Record<string, { title: string; accent: string; preferred?: WindowSize }> = {
  "/engineering/room-ranking": { title: "Room Ranker", accent: "bg-amber-400", preferred: { width: 1900, height: 1000 } },
  "/engineering/room-ranker": { title: "Room Ranker old", accent: "bg-amber-400" },
  "/work-orders": { title: "Create Work Order", accent: "bg-slate-300", preferred: { width: 900, height: 760 } },
  "/profile": { title: "Manage Profile", accent: "bg-slate-300", preferred: { width: 880, height: 720 } },
  "/profile/ai-connection": { title: "ChatGPT Connection", accent: "bg-sky-400", preferred: { width: 760, height: 640 } },
  "/feedback": { title: "Feedback", accent: "bg-amber-500", preferred: { width: 860, height: 680 } },
};

function readSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(NEW_ORDER_SOUND_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSoundPreference(enabled: boolean) {
  try {
    window.localStorage.setItem(NEW_ORDER_SOUND_PREF_KEY, enabled ? "on" : "off");
  } catch {}
}

export default function EngineeringDashboardPage() {
  const router = useRouter();
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const [orders, setOrders] = useState<DesktopWorkOrder[]>([]);
  const [drafts, setDrafts] = useState<DesktopWorkOrderDraft[]>([]);
  const [cmpriSession, setCmpriSession] = useState<CmpriClientSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [chatgptConnected, setChatgptConnected] = useState(false);
  const [newFeedbackCount, setNewFeedbackCount] = useState(0);
  const [inbox, setInbox] = useState<WorkOrderNotification[]>([]);
  const [notificationError, setNotificationError] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(true);
  const userIdRef = useRef("");
  const userRoleRef = useRef("");
  const seenNotificationIdsRef = useRef<Set<string> | null>(null);
  const pendingClearIdsRef = useRef<Set<string>>(new Set());
  const pendingReadIdsRef = useRef<Set<string>>(new Set());
  const ordersVersionRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousTitleRef = useRef<string>("");

  const desktopRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<DesktopBounds>({ width: 0, height: 0 });
  const boundsRef = useRef<DesktopBounds>({ width: 0, height: 0 });
  const [windows, setWindows] = useState<DesktopWindowEntry[]>([]);
  const windowsRef = useRef<DesktopWindowEntry[]>([]);
  const [zOrder, setZOrder] = useState<string[]>([]);
  const [rects, setRects] = useState<Record<string, WindowRect>>({});
  const layoutsRef = useRef<Record<string, WindowRect>>({});
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const windowOpenedAtRef = useRef(new Map<string, number>());
  const pendingFocusRef = useRef("");
  const ordersRef = useRef<DesktopWorkOrder[]>([]);

  useEffect(() => { windowsRef.current = windows; }, [windows]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  // ---------- Notification inbox: items stay until this user clears them ----------

  const playAlertTone = useCallback(() => {
    if (!soundEnabledRef.current) return;
    try {
      const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      audioContextRef.current ??= new AudioCtor();
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + 0.55);
      gain.connect(ctx.destination);
      [880, 1320].forEach((frequency, index) => {
        const oscillator = ctx.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, now + index * 0.22);
        oscillator.connect(gain);
        oscillator.start(now + index * 0.22);
        oscillator.stop(now + index * 0.22 + 0.2);
      });
    } catch {}
  }, []);

  // The server inbox is the source of truth, so every computer shows the same list.
  const applyServerInbox = useCallback((notifications: WorkOrderNotification[]) => {
    const visible = notifications
      .filter((notification) => !pendingClearIdsRef.current.has(notification.id))
      .map((notification) => pendingReadIdsRef.current.has(notification.id) ? { ...notification, is_read: true } : notification);
    const seen = seenNotificationIdsRef.current;
    const arrived = seen !== null && visible.some((notification) => !seen.has(notification.id));
    seenNotificationIdsRef.current = new Set([...(seen || []), ...visible.map((notification) => notification.id)]);
    setInbox(visible);
    if (arrived) playAlertTone();
  }, [playAlertTone]);

  async function clearNotifications(ids: string[]) {
    if (ids.length === 0) return;
    const clearing = new Set(ids);
    ids.forEach((id) => pendingClearIdsRef.current.add(id));
    setInbox((current) => current.filter((notification) => !clearing.has(notification.id)));
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to clear notifications.");
      await clearServerDashboardNotifications(session.access_token, ids);
      setNotificationError("");
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Notifications could not be cleared.");
    } finally {
      // Successful writes invalidate any in-flight shared refresh before it can reapply stale rows.
      ids.forEach((id) => pendingClearIdsRef.current.delete(id));
    }
  }

  async function markNotificationRead(notification: WorkOrderNotification) {
    if (notification.is_read || pendingReadIdsRef.current.has(notification.id)) return;
    pendingReadIdsRef.current.add(notification.id);
    setInbox((current) => current.map((item) => item.id === notification.id ? { ...item, is_read: true } : item));
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to update notifications.");
      await markServerDashboardNotificationsRead(session.access_token, [notification.id]);
      setNotificationError("");
    } catch (error) {
      setInbox((current) => current.map((item) => item.id === notification.id ? { ...item, is_read: false } : item));
      setNotificationError(error instanceof Error ? error.message : "Notification could not be marked read.");
    } finally {
      pendingReadIdsRef.current.delete(notification.id);
    }
  }

  function toggleSound() {
    const next = !soundEnabledRef.current;
    soundEnabledRef.current = next;
    setSoundEnabled(next);
    writeSoundPreference(next);
    if (next) playAlertTone();
  }

  // ---------- Data loading ----------

  const loadDashboard = useCallback(async function refreshDashboard(silent = false, role?: string): Promise<void> {
    if (refreshInFlightRef.current) { refreshQueuedRef.current = true; return; }
    refreshInFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again to load the dashboard.");
      const response = await fetch("/api/work-orders", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.work_orders)) throw new Error(payload.error || "Dashboard work orders could not be loaded.");
      const fetched = payload.work_orders as DesktopWorkOrder[];
      setOrders(previous => reconcileWorkOrderList(previous,fetched));
      if (roleAllows(role || userRoleRef.current, "review_tickets")) {
        const draftResponse = await fetch("/api/work-orders/drafts?scope=review", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const draftPayload = await draftResponse.json().catch(() => ({}));
        if (!draftResponse.ok || !Array.isArray(draftPayload.drafts)) {
          throw new Error(draftPayload.error || "Pending drafts could not be loaded.");
        }
        setDrafts(draftPayload.drafts as DesktopWorkOrderDraft[]);
      } else {
        setDrafts([]);
      }
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? `Dashboard error: ${error.message}` : "Dashboard error.");
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) { refreshQueuedRef.current = false; void refreshDashboard(true, role); }
    }
  }, []);

  const refreshChatgptConnection = useCallback(async () => {
    try {
      const session = await getValidSession();
      if (!session?.access_token) return;
      const response = await fetch("/api/profile", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      setChatgptConnected(payload.chatgpt_connection?.connected === true);
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      const allowed = await enforceSessionPreference();
      if (!allowed) {
        window.location.replace("/");
        return;
      }
      let session: CmpriClientSession;
      try {
        session = await loadCmpriSession();
        {
          const dashboardPath = roleKey(session.user.role) === "front_desk" ? "/front-desk" : "/engineering";
          if (window.location.pathname !== dashboardPath) { window.location.replace(dashboardPath + window.location.search); return; }
        }
        if (!hasCapability(session, "view_dashboard")
          && !hasCapability(session, "view_work_orders")
          && !hasCapability(session, "view_pm")
          && !hasCapability(session, "receive_pool_closed_notifications")) {
          window.location.replace(session.landing);
          return;
        }
        userIdRef.current = session.user.id;
        userRoleRef.current = session.user.role;
        layoutsRef.current = readDesktopLayouts(window.localStorage, session.user.id);
        const soundPreference = readSoundPreference();
        soundEnabledRef.current = soundPreference;
        setSoundEnabled(soundPreference);
        setCmpriSession(session);
      } catch {
        window.location.replace("/");
        return;
      }
      await Promise.all([loadDashboard(false, session.user.role), refreshChatgptConnection()]);
    })();
  }, [loadDashboard, refreshChatgptConnection]);

  useEffect(() => {
    return subscribeResource("work-orders", () => { void loadDashboard(true); });
  }, [loadDashboard]);

  useEffect(() => {
    if (!cmpriSession || (!hasCapability(cmpriSession, "view_dashboard")
      && !hasCapability(cmpriSession, "receive_pool_closed_notifications"))) return;
    const userId = cmpriSession.user.id;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const start = async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token || session.user.id !== userId || !current) return;
        const local = readDashboardInbox(userId);
        if (local.length) await importServerDashboardNotifications(session.access_token, local);
        forgetLocalDashboardInbox(userId);
        if (!current) return;
        unsubscribe = subscribeDashboardRefresh("notifications", (event) => {
          if (event.reset) {
            ordersVersionRef.current = null;
            setInbox([]);
            setNotificationError(event.error || "");
            return;
          }
          try {
            if (event.error) throw new Error(event.error);
            const result = parseDashboardInbox(event.data);
            if (ordersVersionRef.current === null) ordersVersionRef.current = result.orders_version;
            else if (result.orders_version !== ordersVersionRef.current && !refreshInFlightRef.current) {
              ordersVersionRef.current = result.orders_version;
              void loadDashboard(true);
            }
            applyServerInbox(result.notifications);
            setNotificationError("");
          } catch (error) {
            setNotificationError(error instanceof Error ? error.message : "Notifications could not be loaded.");
          }
        }, userId);
      } catch (error) {
        if (current) {
          setNotificationError(error instanceof Error ? error.message : "Notifications could not be loaded.");
          retry = setTimeout(() => void start(), 1000);
        }
      }
    };
    void start();
    return () => { current = false; clearTimeout(retry); unsubscribe?.(); };
  }, [applyServerInbox, cmpriSession, loadDashboard]);

  useEffect(() => {
    if (!cmpriSession || !hasCapability(cmpriSession, "review_feedback")) return;
    let current = true;
    const refreshFeedbackCount = async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) return;
        const response = await fetch("/api/feedback?mode=count", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({}));
        if (current && response.ok && Number.isInteger(payload.count) && payload.count >= 0) setNewFeedbackCount(payload.count);
      } catch {}
    };
    void refreshFeedbackCount();
    const stop = subscribeResource("feedback", () => void refreshFeedbackCount());
    return () => { current = false; stop(); };
  }, [cmpriSession]);

  useEffect(() => {
    const baseTitle = roleKey(cmpriSession?.user.role) === "front_desk" || window.location.pathname === "/front-desk" ? "CMPRI Front Desk" : "CMPRI Engineering";
    previousTitleRef.current = baseTitle;
    document.title = inbox.length > 0 ? `(${inbox.length}) ${baseTitle}` : baseTitle;
    return () => { document.title = baseTitle; };
  }, [inbox.length, cmpriSession?.user.role]);

  // ---------- Window manager ----------

  useEffect(() => {
    const desktop = desktopRef.current;
    if (!desktop) return;
    const measure = () => {
      const next = { width: desktop.clientWidth, height: desktop.clientHeight };
      boundsRef.current = next;
      setBounds(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(desktop);
    return () => observer.disconnect();
  }, [cmpriSession]);

  const raise = useCallback((key: string, focus = false) => {
    if (focus) pendingFocusRef.current = key;
    setZOrder((current) => current.at(-1) === key ? current : raiseWindow(current, key));
  }, []);

  useEffect(() => {
    const key = pendingFocusRef.current;
    if (!key || zOrder.at(-1) !== key) return;
    pendingFocusRef.current = "";
    const frame = frameRefs.current.get(key);
    if (frame) frame.focus();
    else if (key === WORK_ORDER_LIST_KEY && (window.matchMedia("(pointer: coarse)").matches
      || window.innerWidth < COMPACT_DESKTOP_WIDTH)) {
      // Keep focus inside the list without opening a touch device's keyboard.
      desktopRef.current?.querySelector<HTMLElement>("[data-work-order-list-heading]")?.focus();
    }
    else desktopRef.current?.querySelector<HTMLElement>(`[data-cmpri-desktop-window="${CSS.escape(key)}"] .cmpri-desktop-window-body button, [data-cmpri-desktop-window="${CSS.escape(key)}"] .cmpri-desktop-window-body input`)?.focus();
  }, [zOrder, windows]);

  const openWindow = useCallback((entry: DesktopWindowEntry) => {
    if (windowsRef.current.some((existing) => existing.key === entry.key)) {
      raise(entry.key, true);
      return;
    }
    const saved = layoutsRef.current[windowLayoutKey(entry.key)];
    const rect = saved || defaultWindowRect(boundsRef.current, entry.preferred, windowsRef.current.length);
    windowsRef.current = [...windowsRef.current, entry];
    windowOpenedAtRef.current.set(entry.key, Date.now());
    setWindows(windowsRef.current);
    setRects((current) => ({ ...current, [entry.key]: rect }));
    raise(entry.key, true);
  }, [raise]);

  const closeWindow = useCallback((key: string) => {
    windowsRef.current = windowsRef.current.filter((entry) => entry.key !== key);
    windowOpenedAtRef.current.delete(key);
    setWindows(windowsRef.current);
    setZOrder((current) => current.filter((entry) => entry !== key));
    frameRefs.current.delete(key);
  }, []);

  const requestCloseWindow = useCallback((key: string) => {
    const frameDocument = frameRefs.current.get(key)?.contentDocument;
    if (!frameDocument) {
      closeWindow(key);
      return;
    }
    // Screens with unsaved work cancel this event and confirm before closing themselves.
    const cancelRequest = new Event("cmpri-modal-cancel-request", { cancelable: true });
    if (frameDocument.dispatchEvent(cancelRequest)) closeWindow(key);
  }, [closeWindow]);

  function commitRect(key: string, rect: WindowRect) {
    setRects((current) => ({ ...current, [key]: rect }));
    // Compact (phone-width) desktops force full-size windows; keep the remembered desktop layout.
    if (userIdRef.current && boundsRef.current.width >= COMPACT_DESKTOP_WIDTH) {
      layoutsRef.current = saveDesktopLayout(window.localStorage, userIdRef.current, windowLayoutKey(key), rect);
    }
  }

  const openRoute = useCallback((href: string, titleHint?: string, launcher?: Pick<Launcher, "accent" | "preferred" | "label">) => {
    const origin = window.location.origin;
    if (!isDesktopRoute(href, origin)) return;
    const key = desktopWindowKeyForHref(href, origin);
    if (key === "/engineering") return;
    const workOrderId = /^\/work-orders\/([^/]+)$/.exec(key)?.[1];
    const known = ROUTE_WINDOWS[key];
    let title = launcher?.label || known?.title || titleHint || key;
    if (workOrderId) {
      const order = ordersRef.current.find((entry) => entry.id === decodeURIComponent(workOrderId));
      title = `Work Order ${order?.display_id || ""}`.trim() + (order?.room ? ` · ${order.room}` : "");
      if (order) {
        try { window.sessionStorage.setItem(`cmpri:work-order-preview:${order.id}`, JSON.stringify(order)); } catch {}
      }
    }
    openWindow({
      key,
      title,
      kind: "frame",
      src: desktopFrameHref(href, crypto.randomUUID(), origin),
      accent: launcher?.accent || known?.accent || (workOrderId ? "bg-amber-400" : "bg-slate-400"),
      preferred: launcher?.preferred || known?.preferred || (workOrderId ? { width: 960, height: 780 } : DEFAULT_WINDOW_SIZE),
    });
  }, [openWindow]);

  const openWorkOrder = useCallback((workOrderId: string) => {
    openRoute(`/work-orders/${encodeURIComponent(workOrderId)}`);
  }, [openRoute]);

  const openDraft = useCallback((draftId: string) => {
    const origin = window.location.origin;
    openWindow({
      key: `work-order-draft:${draftId}`,
      title: "Review Work-Order Draft",
      kind: "frame",
      src: desktopFrameHref(`/work-orders?draftId=${encodeURIComponent(draftId)}&reviewDraft=1`, crypto.randomUUID(), origin),
      accent: "bg-amber-400",
      preferred: { width: 960, height: 780 },
    });
  }, [openWindow]);

  useEffect(() => {
    const handleWindowMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data.type !== "string") return;
      const key = Array.from(frameRefs.current).find(([, frame]) => frame.contentWindow === event.source)?.[0];
      if (!key) return;
      const data = event.data as { type: string; href?: unknown; title?: unknown; targetWorkOrderId?: unknown; assetId?: unknown; modalToken?: unknown; workOrder?: unknown; workOrderId?: unknown };
      if (data.type === "cmpri-work-order-loaded" || data.type === "cmpri-work-order-saved") {
        const source = windowsRef.current.find(entry => entry.key === key);
        if (!source?.src || new URL(source.src,window.location.origin).searchParams.get("modalToken") !== data.modalToken) return;
        const sourceId = /^\/work-orders\/([^/]+)$/.exec(key)?.[1];
        if (!sourceId || decodeURIComponent(sourceId) !== data.workOrderId) return;
        if (data.workOrder && typeof data.workOrder === 'object' && 'id' in data.workOrder && data.workOrder.id === data.workOrderId) setOrders(previous => mergeConfirmedWorkOrder(previous,data.workOrder));
        if (data.type === "cmpri-work-order-loaded") return;
      }
      switch (data.type) {
        case "cmpri-pm-work-orders-confirmed": {
          const source = windowsRef.current.find(entry => entry.key === key);
          if (key !== "/engineering/preventive-maintenance" || !source?.src) return;
          if (new URL(source.src, window.location.origin).searchParams.get("modalToken") !== data.modalToken) return;
          // PM can confirm several issues; refresh orders without dismissing its form.
          void loadDashboard(true);
          return;
        }
        case "cmpri-assets-changed": {
          const source = windowsRef.current.find(entry => entry.key === key);
          if (key !== "/management/equipment" || !source?.src || typeof data.assetId !== "string" || !data.assetId) return;
          if (new URL(source.src, window.location.origin).searchParams.get("modalToken") !== data.modalToken) return;
          for (const entry of windowsRef.current) {
            if (!entry.src) continue;
            const target = new URL(entry.src, window.location.origin);
            if (target.pathname !== "/work-orders") continue;
            frameRefs.current.get(entry.key)?.contentWindow?.postMessage({ type: "cmpri-assets-changed",
              assetId: data.assetId, modalToken: target.searchParams.get("modalToken") }, window.location.origin);
          }
          return;
        }
        case "cmpri-open-modal":
          if (typeof data.href === "string") openRoute(data.href, typeof data.title === "string" ? data.title : undefined);
          return;
        case "cmpri-open-related-work-order":
          if (typeof data.targetWorkOrderId === "string") openWorkOrder(data.targetWorkOrderId);
          return;
        case "cmpri-profile-ai-updated":
          closeWindow(key);
          frameRefs.current.get("/profile")?.contentWindow?.postMessage({ type: "cmpri-profile-ai-updated" }, window.location.origin);
          void refreshChatgptConnection();
          return;
        case "cmpri-modal-close":
        case "cmpri-modal-dashboard":
        case "cmpri-work-order-cancelled":
          closeWindow(key);
          return;
        case "cmpri-work-order-created":
        case "cmpri-work-order-saved":
        case "cmpri-work-order-deleted":
          closeWindow(key);
          void loadDashboard(true);
          return;
        case "cmpri-modal-sign-out":
          window.location.replace("/");
          return;
      }
    };
    window.addEventListener("message", handleWindowMessage);
    return () => window.removeEventListener("message", handleWindowMessage);
  }, [closeWindow, loadDashboard, openRoute, openWorkOrder, refreshChatgptConnection]);

  if (!cmpriSession) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-4 text-white" aria-busy="true">
        <p role="status" className="text-sm text-slate-300">Loading your authorized dashboard…</p>
      </main>
    );
  }

  const session = cmpriSession;
  const engineerDesktopMenus = roleKey(session.user.role) === "engineer" || session.user.secondary_roles?.some(role => roleKey(role) === "engineer");
  const frontDeskLayout = roleKey(session.user.role) === "front_desk";
  const chiefEngineerMobileLayout = usesChiefEngineerMobileLayout(session.user);
  const isHousekeepingDashboard = roleDisplayName(session.user.role) === "Lead Housekeeper";
  const canViewRanker = roomRankerProfileCanView(session.user, session.user.email);
  const canOpenTroubleshootingGuides = canAccessTroubleshootingGuides(session.user);
  const canUseEngineeringAdminTools = ["engineer", "system_admin"].includes(roleKey(session.user.role));
  const awaitingApproval = orders.filter(isPendingApproval);
  const displayName = session.user.name?.trim() || "Name not set";
  const displayRole = accountRoleDisplayName(session.user);

  async function signOut() {
    await signOutDevice();
    router.replace("/");
  }

  function openWorkOrderList() {
    openWindow({ key: WORK_ORDER_LIST_KEY, title: "Work Order List", kind: "list", accent: "bg-slate-300", preferred: { width: 1100, height: 640 } });
  }

  function openApprovals() {
    const canReviewTickets = hasCapability(cmpriSession, "review_tickets");
    inbox.forEach((notification) => {
      if (!notification.is_read) void markNotificationRead(notification);
    });
    openWindow({
      key: APPROVALS_KEY,
      title: canReviewTickets ? "Work Order Approvals" : "Work Order Notifications",
      kind: "approvals",
      accent: canReviewTickets ? "bg-purple-400" : "bg-sky-400",
      preferred: { width: 780, height: 540 },
    });
  }

  function openNotification(notification: WorkOrderNotification) {
    void markNotificationRead(notification);
    if (notification.target_path) openRoute(notification.target_path, "Daily Room Ops");
    else if (notification.work_order_id) openWorkOrder(notification.work_order_id);
  }

  const launcherGroups: LauncherGroup[] = [
    {
      label: "Work Orders",
      items: [
        hasCapability(session, "view_work_orders") && { key: WORK_ORDER_LIST_KEY, label: "Work Order List", action: "work-order-list", tone: "border-slate-600 bg-slate-800 text-slate-100", accent: "bg-slate-300" },
        roleKey(session.user.role) === "technician" && { key: "/technician", label: "Technician Dashboard", href: "/technician", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
        hasCapability(session, "submit") && { key: "/work-orders", label: "+ Create Work Order", href: "/work-orders", tone: "border-slate-600 bg-slate-800 text-slate-100", accent: "bg-slate-300", preferred: { width: 900, height: 760 } },
      ],
    },
    {
      label: "Operations",
      items: [
        canUseWinterPreparedness(session.user) && { key: "/engineering/winter-preparedness", label: "Winter Preparedness 2026", href: "/engineering/winter-preparedness", tone: "border-cyan-400/50 bg-cyan-950/30 text-cyan-100", accent: "bg-cyan-400", preferred: { width: 960, height: 780 } },
        canReviewEmployment(session.user,session.user) && { key: "/engineering/employment", label: "Candidate questionnaires", href: "/engineering/employment", tone: "border-yellow-400 bg-slate-900 text-yellow-300", accent: "bg-yellow-400", preferred: { width: 850, height: 700 } },
        { key: "/staff-notes", label: "Staff Notes", href: "/staff-notes", tone: "border-amber-400/50 bg-slate-900 text-amber-300", accent: "bg-amber-400" },
        (hasCapability(session, "view_dashboard") || hasCapability(session, "view_pool_log")) && { key: "/engineering/pool-log", label: "Pool Log", href: "/engineering/pool-log", tone: "border-cyan-400/50 bg-cyan-950/30 text-cyan-100", accent: "bg-cyan-400" },
        canUseEngineeringAdminTools && { key: "/engineering/room-operations", label: "Daily Room Ops", href: "/engineering/room-operations", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
        canUseEngineeringAdminTools && { key: "/engineering/gss", label: "GSS Reports", href: "/engineering/gss", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400", preferred: { width: 820, height: 600 } },
        canUseEngineeringAdminTools && { key: "/engineering/enseo-assignments", label: "Enseo Assignments", href: "/engineering/enseo-assignments", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
        { key: "/engineering/room-ranking", label: "Room Ranker", href: "/engineering/room-ranking", tone: "border-amber-400/50 bg-slate-900 text-amber-300", accent: "bg-amber-400", preferred: { width: 1900, height: 1000 } },
        canViewRanker && { key: "/engineering/room-ranker", label: "Room Ranker old", href: "/engineering/room-ranker", tone: "border-amber-400/50 bg-amber-950/30 text-amber-100", accent: "bg-amber-400" },
        hasCapability(session, "view_pm") && { key: "/engineering/preventive-maintenance", label: "Preventive Maintenance", href: "/engineering/preventive-maintenance", tone: "border-emerald-400/50 bg-emerald-950/30 text-emerald-100", accent: "bg-emerald-400", preferred: { width: 1200, height: 780 } },
      ],
    },
    {
      label: engineerDesktopMenus ? "Assets and Inventory" : "Assets & Supply",
      items: [
        hasCapability(session, "manage_assets") && { key: "/management/equipment", label: "Assets", href: "/management/equipment", tone: "border-cyan-400/50 bg-cyan-950/30 text-cyan-100", accent: "bg-cyan-400" },
        hasCapability(session, "manage_assets") && { key: "/engineering/parts", label: "Inventory", href: "/engineering/parts", tone: "border-amber-400/50 bg-amber-950/30 text-amber-100", accent: "bg-amber-400" },
        canUseEngineeringAdminTools && { key: "/engineering/purchasing", label: "POs", href: "/engineering/purchasing", tone: "border-orange-400/50 bg-orange-950/30 text-orange-100", accent: "bg-orange-400" },
      ],
    },
    {
      label: "Admin",
      items: [
        hasCapability(session, "manage_rooms") && { key: "/management/rooms", label: "Manage Rooms", href: "/management/rooms", tone: "border-indigo-400/50 bg-indigo-950/30 text-indigo-100", accent: "bg-indigo-400" },
        hasCapability(session, "manage_users") && { key: "/management/users", label: "Manage Users", href: "/management/users", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
        hasCapability(session, "review_feedback") && { key: "/feedback", label: `Feedback${newFeedbackCount > 0 ? ` (${newFeedbackCount})` : ""}`, href: `/feedback?route=${encodeURIComponent("/engineering")}`, tone: "border-amber-500/50 bg-amber-950/20 text-amber-100", accent: "bg-amber-500" },
      ],
    },
    {
      label: "Account",
      items: [
        (engineerDesktopMenus || profileCanUseHoursTracker(session.user)) && { key: "/engineering/hours-tracker", label: "Hours Tracker", href: "/engineering/hours-tracker", tone: "border-amber-400/50 bg-slate-900 text-amber-300", accent: "bg-amber-400", preferred: { width: 448, height: 310 } },
        hasCapability(session, "view_profiles") && { key: "/profile", label: "Manage Profile", href: "/profile", tone: "border-slate-600 bg-slate-800 text-slate-100", accent: "bg-slate-300", preferred: { width: 880, height: 720 } },
        hasCapability(session, "view_profiles") && !chatgptConnected && { key: "/profile", label: "Connect ChatGPT", href: "/profile", tone: "border-sky-500/50 bg-sky-950/30 text-sky-100", accent: "bg-slate-300", preferred: { width: 880, height: 720 } },
        { key: "sign-out", label: "Sign Out", action: "sign-out", tone: "border-red-400/50 bg-red-950/30 text-red-100", accent: "bg-red-400" },
      ],
    },
  ];
  function launchWindow(key: string, clickedAt: number, open: () => void) {
    const openedAt = windowOpenedAtRef.current.get(key);
    if (windowsRef.current.some((entry) => entry.key === key) && openedAt !== undefined && clickedAt - openedAt <= LAUNCHER_CLOSE_WINDOW_MS) {
      requestCloseWindow(key);
      return;
    }
    open();
  }

  function openPoolStatus() { openWindow({key:"pool-status",title:"Pool",kind:"pool-status",accent:"bg-green-400",preferred:{width:360,height:frontDeskLayout?230:300}}); }

  function launch(launcher: Launcher, clickedAt: number) {
    if (launcher.key === "pool-status") openPoolStatus();
    else if (launcher.action === "work-order-list") launchWindow(WORK_ORDER_LIST_KEY, clickedAt, openWorkOrderList);
    else if (launcher.action === "sign-out") void signOut();
    else if (launcher.href) {
      const href = launcher.href;
      const key = desktopWindowKeyForHref(href, window.location.origin);
      launchWindow(key, clickedAt, () => openRoute(href, launcher.label, { ...launcher, label: launcher.label.replace(/ \(\d+\)$/, "") }));
    }
  }

  {const operations=launcherGroups.find(g=>g.label==="Operations");operations?.items.push({key:"pool-status",label:"Pool",tone:"border-cyan-400/50 bg-cyan-950/30 text-cyan-100",accent:"bg-green-400"});}
  if (engineerDesktopMenus) {
    const work = launcherGroups.find(group => group.label === "Work Orders")!;
    const operations = launcherGroups.find(group => group.label === "Operations")!;
    const assets = launcherGroups.find(group => group.label === "Assets and Inventory")!;
    const admin = launcherGroups.find(group => group.label === "Admin")!;
    const account = launcherGroups.find(group => group.label === "Account")!;
    const rooms = admin.items.find(item => item && item.key === "/management/rooms");
    if (rooms) { admin.items = admin.items.filter(item => item !== rooms); operations.items.push(rooms); }
    const reorder = (group: LauncherGroup, keys: string[]) => {
      const present = group.items.filter((item): item is Launcher => Boolean(item));
      group.items = [...keys.flatMap(key => present.filter(item => item.key === key)), ...present.filter(item => !keys.includes(item.key))];
    };
    reorder(work, ["/work-orders", WORK_ORDER_LIST_KEY]);
    reorder(operations, ["/engineering/preventive-maintenance", "/engineering/room-operations", "/management/rooms", "/engineering/pool-log", "pool-status", "/engineering/room-ranking", "/engineering/gss", "/engineering/enseo-assignments", "/engineering/room-ranker", "/staff-notes"]);
    reorder(assets, ["/engineering/purchasing", "/engineering/parts", "/management/equipment"]);
    const tracker = account.items.find(item => item && item.key === "/engineering/hours-tracker");
    if (tracker) {
      account.items = account.items.filter(item => item !== tracker);
      const profileIndex = account.items.findIndex(item => item && item.label === "Manage Profile");
      account.items.splice(profileIndex + 1, 0, tracker);
    }
    for (const group of [work, operations, assets]) for (const item of group.items) {
      if (!item) continue;
      if (item.key === "/work-orders") item.label = "+ Create Work Order";
      if (item.key === "/engineering/preventive-maintenance") item.label = "Preventative Maintenance";
      if (item.key === "/engineering/room-ranker") item.label = "Room Ranker Old";
      if (item.key === "/engineering/purchasing") item.label = "PO";
    }
  }
  const frontDeskKeys = ["/engineering/employment","/engineering/room-ranking", WORK_ORDER_LIST_KEY, "pool-status", "/staff-notes", "/profile", "sign-out"];
  const presentationGroups = frontDeskLayout ? [{ label: "Front Desk", items: frontDeskKeys.map(key => launcherGroups.flatMap(group => group.items).find(item => item && item.key === key) || false) }] : launcherGroups;
  const visibleLauncherGroups = presentationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item): item is Launcher => Boolean(item)),
    }))
    .filter((group) => group.items.length > 0);
  const openKeys = new Set(windows.map((entry) => entry.key));
  const activeKey = zOrder.at(-1) || "";
  const canReviewTickets = hasCapability(session, "review_tickets");
  const unreadCount = unreadWorkOrderNotificationCount(inbox);
  const notificationCount = unreadCount + (canReviewTickets ? awaitingApproval.length : 0);
  const bellLabel = canReviewTickets
    ? `Work order approvals for ${displayName} (${displayRole}): ${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}, ${awaitingApproval.length} awaiting approval`
    : `Notifications for ${displayName} (${displayRole}): ${unreadCount} unread`;
  const mobileLaunchers = visibleLauncherGroups
    .flatMap((group) => group.items)
    .filter((launcher) => launcher.key !== "/work-orders");
  const createWorkOrderLauncher = launcherGroups
    .flatMap((group) => group.items)
    .find((launcher): launcher is Launcher => Boolean(launcher && launcher.key === "/work-orders"));

  return (
    <main data-cmpri-modal-ignore="true" className="cmpri-desktop-root flex h-svh w-full min-w-0 flex-col overflow-hidden bg-slate-950 text-white lg:h-dvh" data-dashboard-responsive={(engineerDesktopMenus || frontDeskLayout) ? "true" : undefined} data-chief-engineer-mobile={chiefEngineerMobileLayout ? "true" : undefined}>
      <header className="cmpri-desktop-topbar relative z-[200] flex shrink-0 flex-col items-start gap-1 border-b border-slate-800 bg-gradient-to-b from-slate-900/95 to-slate-950/95 px-3 pb-2 pt-[8pt] shadow-lg shadow-black/30 lg:flex-row lg:items-center lg:gap-3 lg:pb-3">
        <div className="flex w-full shrink-0 items-center gap-4 border-b border-slate-800 pb-2 lg:w-auto lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4">
          <div className="flex min-w-0 flex-col items-start leading-tight">
            <p data-dashboard-title data-front-desk-colors={frontDeskLayout ? "true" : undefined} className="text-[14pt] font-bold leading-none tracking-tight">
              <span className="text-amber-300">CMPRI</span>{" "}
              <span className="text-amber-300">{frontDeskLayout ? "Front Desk" : isHousekeepingDashboard ? "Housekeeping" : "Engineering"}</span>
            </p>
            <div data-dashboard-account className="mt-2 text-left leading-tight">
              <div className="flex min-w-0 items-center gap-2">
                <p data-dashboard-name className="max-w-[18rem] truncate text-[14pt] font-semibold tracking-tight text-slate-100">{displayName}</p>
                {(canReviewTickets || hasCapability(session, "receive_pool_closed_notifications") || inbox.length > 0) && (
                  <DashboardNotificationBell
                    count={notificationCount}
                    label={bellLabel}
                    aria-label={bellLabel}
                    title={canReviewTickets
                      ? `${displayName} · ${displayRole}${session.user.email ? ` · ${session.user.email}` : ""}\n${unreadCount} unread notification(s) · ${awaitingApproval.length} awaiting approval`
                      : `${displayName} · ${displayRole}${session.user.email ? ` · ${session.user.email}` : ""}\n${unreadCount} unread notification(s)`}
                    onClick={openApprovals}
                  />
                )}
              </div>
              <p data-dashboard-role className="mt-1 text-[9pt] font-medium text-sky-200/90">{displayRole}</p>
            </div>
            {createWorkOrderLauncher && !engineerDesktopMenus && !chiefEngineerMobileLayout && !frontDeskLayout && (
              <DashboardLauncherButton
                launcher={createWorkOrderLauncher}
                open={openKeys.has(createWorkOrderLauncher.key)}
                onLaunch={launch}
                className="ml-auto min-h-10 shrink-0 rounded-lg border border-amber-400/60 bg-amber-500 px-3 py-2 text-xs font-bold text-slate-950 shadow-sm lg:hidden"
              />
            )}
          </div>
          {createWorkOrderLauncher && !engineerDesktopMenus && chiefEngineerMobileLayout && (
            <DashboardLauncherButton launcher={createWorkOrderLauncher} open={openKeys.has(createWorkOrderLauncher.key)} onLaunch={launch}
              className="ml-auto min-h-8 shrink-0 self-start rounded-lg border border-amber-400/60 bg-amber-500 px-2 py-1 text-xs font-bold text-slate-950 shadow-sm lg:hidden" />
          )}
        </div>

        <nav aria-label="Open dashboard windows" className="flex min-w-0 w-full flex-1 flex-wrap items-center gap-0.5 lg:w-auto">
          {engineerDesktopMenus || chiefEngineerMobileLayout ? (
            <MobileDashboardMenus groups={visibleLauncherGroups} onLaunch={launch} />
          ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-1 lg:hidden">
            {mobileLaunchers.map((launcher) => (
              <DashboardLauncherButton key={`${launcher.key}:${launcher.label}`} launcher={launcher} open={openKeys.has(launcher.key)} onLaunch={launch} />
            ))}
          </div>
          )}
          {engineerDesktopMenus ? <MobileDashboardMenus groups={visibleLauncherGroups} onLaunch={launch} desktop /> : <div className="hidden min-w-0 flex-wrap items-center gap-0.5 lg:flex">
          {visibleLauncherGroups.map((group) => (
            <div key={group.label} className="relative">
              <div
                role="group"
                aria-label={group.label}
                className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5 rounded-md border border-slate-700/80 bg-slate-900/75 p-0.5"
              >
                <span aria-hidden="true" className="hidden px-0.5 text-[9pt] font-bold uppercase tracking-wide text-slate-400">{group.label}</span>
                {group.items.map((launcher) => (
                  <DashboardLauncherButton key={`${launcher.key}:${launcher.label}`} launcher={launcher} open={openKeys.has(launcher.key)} onLaunch={launch} />
                ))}
              </div>
            </div>
          ))}
          </div>}
        </nav>
        {<PoolStatus controlOnly/>}
        {frontDeskLayout && <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 max-w-[min(24rem,calc(100vw-2rem))]"><PoolStatus noticeOnly onOpen={openPoolStatus}/></div>}
        {frontDeskLayout && createWorkOrderLauncher && <DashboardLauncherButton launcher={createWorkOrderLauncher} open={openKeys.has(createWorkOrderLauncher.key)} onLaunch={launch} className="cmpri-front-desk-create ml-auto mr-2 shrink-0 rounded border border-amber-300 bg-amber-400 px-3.5 py-2 text-sm font-bold text-slate-950" />}
        {canOpenTroubleshootingGuides && (chiefEngineerMobileLayout ? <div className="hidden lg:contents"><TroubleshootingGuideDropdown /></div> : <TroubleshootingGuideDropdown />)}
      </header>

      <div ref={desktopRef} className="cmpri-desktop relative isolate min-h-0 flex-1 overflow-hidden">
        <ThanksgivingBackground />
        {windows.length === 0 && (
          <p aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center text-xs uppercase tracking-[0.4em] text-slate-700 select-none">CMPRI {frontDeskLayout ? "Front Desk" : "Engineering"}</p>
        )}
        {message && (
          <div role="alert" className="absolute bottom-2 left-2 z-[150] flex max-w-md items-start gap-2 rounded-md border border-red-400/40 bg-red-950/80 px-3 py-2 text-xs text-red-100 shadow-lg">
            <span className="flex-1">{message}</span>
            <button type="button" onClick={() => setMessage("")} aria-label="Dismiss dashboard error" className="text-red-200 hover:text-white">×</button>
          </div>
        )}
        {windows.map((entry) => {
          const rect = rects[entry.key];
          if (!rect) return null;
          const zIndex = 10 + Math.max(0, zOrder.indexOf(entry.key));
          return (
            <DesktopWindow
              key={entry.key}
              windowKey={entry.key}
              title={entry.title}
              accentClass={entry.accent}
              rect={rect}
              bounds={bounds}
              zIndex={zIndex}
              active={activeKey === entry.key}
              onFocus={() => raise(entry.key)}
              onClose={() => requestCloseWindow(entry.key)}
              onRectCommit={(next) => commitRect(entry.key, next)}
            >
              {entry.kind === "frame" && entry.src && (
                <DesktopFrame
                  src={entry.src}
                  title={entry.title}
                  registerFrame={(frame) => {
                    if (frame) frameRefs.current.set(entry.key, frame);
                  }}
                  onFocus={() => raise(entry.key)}
                  onOpen={(href, title) => openRoute(href, title)}
                  onReturnToDesktop={() => closeWindow(entry.key)}
                />
              )}
              {entry.kind === "pool-status" && <PoolStatus engineer={engineerDesktopMenus===true}/>}
              {entry.kind === "list" && (
                <WorkOrderListWindow
                  frontDeskLayout={frontDeskLayout}
                  orders={orders}
                  drafts={drafts.map((draft) => ({
                    ...draft,
                    potential_duplicate: orders.some((order) => likelyDuplicate(draft, order)),
                  }))}
                  loading={loading}
                  onOpenWorkOrder={(order) => openWorkOrder(order.id)}
                  onOpenDraft={openDraft}
                />
              )}
              {entry.kind === "approvals" && (
                <WorkOrderApprovalsWindow
                  user={session.user}
                  notifications={inbox}
                  awaitingApproval={awaitingApproval}
                  canReview={canReviewTickets}
                  notificationError={notificationError}
                  soundEnabled={soundEnabled}
                  onToggleSound={toggleSound}
                  onOpenWorkOrder={openWorkOrder}
                  onOpenNotification={openNotification}
                  onClear={(id) => void clearNotifications([id])}
                  onClearAll={() => void clearNotifications(inbox.map((notification) => notification.id))}
                />
              )}
            </DesktopWindow>
          );
        })}
      </div>
    </main>
  );
}
