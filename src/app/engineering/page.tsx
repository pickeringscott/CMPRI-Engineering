"use client";
import { isNotepadPath } from "@/lib/ui/notepad-navigation";
import BeginnerGuide from "@/components/beginners-guide/BeginnerGuide";
import { useUiLanguage } from "@/components/UiLanguageProvider";

import { SITE_SEASONAL_THEME } from "@/lib/ui/site-seasonal-theme";
import { subscribeResources } from "@/lib/events/browser";
import { canReviewEmployment } from "@/lib/employment-access";
import { canUseWinterPreparedness } from "@/lib/winter-preparedness-access";
import { canOpenEnseo, canOpenGss, canOpenRoomOperations, canOpenWeather, isChiefMenuRole } from "@/lib/dashboard/menu-access";
import { dashboardMenuGroups, usesThreeTabDashboard, WEATHER_MENU_PATH } from "@/lib/dashboard/menu-groups";
import { canReadChiefModules } from "@/lib/dashboard/chief-module-access";
import {mergeConfirmedWorkOrder,reconcileWorkOrderList,workOrderListSnapshot} from "@/lib/work-order-list-sync";
import { formatWorkOrder } from "@/lib/work-order-reference.js";
import { claimWorkOrder, releaseWorkOrder } from "@/lib/open-work-orders";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { getValidSession, signOutDevice } from "@/lib/supabase/client";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { usesChiefEngineerMobileLayout } from "@/lib/dashboard/chief-engineer-mobile";
import { accountRoleDisplayName } from "@/lib/account-display";
import {
  clearServerDashboardNotifications,
  fetchDashboardInbox,
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
  isAskRecordRoute,
  isDesktopRoute,
  raiseWindow,
  refocusAssetWindow,
  readDesktopLayouts,
  saveDesktopLayout,
  windowLayoutKey,
  type DesktopBounds,
  type WindowRect,
  type WindowSize,
} from "@/lib/ui/desktop-windows";
import { animateWindowTelescope, captureWindowLauncher, clearWindowTelescope, currentWindowLauncher, type WindowLauncher } from "@/lib/ui/window-telescope";
import { isRecognizedChiefEngineer, profileCanReopenPool, profileCanUseHoursTracker, roleAllows, roleKey } from "@/lib/server/roles";
import PoolStatus from "@/components/desktop/PoolStatus";
import WeatherUtilities from "@/components/desktop/WeatherUtilities";
import ApprovedDashboardMenus from "@/components/desktop/ApprovedDashboardMenus";
import DesktopWindow from "@/components/desktop/DesktopWindow";
import DesktopFrame from "@/components/desktop/DesktopFrame";
import DesktopWorkspaceResume from "@/components/desktop/DesktopWorkspaceResume";
import type { WorkspaceState } from "@/lib/ui/workspace-resume";
import WeatherPreviewWindow from "@/components/desktop/WeatherPreviewWindow";
import { armWeatherWarningSound } from "@/lib/weather-warning-sound";
import DashboardNotificationBell from "@/components/DashboardNotificationBell";
import TroubleshootingGuideDropdown from "@/components/TroubleshootingGuideDropdown";
import WorkOrderListWindow, { isPendingApproval, type DesktopWorkOrder, type DesktopWorkOrderDraft } from "@/components/desktop/WorkOrderListWindow";
import WorkOrderApprovalsWindow from "@/components/desktop/WorkOrderApprovalsWindow";
import WorkOrderWindowSwitcher from "@/components/desktop/WorkOrderWindowSwitcher";
import { canAccessTroubleshootingGuides } from "@/lib/room-ranker-access";
import { likelyDuplicate } from "@/lib/work-order-duplicates";

const NEW_ORDER_SOUND_PREF_KEY = "cmpri:new-order-sound:v1";
const LAUNCHER_CLOSE_WINDOW_MS = 5_000;
const WORK_ORDER_LIST_KEY = "work-order-list";
const APPROVALS_KEY = "work-order-approvals";
const WEATHER_PREVIEW_PATH = WEATHER_MENU_PATH;
const WORK_ORDER_LIMIT_MESSAGE = "You can have up to five work orders open. Close a work order before opening another.";
const DEFAULT_WINDOW_SIZE: WindowSize = { width: 1040, height: 720 };

type DesktopWindowEntry = {
  key: string;
  title: string;
  kind: "frame" | "list" | "approvals" | "pool-status";
  src?: string;
  accent: string;
  preferred: WindowSize;
  launcher?: WindowLauncher;
  // Weather keeps its iframe and loaded data in page memory while closed.
  weatherCached?: boolean;
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


function DashboardLauncherButton({
  launcher,
  open,
  onLaunch,
  className,
}: {
  launcher: Launcher;
  open: boolean;
  onLaunch: (launcher: Launcher, clickedAt: number, opener: HTMLElement) => void;
  className?: string;
}) {
  const { t, tt } = useUiLanguage();
  return (
    <button
      type="button"
      data-cmpri-desktop-launch={launcher.key}
      data-open={open ? "true" : "false"}
      title={tt(launcher.label)}
      onClick={event => onLaunch(launcher, Date.now(), event.currentTarget)}
      className={className || `cmpri-desktop-launch shrink-0 whitespace-nowrap rounded border px-1 py-0.5 font-semibold shadow-sm shadow-black/20 ${launcher.tone}`}
    >
      {t(launcher.label)}
    </button>
  );
}

const ROUTE_WINDOWS: Record<string, { title: string; accent: string; preferred?: WindowSize }> = {
  "/notepad": { title: "Notepad", accent: "bg-green-500", preferred: { width: 1040, height: 720 } },
  "/notes": { title: "Notepad", accent: "bg-green-500", preferred: { width: 1040, height: 720 } },
  "/staff-notes": { title: "Notepad", accent: "bg-green-500", preferred: { width: 1040, height: 720 } },
  [WEATHER_PREVIEW_PATH]: { title: "Weather", accent: "bg-amber-400", preferred: { width: 1280, height: 800 } },
  "/engineering/room-ranking": { title: "Room Ranker", accent: "bg-amber-400", preferred: { width: 1900, height: 1000 } },
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
  const { t, tt } = useUiLanguage();
  const router = useRouter();
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const [orders, setOrders] = useState<DesktopWorkOrder[]>([]);
  const approvalPageRef = useRef(0);
  const [approvalPage, setApprovalPage] = useState(0);
  const [approvalTotal, setApprovalTotal] = useState(0);
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
  const clearGenerationRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const previousTitleRef = useRef<string>("");

  const desktopRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<DesktopBounds>({ width: 0, height: 0 });
  const boundsRef = useRef<DesktopBounds>({ width: 0, height: 0 });
  const [windows, setWindows] = useState<DesktopWindowEntry[]>([]);
  const [weatherBulletinHost, setWeatherBulletinHost] = useState<HTMLDivElement | null>(null);
  const [weatherWallpaperHost, setWeatherWallpaperHost] = useState<HTMLDivElement | null>(null);
  const [windowGuests, setWindowGuests] = useState<Record<string, Record<string, unknown>>>({});
  const windowsRef = useRef<DesktopWindowEntry[]>([]);
  const workOrderRegistryOwner = useRef("");
  const [zOrder, setZOrder] = useState<string[]>([]);
  const [rects, setRects] = useState<Record<string, WindowRect>>({});
  const layoutsRef = useRef<Record<string, WindowRect>>({});
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const windowOpenedAtRef = useRef(new Map<string, number>());
  const openingWindows = useRef(new Set<string>());
  const closingWindows = useRef(new Set<string>());
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
    clearGenerationRef.current += 1;
    setInbox((current) => current.filter((notification) => !clearing.has(notification.id)));
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to clear notifications.");
      await clearServerDashboardNotifications(session.access_token, ids);
      setNotificationError("");
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Notifications could not be cleared.");
    } finally {
      // Ignore any poll that started before the clear finished, then let the server list rule again.
      clearGenerationRef.current += 1;
      ids.forEach((id) => pendingClearIdsRef.current.delete(id));
    }
  }

  async function markNotificationRead(notification: WorkOrderNotification) {
    if (notification.is_read || pendingReadIdsRef.current.has(notification.id)) return;
    pendingReadIdsRef.current.add(notification.id);
    clearGenerationRef.current += 1;
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
      clearGenerationRef.current += 1;
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
      const response = await fetch(`/api/work-orders?filter=pending&page=${approvalPageRef.current}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.work_orders)) throw new Error(payload.error || "Dashboard work orders could not be loaded.");
      const fetched = payload.work_orders as DesktopWorkOrder[];
      setApprovalTotal(payload.total ?? fetched.length);
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
    return subscribeResources(["orders", "rooms"], () => loadDashboard(true), false);
  }, [loadDashboard]);

  useEffect(() => {
    if (!cmpriSession) return;
    const userId = cmpriSession.user.id;
    let current = true;
    let imported = false;
    const importLocalInbox = async (accessToken: string) => {
      // One-time move of notifications this browser kept before the inbox moved to the server.
      const local = readDashboardInbox(userId);
      if (local.length) await importServerDashboardNotifications(accessToken, local);
      forgetLocalDashboardInbox(userId);
    };
    const refreshInbox = async () => {
      const generation = clearGenerationRef.current;
      try {
        const session = await getValidSession();
        if (!session?.access_token) throw new Error("Sign in again to load notifications.");
        if (!imported) {
          await importLocalInbox(session.access_token);
          imported = true;
        }
        const result = await fetchDashboardInbox(session.access_token);
        if (!current) return;
        if (generation === clearGenerationRef.current) applyServerInbox(result.notifications);
        setNotificationError("");
      } catch (error) {
        if (current) setNotificationError(error instanceof Error ? error.message : "Notifications could not be loaded.");
      }
    };
    const unsubscribe = subscribeResources(["inbox", "session"], refreshInbox);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [applyServerInbox, cmpriSession, loadDashboard]);

  useEffect(() => {
    if (!cmpriSession || (!hasCapability(cmpriSession, "review_feedback") && !canReadChiefModules(cmpriSession.user))) return;
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
    const unsubscribe = subscribeResources(["feedback"], refreshFeedbackCount);
    return () => { current = false; unsubscribe(); };
  }, [cmpriSession]);

  useEffect(() => {
    const baseTitle = t(roleKey(cmpriSession?.user.role) === "front_desk" || window.location.pathname === "/front-desk" ? "CMPRI Front Desk" : "CMPRI Engineering");
    previousTitleRef.current = baseTitle;
    document.title = inbox.length > 0 ? `(${inbox.length}) ${baseTitle}` : baseTitle;
    return () => { document.title = baseTitle; };
  }, [inbox.length, cmpriSession?.user.role, t]);

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
    if (frame) frame.focus({ preventScroll: true });
    else if (key === WORK_ORDER_LIST_KEY && (window.matchMedia("(pointer: coarse)").matches
      || window.innerWidth < COMPACT_DESKTOP_WIDTH)) {
      // Keep focus inside the list without opening a touch device's keyboard.
      desktopRef.current?.querySelector<HTMLElement>("[data-work-order-list-heading]")?.focus({ preventScroll: true });
    }
    else desktopRef.current?.querySelector<HTMLElement>(`[data-cmpri-desktop-window="${CSS.escape(key)}"] .cmpri-desktop-window-body button, [data-cmpri-desktop-window="${CSS.escape(key)}"] .cmpri-desktop-window-body input`)?.focus({ preventScroll: true });
  }, [zOrder, windows]);

  const openWindow = useCallback((entry: DesktopWindowEntry) => {
    if (closingWindows.current.has(entry.key)) return;
    const existing = windowsRef.current.find((item) => item.key === entry.key);
    if (existing) {
      if (entry.key === WEATHER_PREVIEW_PATH && existing.weatherCached) {
        windowsRef.current = windowsRef.current.map(item => item.key === entry.key ? { ...item, launcher: entry.launcher, weatherCached: false } : item);
        if (entry.launcher) openingWindows.current.add(entry.key);
        windowOpenedAtRef.current.set(entry.key, Date.now());
        setWindows(windowsRef.current);
      }
      refocusAssetWindow(frameRefs.current.get(entry.key), existing.src);
      raise(entry.key, true);
      return;
    }
    const workOrderMatch = /^\/work-orders\/([^/]+)$/.exec(entry.key);
    if (workOrderMatch) {
      const owner = workOrderRegistryOwner.current || (workOrderRegistryOwner.current = crypto.randomUUID());
      const outcome = claimWorkOrder(decodeURIComponent(workOrderMatch[1]), owner, () => raise(entry.key, true));
      if (outcome === "limit") { setMessage(WORK_ORDER_LIMIT_MESSAGE); return; }
      if (outcome === "existing") return;
      setMessage(previous => previous === WORK_ORDER_LIMIT_MESSAGE ? "" : previous);
    }
    const saved = layoutsRef.current[windowLayoutKey(entry.key)];
    const rect = saved || defaultWindowRect(boundsRef.current, entry.preferred, windowsRef.current.length);
    windowsRef.current = [...windowsRef.current, entry];
    if (entry.launcher) openingWindows.current.add(entry.key);
    windowOpenedAtRef.current.set(entry.key, Date.now());
    setWindows(windowsRef.current);
    setRects((current) => ({ ...current, [entry.key]: rect }));
    raise(entry.key, true);
  }, [raise]);

  const windowPanel = useCallback((key: string) => desktopRef.current?.querySelector<HTMLElement>(
    `[data-cmpri-desktop-window="${CSS.escape(key)}"]`
  ) ?? null, []);

  useLayoutEffect(() => {
    for (const entry of windows) {
      const panel = windowPanel(entry.key);
      if (!panel) continue;
      if (entry.weatherCached) clearWindowTelescope(panel);
      if (openingWindows.current.delete(entry.key)) animateWindowTelescope(panel, entry.launcher, "open");
    }
  }, [windows, rects, windowPanel]);

  const removeWindow = useCallback((key: string) => {
    if (key === WEATHER_PREVIEW_PATH) {
      windowsRef.current = windowsRef.current.map(entry => entry.key === key ? { ...entry, weatherCached: true } : entry);
      windowOpenedAtRef.current.delete(key);
      setWindows(windowsRef.current);
      setZOrder(current => current.filter(entry => entry !== key));
      return;
    }
    const workOrderMatch = /^\/work-orders\/([^/]+)$/.exec(key);
    if (workOrderMatch && workOrderRegistryOwner.current) {
      releaseWorkOrder(decodeURIComponent(workOrderMatch[1]), workOrderRegistryOwner.current);
      setMessage(previous => previous === WORK_ORDER_LIMIT_MESSAGE ? "" : previous);
    }
    windowsRef.current = windowsRef.current.filter((entry) => entry.key !== key);
    windowOpenedAtRef.current.delete(key);
    setWindows(windowsRef.current);
    setWindowGuests(current => { const next = { ...current }; delete next[key]; return next; });
    setZOrder((current) => current.filter((entry) => entry !== key));
    frameRefs.current.delete(key);
  }, []);

  const closeWindow = useCallback((key: string) => {
    if (closingWindows.current.has(key)) return;
    const launcher = windowsRef.current.find(entry => entry.key === key)?.launcher;
    const panel = windowPanel(key);
    const motion = animateWindowTelescope(panel, launcher, "close");
    if (!motion) { removeWindow(key); return; }
    closingWindows.current.add(key);
    void motion.finished.then(() => {
      const returnFocus = launcher && panel?.contains(document.activeElement);
      removeWindow(key);
      if (returnFocus) currentWindowLauncher(launcher)?.focus({ preventScroll: true });
    }).catch(() => undefined).finally(() => closingWindows.current.delete(key));
  }, [removeWindow, windowPanel]);

  useEffect(() => () => {
    const owner = workOrderRegistryOwner.current;
    if (!owner) return;
    for (const entry of windowsRef.current) {
      const workOrderMatch = /^\/work-orders\/([^/]+)$/.exec(entry.key);
      if (workOrderMatch) releaseWorkOrder(decodeURIComponent(workOrderMatch[1]), owner);
    }
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

  const openRoute = useCallback((href: string, titleHint?: string, launcher?: Pick<Launcher, "accent" | "preferred" | "label">, originLauncher?: WindowLauncher) => {
    const origin = window.location.origin;
    if (!isDesktopRoute(href, origin)) return;
    const key = desktopWindowKeyForHref(href, origin);
    if (key === "/engineering") return;
    const workOrderId = /^\/work-orders\/([^/]+)$/.exec(key)?.[1];
    const known = ROUTE_WINDOWS[new URL(href, origin).pathname];
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
      launcher: originLauncher,
    });
  }, [openWindow]);

  useEffect(() => {
    if (!cmpriSession || window.parent !== window) return;
    const openAskRecord = (event: Event) => {
      const detail = (event as CustomEvent<{ origin?: string; href?: string; title?: string; opener?: HTMLElement; openerRect?: DOMRect }>).detail;
      if (detail?.origin !== "ask-cmpri" || typeof detail.href !== "string" || !isAskRecordRoute(detail.href, window.location.origin)) return;
      if (!event.cancelable) event.stopImmediatePropagation();
      event.preventDefault();
      const opener = detail.opener instanceof HTMLElement ? detail.opener : undefined;
      const rect = detail.openerRect instanceof DOMRect ? detail.openerRect : undefined;
      openRoute(detail.href, detail.title, undefined, captureWindowLauncher(opener, rect));
    };
    window.addEventListener("cmpri-open-modal", openAskRecord, true);
    return () => window.removeEventListener("cmpri-open-modal", openAskRecord, true);
  }, [cmpriSession, openRoute]);

  const openWorkOrder = useCallback((workOrderId: string, opener?: HTMLElement) => {
    openRoute(`/work-orders/${encodeURIComponent(workOrderId)}`, undefined, undefined, captureWindowLauncher(opener));
  }, [openRoute]);

  const openWorkOrderList = useCallback((launcher?: WindowLauncher) => {
    openWindow({ key: WORK_ORDER_LIST_KEY, title: "Work Order List", kind: "list", accent: "bg-slate-300", preferred: { width: 1100, height: 640 }, launcher });
  }, [openWindow]);

  const openDraft = useCallback((draftId: string, opener?: HTMLElement) => {
    const origin = window.location.origin;
    openWindow({
      key: `work-order-draft:${draftId}`,
      title: "Draft — awaiting approval",
      kind: "frame",
      src: desktopFrameHref(`/work-orders?draftId=${encodeURIComponent(draftId)}&reviewDraft=1`, crypto.randomUUID(), origin),
      accent: "bg-amber-400",
      preferred: { width: 960, height: 780 },
      launcher: captureWindowLauncher(opener),
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
        if (data.workOrder && typeof data.workOrder === 'object' && 'id' in data.workOrder && data.workOrder.id === data.workOrderId) {
          const snapshot = workOrderListSnapshot(data.workOrder);
          if (snapshot) setWindowGuests(previous => ({ ...previous, [key]: snapshot }));
          setOrders(previous => mergeConfirmedWorkOrder(previous,data.workOrder));
        }
        if (data.type === "cmpri-work-order-loaded") return;
      }
      switch (data.type) {
        case "cmpri-assets-changed": {
          const source = windowsRef.current.find(entry => entry.key === key);
          if (!source?.src || typeof data.assetId !== "string" || !data.assetId) return;
          const sourceUrl = new URL(source.src, window.location.origin);
          if (sourceUrl.pathname !== "/management/equipment" || sourceUrl.searchParams.get("modalToken") !== data.modalToken) return;
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
          if (data.href === "/work-order-list") {
            const source = windowsRef.current.find(entry => entry.key === key);
            const token = source?.src && new URL(source.src, window.location.origin).searchParams.get("modalToken");
            if (key === "/technician" && token && data.modalToken === token && hasCapability(cmpriSession, "view_work_orders")) openWorkOrderList();
            return;
          }
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
        case "cmpri-work-order-cancelled":
          closeWindow(key);
          return;
        case "cmpri-modal-dashboard":
          requestCloseWindow(key);
          return;
        case "cmpri-work-order-created":
        case "cmpri-work-order-saved":
        case "cmpri-work-order-deleted":
          closeWindow(key);
          void loadDashboard(true);
          return;
        case "cmpri-modal-sign-out":
          window.dispatchEvent(new Event("cmpri-workspace-sign-out"));
          window.location.replace("/");
          return;
      }
    };
    window.addEventListener("message", handleWindowMessage);
    return () => window.removeEventListener("message", handleWindowMessage);
  }, [closeWindow, requestCloseWindow, cmpriSession, loadDashboard, openRoute, openWorkOrder, openWorkOrderList, refreshChatgptConnection]);

  if (!cmpriSession) {
    return (
      <main data-cmpri-modal-ignore="true" data-cmpri-seasonal-theme={SITE_SEASONAL_THEME} className="cmpri-desktop-root flex h-svh w-full min-w-0 flex-col overflow-hidden text-white lg:h-dvh" aria-busy="true">
        {/* Keep the same element tree when the authorized dashboard appears.
            The hidden header lets the artwork observe its eventual height. */}
        <header className="cmpri-desktop-topbar" hidden aria-hidden="true" />
        <div ref={desktopRef} className="cmpri-desktop relative isolate min-h-0 flex-1 overflow-hidden">
          <p role="status" aria-live="polite" className="cmpri-sign-in-card relative z-10 mx-auto mt-4 w-fit rounded-[22px] border p-4 text-center text-[16pt] font-semibold">{t("Loading Dashboard...")}<br />{t("Have a wonderful day!")}</p>
        </div>
      </main>
    );
  }

  const session = cmpriSession;
  const chiefHeaderPresentation = isChiefMenuRole(session.user);
  const canReadChiefOnlyModules = canReadChiefModules(session.user);
  const frontDeskLayout = roleKey(session.user.role) === "front_desk";
  const threeTabLayout = usesThreeTabDashboard(session.user.role);
  const chiefEngineerMobileLayout = usesChiefEngineerMobileLayout(session.user);
  const isHousekeepingDashboard = roleKey(session.user.role) === "housekeeping";
  const canOpenTroubleshootingGuides = canAccessTroubleshootingGuides(session.user);
  const awaitingApproval = orders.filter(isPendingApproval);
  const displayName = session.user.name?.trim() || t("Name not set");
  const displayRole = accountRoleDisplayName(session.user);

  async function signOut() {
    window.dispatchEvent(new Event("cmpri-workspace-sign-out"));
    await signOutDevice();
    router.replace("/");
  }

  function openApprovals(event: ReactMouseEvent<HTMLButtonElement>) {
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
      launcher: captureWindowLauncher(event.currentTarget),
    });
  }

  function openNotification(notification: WorkOrderNotification, opener: HTMLElement) {
    void markNotificationRead(notification);
    if (notification.target_path && isDesktopRoute(notification.target_path, window.location.origin)) {
      const target = new URL(notification.target_path, window.location.origin);
      if (isNotepadPath(target.pathname)) {
        openRoute(notification.target_path, "Notepad", undefined, captureWindowLauncher(opener));
      } else openRoute(notification.target_path, "Daily Room Ops", undefined, captureWindowLauncher(opener));
    } else if (notification.work_order_id) openWorkOrder(notification.work_order_id, opener);
  }

  const launchers: Array<Launcher | false> = [
    hasCapability(session, "view_work_orders") && { key: WORK_ORDER_LIST_KEY, label: "Work Order List", action: "work-order-list", tone: "border-slate-600 bg-slate-800 text-slate-100", accent: "bg-slate-300" },
    roleKey(session.user.role) === "technician" && { key: "/technician", label: "Technician Dashboard", href: "/technician", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
    hasCapability(session, "submit") && { key: "/work-orders", label: "+ Work Order", href: "/work-orders", tone: "border-slate-600 bg-slate-800 text-slate-100", accent: "bg-slate-300", preferred: { width: 900, height: 760 } },
    process.env.NEXT_PUBLIC_CMPRI_WEATHER_PREVIEW === "1" && canOpenWeather(session.user) && { key: WEATHER_PREVIEW_PATH, label: "Weather", href: `${WEATHER_PREVIEW_PATH}?weather=open`, tone: "border-amber-400/50 bg-slate-900 text-amber-300", accent: "bg-amber-400", preferred: { width: 1280, height: 800 } },
    canUseWinterPreparedness(session.user) && { key: "/engineering/winter-preparedness", label: "Winter Preparedness 2026", href: "/engineering/winter-preparedness", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
    canReviewEmployment(session.user,session.user) && { key: "/engineering/employment", label: "Candidate questionnaires", href: "/engineering/employment", tone: "border-yellow-400 bg-slate-900 text-yellow-300", accent: "bg-yellow-400", preferred: { width: 850, height: 700 } },
    { key: "/notepad", label: "Notepad", href: "/notepad", tone: "border-green-700 bg-green-950 text-green-100", accent: "bg-green-500" },
    hasCapability(session, "view_pool_log") && { key: "/engineering/pool-log", label: "Pool Log", href: "/engineering/pool-log", tone: "border-cyan-400/50 bg-cyan-950/30 text-cyan-100", accent: "bg-cyan-400" },
    canOpenRoomOperations(session.user) && { key: "/engineering/room-operations", label: "Daily Room Ops", href: "/engineering/room-operations", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
    canOpenGss(session.user) && { key: "/engineering/gss", label: "GSS Reports", href: "/engineering/gss", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400", preferred: { width: 820, height: 600 } },
    canOpenEnseo(session.user) && { key: "/engineering/enseo-assignments", label: "Enseo Assignments", href: "/engineering/enseo-assignments", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
    { key: "/engineering/room-ranking", label: "Room Ranker", href: "/engineering/room-ranking", tone: "border-amber-400/50 bg-slate-900 text-amber-300", accent: "bg-amber-400", preferred: { width: 1900, height: 1000 } },
    hasCapability(session, "view_pm") && { key: "/engineering/preventive-maintenance", label: chiefHeaderPresentation ? "Preventative Maintenance" : "Preventive Maintenance", href: "/engineering/preventive-maintenance", tone: "border-emerald-400/50 bg-emerald-950/30 text-emerald-100", accent: "bg-emerald-400", preferred: { width: 1200, height: 780 } },
    (hasCapability(session, "manage_assets") || canReadChiefOnlyModules) && { key: "/management/equipment", label: "Assets", href: "/management/equipment", tone: "border-cyan-400/50 bg-cyan-950/30 text-cyan-100", accent: "bg-cyan-400" },
    (hasCapability(session, "manage_assets") || canReadChiefOnlyModules) && { key: "/engineering/parts", label: "Inventory", href: "/engineering/parts", tone: "border-amber-400/50 bg-amber-950/30 text-amber-100", accent: "bg-amber-400" },
    chiefHeaderPresentation && (hasCapability(session, "manage_assets") || canReadChiefOnlyModules) && { key: "/engineering/purchasing", label: "PO", href: "/engineering/purchasing", tone: "border-orange-400/50 bg-orange-950/30 text-orange-100", accent: "bg-orange-400" },
    hasCapability(session, "view_locations") && { key: "/management/rooms", label: "Manage Locations", href: "/management/rooms", tone: "border-indigo-400/50 bg-indigo-950/30 text-indigo-100", accent: "bg-indigo-400" },
    (hasCapability(session, "manage_users") || canReadChiefOnlyModules) && { key: "/management/users", label: "Manage Users", href: "/management/users", tone: "border-sky-400/50 bg-sky-950/30 text-sky-100", accent: "bg-sky-400" },
    (hasCapability(session, "review_feedback") || canReadChiefOnlyModules) && { key: "/feedback", label: `Feedback${newFeedbackCount > 0 ? ` (${newFeedbackCount})` : ""}`, href: `/feedback?route=${encodeURIComponent("/engineering")}`, tone: "border-amber-500/50 bg-amber-950/20 text-amber-100", accent: "bg-amber-500" },
    profileCanUseHoursTracker(session.user) && { key: "/engineering/hours-tracker", label: "Hours Tracker", href: "/engineering/hours-tracker", tone: "border-amber-400/50 bg-slate-900 text-amber-300", accent: "bg-amber-400", preferred: { width: 448, height: 310 } },
    hasCapability(session, "view_profiles") && { key: "/profile", label: "Manage Profile", href: "/profile", tone: "border-slate-600 bg-slate-800 text-slate-100", accent: "bg-slate-300", preferred: { width: 880, height: 720 } },
    hasCapability(session, "view_profiles") && !chatgptConnected && { key: "/profile", label: "Connect ChatGPT", href: "/profile", tone: "border-sky-500/50 bg-sky-950/30 text-sky-100", accent: "bg-slate-300", preferred: { width: 880, height: 720 } },
    { key: "sign-out", label: "Sign Out", action: "sign-out", tone: "border-red-400/50 bg-red-950/30 text-red-100", accent: "bg-red-400" },
  ];
  const availableLaunchers = launchers.filter((item): item is Launcher => Boolean(item));
  const visibleLauncherGroups = dashboardMenuGroups(session.user.role, availableLaunchers, chiefHeaderPresentation);

  function launchWindow(key: string, clickedAt: number, open: () => void, opener?: HTMLElement) {
    // The approved list launcher must bring a background list forward even
    // immediately after it was opened, so other windows can stay mounted.
    if (key === WORK_ORDER_LIST_KEY && zOrder.at(-1) !== key) {
      open();
      return;
    }
    const openedAt = windowOpenedAtRef.current.get(key);
    const existing = windowsRef.current.find(entry => entry.key === key && !entry.weatherCached);
    if (existing?.launcher && opener && currentWindowLauncher(existing.launcher) !== opener) {
      open();
      return;
    }
    if (existing && openedAt !== undefined && clickedAt - openedAt <= LAUNCHER_CLOSE_WINDOW_MS) {
      requestCloseWindow(key);
      return;
    }
    open();
  }

  function openPoolStatus(opener?: HTMLElement) {
    openWindow({key:"pool-status",title:"Pool",kind:"pool-status",accent:"bg-green-400",preferred:{width:360,height:frontDeskLayout?230:300},launcher:captureWindowLauncher(opener)});
  }

  function launch(launcher: Launcher, clickedAt: number, opener?: HTMLElement) {
    if (launcher.key === "pool-status") openPoolStatus(opener);
    else if (launcher.action === "work-order-list") launchWindow(WORK_ORDER_LIST_KEY, clickedAt, () => openWorkOrderList(captureWindowLauncher(opener)), opener);
    else if (launcher.action === "sign-out") void signOut();
    else if (launcher.href) {
      const href = launcher.href;
      // Resume the local warning sound during this genuine user gesture so an
      // asynchronously arriving NWS warning can play on mobile browsers too.
      if (href.split(/[?#]/)[0] === WEATHER_PREVIEW_PATH) void armWeatherWarningSound();
      const key = desktopWindowKeyForHref(href, window.location.origin);
      launchWindow(key, clickedAt, () => openRoute(href, launcher.label, { ...launcher, label: launcher.label.replace(/ \(\d+\)$/, "") }, captureWindowLauncher(opener)), opener);
    }
  }

  const openKeys = new Set(windows.filter(entry => !entry.weatherCached).map((entry) => entry.key));
  const activeKey = zOrder.at(-1) || "";
  const canReviewTickets = hasCapability(session, "review_tickets");
  const unreadCount = unreadWorkOrderNotificationCount(inbox);
  const notificationCount = unreadCount + (canReviewTickets ? approvalTotal : 0);

  function restoreWorkspaceDesktop(saved: WorkspaceState["desktop"]) {
    const byKey = new Map(saved.views.map(view => [view.key, view]));
    for (const key of saved.zOrder) {
      const view = byKey.get(key);
      if (!view) continue;
      if (view.kind === "list") openWorkOrderList();
      else if (view.kind === "pool-status") openPoolStatus();
      else if (view.kind === "approvals") openWindow({ key: APPROVALS_KEY, title: canReviewTickets ? "Work Order Approvals" : "Work Order Notifications",
        kind: "approvals", accent: canReviewTickets ? "bg-purple-400" : "bg-sky-400", preferred: { width: 780, height: 540 } });
      else if (view.key.startsWith("work-order-draft:") && view.href) {
        const draftId = new URL(view.href, window.location.origin).searchParams.get("draftId");
        if (draftId) openDraft(draftId);
      } else if (view.href) {
        const path = new URL(view.href, window.location.origin).pathname;
        const launcher = availableLaunchers.find(item => item.href?.split("?")[0] === path);
        openRoute(view.href, launcher ? launcher.label : undefined, launcher || undefined);
      }
    }
  }
  const bellLabel = canReviewTickets
    ? t("Work order approvals for {name} ({role}): {count} unread, {approvals} awaiting approval", { name: displayName, role: t(displayRole), count: unreadCount, approvals: approvalTotal })
    : t("Notifications for {name} ({role}): {count} unread", { name: displayName, role: t(displayRole), count: unreadCount });
  const createWorkOrderLauncher = availableLaunchers.find(launcher => launcher.key === "/work-orders");
  const weatherLauncher = availableLaunchers.find(launcher => launcher.key === WEATHER_PREVIEW_PATH);
  function openDashboardWeather(event: React.MouseEvent<HTMLButtonElement>) {
    if (weatherLauncher) launch(weatherLauncher, Date.now(), event.currentTarget);
  }

  return (
    <main data-cmpri-modal-ignore="true" data-cmpri-engineering-window-owner data-cmpri-seasonal-theme={SITE_SEASONAL_THEME} className="cmpri-desktop-root flex h-svh w-full min-w-0 flex-col overflow-hidden bg-slate-950 text-white lg:h-dvh" data-dashboard-responsive={(chiefHeaderPresentation || threeTabLayout) ? "true" : undefined} data-chief-engineer-mobile={chiefHeaderPresentation ? "true" : undefined}>
      {typeof window !== "undefined" && window.parent === window
        && new URLSearchParams(window.location.search).get("embedded") !== "1" && (
          <BeginnerGuide key={session.user.id + ":" + session.user.role + ":" + displayRole} user={{
            ...session.user,
            name: session.user.name?.trim() || "",
            displayRole,
          }} />
        )}
      <DesktopWorkspaceResume session={session}
        allowedHrefs={availableLaunchers.flatMap(item => item.href ? [item.href] : [])}
        views={windows.filter(entry => !entry.weatherCached).map(entry => ({ key: entry.key, kind: entry.kind, ...(entry.src ? { href: entry.src } : {}) }))}
        zOrder={zOrder} onRestore={restoreWorkspaceDesktop}
        onSessionChanged={() => window.location.reload()}
        onStorageError={() => setMessage("This device could not save the open workspace. Keep this window open to preserve the current view.")} />
      <header className="cmpri-desktop-topbar cmpri-dashboard-titlebar relative flex shrink-0 flex-col items-start gap-1 border-b border-slate-800 bg-gradient-to-b from-slate-900/95 to-slate-950/95 px-3 pt-[8pt] shadow-lg shadow-black/30 lg:gap-3">
        <div className="cmpri-header-shelf">
          <div className="cmpri-header-identity">
            <p data-dashboard-title data-cmpri-menu-title="" data-front-desk-colors={frontDeskLayout ? "true" : undefined} className="flex items-center gap-1 text-[14pt] font-bold leading-none tracking-tight">
              <span className="text-amber-300">{t("CMPRI")}</span>{" "}
              <span className="text-amber-300">{frontDeskLayout ? t("Front Desk") : isHousekeepingDashboard ? t("Housekeeping") : t("Engineering")}</span>
                               <DashboardNotificationBell
                    count={notificationCount}
                    label={bellLabel}
                    aria-label={bellLabel}
                    title={tt(canReviewTickets
                      ? `${displayName} · ${t(displayRole)}${session.user.email ? ` · ${session.user.email}` : ""}\n${t("{count} unread notifications · {approvals} awaiting approval", { count: unreadCount, approvals: approvalTotal })}`
                      : `${displayName} · ${t(displayRole)}${session.user.email ? ` · ${session.user.email}` : ""}\n${t("{count} unread notifications", { count: unreadCount })}`)}
                    onClick={openApprovals}
                  /></p>
            <div data-dashboard-account className="mt-2 text-left leading-tight">
              <div className="flex min-w-0 items-center gap-2">
                <p data-dashboard-name className="max-w-[18rem] truncate text-[14pt] font-semibold tracking-tight text-slate-100">{displayName}</p>
              </div>
              <p data-dashboard-role data-cmpri-chief-engineer={displayRole === "Chief Engineer" ? "true" : "false"} className="mt-1 text-[9pt] font-medium text-sky-200/90">{t(displayRole)}</p>
            </div>
          </div>
          <WeatherUtilities onOpen={weatherLauncher ? openDashboardWeather : undefined}>
            <div className="cmpri-header-utilities" data-front-desk={frontDeskLayout}>
              <PoolStatus controlOnly onOpen={event => openPoolStatus(event.currentTarget)} />
              {createWorkOrderLauncher && <DashboardLauncherButton launcher={createWorkOrderLauncher} open={openKeys.has(createWorkOrderLauncher.key)} onLaunch={launch} className="cmpri-header-create" />}
            </div>
          </WeatherUtilities>
        </div>
        <nav aria-label={t("Open dashboard windows")} className="cmpri-dashboard-menu-rail w-full min-w-0">
          <ApprovedDashboardMenus anchored askEnabled={isRecognizedChiefEngineer(session.user)} restriction={frontDeskLayout ? "front_desk" : isHousekeepingDashboard ? "housekeeping" : null} groups={visibleLauncherGroups} onLaunch={launch} userId={session.user.id} hotelId={session.hotelId} />
        </nav>

        {frontDeskLayout && <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 max-w-[min(24rem,calc(100vw-2rem))]"><PoolStatus noticeOnly onOpen={event => openPoolStatus(event.currentTarget)}/></div>}
      </header>

      <div className="flex shrink-0 flex-col items-start gap-0.5 px-0.5 empty:hidden">
        {hasCapability(session, "view_work_orders") && <WorkOrderWindowSwitcher
          tickets={windows.filter(entry => /^\/work-orders\/[^/]+$/.test(entry.key)).map(entry => {
            const details = windowGuests[entry.key] || orders.find(order => entry.key === `/work-orders/${order.id}`);
            if (!details) return entry;
            const title = formatWorkOrder(details.display_id);
            return { ...entry, title: title + (details.room ? ` · ${String(details.room)}` : "") };
          })}
          activeKey={activeKey}
          onRaise={key => raise(key, true)}
        />}

        {canOpenTroubleshootingGuides && (chiefEngineerMobileLayout ? <div className="hidden lg:contents"><TroubleshootingGuideDropdown /></div> : <TroubleshootingGuideDropdown />)}
      </div>

      <div ref={setWeatherBulletinHost} data-weather-desktop-bulletin-host className="relative z-[200] w-full shrink-0" />

      <div className="cmpri-desktop relative isolate min-h-0 flex-1 overflow-hidden">
        <div ref={setWeatherWallpaperHost} className="pointer-events-none absolute inset-0" />
        {openKeys.size === 0 && (
          <p aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center text-xs uppercase tracking-[0.4em] text-slate-700 select-none">{t("CMPRI ")}{frontDeskLayout ? t("Front Desk") : t("Engineering")}</p>
        )}
        {message && (
          <div role="alert" className="absolute bottom-2 left-2 z-[150] flex max-w-md items-start gap-2 rounded-md border border-red-400/40 bg-red-950/80 px-3 py-2 text-xs text-red-100 shadow-lg">
            <span className="flex-1">{t(message)}</span>
            <button type="button" onClick={() => setMessage("")} aria-label={t("Dismiss dashboard error")} className="text-red-200 hover:text-white">×</button>
          </div>
        )}
        <div ref={desktopRef} className="cmpri-dashboard-window-layer">
          {windows.map((entry) => {
            const rect = rects[entry.key];
            if (!rect) return null;
            const zIndex = 10 + Math.max(0, zOrder.indexOf(entry.key));
            if (entry.key === WEATHER_PREVIEW_PATH && entry.kind === "frame" && entry.src) {
              return <WeatherPreviewWindow key={entry.key} windowKey={entry.key} title={entry.title} accentClass={entry.accent} src={entry.src}
                visible={!entry.weatherCached} bulletinHost={weatherBulletinHost} wallpaperHost={weatherWallpaperHost}
                canEditManualAlert={isRecognizedChiefEngineer(session.user)}
                rect={rect} bounds={bounds} zIndex={zIndex} active={activeKey === entry.key} onFocus={() => raise(entry.key)}
                onClose={() => requestCloseWindow(entry.key)} onRectCommit={next => commitRect(entry.key, next)}
                registerFrame={frame => { if (frame) frameRefs.current.set(entry.key, frame); }}
                onOpen={(href, title) => openRoute(href, title)} onReturnToDesktop={() => requestCloseWindow(entry.key)} />;
            }
            return (
              <DesktopWindow
                guest={windowGuests[entry.key] || orders.find(order => entry.key === `/work-orders/${order.id}`)}
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
                    onReturnToDesktop={() => requestCloseWindow(entry.key)}
                  />
                )}
                {entry.kind === "pool-status" && <PoolStatus canReopen={profileCanReopenPool(session.user)}/>}
                {entry.kind === "list" && (
                  <WorkOrderListWindow
                    preferencesScope={`${session.hotelId}:${session.user.id}`}
                    frontDeskLayout={frontDeskLayout}
                    orders={orders}
                    drafts={drafts.map((draft) => ({
                      ...draft,
                      potential_duplicate: orders.some((order) => likelyDuplicate(draft, order)),
                    }))}
                    loading={loading}
                    onOpenWorkOrder={(order, opener) => openWorkOrder(order.id, opener)}
                    onOpenDraft={openDraft}
                  />
                )}
                {entry.kind === "approvals" && (
                  <div className="flex h-full min-h-0 flex-col"><div className="min-h-0 flex-1">
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
                  /></div>
                  {canReviewTickets && <nav aria-label={t("Approval pages")} className="flex justify-between gap-2 p-2 text-sm">
                    <button disabled={loading || approvalPage === 0} onClick={() => { approvalPageRef.current--; setApprovalPage(approvalPageRef.current); void loadDashboard(true); }}>{t("Previous")}</button>
                    <span>{t("Page ")}{approvalPage + 1} · {approvalTotal}{t(" awaiting approval")}</span>
                    <button disabled={loading || (approvalPage + 1) * 100 >= approvalTotal} onClick={() => { approvalPageRef.current++; setApprovalPage(approvalPageRef.current); void loadDashboard(true); }}>{t("Next")}</button>
                  </nav>}
                  </div>
                )}
              </DesktopWindow>
            );
          })}
        </div>
      </div>
    </main>
  );
}
