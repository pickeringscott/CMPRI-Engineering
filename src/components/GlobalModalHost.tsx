"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import {modalActionForRoute,modalThemeStyle,modalTitleStyle,modalDisplayTitle,hasBonvoyTierHelp} from '@/lib/ui/header-palette';
import WorkOrderTierKey from './WorkOrderTierKey';
import RoomRankerKey from './RoomRankerKey';
import WorkOrderTitleGuest from './WorkOrderTitleGuest';
import WorkOrderListWindow from './desktop/WorkOrderListWindow';
import { loadCmpriSession } from '@/lib/auth/client-session';
import { claimWorkOrder, releaseWorkOrder } from '@/lib/open-work-orders';

type ModalEntry = {
  guest?: Record<string,unknown>;
  id: string;
  href: string;
  title: string;
  modalToken?: string;
  returnFocus?: HTMLElement | null;
  kind?: "work-order-list";
};

type ModalPanelStyle = CSSProperties & {
  "--cmpri-modal-width": string;
  "--cmpri-modal-height": string;
  "--cmpri-modal-mobile-width": string;
  "--cmpri-modal-mobile-height": string;
};

function modalHref(href: string) {
  const isWorkOrderDetail = /^\/work-orders\/[^/?#]+(?:[/?#]|$)/.test(href);
  const modalRoutes = new Set([
    "/staff-notes",
    "/notes",
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
    "/feedback",
  ]);
  if (!isWorkOrderDetail && !modalRoutes.has(new URL(href, window.location.origin).pathname)) {
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

export default function GlobalModalHost() {
  const pathname = usePathname();
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [canViewWorkOrders, setCanViewWorkOrders] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<HTMLElement | null>(null);
  const [nativeObscuresStack, setNativeObscuresStack] = useState(false);
  const [shellSuspended, setShellSuspended] = useState(false);
  const [nativeShell, setNativeShell] = useState<HTMLDialogElement | null>(null);
  const [limitMessage, setLimitMessage] = useState("");
  const stackRef = useRef<ModalEntry[]>([]);
  const [owner] = useState(() => crypto.randomUUID());
  const nativeShellRef = useRef<HTMLDialogElement | null>(null);
  const suspendedDialogsRef = useRef<HTMLDialogElement[]>([]);
  const suspendedCustomRef = useRef<Array<{ element: HTMLElement; value: string; priority: string }>>([]);
  const activeIdRef = useRef<string | null>(null);
  const requestCloseRef = useRef<(entryId: string) => void>(() => {});
  const resumeScreensRef = useRef<() => void>(() => {});
  useLayoutEffect(() => { stackRef.current = stack; }, [stack]);
  const modalRootRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const embeddedCleanupRefs = useRef(new Map<string, () => void>());
  const previousStackRef = useRef<ModalEntry[]>([]);
  const previousActiveRef = useRef<string | null>(null);
  const hasOpenModals = stack.length > 0;

  useEffect(() => {
    if (window.parent !== window || new URLSearchParams(window.location.search).get("embedded") === "1") return;
    const id = workOrderId(pathname || "/");
    if (!id) return;
    const result = claimWorkOrder(id, owner, () => window.focus());
    if (result !== "claimed") return;
    return () => releaseWorkOrder(id, owner);
  }, [pathname, owner]);

  useEffect(() => {
    if (window.parent !== window) return;
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
  }, [hasOpenModals, dialogTarget]);

  useEffect(() => {
    if (!hasOpenModals && !dialogTarget) return;
    let live = true;
    void loadCmpriSession().then(session => {
      if (live) setCanViewWorkOrders(session.capabilities.includes("view_work_orders"));
    }).catch(() => { if (live) setCanViewWorkOrders(false); });
    return () => { live = false; };
  }, [hasOpenModals, dialogTarget]);

  const openEntry = useCallback((entry: ModalEntry) => {
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
    if (!stackRef.current.length && !nativeShellRef.current) {
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
    stackRef.current = [...stackRef.current, entry];
    setStack(current => [...current, entry]);
    setActiveId(entry.id);
  }, [owner]);

  const openWorkOrderList = useCallback(() => {
    if (nativeShellRef.current && nativeObscuresStack) {
      nativeShellRef.current.close();
      nativeShellRef.current.showModal();
      setNativeObscuresStack(false);
    }
    const existing = stackRef.current.find(item => item.kind === "work-order-list");
    if (existing) setActiveId(existing.id);
    else openEntry({ id: crypto.randomUUID(), href: "/__work-order-list", title: "Work Order List", kind: "work-order-list", returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, [nativeObscuresStack, openEntry]);

  const resumeScreens = useCallback(() => {
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
      const language = window.localStorage.getItem("cmpri:work-order-language");
      const appearance = window.localStorage.getItem("cmpri:appearance");
      if (language === "en" || language === "es") document.documentElement.lang = language;
      if (appearance === "light" || appearance === "dark") document.documentElement.dataset.theme = appearance;
    } catch {}
  }, []);

  const closeModal = useCallback((entryId: string) => {
    setLimitMessage("");
    const id = workOrderId(stackRef.current.find(entry => entry.id === entryId)?.href || "/");
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
    setActiveId(current => current === entryId ? remaining.at(-1)?.id ?? null : current);
  }, [owner]);

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
      if (keyEvent.key !== "Tab") return;
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
      if (isDashboardAction || new URL(href, window.location.origin).pathname === "/engineering") {
        requestModalClose(entry.id);
        return;
      }
      openNestedModal(href, deriveTitle(target));
    };
    document.addEventListener("click", openNestedScreen, true);
    cleanups.push(() => document.removeEventListener("click", openNestedScreen, true));
    document.addEventListener("keydown", closeOnEscape);
    cleanups.push(() => document.removeEventListener("keydown", closeOnEscape));
    if (entry.id === activeId) frame.focus();

    const history = frame.contentWindow?.history;
    if (history) {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      const intercept = (original: typeof history.pushState) => (state: unknown, unused: string, url?: string | URL | null) => {
        if (url) {
          const nextUrl = new URL(String(url), frame.contentWindow?.location.href || window.location.href);
          if (isSameOriginInternal(nextUrl.href) && nextUrl.pathname !== frame.contentWindow?.location.pathname) {
            openNestedModal(nextUrl.href, nextUrl.pathname);
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
      target.documentElement.lang = preferences.language;
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
      const detail = (event as CustomEvent<{ href?: string; title?: string }>).detail;
      if (!detail?.href || !isSameOriginInternal(detail.href)) return;
      if (window.parent !== window) {
        window.parent.postMessage({
          type: "cmpri-open-modal",
          href: detail.href,
          title: detail.title?.trim() || "Open screen",
          modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
        }, window.location.origin);
        return;
      }
      const modal = modalHref(detail.href);
      openEntry({
          id: crypto.randomUUID(),
          ...modal,
          title: detail.title?.trim() || "Open screen",
          returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
    };

    const handleClick = (event: MouseEvent) => {
      if (window.parent !== window) return;
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
          || new URL(href, window.location.origin).pathname === "/engineering";
        if (returnToDashboard) {
          if (stack.length === 0) return;
          event.preventDefault();
          if (activeId) requestModalClose(activeId);
          return;
        }
        event.preventDefault();
        openEntry({
          id: crypto.randomUUID(),
          ...modalHref(href),
          title: deriveTitle(anchor),
          returnFocus: anchor,
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
      openEntry({
        id: crypto.randomUUID(),
        ...modalHref(href),
        title: deriveTitle(button),
        returnFocus: button,
      });
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && activeId) {
        const panel = modalRootRef.current?.querySelector<HTMLElement>(`[data-modal-entry="${CSS.escape(activeId)}"]`);
        const focusable = Array.from(panel?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex='-1'])") || []).filter(element => element.getClientRects().length > 0);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      if (event.key === "Escape" && stack.length > 0) {
        if (event.defaultPrevented) return;
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
      if (event.data.type === "cmpri-open-modal" && typeof event.data.href === "string") {
        if (top.modalToken ? event.data.modalToken !== top.modalToken : event.data.modalToken !== "") return;
        if (!isSameOriginInternal(event.data.href)) return;
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
  }, [requestModalClose, closeModal, openEntry, activeId, stack]);

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
        if (frame) frame.focus();
        else modalRootRef.current?.querySelector<HTMLElement>(`[data-modal-entry="${CSS.escape(currentTop.id)}"] nav button`)?.focus();
      }
      else previousTop?.returnFocus?.focus();
    }
    previousStackRef.current = stack;
    previousActiveRef.current = activeId;
  }, [stack, activeId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = stack.length > 0 ? "hidden" : previousOverflow;
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [stack.length]);

  useEffect(() => {
    const modalRoot = modalRootRef.current;
    const parent = modalRoot?.parentElement;
    if (!modalRoot || !parent || stack.length === 0) return;
    const background = Array.from(parent.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot)
      .map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    return () => background.forEach(({ element, inert }) => { element.inert = inert; });
  }, [stack.length]);

  if (stack.length === 0) {
    if ((!dialogTarget || !canViewWorkOrders) && !limitMessage) return null;
    return createPortal(<>
      {dialogTarget && canViewWorkOrders && <button type="button" onClick={openWorkOrderList} className="fixed bottom-3 left-3 z-[2147483000] min-h-10 rounded-md border border-amber-500/60 bg-slate-950 px-3 text-xs font-semibold text-amber-200 shadow-lg">Work orders</button>}
      {limitMessage && <p role="alert" className="fixed bottom-16 left-3 z-[2147483000] max-w-sm rounded-md border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-100">{limitMessage}</p>}
    </>, dialogTarget?.isConnected ? dialogTarget : document.body);
  }

  const host = (
    <div ref={modalRootRef} className="pointer-events-none fixed inset-0 z-[120]">
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
        };
        return (
          <div
            key={entry.id}
            className="cmpri-modal-backdrop pointer-events-auto absolute inset-0 flex items-center justify-center overscroll-contain bg-black/75 backdrop-blur-md"
            style={{ zIndex: isTop ? 120 + stack.length : 120 + index, pointerEvents: isTop ? "auto" : "none" }}
            inert={!isTop}
          >
            <div
              role="dialog"
              aria-modal={isTop}
              aria-label={displayTitle}
              data-cmpri-modal-theme="true"
              aria-hidden={!isTop}
              data-modal-entry={entry.id}
              className="cmpri-modal-shell cmpri-dashboard-overlay-panel cmpri-modal-frame relative flex min-h-0 min-w-0 flex-col overflow-hidden overscroll-contain border border-slate-700 bg-slate-950 shadow-2xl"
              style={panelStyle}
            >
              <div className={`cmpri-desktop-titlebar${isWorkOrderDetail ? " cmpri-work-order-titlebar" : ""}${isAssets ? " cmpri-assets-titlebar" : ""}`} style={modalTitleStyle(modalActionForRoute(entryPath,entry.title))}>
                {isAssets ? <svg aria-hidden="true" className="cmpri-assets-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg> : <span aria-hidden="true" className="size-2 rounded-full" style={{backgroundColor:'var(--cmpri-outline)'}} />}
                <span className="cmpri-title-content">
                  <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                  {entry.guest && <WorkOrderTitleGuest guest={entry.guest} />}
                </span>
                {hasBonvoyTierHelp(entryPath) && <WorkOrderTierKey />}
                {isRoomRanking && <RoomRankerKey />}
                <button type="button" className="cmpri-desktop-close" aria-label={`Close ${displayTitle}`} onClick={()=>requestModalClose(entry.id)}>×</button>
              </div>
              {isTop && (!isAssets || stack.length > 1) && <nav aria-label="Open screens" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-700 bg-slate-950 p-1">
                {canViewWorkOrders && <button type="button" onClick={openWorkOrderList} className="min-h-10 shrink-0 rounded-md border border-amber-500/60 px-3 text-xs font-semibold text-amber-200">Work orders</button>}
                {stack.map(item => <button key={item.id} type="button" aria-pressed={item.id === activeId} onClick={() => setActiveId(item.id)} className={`min-h-10 max-w-44 shrink-0 truncate rounded-md px-3 text-xs ${item.id === activeId ? "bg-slate-700 text-white" : "text-slate-300 hover:bg-slate-800"}`}>{item.title}</button>)}
              </nav>}
              {isTop && limitMessage && <p role="alert" className="shrink-0 border-b border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-100">{limitMessage}</p>}
              {entry.kind === "work-order-list" ? <WorkOrderListWindow orders={[]} loading={false} onOpenWorkOrder={order => {
                const path = `/work-orders/${encodeURIComponent(order.id)}`;
                openEntry({ id: crypto.randomUUID(), ...modalHref(path), title: `Work Order ${order.display_id || ""}${order.room ? ` · ${order.room}` : ""}`.trim(), guest: order, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
              }} /> : <iframe
                allow="camera"
                ref={(frame) => {
                  if (frame) frameRefs.current.set(entry.id, frame);
                  else {
                    embeddedCleanupRefs.current.get(entry.id)?.();
                    embeddedCleanupRefs.current.delete(entry.id);
                    frameRefs.current.delete(entry.id);
                  }
                }}
                title={displayTitle}
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
    {shellSuspended && canViewWorkOrders && createPortal(<button type="button" onClick={resumeScreens} className="fixed bottom-3 left-3 z-[2147483000] min-h-10 rounded-md border border-amber-500/60 bg-slate-950 px-3 text-xs font-semibold text-amber-200 shadow-lg">Open screens</button>, document.body)}
    {dialogTarget && nativeObscuresStack && canViewWorkOrders && createPortal(<button type="button" onClick={openWorkOrderList} className="fixed bottom-3 left-3 z-[2147483000] min-h-10 rounded-md border border-amber-500/60 bg-slate-950 px-3 text-xs font-semibold text-amber-200 shadow-lg">Work orders</button>, dialogTarget)}
  </>;
}
