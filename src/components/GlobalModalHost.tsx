"use client";

import { useEffect, useRef, useState, type SyntheticEvent } from "react";

type ModalEntry = {
  id: string;
  href: string;
  title: string;
  modalToken?: string;
  returnFocus?: HTMLElement | null;
};

function modalHref(href: string) {
  const isWorkOrderDetail = /^\/work-orders\/[^/?#]+(?:[/?#]|$)/.test(href);
  const isCreateWorkOrder = new URL(href, window.location.origin).pathname === "/work-orders";
  const isUserManagement = new URL(href, window.location.origin).pathname === "/management/users";
  const isFeedback = new URL(href, window.location.origin).pathname === "/feedback";
  if (!isWorkOrderDetail && !isCreateWorkOrder && !isUserManagement && !isFeedback) return { href, modalToken: undefined };
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
  if (target.closest("button[type='button']") && !target.closest("[data-cmpri-modal-trigger='true']")) {
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
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const embeddedCleanupRefs = useRef(new Map<string, () => void>());
  const previousStackRef = useRef<ModalEntry[]>([]);

  useEffect(() => {
    try {
      const language = window.localStorage.getItem("cmpri:work-order-language");
      const appearance = window.localStorage.getItem("cmpri:appearance");
      if (language === "en" || language === "es") document.documentElement.lang = language;
      if (appearance === "light" || appearance === "dark") document.documentElement.dataset.theme = appearance;
    } catch {}
  }, []);

  function closeModal(entryId: string) {
    setStack((current) => current.at(-1)?.id === entryId ? current.slice(0, -1) : current);
  }

  function requestModalClose(entryId: string) {
    const frameDocument = frameRefs.current.get(entryId)?.contentDocument;
    if (!frameDocument) {
      closeModal(entryId);
      return;
    }
    const cancelRequest = new Event("cmpri-modal-cancel-request", { cancelable: true });
    if (frameDocument.dispatchEvent(cancelRequest)) closeModal(entryId);
  }

  function handleEmbeddedLoad(event: SyntheticEvent<HTMLIFrameElement>, entry: ModalEntry) {
    embeddedCleanupRefs.current.get(entry.id)?.();
    embeddedCleanupRefs.current.delete(entry.id);
    const frame = event.currentTarget;
    const document = frame.contentDocument;
    if (!document) return;
    const cleanups: Array<() => void> = [];
    const closeToDashboard = () => requestModalClose(entry.id);
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
    document.addEventListener("keydown", closeOnEscape);
    cleanups.push(() => document.removeEventListener("keydown", closeOnEscape));
    frame.focus();

    const path = new URL(frame.src, window.location.origin).pathname;
    const isCreateWorkOrder = path === "/work-orders";
    if (!isCreateWorkOrder && !document.querySelector(".cmpri-embedded-modal-dashboard, a[href='/engineering']")) {
      const dashboard = document.createElement("a");
      dashboard.href = "/engineering";
      dashboard.textContent = "← Dashboard";
      dashboard.className = "cmpri-embedded-modal-dashboard";
      dashboard.style.cssText = "display:inline-block;margin:4px 8px;padding:8px 12px;border:1px solid #475569;border-radius:8px;color:#e2e8f0;text-decoration:none;font-weight:600";
      document.body.insertBefore(dashboard, document.body.firstChild);
    }
    const dashboardClick = (clickEvent: MouseEvent) => {
      const target = clickEvent.target instanceof Element ? clickEvent.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      let targetUrl: URL;
      try { targetUrl = new URL(target.href, window.location.origin); }
      catch { return; }
      if (targetUrl.origin !== window.location.origin || targetUrl.pathname !== "/engineering") return;
      clickEvent.preventDefault();
      closeToDashboard();
    };
    document.addEventListener("click", dashboardClick, true);
    cleanups.push(() => document.removeEventListener("click", dashboardClick, true));

    const history = frame.contentWindow?.history;
    if (history) {
      const originalPushState = history.pushState;
      const originalReplaceState = history.replaceState;
      const intercept = (original: typeof history.pushState) => (state: unknown, unused: string, url?: string | URL | null) => {
        const nextPath = url ? new URL(String(url), window.location.origin).pathname : "";
        if (nextPath === "/engineering") {
          closeToDashboard();
          return;
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
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href], button[data-cmpri-modal-trigger='true']") : null;
      if (!target || isExcludedNavigation(target)) return;

      const anchor = target instanceof HTMLAnchorElement ? target : null;
      if (anchor) {
        const href = anchor.getAttribute("href") || "";
        if (!isSameOriginInternal(href) || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
        if (anchor.closest("[data-cmpri-modal-ignore='true']")) return;
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
      const href = button.dataset.cmpriModalHref;
      if (!href || !isSameOriginInternal(href)) return;
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
      if (top.modalToken ? event.data.modalToken !== top.modalToken : event.data.modalToken !== "") return;
      if (event.data.type === "cmpri-open-related-work-order" && typeof event.data.targetWorkOrderId === "string") {
        const related = modalHref(`/work-orders/${encodeURIComponent(event.data.targetWorkOrderId)}`);
        setStack((current) => current.map((entry, index) => index === current.length - 1 ? { ...entry, ...related } : entry));
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
  }, [stack]);

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

  if (stack.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[120]">
      {stack.map((entry, index) => {
        const isTop = index === stack.length - 1;
        return (
          <div
            key={entry.id}
            className="cmpri-modal-backdrop pointer-events-auto absolute inset-0 flex items-center justify-center overscroll-contain bg-black/75 p-[15px] backdrop-blur-md"
            style={{ zIndex: 120 + index }}
          >
            <div
              role="dialog"
              aria-modal={isTop}
              aria-label={entry.title}
              aria-hidden={!isTop}
              className="relative flex min-h-0 min-w-0 max-h-[calc(100dvh-30px)] max-w-[calc(100vw-30px)] flex-col overflow-hidden overscroll-contain rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl"
              style={{ width: "min(calc(100vw - 30px), 72rem)", height: "min(calc(100dvh - 30px), 56rem)", boxSizing: "border-box" }}
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
