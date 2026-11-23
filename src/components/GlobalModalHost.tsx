"use client";
import { isNotepadPath, notepadTargetId } from "@/lib/ui/notepad-navigation";
import { useUiLanguage } from "@/components/UiLanguageProvider";


import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {modalActionForRoute,modalThemeStyle,modalTitleStyle,modalDisplayTitle,hasBonvoyTierHelp} from '@/lib/ui/header-palette';
import WorkOrderTierKey from './WorkOrderTierKey';
import RoomRankerKey from './RoomRankerKey';
import WorkOrderTitleGuest from './WorkOrderTitleGuest';
import WorkOrderListWindow, { type DesktopWorkOrder } from './desktop/WorkOrderListWindow';
import DesktopWindow from './desktop/DesktopWindow';
import WeatherPreviewWindow from './desktop/WeatherPreviewWindow';
import { loadCmpriSession } from '@/lib/auth/client-session';
import { claimWorkOrder, releaseWorkOrder } from '@/lib/open-work-orders';
import { canResumeWorkspaceView } from '@/lib/ui/workspace-route-access';
import { clearWorkspace, normalizeWorkspaceHref, readWorkspace, saveWorkspace, workspaceIdentity, workspaceResumeHref,
  type WorkspaceIdentity, type WorkspaceOptions, type WorkspaceView } from '@/lib/ui/workspace-resume';
import { defaultWindowRect, desktopWindowKeyForHref, isAskRecordRoute, refocusAssetWindow, type DesktopBounds, type WindowRect } from '@/lib/ui/desktop-windows';
import { animateWindowTelescope, captureWindowLauncher, clearWindowTelescope, currentWindowLauncher, type WindowLauncher } from '@/lib/ui/window-telescope';

type ModalEntry = {
  guest?: Record<string,unknown>;
  id: string;
  href: string;
  title: string;
  modalToken?: string;
  returnFocus?: HTMLElement | null;
  launcher?: WindowLauncher;
  kind?: "work-order-list";
  rect?: WindowRect;
  openedAt?: number;
  weatherCached?: boolean;
};

type TechnicianDesktop = {
  anchor: HTMLElement;
  bulletinHost: HTMLElement | null;
  bounds: DesktopBounds;
  left: number;
  top: number;
};

const WEATHER_PATH = "/previews/cmpri-weather-preview.html";
const WORK_ORDER_LIST_PATH = "/work-order-list";
const TECHNICIAN_LAUNCHER_CLOSE_MS = 5_000;
const EMPTY_WORK_ORDERS: DesktopWorkOrder[] = [];

function EmbeddedModalFrame({ entryId, register, ...props }: ComponentPropsWithoutRef<"iframe"> & {
  entryId: string;
  register: (id: string, frame: HTMLIFrameElement | null) => void;
}) {
  const ref = useCallback((frame: HTMLIFrameElement | null) => register(entryId, frame), [entryId, register]);
  return <iframe {...props} ref={ref} />;
}

function desktopEntryKey(entry: ModalEntry) {
  if (entry.kind === "work-order-list") return "work-order-list";
  const url = new URL(entry.href, window.location.origin);
  const draftId = url.pathname === "/work-orders" && url.searchParams.get("draftId");
  return draftId ? `work-order-draft:${draftId}` : desktopWindowKeyForHref(entry.href, url.origin);
}

function needsNonmodalDashboardShell() {
  const launcher = document.querySelector<HTMLElement>("#desktop-ask-search");
  return Boolean(launcher && typeof launcher.showPopover !== "function" && typeof window.matchMedia === "function"
    && window.matchMedia("(min-width: 701px) and (hover: hover)").matches);
}

function openDashboardStaffNotes(href: string, opener?: HTMLElement) {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin || !isNotepadPath(url.pathname) || !document.querySelector("header.cmpri-dashboard-titlebar [data-cmpri-ask-launcher]")) return false;
  window.dispatchEvent(new CustomEvent("cmpri-ask-open", { detail: { tab: "notepad", noteId: notepadTargetId(url), opener } }));
  return true;
}

type ModalPanelStyle = CSSProperties & {
  "--cmpri-modal-width": string;
  "--cmpri-modal-height": string;
  "--cmpri-modal-mobile-width": string;
  "--cmpri-modal-mobile-height": string;
};

function modalHref(href: string, forceEmbedded = false) {
  const isWorkOrderDetail = /^\/work-orders\/[^/?#]+(?:[/?#]|$)/.test(href);
  const modalRoutes = new Set([
    "/staff-notes",
    "/notes",
    "/notepad",
    "/work-orders",
    "/management/equipment",
    "/management/rooms",
    "/management/users",
    "/profile",
    "/profile/ai-connection",
    "/engineering/room-ranker",
    "/engineering/room-ranking",
    "/engineering/preventive-maintenance",
    "/engineering/winter-preparedness",
    "/engineering/purchasing",
    "/engineering/gss",
    "/engineering/pool-log",
    "/pool",
    "/engineering/hours-tracker",
    "/engineering/room-operations",
    "/engineering/enseo-assignments",
    "/engineering/parts",
    "/engineering/import-work-orders",
    "/previews/cmpri-weather-preview.html",
    "/feedback",
  ]);
  if (!forceEmbedded && !isWorkOrderDetail && !modalRoutes.has(new URL(href, window.location.origin).pathname)) {
    return { href, modalToken: undefined };
  }
  const modalToken = crypto.randomUUID();
  const url = new URL(href, window.location.origin);
  url.searchParams.set("embedded", "1");
  url.searchParams.set("modalToken", modalToken);
  return { href: `${url.pathname}${url.search}${url.hash}`, modalToken };
}

function isSameOriginInternal(href: string): boolean {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
    return false;
  }
  try {
    const url = new URL(href, window.location.origin);
    return (href.startsWith("/") || url.origin === window.location.origin)
      && url.origin === window.location.origin
      && url.pathname !== "/api"
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/_");
  } catch {
    return false;
  }
}

function isExcludedNavigation(target: Element | null): boolean {
  if (!target) return true;
  if (target.closest("[data-cmpri-modal-ignore='true']")) return true;
  if (target.closest("button[data-cmpri-modal-close='true']")) return true;
  if (target.closest("button[type='button']")
    && !target.closest("[data-cmpri-modal-trigger='true']")
    && !target.closest("[data-cmpri-modal-dashboard='true']")) {
    return true;
  }
  return false;
}

function deriveTitle(target: Element): string {
  const explicit = target.getAttribute("aria-label") || target.getAttribute("title");
  if (explicit && explicit.trim()) return explicit.trim();
  const text = (target.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const href = target.getAttribute("href") || "";
  return href || "Open screen";
}

function workOrderId(href: string) {
  const path = new URL(href, window.location.origin).pathname;
  const match = /^\/work-orders\/([^/]+)$/.exec(path);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function modalBackdrop(element: HTMLElement) {
  const explicit = element.closest<HTMLElement>('.cmpri-modal-backdrop, [class~="fixed"][class~="inset-0"]');
  if (explicit) return explicit;
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (["fixed", "absolute"].includes(style.position) && [style.top, style.right, style.bottom, style.left].every(value => value === "0px")) return parent;
  }
  return element;
}

function workspaceModalView(entry: ModalEntry): WorkspaceView | null {
  if (entry.kind === "work-order-list") return { key: "work-order-list", kind: "list" };
  const href = normalizeWorkspaceHref(entry.href, window.location.origin);
  if (!href) return null;
  const url = new URL(href, window.location.origin), draft = url.searchParams.get("draftId");
  const key = url.pathname === "/work-orders" && url.searchParams.get("reviewDraft") === "1" && draft
    ? "work-order-draft:" + draft : url.pathname;
  return { key, href, kind: "frame" };
}

function restoredModalTitle(href: string) {
  const path = new URL(href, window.location.origin).pathname;
  if (/^\/work-orders\/[^/]+$/.test(path)) return "Work Order";
  const titles: Record<string, string> = { "/work-orders": "Create Work Order", "/profile": "Manage Profile",
    "/profile/ai-connection": "ChatGPT Connection", "/staff-notes": "Notepad", "/notes": "Notepad", "/notepad": "Notepad",
    "/management/equipment": "Assets", "/management/rooms": "Manage Locations", "/management/users": "Manage Users",
    "/engineering/preventive-maintenance": "Preventative Maintenance", "/engineering/purchasing": "PO",
    "/engineering/parts": "Inventory", "/engineering/pool-log": "Pool Log", "/pool": "Pool",
    "/engineering/room-ranking": "Room Ranker", "/engineering/room-ranker": "Room Ranker",
    "/engineering/room-operations": "Daily Room Ops", "/engineering/gss": "GSS Reports",
    "/engineering/enseo-assignments": "Enseo Assignments", "/engineering/hours-tracker": "Hours Tracker",
    "/engineering/winter-preparedness": "Winter Preparedness 2026", "/feedback": "Feedback" };
  return titles[path] || "Open screen";
}

export default function GlobalModalHost() {
  const { t, tt } = useUiLanguage();
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams().toString();
  const publicRoute = !pathname || pathname === "/" || /^\/(?:auth|oauth|login|logout|sign-in|sign-out|employment)(?:\/|$)/.test(pathname);
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [canViewWorkOrders, setCanViewWorkOrders] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<HTMLElement | null>(null);
  const workOrderShortcutTarget = dialogTarget?.isConnected
    && dialogTarget.matches('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])')
    && !dialogTarget.matches("#ask-cmpri, [data-cmpri-guide-dialog]") ? dialogTarget : null;
  const [nativeObscuresStack, setNativeObscuresStack] = useState(false);
  const [shellSuspended, setShellSuspended] = useState(false);
  const [nativeShell, setNativeShell] = useState<HTMLDialogElement | null>(null);
  const [limitMessage, setLimitMessage] = useState("");
  const [technicianDesktop, setTechnicianDesktop] = useState<TechnicianDesktop | null>(null);
  const technicianDesktopRef = useRef<TechnicianDesktop | null>(null);
  const technicianAnchor = technicianDesktop?.anchor;
  const stackRef = useRef<ModalEntry[]>([]);
  const [owner] = useState(() => crypto.randomUUID());
  const nativeShellRef = useRef<HTMLDialogElement | null>(null);
  const suspendedDialogsRef = useRef<HTMLDialogElement[]>([]);
  const suspendedCustomRef = useRef<Array<{ element: HTMLElement; value: string; priority: string }>>([]);
  const activeIdRef = useRef<string | null>(null);
  const requestCloseRef = useRef<(entryId: string) => void>(() => {});
  const openingWindows = useRef(new Set<string>());
  const closingWindows = useRef(new Set<string>());
  const resumeScreensRef = useRef<() => void>(() => {});
  useLayoutEffect(() => { stackRef.current = stack; }, [stack]);
  const modalRootRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const embeddedCleanupRefs = useRef(new Map<string, () => void>());
  const previousStackRef = useRef<ModalEntry[]>([]);
  const previousActiveRef = useRef<string | null>(null);
  const hasOpenModals = stack.length > 0;
  const dashboardOverlay = hasOpenModals && !technicianDesktop && !nativeShell;
  const workspaceRef = useRef<{ identity: WorkspaceIdentity; options: WorkspaceOptions } | null>(null);
  const workspaceIdentityRef = useRef<WorkspaceIdentity | null>(null);
  const workspaceLatestIdentityRef = useRef<WorkspaceIdentity | null>(null);
  const workspaceRestoredRef = useRef(false);
  const workspaceStoppedRef = useRef(false);
  const workspaceSignInSeenRef = useRef(false);
  const workspaceGenerationRef = useRef(0);
  const workspaceCheckingRef = useRef(false);
  const workspaceRouteDecidedRef = useRef(false);
  const workspaceTouchedRef = useRef(false);
  const workspaceScopeBlockedRef = useRef(false);
  const workspaceBlockedRef = useRef(false);
  const [workspaceBlocked, setWorkspaceBlocked] = useState(false);
  const workspaceHidden = workspaceBlocked || publicRoute;
  const [workspaceReady, setWorkspaceReady] = useState(0);
  const [workspacePreferencesScope, setWorkspacePreferencesScope] = useState<string>();
  const [workspaceCheck, setWorkspaceCheck] = useState(0);

  useLayoutEffect(() => {
    if (pathname !== "/technician" || window.parent !== window) return;
    const anchor = document.querySelector<HTMLElement>("[data-cmpri-technician-window-anchor]");
    const header = anchor?.parentElement?.querySelector("header");
    if (!anchor || !header) return;
    const menuOverlay = header.querySelector<HTMLElement>(".cmpri-dashboard-menu-overlay");
    const bulletinHost = anchor.parentElement?.querySelector<HTMLElement>("[data-weather-desktop-bulletin-host]") ?? null;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const rowDepth = parseFloat(getComputedStyle(header).getPropertyValue("--cmpri-menu-open-row-depth")) || 0;
      const top = Math.max(rect.top, header.getBoundingClientRect().bottom + rowDepth, menuOverlay?.getBoundingClientRect().bottom ?? 0, 0);
      const bounds = { width: Math.floor(rect.width), height: Math.max(0, Math.floor(window.innerHeight - top)) };
      const previous = technicianDesktopRef.current;
      if (previous?.left === rect.left && previous.top === top
        && previous.bounds.width === bounds.width && previous.bounds.height === bounds.height) return;
      const desktop = { anchor, bulletinHost, left: rect.left, top, bounds };
      technicianDesktopRef.current = desktop;
      setTechnicianDesktop(desktop);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(header);
    if (menuOverlay) observer.observe(menuOverlay);
    if (bulletinHost) observer.observe(bulletinHost);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      technicianDesktopRef.current = null;
      setTechnicianDesktop(null);
      for (const entry of stackRef.current) {
        const id = workOrderId(entry.href);
        if (id) releaseWorkOrder(id, owner);
      }
      stackRef.current = [];
      setStack([]);
      setActiveId(null);
      setLimitMessage("");
    };
  }, [owner, pathname]);

  useEffect(() => {
    if (window.parent !== window || new URLSearchParams(window.location.search).get("embedded") === "1") return;
    const id = workOrderId(pathname || "/");
    if (!id) return;
    const result = claimWorkOrder(id, owner, () => window.focus());
    if (result !== "claimed") return;
    return () => releaseWorkOrder(id, owner);
  }, [pathname, owner]);

  useEffect(() => {
    if (window.parent !== window || technicianAnchor) return;
    const update = () => {
      if (stackRef.current.length) return;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('dialog:modal, [role="dialog"][aria-modal="true"]'))
        .filter(dialog => dialog.getClientRects().length > 0 && !dialog.closest('[inert], [hidden], [aria-hidden="true"]'));
      const nativeDialogs = dialogs.filter(dialog => dialog.matches("dialog:modal"));
      setDialogTarget(nativeDialogs.at(-1) || dialogs.at(-1) || null);
    };
    update();
    const observer = new MutationObserver(records => {
      if (!stackRef.current.length) { update(); return; }
      // A native dialog opened asynchronously sits above our shell. Offer the
      // launcher inside that dialog without moving any of the mounted iframes.
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName !== "open") continue;
        const candidates = record.type === "attributes" ? [record.target] : Array.from(record.addedNodes);
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement)) continue;
          const dialogs = candidate instanceof HTMLDialogElement ? [candidate] : Array.from(candidate.querySelectorAll<HTMLDialogElement>("dialog[open]"));
          for (const dialog of dialogs) {
            if (dialog === nativeShellRef.current) continue;
            if (dialog.open && dialog.matches("dialog:modal")) { setDialogTarget(dialog); setNativeObscuresStack(true); }
            else if (dialog === dialogTarget && !dialog.open) setNativeObscuresStack(false);
          }
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open", "aria-modal", "aria-hidden", "style", "class", "hidden", "inert"] });
    document.addEventListener("close", update, true);
    return () => { observer.disconnect(); document.removeEventListener("close", update, true); };
  }, [hasOpenModals, dialogTarget, technicianAnchor]);

  useEffect(() => {
    if (technicianAnchor || (!hasOpenModals && !workOrderShortcutTarget)) return;
    let live = true;
    void loadCmpriSession().then(session => {
      if (live) setCanViewWorkOrders(session.capabilities.includes("view_work_orders"));
    }).catch(() => { if (live) setCanViewWorkOrders(false); });
    return () => { live = false; };
  }, [hasOpenModals, workOrderShortcutTarget, technicianAnchor]);

  const openEntry = useCallback((entry: ModalEntry, clickedAt?: number) => {
    if (workspaceBlockedRef.current) return;
    workspaceTouchedRef.current = true;
    const desktop = technicianDesktopRef.current;
    if (desktop) {
      const key = desktopEntryKey(entry);
      const existing = stackRef.current.find(item => desktopEntryKey(item) === key);
      if (existing) {
        if (closingWindows.current.has(existing.id)) return;
        const sameLauncher = !entry.launcher || !existing.launcher
          || currentWindowLauncher(existing.launcher) === entry.launcher.element;
        if (clickedAt !== undefined && existing.openedAt !== undefined && !existing.weatherCached
          && sameLauncher
          && (entry.kind !== "work-order-list" || activeIdRef.current === existing.id)
          && clickedAt - existing.openedAt <= TECHNICIAN_LAUNCHER_CLOSE_MS) {
          requestCloseRef.current(existing.id);
          return;
        }
        if (existing.weatherCached) {
          const reopen = (item: ModalEntry) => item.id === existing.id
            ? { ...item, launcher: entry.launcher, weatherCached: false, openedAt: clickedAt ?? Date.now() } : item;
          if (entry.launcher) openingWindows.current.add(existing.id);
          stackRef.current = stackRef.current.map(reopen);
          setStack(current => current.map(reopen));
        }
        refocusAssetWindow(frameRefs.current.get(existing.id), existing.href);
        setActiveId(existing.id);
        return;
      }
      const preferred = key === WEATHER_PATH ? { width: 1280, height: 800 }
        : entry.kind === "work-order-list" ? { width: 1100, height: 640 } : { width: 900, height: 760 };
      entry = {
        ...entry,
        openedAt: clickedAt ?? Date.now(),
        rect: defaultWindowRect(desktop.bounds, preferred, stackRef.current.filter(item => !item.weatherCached).length),
      };
    }
    if (!desktop) {
      const key = desktopEntryKey(entry);
      const existing = key.includes("?") ? stackRef.current.find(item => desktopEntryKey(item) === key) : undefined;
      if (existing) {
        refocusAssetWindow(frameRefs.current.get(existing.id), existing.href);
        setActiveId(existing.id);
        return;
      }
    }
    const id = workOrderId(entry.href);
    if (id) {
      const existing = stackRef.current.find(item => workOrderId(item.href) === id);
      if (existing) { setLimitMessage(""); setActiveId(existing.id); return; }
      const result = claimWorkOrder(id, owner, () => {
        const shell = nativeShellRef.current;
        if (shell && !shell.open) resumeScreensRef.current();
        else if (shell) { shell.close(); shell.showModal(); }
        setActiveId(entry.id);
      });
      if (result === "existing") {
        if (nativeShellRef.current?.open) {
          nativeShellRef.current.close();
          // Reveal the already-open editor without unmounting the dialogs which
          // were underneath this shell. Suppress the one synthetic close event:
          // their own close handlers would otherwise discard the modal's state.
          const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog:modal"));
          suspendedDialogsRef.current = dialogs.filter(dialog => dialog !== nativeShellRef.current);
          for (const dialog of suspendedDialogsRef.current.slice().reverse()) {
            dialog.addEventListener("close", event => event.stopImmediatePropagation(), { capture: true, once: true });
            dialog.close();
          }
          const custom = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
            .filter(element => !nativeShellRef.current?.contains(element) && element.getClientRects().length > 0 && !element.closest('[inert], [hidden], [aria-hidden="true"]'))
            .map(modalBackdrop);
          suspendedCustomRef.current = Array.from(new Set(custom)).map(element => ({ element, value: element.style.getPropertyValue("visibility"), priority: element.style.getPropertyPriority("visibility") }));
          for (const { element } of suspendedCustomRef.current) element.style.setProperty("visibility", "hidden", "important");
          setNativeObscuresStack(false);
          setShellSuspended(true);
        }
        setLimitMessage("");
        return;
      }
      if (result === "limit") {
        setLimitMessage("You can have up to five work orders open. Close one before opening another.");
        return;
      }
    }
    setLimitMessage("");
    // A separate native top-layer shell keeps this stack independent of the
    // underlying dialog, even if that dialog closes asynchronously.
    if (!desktop && !stackRef.current.length && !nativeShellRef.current && !needsNonmodalDashboardShell()) {
      const shell = document.createElement("dialog");
      shell.setAttribute("aria-label", "Open screens");
      shell.dataset.cmpriGlobalModalShell = "true";
      for (const [name, value] of Object.entries({ position:"fixed", inset:"0", width:"100vw", height:"100dvh", "max-width":"none", "max-height":"none", margin:"0", padding:"0", border:"0", background:"transparent" })) shell.style.setProperty(name, value, "important");
      shell.addEventListener("cancel", event => { event.preventDefault(); if (activeIdRef.current) requestCloseRef.current(activeIdRef.current); });
      document.body.appendChild(shell);
      shell.showModal();
      nativeShellRef.current = shell;
      setNativeShell(shell);
      setNativeObscuresStack(false);
    }
    if (entry.launcher) openingWindows.current.add(entry.id);
    stackRef.current = [...stackRef.current, entry];
    setStack(current => [...current, entry]);
    setActiveId(entry.id);
  }, [owner]);

  const openWorkOrderList = useCallback((clickedAt?: number, opener?: HTMLElement) => {
    if (workspaceBlockedRef.current) return;
    if (nativeShellRef.current && nativeObscuresStack) {
      nativeShellRef.current.close();
      nativeShellRef.current.showModal();
      setNativeObscuresStack(false);
    }
    const existing = stackRef.current.find(item => item.kind === "work-order-list");
    if (existing && !technicianDesktopRef.current) setActiveId(existing.id);
    else openEntry({ id: crypto.randomUUID(), href: WORK_ORDER_LIST_PATH, title: "Work Order List", kind: "work-order-list", returnFocus: opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null), launcher: captureWindowLauncher(opener) }, clickedAt);
  }, [nativeObscuresStack, openEntry]);

  const resumeScreens = useCallback(() => {
    if (workspaceBlockedRef.current) return;
    for (const { element, value, priority } of suspendedCustomRef.current) {
      if (value) element.style.setProperty("visibility", value, priority); else element.style.removeProperty("visibility");
    }
    suspendedCustomRef.current = [];
    for (const dialog of suspendedDialogsRef.current) if (dialog.isConnected && !dialog.open) dialog.showModal();
    suspendedDialogsRef.current = [];
    if (nativeShellRef.current && !nativeShellRef.current.open) nativeShellRef.current.showModal();
    setShellSuspended(false);
  }, []);
  useLayoutEffect(() => { resumeScreensRef.current = resumeScreens; }, [resumeScreens]);

  useEffect(() => {
    document.documentElement.dataset.cmpriFramed = window.parent !== window ? "true" : "false";
    document.documentElement.dataset.cmpriEmbedded =
      new URLSearchParams(window.location.search).get("embedded") === "1" ? "true" : "false";
    try {
      const appearance = window.localStorage.getItem("cmpri:appearance");
      if (appearance === "light" || appearance === "dark") document.documentElement.dataset.theme = appearance;
    } catch {}
  }, []);

  const windowPanel = useCallback((entry: ModalEntry) => {
    const selector = entry.rect
      ? `[data-cmpri-desktop-window="${CSS.escape(desktopEntryKey(entry))}"]`
      : `[data-modal-entry="${CSS.escape(entry.id)}"]`;
    return modalRootRef.current?.querySelector<HTMLElement>(selector) ?? null;
  }, []);

  useLayoutEffect(() => {
    for (const entry of stack) {
      const panel = windowPanel(entry);
      if (!panel) continue;
      if (entry.weatherCached) clearWindowTelescope(panel);
      if (openingWindows.current.delete(entry.id)) animateWindowTelescope(panel, entry.launcher, "open");
    }
  }, [stack, technicianDesktop, windowPanel]);

  const removeModal = useCallback((entryId: string) => {
    setLimitMessage("");
    const closing = stackRef.current.find(entry => entry.id === entryId);
    if (closing?.rect && desktopEntryKey(closing) === WEATHER_PATH) {
      const hide = (entry: ModalEntry) => entry.id === entryId ? { ...entry, weatherCached: true } : entry;
      stackRef.current = stackRef.current.map(hide);
      setStack(current => current.map(hide));
      setActiveId(current => current === entryId ? stackRef.current.filter(entry => !entry.weatherCached).at(-1)?.id ?? null : current);
      return;
    }
    const id = workOrderId(closing?.href || "/");
    if (id) releaseWorkOrder(id, owner);
    const remaining = stackRef.current.filter(entry => entry.id !== entryId);
    stackRef.current = remaining;
    if (!remaining.length && nativeShellRef.current) {
      nativeShellRef.current.close();
      nativeShellRef.current.remove();
      nativeShellRef.current = null;
      setNativeShell(null);
    }
    setStack(current => current.filter(entry => entry.id !== entryId));
    setActiveId(current => current === entryId ? remaining.filter(entry => !entry.weatherCached).at(-1)?.id ?? null : current);
  }, [owner]);

  const closeModal = useCallback((entryId: string) => {
    if (closingWindows.current.has(entryId)) return;
    const entry = stackRef.current.find(item => item.id === entryId);
    const motion = entry ? animateWindowTelescope(windowPanel(entry), entry.launcher, "close") : null;
    if (!motion) { removeModal(entryId); return; }
    closingWindows.current.add(entryId);
    void motion.finished.then(() => removeModal(entryId)).catch(() => undefined)
      .finally(() => closingWindows.current.delete(entryId));
  }, [removeModal, windowPanel]);

  const requestModalClose = useCallback((entryId: string) => {
    const frameDocument = frameRefs.current.get(entryId)?.contentDocument;
    if (!frameDocument) {
      closeModal(entryId);
      return;
    }
    const cancelRequest = new Event("cmpri-modal-cancel-request", { cancelable: true });
    if (frameDocument.dispatchEvent(cancelRequest)) closeModal(entryId);
  }, [closeModal]);
  useLayoutEffect(() => { activeIdRef.current = activeId; requestCloseRef.current = requestModalClose; }, [activeId, requestModalClose]);

  // Navigation identity only. Editors keep ownership of their own saved drafts
  // and cancel guards; no guest, form, auth or iframe-token data enters this store.
  useEffect(() => {
    if (window.parent !== window || new URLSearchParams(window.location.search).get("embedded") === "1") return;
    workspaceRef.current = null;
    if (publicRoute) {
      if (workspaceStoppedRef.current && (pathname === "/" || pathname === "/sign-in")) workspaceSignInSeenRef.current = true;
      workspaceBlockedRef.current = true;
      nativeShellRef.current?.close();
      // Render hides public-route contents immediately. Keep subsequent private
      // routes blocked until they verify, without synchronously cascading state.
      let live = true;
      void Promise.resolve().then(() => {
        if (!live) return;
        setWorkspaceBlocked(true);
        setWorkspacePreferencesScope(undefined);
      });
      return () => { live = false; };
    }
    const reconnecting = workspaceStoppedRef.current && workspaceSignInSeenRef.current;
    if (workspaceStoppedRef.current && !reconnecting) return;
    const generation = workspaceGenerationRef.current;
    const checkedHref = window.location.href;
    workspaceCheckingRef.current = true;
    let live = true;
    void loadCmpriSession().then(session => {
      const identity = workspaceIdentity(session);
      // Even if sign-out navigated away while this check was pending, its
      // verified owner can now be cleared without hydrating or setting state.
      if (generation !== workspaceGenerationRef.current || (workspaceStoppedRef.current && !reconnecting)) {
        if (workspaceStoppedRef.current) try { clearWorkspace(window.localStorage, identity); } catch {}
        return;
      }
      if (!live) return;
      workspaceCheckingRef.current = false;
      workspaceLatestIdentityRef.current = identity;
      const previousIdentity = workspaceIdentityRef.current;
      if (reconnecting) {
        workspaceStoppedRef.current = false;
        workspaceSignInSeenRef.current = false;
      }
      if (reconnecting || (previousIdentity && JSON.stringify(previousIdentity) !== JSON.stringify(identity))) {
        // Never copy another account/property/permission scope's open routes.
        // Existing editors retain first refusal instead of bypassing a save.
        workspaceBlockedRef.current = true; setWorkspaceBlocked(true);
        setWorkspacePreferencesScope(undefined);
        nativeShellRef.current?.close();
        workspaceRestoredRef.current = false;
        workspaceRouteDecidedRef.current = false;
        workspaceTouchedRef.current = false;
        for (const entry of stackRef.current.slice()) requestModalClose(entry.id);
        // Modeless Weather keeps its loaded iframe only within this verified
        // scope. A closed cache must not masquerade as an editor refusing save.
        const retained = stackRef.current.filter(entry => !entry.weatherCached);
        if (retained.length !== stackRef.current.length) {
          stackRef.current = retained;
          setStack(retained);
          setActiveId(current => retained.some(entry => entry.id === current) ? current : retained.at(-1)?.id ?? null);
        }
        if (stackRef.current.length) { workspaceScopeBlockedRef.current = true; return; }
      }
      workspaceBlockedRef.current = false; setWorkspaceBlocked(false);
      if (stackRef.current.length && nativeShellRef.current && !nativeShellRef.current.open) nativeShellRef.current.showModal();
      const options: WorkspaceOptions = { origin: window.location.origin, isAllowed: view => canResumeWorkspaceView(session, view) };
      const saved = readWorkspace(window.localStorage, identity, options);
      setCanViewWorkOrders(session.capabilities.includes("view_work_orders"));
      if (!workspaceRouteDecidedRef.current) {
        workspaceRouteDecidedRef.current = true;
        const href = !workspaceTouchedRef.current && window.location.href === checkedHref
          ? workspaceResumeHref(saved, checkedHref, session.landing, options) : null;
        if (href) {
          // Pause every host's top-level persistence until the destination has
          // mounted. Desktop windows patch only their independent section.
          workspaceIdentityRef.current = identity;
          router.replace(href);
          return;
        }
      }
      if (!workspaceRestoredRef.current) {
        workspaceRestoredRef.current = true;
        // A user action during the session check takes precedence over an old stack.
        if (!workspaceTouchedRef.current && !stackRef.current.length && saved?.modals.views.length) {
          let restoredActive: string | null = null;
          for (const view of saved.modals.views) {
            if (view.kind !== "list" && (view.kind !== "frame" || !view.href)) continue;
            const id = crypto.randomUUID();
            const entry: ModalEntry = view.kind === "list"
              ? { id, href: "/__work-order-list", kind: "work-order-list", title: "Work Order List" }
              : { id, ...modalHref(view.href!, true), title: restoredModalTitle(view.href!) };
            openEntry(entry);
            if (view.key === saved.modals.activeKey && stackRef.current.some(item => item.id === id)) restoredActive = id;
          }
          if (restoredActive) setActiveId(restoredActive);
        }
      }
      workspaceIdentityRef.current = identity;
      workspaceRef.current = { identity, options };
      setWorkspacePreferencesScope(`${identity.hotelId}:${identity.userId}`);
      setWorkspaceReady(value => value + 1);
    }).catch(() => {
      // loadCmpriSession fails for revoked access as well as failed transport.
      // Retain protected drafts, but hide them until a fresh check succeeds.
      if (live) {
        workspaceCheckingRef.current = false;
        workspaceBlockedRef.current = true; setWorkspaceBlocked(true);
        setWorkspacePreferencesScope(undefined);
        nativeShellRef.current?.close();
      }
    });
    return () => { live = false; };
  }, [pathname, search, publicRoute, workspaceCheck, openEntry, requestModalClose, router]);
  useEffect(() => {
    if (!stack.length && workspaceScopeBlockedRef.current && !workspaceStoppedRef.current) {
      workspaceScopeBlockedRef.current = false;
      setWorkspaceCheck(value => value + 1);
    }
  }, [stack.length]);

  const persistWorkspace = useCallback(() => {
    const context = workspaceRef.current;
    if (!context || workspaceStoppedRef.current || workspaceBlockedRef.current || !workspaceRestoredRef.current || window.parent !== window) return;
    const currentPath = window.location.pathname;
    if (currentPath === "/" || /^\/(?:auth|oauth|login|logout|sign-in|sign-out|employment)(?:\/|$)/.test(currentPath)) return;
    const views = stackRef.current.filter(entry => !entry.weatherCached).map(workspaceModalView).filter((view): view is WorkspaceView => Boolean(view));
    const active = stackRef.current.find(entry => entry.id === activeIdRef.current);
    try {
      saveWorkspace(window.localStorage, context.identity,
        { topHref: window.location.href, modals: { views, activeKey: active ? workspaceModalView(active)?.key || null : null } }, context.options);
    } catch { /* Blocked device storage does not interfere with an open editor. */ }
  }, []);
  useEffect(() => { persistWorkspace(); }, [stack, activeId, workspaceReady, pathname, persistWorkspace]);
  useEffect(() => {
    const signOut = () => {
      const identity = workspaceLatestIdentityRef.current || workspaceIdentityRef.current || workspaceRef.current?.identity;
      workspaceStoppedRef.current = true;
      workspaceSignInSeenRef.current = false;
      workspaceGenerationRef.current += 1;
      workspaceRef.current = null;
      workspaceBlockedRef.current = true; setWorkspaceBlocked(true);
      setWorkspacePreferencesScope(undefined);
      nativeShellRef.current?.close();
      try { if (identity) clearWorkspace(window.localStorage, identity); } catch {}
    };
    const sessionChanged = (event: Event) => {
      if (workspaceStoppedRef.current || workspaceCheckingRef.current
        || !(event as CustomEvent<{ topics?: string[] }>).detail?.topics?.includes("session")) return;
      workspaceRef.current = null;
      setWorkspaceCheck(value => value + 1);
    };
    const hidden = () => { if (document.hidden) persistWorkspace(); };
    window.addEventListener("cmpri-workspace-sign-out", signOut);
    window.addEventListener("cmpri-data-cache-invalidated", sessionChanged);
    window.addEventListener("pagehide", persistWorkspace);
    window.addEventListener("popstate", persistWorkspace);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("cmpri-workspace-sign-out", signOut);
      window.removeEventListener("cmpri-data-cache-invalidated", sessionChanged);
      window.removeEventListener("pagehide", persistWorkspace);
      window.removeEventListener("popstate", persistWorkspace);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [persistWorkspace]);
  function openWorkOrder(order: DesktopWorkOrder, opener?: HTMLElement) {
    const path = `/work-orders/${encodeURIComponent(order.id)}`;
    openEntry({
      id: crypto.randomUUID(), ...modalHref(path),
      title: `Work Order ${order.display_id || ""}${order.room ? ` · ${order.room}` : ""}`.trim(),
      guest: order,
      returnFocus: opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null),
      launcher: captureWindowLauncher(opener),
    });
  }

  const registerFrame = useCallback((entryId: string, frame: HTMLIFrameElement | null) => {
    if (frame) frameRefs.current.set(entryId, frame);
    else {
      embeddedCleanupRefs.current.get(entryId)?.();
      embeddedCleanupRefs.current.delete(entryId);
      frameRefs.current.delete(entryId);
    }
  }, []);

  function commitDesktopRect(entryId: string, rect: WindowRect) {
    setStack(current => current.map(entry => entry.id === entryId ? { ...entry, rect } : entry));
  }

  useEffect(() => () => {
    for (const entry of stackRef.current) { const id = workOrderId(entry.href); if (id) releaseWorkOrder(id, owner); }
    for (const { element, value, priority } of suspendedCustomRef.current) {
      if (value) element.style.setProperty("visibility", value, priority); else element.style.removeProperty("visibility");
    }
    for (const dialog of suspendedDialogsRef.current) if (dialog.isConnected && !dialog.open) dialog.showModal();
    nativeShellRef.current?.remove(); nativeShellRef.current = null;
  }, [owner]);

  function handleEmbeddedLoad(event: SyntheticEvent<HTMLIFrameElement>, entry: ModalEntry) {
    embeddedCleanupRefs.current.get(entry.id)?.();
    embeddedCleanupRefs.current.delete(entry.id);
    const frame = event.currentTarget;
    const document = frame.contentDocument;
    if (!document) return;
    const cleanups: Array<() => void> = [];
    const openNestedModal = (href: string, title: string) => {
      const modal = modalHref(href);
      openEntry({
        id: crypto.randomUUID(),
        ...modal,
        title,
        returnFocus: frameRefs.current.get(entry.id) || null,
      });
    };
    const closeOnEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        if (keyEvent.defaultPrevented) return;
        if (document.querySelector('dialog[open], [role="listbox"], [role="dialog"][aria-modal="true"]')) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        requestModalClose(entry.id);
        return;
      }
      if (keyEvent.key !== "Tab" || technicianDesktopRef.current) return;
      const content = document.querySelector("main") || document.body;
      const focusable = Array.from(content.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        keyEvent.preventDefault();
        frame.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (keyEvent.shiftKey && (document.activeElement === first || document.activeElement === document.body || !content.contains(document.activeElement))) {
        keyEvent.preventDefault();
        modalRootRef.current?.querySelector<HTMLElement>(`[data-modal-entry="${CSS.escape(entry.id)}"] nav button:last-child`)?.focus();
      } else if (!keyEvent.shiftKey && (document.activeElement === last || document.activeElement === document.body || !content.contains(document.activeElement))) {
        keyEvent.preventDefault();
        modalRootRef.current?.querySelector<HTMLElement>(`[data-modal-entry="${CSS.escape(entry.id)}"] nav button:first-child`)?.focus();
      }
    };
    const openNestedScreen = (navigationEvent: MouseEvent) => {
      if (navigationEvent.defaultPrevented || navigationEvent.button !== 0
        || navigationEvent.metaKey || navigationEvent.ctrlKey || navigationEvent.shiftKey || navigationEvent.altKey) return;
      const target = (navigationEvent.target as Element | null)
        ?.closest("a[href], button[data-cmpri-modal-trigger='true'], button[data-cmpri-modal-dashboard='true']");
      if (!target || target.closest("[data-cmpri-modal-ignore='true']")) return;
      const isDashboardAction = !!target.closest("[data-cmpri-modal-dashboard='true']");
      const href = target.localName === "a"
        ? (target as HTMLAnchorElement).href
        : isDashboardAction
          ? (target as HTMLButtonElement).dataset.cmpriModalDashboardHref || "/engineering"
          : (target as HTMLButtonElement).dataset.cmpriModalHref || "";
      if (target.localName === "a"
        && ((target as HTMLAnchorElement).target === "_blank" || target.hasAttribute("download"))) return;
      if (!isSameOriginInternal(href)) return;
      navigationEvent.preventDefault();
      navigationEvent.stopPropagation();
      if (isDashboardAction || ["/engineering", "/front-desk"].includes(new URL(href, window.location.origin).pathname)) {
        requestModalClose(entry.id);
        return;
      }
      openNestedModal(href, deriveTitle(target));
    };
    document.addEventListener("click", openNestedScreen, true);
    cleanups.push(() => document.removeEventListener("click", openNestedScreen, true));
    document.addEventListener("keydown", closeOnEscape);
    cleanups.push(() => document.removeEventListener("keydown", closeOnEscape));
    if (technicianDesktopRef.current) {
      const raise = () => setActiveId(entry.id);
      document.addEventListener("focusin", raise);
      document.addEventListener("pointerdown", raise);
      cleanups.push(() => {
        document.removeEventListener("focusin", raise);
        document.removeEventListener("pointerdown", raise);
      });
    }
    if (entry.id === activeId) frame.focus();

    const history = frame.contentWindow?.history;
    if (history) {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      const intercept = (original: typeof history.pushState) => (state: unknown, unused: string, url?: string | URL | null) => {
        if (url) {
          const nextUrl = new URL(String(url), frame.contentWindow?.location.href || window.location.href);
          if (isSameOriginInternal(nextUrl.href) && nextUrl.pathname !== frame.contentWindow?.location.pathname) {
            if (["/engineering", "/front-desk"].includes(nextUrl.pathname)) requestModalClose(entry.id);
            else openNestedModal(nextUrl.href, nextUrl.pathname);
            return;
          }
        }
        return original.call(history, state, unused, url);
      };
      const wrappedPushState = intercept(originalPushState) as typeof history.pushState;
      const wrappedReplaceState = intercept(originalReplaceState) as typeof history.replaceState;
      history.pushState = wrappedPushState;
      history.replaceState = wrappedReplaceState;
      cleanups.push(() => {
        if (history.pushState === wrappedPushState) history.pushState = originalPushState;
        if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState;
      });
    }
    embeddedCleanupRefs.current.set(entry.id, () => cleanups.forEach((cleanup) => cleanup()));
  }

  useEffect(() => {
    const applyPreferences = (target: Document, preferences: { language: "en" | "es"; appearance: "light" | "dark" }) => {
      target.documentElement.dataset.theme = preferences.appearance;
    };
    const handleProfilePreferences = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "cmpri-profile-preferences-updated") return;
      const preferences = event.data.preferences;
      if (!preferences || !["en", "es"].includes(preferences.language) || !["light", "dark"].includes(preferences.appearance)) return;
      try {
        window.localStorage.setItem("cmpri:work-order-language", preferences.language);
        window.localStorage.setItem("cmpri:appearance", preferences.appearance);
      } catch {}
      applyPreferences(document, preferences);
      document.querySelectorAll("iframe").forEach((frame) => {
        try { if (frame.contentDocument) applyPreferences(frame.contentDocument, preferences); } catch {}
      });
    };
    window.addEventListener("message", handleProfilePreferences);
    return () => window.removeEventListener("message", handleProfilePreferences);
  }, []);

  useEffect(() => {
    const openFromEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ href?: string; title?: string; origin?: string; clickedAt?: number; opener?: HTMLElement; openerRect?: DOMRect }>).detail;
      if (event.defaultPrevented || !detail?.href || !isSameOriginInternal(detail.href)) return;
      if (window.parent !== window) {
        window.parent.postMessage({
          type: "cmpri-open-modal",
          href: detail.href,
          title: detail.title?.trim() || "Open screen",
          modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
        }, window.location.origin);
        return;
      }
      // Engineering owns Ask record windows in its existing desktop manager.
      if (detail.origin === "ask-cmpri" && document.querySelector("[data-cmpri-engineering-window-owner]")
        && isAskRecordRoute(detail.href, window.location.origin)) return;
      const desktop = technicianDesktopRef.current;
      const clickedAt = Number.isFinite(detail.clickedAt) ? detail.clickedAt : undefined;
      const opener = detail.opener instanceof HTMLElement ? detail.opener : undefined;
      if (openDashboardStaffNotes(detail.href, opener)) return;
      if (detail.href === WORK_ORDER_LIST_PATH) {
        if (desktop?.anchor.dataset.canViewWorkOrders === "true") openWorkOrderList(clickedAt, opener);
        return;
      }
      const modal = modalHref(detail.href);
      openEntry({
          id: crypto.randomUUID(),
          ...modal,
          title: detail.title?.trim() || "Open screen",
          returnFocus: opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null),
          launcher: captureWindowLauncher(opener, typeof DOMRect !== "undefined" && detail.openerRect instanceof DOMRect ? detail.openerRect : undefined),
      }, clickedAt);
    };

    const handleClick = (event: MouseEvent) => {
      if (window.parent !== window) return;
      if (workspaceBlockedRef.current) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element
        ? event.target.closest("a[href], button[data-cmpri-modal-trigger='true'], button[data-cmpri-modal-dashboard='true']")
        : null;
      if (!target || isExcludedNavigation(target)) return;

      const anchor = target instanceof HTMLAnchorElement ? target : null;
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        if (!isSameOriginInternal(href) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
        if (anchor.closest("[data-cmpri-modal-ignore='true']")) return;
        const returnToDashboard = target.closest("[data-cmpri-modal-dashboard='true']")
          || ["/engineering", "/front-desk"].includes(new URL(href, window.location.origin).pathname);
        if (returnToDashboard) {
          if (stack.length === 0) return;
          event.preventDefault();
          if (activeId) requestModalClose(activeId);
          return;
        }
        event.preventDefault();
        if (openDashboardStaffNotes(href, anchor)) return;
        openEntry({
          id: crypto.randomUUID(),
          ...modalHref(href),
          title: deriveTitle(anchor),
          returnFocus: anchor,
          launcher: captureWindowLauncher(anchor),
        });
        return;
      }

      const button = target as HTMLButtonElement;
      const isDashboardAction = !!button.closest("[data-cmpri-modal-dashboard='true']");
      const href = isDashboardAction
        ? button.dataset.cmpriModalDashboardHref || "/engineering"
        : button.dataset.cmpriModalHref;
      if (!href || !isSameOriginInternal(href)) return;
      if (isDashboardAction) {
        if (stack.length === 0) return;
        event.preventDefault();
        if (activeId) requestModalClose(activeId);
        return;
      }
      event.preventDefault();
      if (openDashboardStaffNotes(href, button)) return;
      openEntry({
        id: crypto.randomUUID(),
        ...modalHref(href),
        title: deriveTitle(button),
        returnFocus: button,
        launcher: captureWindowLauncher(button),
      });
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if (workspaceBlockedRef.current) return;
      if (event.key === "Tab" && activeId && !technicianDesktopRef.current && !dashboardOverlay) {
        const panel = modalRootRef.current?.querySelector<HTMLElement>(`[data-modal-entry="${CSS.escape(activeId)}"]`);
        const focusable = Array.from(panel?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex='-1'])") || []).filter(element => element.getClientRects().length > 0);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      if (event.key === "Escape" && stack.length > 0) {
        if (event.target instanceof Element && (event.target.closest("#ask-cmpri, #desktop-ask-search")
          || dashboardOverlay && event.target.closest("dialog:modal"))) return;
        if (event.defaultPrevented || (technicianDesktopRef.current
          && !(event.target instanceof Element && event.target.closest("[data-cmpri-technician-windows]")))) return;
        event.preventDefault();
        const top = stack.find(entry => entry.id === activeId);
        if (top) requestModalClose(top.id);
      }
    };

    window.addEventListener("cmpri-open-modal", openFromEvent as EventListener);
    window.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown);

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || stack.length === 0) return;
      const top = stack.find(entry => event.source === frameRefs.current.get(entry.id)?.contentWindow);
      if (!top) return;
      if (event.data.type === "cmpri-work-order-draft-status" && event.data.modalToken === top.modalToken) {
        if (new URL(top.href, window.location.origin).pathname !== "/work-orders") return;
        setStack(current => current.map(entry => entry.id === top.id
          ? { ...entry, title: event.data.isDraft ? "Draft — awaiting approval" : "Create Work Order" } : entry));
        return;
      }
      if (event.data.type === "cmpri-open-modal" && typeof event.data.href === "string") {
        if (top.modalToken ? event.data.modalToken !== top.modalToken : event.data.modalToken !== "") return;
        if (!isSameOriginInternal(event.data.href)) return;
        if (event.data.href === WORK_ORDER_LIST_PATH) {
          if (technicianDesktopRef.current?.anchor.dataset.canViewWorkOrders === "true") openWorkOrderList();
          return;
        }
        const modal = modalHref(event.data.href);
        openEntry({
          id: crypto.randomUUID(),
          ...modal,
          title: typeof event.data.title === "string" && event.data.title.trim()
            ? event.data.title.trim()
            : "Open screen",
          returnFocus: frameRefs.current.get(top.id) || null,
        });
        return;
      }
      if (top.modalToken ? event.data.modalToken !== top.modalToken : event.data.modalToken !== "") return;
      if (event.data.type === 'cmpri-work-order-loaded') {
        const sourceId = /^\/work-orders\/([^/?#]+)/.exec(new URL(top.href,window.location.origin).pathname)?.[1];
        const guest = event.data.workOrder;
        if (sourceId && guest && typeof guest === 'object' && guest.id === decodeURIComponent(sourceId)) setStack(current => current.map(entry => entry.id === top.id ? {...entry,guest} : entry));
        return;
      }
      if (event.data.type === "cmpri-assets-changed" && typeof event.data.assetId === "string" && event.data.assetId
        && new URL(top.href, window.location.origin).pathname === "/management/equipment") {
        // Only relay the invalidation; each form fetches its own authorized list.
        for (const entry of stack.filter(item => item.id !== top.id)) {
          if (new URL(entry.href, window.location.origin).pathname !== "/work-orders") continue;
          frameRefs.current.get(entry.id)?.contentWindow?.postMessage({ type: "cmpri-assets-changed",
            assetId: event.data.assetId, modalToken: entry.modalToken }, window.location.origin);
        }
        return; // Keep both screens and the draft mounted.
      }
      if (event.data.type === "cmpri-profile-ai-updated") {
        const profileModal = stack[stack.indexOf(top) - 1];
        if (profileModal) frameRefs.current.get(profileModal.id)?.contentWindow?.postMessage({ type: "cmpri-profile-ai-updated" }, window.location.origin);
        closeModal(top.id);
        return;
      }
      if (event.data.type === "cmpri-modal-close") {
        closeModal(top.id);
        return;
      }
      if (event.data.type === "cmpri-open-related-work-order" && typeof event.data.targetWorkOrderId === "string") {
        const related = modalHref(`/work-orders/${encodeURIComponent(event.data.targetWorkOrderId)}`);
        openEntry({
          id: crypto.randomUUID(),
          ...related,
          title: "Related work order",
          returnFocus: frameRefs.current.get(top.id) || null,
        });
        return;
      }
      if (event.data.type === "cmpri-modal-dashboard") {
        requestModalClose(top.id);
        return;
      }
      if (event.data.type === "cmpri-modal-sign-out") {
        window.dispatchEvent(new Event("cmpri-workspace-sign-out"));
        setStack([]);
        window.location.replace("/");
        return;
      }
      if (["cmpri-work-order-cancelled", "cmpri-work-order-created", "cmpri-work-order-saved", "cmpri-work-order-deleted"].includes(event.data.type)) {
        closeModal(top.id);
      }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("cmpri-open-modal", openFromEvent as EventListener);
      window.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("message", handleMessage);
    };
  }, [requestModalClose, closeModal, openEntry, openWorkOrderList, activeId, stack, dashboardOverlay]);

  useEffect(() => () => {
    embeddedCleanupRefs.current.forEach((cleanup) => cleanup());
    embeddedCleanupRefs.current.clear();
  }, []);

  useEffect(() => {
    const previous = previousStackRef.current;
    const previousTop = previous.find(entry => entry.id === previousActiveRef.current);
    const currentTop = stack.find(entry => entry.id === activeId);
    if (currentTop?.id !== previousTop?.id) {
      if (currentTop) {
        const frame = frameRefs.current.get(currentTop.id);
        if (frame) frame.focus({ preventScroll: true });
        else if (technicianDesktopRef.current) modalRootRef.current?.querySelector<HTMLElement>('[data-cmpri-desktop-window][data-active="true"] [data-cmpri-window-close]')?.focus({ preventScroll: true });
        else modalRootRef.current?.querySelector<HTMLElement>(`[data-modal-entry="${CSS.escape(currentTop.id)}"] nav button`)?.focus();
      }
      else if (previousTop) {
        const trigger = previousTop.launcher ? currentWindowLauncher(previousTop.launcher) : previousTop.returnFocus;
        trigger?.focus({ preventScroll: true });
      }
    }
    previousStackRef.current = stack;
    previousActiveRef.current = activeId;
  }, [stack, activeId]);

  useEffect(() => {
    if (technicianAnchor || dashboardOverlay) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = stack.length > 0 ? "hidden" : previousOverflow;
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [stack.length, technicianAnchor, dashboardOverlay]);

  useEffect(() => {
    if (technicianAnchor || dashboardOverlay) return;
    const modalRoot = modalRootRef.current;
    const parent = modalRoot?.parentElement;
    if (!modalRoot || !parent || stack.length === 0) return;
    const background = Array.from(parent.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot)
      .map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    return () => background.forEach(({ element, inert }) => { element.inert = inert; });
  }, [stack.length, technicianAnchor, dashboardOverlay]);

  if (technicianDesktop) return createPortal(
    <div ref={modalRootRef} hidden={workspaceHidden} inert={workspaceHidden} aria-hidden={workspaceHidden || undefined} className="pointer-events-none fixed z-[19] [&_.cmpri-desktop-window]:pointer-events-auto"
      style={{ left: technicianDesktop.left, top: technicianDesktop.top, ...technicianDesktop.bounds }}
      data-cmpri-technician-windows>
      {stack.map((entry, index) => {
        if (!entry.rect) return null;
        const key = desktopEntryKey(entry);
        const active = entry.id === activeId;
        const zIndex = active ? stack.length + 10 : index + 10;
        const onFocus = () => setActiveId(entry.id);
        const onClose = () => requestModalClose(entry.id);
        const onRectCommit = (rect: WindowRect) => commitDesktopRect(entry.id, rect);
        if (key === WEATHER_PATH) return (
          <WeatherPreviewWindow
            key={entry.id} windowKey={key} title={entry.title} accentClass="bg-amber-400"
            src={entry.href} visible={!workspaceHidden && !entry.weatherCached} use24HourTime={false}
            bulletinHost={technicianDesktop.bulletinHost} rect={entry.rect} bounds={technicianDesktop.bounds}
            zIndex={zIndex} active={active} onFocus={onFocus} onClose={onClose} onRectCommit={onRectCommit}
            registerFrame={frame => registerFrame(entry.id, frame)}
            onOpen={(href, title) => {
              if (!isSameOriginInternal(href)) return;
              openEntry({ id: crypto.randomUUID(), ...modalHref(href), title, returnFocus: frameRefs.current.get(entry.id) });
            }}
            onReturnToDesktop={onClose}
          />
        );
        return (
          <DesktopWindow
            key={entry.id} windowKey={key} title={entry.title} accentClass="bg-slate-400"
            rect={entry.rect} bounds={technicianDesktop.bounds} zIndex={zIndex} active={active}
            guest={entry.guest} onFocus={onFocus} onClose={onClose} onRectCommit={onRectCommit}
          >
            {entry.kind === "work-order-list"
              ? <WorkOrderListWindow preferencesScope={workspacePreferencesScope} orders={EMPTY_WORK_ORDERS} loading={false} onOpenWorkOrder={openWorkOrder} />
              : <EmbeddedModalFrame
                allow="camera" entryId={entry.id} register={registerFrame} title={entry.title}
                src={entry.href} onLoad={event => handleEmbeddedLoad(event, entry)}
                className="block size-full min-h-0 min-w-0 border-0 bg-slate-950"
              />}
          </DesktopWindow>
        );
      })}
      {limitMessage && <p role="alert" className="pointer-events-auto absolute bottom-2 left-2 z-[150] max-w-sm rounded-md border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-100">{limitMessage}</p>}
    </div>,
    technicianDesktop.anchor,
  );

  if (stack.length === 0) {
    if (workspaceHidden) return null;
    if ((!workOrderShortcutTarget || !canViewWorkOrders) && !limitMessage) return null;
    return createPortal(<>
      {workOrderShortcutTarget && canViewWorkOrders && <button type="button" onClick={() => openWorkOrderList()} className="fixed bottom-3 left-3 z-[2147483000] min-h-10 rounded-md border border-amber-500/60 bg-slate-950 px-3 text-xs font-semibold text-amber-200 shadow-lg">{t("Work orders")}</button>}
      {limitMessage && <p role="alert" className="fixed bottom-16 left-3 z-[2147483000] max-w-sm rounded-md border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-100">{t(limitMessage)}</p>}
    </>, workOrderShortcutTarget ?? document.body);
  }

  const host = (
    <div ref={modalRootRef} hidden={workspaceHidden} inert={workspaceHidden} aria-hidden={workspaceHidden || undefined} className="pointer-events-none fixed inset-0 z-[120]">
      {stack.map((entry, index) => {
        const isTop = entry.id === activeId;
        const scale = 0.9 ** (Math.min(index, 2) + 1);
        const entryPath = entry.href.replace(/^https?:\/\/[^/]+/, "");
        const displayTitle = modalDisplayTitle(entryPath,entry.title);
        const isWorkOrderDetail = /^\/work-orders\/[^/?#]+(?:[/?#]|$)/.test(entryPath);
        const isPurchasing = entryPath === "/engineering/purchasing";
        const isAssets = entryPath.split("?")[0] === "/management/equipment";
        const isRoomRanking = entryPath.split("?")[0] === "/engineering/room-ranking";
          const panelStyle: ModalPanelStyle = {
          ...modalThemeStyle(modalActionForRoute(entryPath,entry.title)),
          "--cmpri-modal-width": `min(${(isRoomRanking ? 100 : (isPurchasing || isAssets ? 94 : (isWorkOrderDetail ? 94 : 66))) * scale}vw, ${(isRoomRanking ? 120 : (isPurchasing || isAssets ? 88 : (isWorkOrderDetail ? 88 : 72))) * scale}rem)`,
          "--cmpri-modal-height": `calc(${(isWorkOrderDetail ? 82 : 100) * scale}dvh - ${(isWorkOrderDetail ? 24 : 16) * scale}px)`,
          "--cmpri-modal-mobile-width": `calc(${100 * scale}vw - ${(isWorkOrderDetail ? 24 : 16) * scale}px)`,
          "--cmpri-modal-mobile-height": `calc(${100 * scale}dvh - ${(isWorkOrderDetail ? 24 : 16) * scale}px)`,
          ...(dashboardOverlay ? { maxHeight: "max(0px, calc(100dvh - var(--ask-launcher-clearance, 0px)))" } : {}),
        };
        return (
          <div
            key={entry.id}
            className="cmpri-modal-backdrop pointer-events-auto absolute inset-0 flex items-center justify-center overscroll-contain bg-black/75 backdrop-blur-md"
            style={{ zIndex: isTop ? 120 + stack.length : 120 + index, pointerEvents: isTop ? "auto" : "none",
              top: dashboardOverlay ? "var(--ask-launcher-clearance, 0px)" : undefined }}
            inert={!isTop}
          >
            <div
              role="dialog"
              aria-modal={isTop && !dashboardOverlay}
              aria-label={t(displayTitle)}
              data-cmpri-modal-theme="true"
              aria-hidden={!isTop}
              data-modal-entry={entry.id}
              className="cmpri-modal-shell cmpri-dashboard-overlay-panel cmpri-modal-frame relative flex min-h-0 min-w-0 flex-col overflow-hidden overscroll-contain border border-slate-700 bg-slate-950 shadow-2xl"
              style={panelStyle}
            >
              <div className={`cmpri-desktop-titlebar${isWorkOrderDetail ? " cmpri-work-order-titlebar" : ""}${isAssets ? " cmpri-assets-titlebar" : ""}`} style={modalTitleStyle(modalActionForRoute(entryPath,entry.title))}>
                {isAssets ? <svg aria-hidden="true" className="cmpri-assets-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg> : <span aria-hidden="true" className="size-2 rounded-full" style={{backgroundColor:'var(--cmpri-outline)'}} />}
                <span className="cmpri-title-content">
                  <span className="min-w-0 flex-1 truncate">{t(displayTitle)}</span>
                  {entry.guest && <WorkOrderTitleGuest guest={entry.guest} />}
                </span>
                {hasBonvoyTierHelp(entryPath) && <WorkOrderTierKey />}
                {isRoomRanking && <RoomRankerKey />}
                <button type="button" className="cmpri-desktop-close" aria-label={t("Close {value0}", { value0: String(t(displayTitle)) })} onClick={()=>requestModalClose(entry.id)}>×</button>
              </div>
              {isTop && (!isAssets || stack.length > 1) && <nav aria-label={t("Open screens")} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-700 bg-slate-950 p-1">
                {canViewWorkOrders && <button type="button" onClick={() => openWorkOrderList()} className="min-h-10 shrink-0 rounded-md border border-amber-500/60 px-3 text-xs font-semibold text-amber-200">{t("Work orders")}</button>}
                {stack.map(item => <button key={item.id} type="button" aria-pressed={item.id === activeId} onClick={() => setActiveId(item.id)} className={`min-h-10 max-w-44 shrink-0 truncate rounded-md px-3 text-xs ${item.id === activeId ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{t(item.title)}</button>)}
              </nav>}
              {isTop && limitMessage && <p role="alert" className="shrink-0 border-b border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-100">{t(limitMessage)}</p>}
              {entry.kind === "work-order-list" ? <WorkOrderListWindow preferencesScope={workspacePreferencesScope} orders={EMPTY_WORK_ORDERS} loading={false} onOpenWorkOrder={openWorkOrder} /> : <EmbeddedModalFrame
                allow="camera"
                entryId={entry.id}
                register={registerFrame}
                title={tt(displayTitle)}
                src={entry.href}
                scrolling="yes"
                onLoad={(event) => handleEmbeddedLoad(event, entry)}
                className="min-h-0 min-w-0 flex-1 overscroll-contain border-0 bg-white"
                style={{ pointerEvents: isTop ? "auto" : "none" }}
              />}
            </div>
          </div>
        );
      })}
    </div>
  );
  return <>{nativeShell ? createPortal(host, nativeShell) : host}
    {!workspaceHidden && shellSuspended && canViewWorkOrders && createPortal(<button type="button" onClick={resumeScreens} className="fixed bottom-3 left-3 z-[2147483000] min-h-10 rounded-md border border-amber-500/60 bg-slate-950 px-3 text-xs font-semibold text-amber-200 shadow-lg">{t("Open screens")}</button>, document.body)}
    {!workspaceHidden && workOrderShortcutTarget && nativeObscuresStack && canViewWorkOrders && createPortal(<button type="button" onClick={() => openWorkOrderList()} className="fixed bottom-3 left-3 z-[2147483000] min-h-10 rounded-md border border-amber-500/60 bg-slate-950 px-3 text-xs font-semibold text-amber-200 shadow-lg">{t("Work orders")}</button>, workOrderShortcutTarget)}
  </>;
}
