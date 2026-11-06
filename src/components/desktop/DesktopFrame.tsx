"use client";

import { useEffect, useRef, type SyntheticEvent } from "react";
import { isDesktopRoute } from "@/lib/ui/desktop-windows";

function linkTitle(target: Element) {
  const explicit = target.getAttribute("aria-label") || target.getAttribute("title");
  if (explicit?.trim()) return explicit.trim();
  return (target.textContent || "").replace(/\s+/g, " ").trim() || "Open screen";
}

/**
 * Hosts one CMPRI screen inside a desktop window. Navigation to another screen
 * opens (or raises) that screen's own window instead of replacing this one.
 */
export default function DesktopFrame({
  src,
  title,
  registerFrame,
  onFocus,
  onOpen,
  onReturnToDesktop,
}: {
  src: string;
  title: string;
  registerFrame: (frame: HTMLIFrameElement | null) => void;
  onFocus: () => void;
  onOpen: (href: string, title: string) => void;
  onReturnToDesktop: () => void;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const handlersRef = useRef({ onFocus, onOpen, onReturnToDesktop });
  useEffect(() => {
    handlersRef.current = { onFocus, onOpen, onReturnToDesktop };
  });
  useEffect(() => () => cleanupRef.current?.(), []);

  function handleLoad(event: SyntheticEvent<HTMLIFrameElement>) {
    cleanupRef.current?.();
    cleanupRef.current = null;
    const frame = event.currentTarget;
    const frameWindow = frame.contentWindow;
    const frameDocument = frame.contentDocument;
    if (!frameWindow || !frameDocument) return;
    const origin = window.location.origin;
    const cleanups: Array<() => void> = [];
    const listen = <K extends keyof DocumentEventMap>(type: K, listener: (event: DocumentEventMap[K]) => void) => {
      frameDocument.addEventListener(type, listener, true);
      cleanups.push(() => frameDocument.removeEventListener(type, listener, true));
    };

    listen("pointerdown", () => handlersRef.current.onFocus());
    listen("focusin", () => handlersRef.current.onFocus());
    listen("click", (clickEvent) => {
      if (clickEvent.defaultPrevented || clickEvent.button !== 0
        || clickEvent.metaKey || clickEvent.ctrlKey || clickEvent.shiftKey || clickEvent.altKey) return;
      const target = (clickEvent.target as Element | null)
        ?.closest("a[href], button[data-cmpri-modal-trigger='true'], button[data-cmpri-modal-dashboard='true']");
      if (!target || target.closest("[data-cmpri-modal-ignore='true']")) return;
      const returnsToDesktop = !!target.closest("[data-cmpri-modal-dashboard='true']");
      const href = target.localName === "a"
        ? (target as HTMLAnchorElement).href
        : returnsToDesktop
          ? (target as HTMLButtonElement).dataset.cmpriModalDashboardHref || "/engineering"
          : (target as HTMLButtonElement).dataset.cmpriModalHref || "";
      if (target.localName === "a" && ((target as HTMLAnchorElement).target === "_blank" || target.hasAttribute("download"))) return;
      if (!isDesktopRoute(href, origin)) return;
      const nextPath = new URL(href, origin).pathname;
      if (!returnsToDesktop && nextPath === frameWindow.location.pathname) return;
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      if (returnsToDesktop || nextPath === "/engineering") handlersRef.current.onReturnToDesktop();
      else handlersRef.current.onOpen(href, linkTitle(target));
    });

    const history = frameWindow.history;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const intercept = (original: typeof history.pushState) => function (this: History, state: unknown, unused: string, url?: string | URL | null) {
      if (url) {
        const next = new URL(String(url), frameWindow.location.href);
        if (isDesktopRoute(next.href, origin) && next.pathname !== frameWindow.location.pathname) {
          if (next.pathname === "/engineering") handlersRef.current.onReturnToDesktop();
          else handlersRef.current.onOpen(next.href, next.pathname);
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
    cleanupRef.current = () => cleanups.forEach((cleanup) => cleanup());
  }

  return (
    <iframe
      allow="camera"
      ref={registerFrame}
      title={title}
      src={src}
      onLoad={handleLoad}
      className="block size-full min-h-0 min-w-0 border-0 bg-slate-950"
    />
  );
}
