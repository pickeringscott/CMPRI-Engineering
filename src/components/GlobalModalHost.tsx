"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";

type ModalEntry = {
  id: string;
  href: string;
  title: string;
  modalToken?: string;
  returnFocus?: HTMLElement | null;
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
    "/work-orders",
    "/management/equipment",
    "/management/rooms",
    "/management/users",
    "/profile",
    "/profile/ai-connection",
    "/engineering/room-ranker",
    "/engineering/room-ranking",
    "/engineering/preventive-maintenance",
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

export default function GlobalModalHost() {
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const modalRootRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const embeddedCleanupRefs = useRef(new Map<string, () => void>());
  const previousStackRef = useRef<ModalEntry[]>([]);

  useEffect(() => {
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
    setStack((current) => current.at(-1)?.id === entryId ? current.slice(0, -1) : current);
  }, []);

  const requestModalClose = useCallback((entryId: string) => {
    const frameDocument = frameRefs.current.get(entryId)?.contentDocument;
    if (!frameDocument) {
      closeModal(entryId);
      return;
    }
    const cancelRequest = new Event("cmpri-modal-cancel-request", { cancelable: true });
    if (frameDocument.dispatchEvent(cancelRequest)) closeModal(entryId);
  }, [closeModal]);

  function handleEmbeddedLoad(event: SyntheticEvent<HTMLIFrameElement>, entry: ModalEntry) {
    embeddedCleanupRefs.current.get(entry.id)?.();
    embeddedCleanupRefs.current.delete(entry.id);
    const frame = event.currentTarget;
    const document = frame.contentDocument;
    if (!document) return;
    const cleanups: Array<() => void> = [];
    const openNestedModal = (href: string, title: string) => {
      const modal = modalHref(href);
      setStack((current) => [...current, {
        id: crypto.randomUUID(),
        ...modal,
        title,
        returnFocus: frameRefs.current.get(entry.id) || null,
      }]);
    };
    const closeOnEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        if (keyEvent.defaultPrevented) return;
        if (document.querySelector('[role="listbox"], [role="dialog"][aria-modal="true"]')) return;
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
        last.focus();
      } else if (!keyEvent.shiftKey && (document.activeElement === last || document.activeElement === document.body || !content.contains(document.activeElement))) {
        keyEvent.preventDefault();
        first.focus();
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
        if (window.parent !== window) {
          frame.contentWindow?.parent.postMessage({
            type: "cmpri-modal-dashboard",
            modalToken: entry.modalToken || "",
          }, window.location.origin);
        } else {
          setStack([]);
        }
        return;
      }
      openNestedModal(href, deriveTitle(target));
    };
    document.addEventListener("click", openNestedScreen, true);
    cleanups.push(() => document.removeEventListener("click", openNestedScreen, true));
    document.addEventListener("keydown", closeOnEscape);
    cleanups.push(() => document.removeEventListener("keydown", closeOnEscape));
    frame.focus();

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
      setStack((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          ...modal,
          title: detail.title?.trim() || "Open screen",
          returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        },
      ]);
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
          setStack([]);
          return;
        }
        event.preventDefault();
        setStack((current) => [...current, {
          id: crypto.randomUUID(),
          ...modalHref(href),
          title: deriveTitle(anchor),
          returnFocus: anchor,
        }]);
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
        setStack([]);
        return;
      }
      event.preventDefault();
      setStack((current) => [...current, {
        id: crypto.randomUUID(),
        ...modalHref(href),
        title: deriveTitle(button),
        returnFocus: button,
      }]);
    };

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stack.length > 0) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const top = stack.at(-1);
        if (top) requestModalClose(top.id);
      }
    };

    window.addEventListener("cmpri-open-modal", openFromEvent as EventListener);
    window.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown);

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !event.data || stack.length === 0) return;
      const top = stack[stack.length - 1];
      if (event.source !== frameRefs.current.get(top.id)?.contentWindow) return;
      if (event.data.type === "cmpri-open-modal" && typeof event.data.href === "string") {
        if (top.modalToken ? event.data.modalToken !== top.modalToken : event.data.modalToken !== "") return;
        if (!isSameOriginInternal(event.data.href)) return;
        const modal = modalHref(event.data.href);
        setStack((current) => [...current, {
          id: crypto.randomUUID(),
          ...modal,
          title: typeof event.data.title === "string" && event.data.title.trim()
            ? event.data.title.trim()
            : "Open screen",
          returnFocus: frameRefs.current.get(top.id) || null,
        }]);
        return;
      }
      if (top.modalToken ? event.data.modalToken !== top.modalToken : event.data.modalToken !== "") return;
      if (event.data.type === "cmpri-assets-changed" && typeof event.data.assetId === "string" && event.data.assetId
        && new URL(top.href, window.location.origin).pathname === "/management/equipment") {
        // Only relay the invalidation; each form fetches its own authorized list.
        for (const entry of stack.slice(0, -1)) {
          if (new URL(entry.href, window.location.origin).pathname !== "/work-orders") continue;
          frameRefs.current.get(entry.id)?.contentWindow?.postMessage({ type: "cmpri-assets-changed",
            assetId: event.data.assetId, modalToken: entry.modalToken }, window.location.origin);
        }
        return; // Keep both screens and the draft mounted.
      }
      if (event.data.type === "cmpri-profile-ai-updated") {
        const profileModal = stack.at(-2);
        if (profileModal) frameRefs.current.get(profileModal.id)?.contentWindow?.postMessage({ type: "cmpri-profile-ai-updated" }, window.location.origin);
        setStack((current) => current.slice(0, -1));
        return;
      }
      if (event.data.type === "cmpri-modal-close") {
        setStack((current) => current.slice(0, -1));
        return;
      }
      if (event.data.type === "cmpri-open-related-work-order" && typeof event.data.targetWorkOrderId === "string") {
        const related = modalHref(`/work-orders/${encodeURIComponent(event.data.targetWorkOrderId)}`);
        setStack((current) => [...current, {
          id: crypto.randomUUID(),
          ...related,
          title: "Related work order",
          returnFocus: frameRefs.current.get(top.id) || null,
        }]);
        return;
      }
      if (event.data.type === "cmpri-modal-dashboard") {
        setStack([]);
        return;
      }
      if (event.data.type === "cmpri-modal-sign-out") {
        setStack([]);
        window.location.replace("/");
        return;
      }
      if (["cmpri-work-order-cancelled", "cmpri-work-order-created", "cmpri-work-order-saved", "cmpri-work-order-deleted"].includes(event.data.type)) {
        setStack((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("cmpri-open-modal", openFromEvent as EventListener);
      window.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("message", handleMessage);
    };
  }, [requestModalClose, stack]);

  useEffect(() => () => {
    embeddedCleanupRefs.current.forEach((cleanup) => cleanup());
    embeddedCleanupRefs.current.clear();
  }, []);

  useEffect(() => {
    const previous = previousStackRef.current;
    const previousTop = previous.at(-1);
    const currentTop = stack.at(-1);
    if (currentTop?.id !== previousTop?.id) {
      if (currentTop) frameRefs.current.get(currentTop.id)?.focus();
      else previousTop?.returnFocus?.focus();
    }
    previousStackRef.current = stack;
  }, [stack]);

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

  if (stack.length === 0) return null;

  return (
    <div ref={modalRootRef} className="pointer-events-none fixed inset-0 z-[120]">
      {stack.map((entry, index) => {
        const isTop = index === stack.length - 1;
        const scale = 0.9 ** (index + 1);
        const entryPath = entry.href.replace(/^https?:\/\/[^/]+/, "");
        const isWorkOrderDetail = /^\/work-orders\/[^/?#]+(?:[/?#]|$)/.test(entryPath);
        const isPurchasing = entryPath === "/engineering/purchasing";
        const isRoomRanking = entryPath.split("?")[0] === "/engineering/room-ranking";
          const panelStyle: ModalPanelStyle = {
          "--cmpri-modal-width": `min(${(isRoomRanking ? 100 : (isPurchasing ? 94 : (isWorkOrderDetail ? 94 : 66))) * scale}vw, ${(isRoomRanking ? 120 : (isPurchasing ? 88 : (isWorkOrderDetail ? 88 : 72))) * scale}rem)`,
          "--cmpri-modal-height": `calc(${(isWorkOrderDetail ? 82 : 100) * scale}dvh - ${(isWorkOrderDetail ? 24 : 16) * scale}px)`,
          "--cmpri-modal-mobile-width": `calc(${100 * scale}vw - ${(isWorkOrderDetail ? 24 : 16) * scale}px)`,
          "--cmpri-modal-mobile-height": `calc(${100 * scale}dvh - ${(isWorkOrderDetail ? 24 : 16) * scale}px)`,
        };
        return (
          <div
            key={entry.id}
            className="cmpri-modal-backdrop pointer-events-auto absolute inset-0 flex items-center justify-center overscroll-contain bg-black/75 backdrop-blur-md"
            style={{ zIndex: 120 + index, pointerEvents: isTop ? "auto" : "none" }}
            inert={!isTop}
          >
            <div
              role="dialog"
              aria-modal={isTop}
              aria-label={entry.title}
              aria-hidden={!isTop}
              className="cmpri-modal-shell cmpri-dashboard-overlay-panel cmpri-modal-frame relative flex min-h-0 min-w-0 flex-col overflow-hidden overscroll-contain border border-slate-700 bg-slate-950 shadow-2xl"
              style={panelStyle}
            >
              <iframe
                ref={(frame) => {
                  if (frame) frameRefs.current.set(entry.id, frame);
                  else {
                    embeddedCleanupRefs.current.get(entry.id)?.();
                    embeddedCleanupRefs.current.delete(entry.id);
                    frameRefs.current.delete(entry.id);
                  }
                }}
                title={entry.title}
                src={entry.href}
                scrolling="yes"
                onLoad={(event) => handleEmbeddedLoad(event, entry)}
                className="min-h-0 min-w-0 flex-1 overscroll-contain border-0 bg-white"
                style={{ pointerEvents: isTop ? "auto" : "none" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
