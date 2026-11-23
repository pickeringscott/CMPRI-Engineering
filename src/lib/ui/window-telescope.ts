export type WindowLauncher = {
  element: HTMLElement;
  rect: DOMRect;
  rail: HTMLElement | null;
  layoutKey?: string;
};

const active = new WeakMap<HTMLElement, Animation>();

function layoutRect(element: HTMLElement | null): DOMRect | null {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function launcherRect(element: HTMLElement | null): DOMRect | null {
  const rect = layoutRect(element);
  if (!element || !rect) return null;
  if (getComputedStyle(element).visibility === "hidden" && !element.closest("#desktop-ask-search[data-modal-open]")) return null;
  const viewport = element.ownerDocument.documentElement;
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(viewport.clientWidth, rect.right), bottom = Math.min(viewport.clientHeight, rect.bottom);
  for (let ancestor = element.parentElement; ancestor && ancestor !== viewport; ancestor = ancestor.parentElement) {
    // A popover belongs to the document's top layer. Its old parent cannot
    // clip it after it has been raised above a dialog.
    if (ancestor.hasAttribute("popover") && ancestor.matches(":popover-open")) break;
    const style = getComputedStyle(ancestor);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const bounds = ancestor.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      left = Math.max(left, bounds.left + ancestor.clientLeft);
      right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth);
    }
    if (style.overflowY !== "visible") {
      top = Math.max(top, bounds.top + ancestor.clientTop);
      bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
    }
  }
  return left < right && top < bottom ? new DOMRect(left, top, right - left, bottom - top) : null;
}

export function captureWindowLauncher(element?: HTMLElement | null, initialRect?: DOMRect): WindowLauncher | undefined {
  const rect = initialRect ?? launcherRect(element ?? null);
  if (!element || !rect) return undefined;
  const header = element.closest<HTMLElement>(".cmpri-dashboard-menu-rail, header.cmpri-dashboard-titlebar")
    ?? (element.closest("#desktop-ask-search") ? element.ownerDocument.querySelector<HTMLElement>("header.cmpri-dashboard-titlebar") : null);
  return {
    element, rect, rail: header,
    layoutKey: element.dataset.layoutKey,
  };
}

export function currentWindowLauncher(launcher: WindowLauncher): HTMLElement | null {
  if (launcher.element.isConnected) return launcher.element;
  if (!launcher.rail || !launcher.layoutKey) return null;
  // The menu can remount after syncing its saved layout. Use the exact action,
  // including its label, because a route can have multiple launch buttons.
  const selector = `[data-layout-key="${CSS.escape(launcher.layoutKey)}"]`;
  return launcher.rail.querySelector<HTMLElement>(selector)
    ?? (launcher.rail.isConnected && launcher.layoutKey.startsWith("ask-cmpri::")
      ? launcher.rail.ownerDocument.querySelector<HTMLElement>("#desktop-ask-search " + selector) : null);
}

export function clearWindowTelescope(panel: HTMLElement) {
  active.get(panel)?.cancel();
  active.delete(panel);
}

export function animateWindowTelescope(panel: HTMLElement | null, launcher: WindowLauncher | undefined, direction: "open" | "close"): Animation | null {
  if (!panel || !launcher || typeof panel.animate !== "function") return null;
  const target = direction === "open" ? launcher.rect : launcherRect(currentWindowLauncher(launcher));
  if (!target) return null;

  const previous = active.get(panel);
  const interrupted = direction === "close" && previous?.playState === "running" ? getComputedStyle(panel) : null;
  const full = {
    transform: interrupted?.transform ?? "translate(0, 0) scale(1)",
    opacity: interrupted?.opacity ?? 1,
    transformOrigin: "center",
  };
  clearWindowTelescope(panel);
  const bounds = layoutRect(panel);
  if (!bounds) return null;
  const x = target.left + target.width / 2 - (bounds.left + bounds.width / 2);
  const y = target.top + target.height / 2 - (bounds.top + bounds.height / 2);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const button = {
    transform: reduced ? full.transform
      : `translate(${x}px, ${y}px) scale(${target.width / bounds.width}, ${target.height / bounds.height})`,
    transformOrigin: "center",
    opacity: 0,
  };
  const closing = direction === "close";
  const motion = panel.animate(closing ? [full, button] : [button, full], {
    id: `cmpri-window-telescope-${direction}`,
    duration: reduced ? 130 : 470,
    easing: closing ? "cubic-bezier(.55,.07,.75,.4)" : "cubic-bezier(.25,.6,.45,.93)",
    fill: closing ? "forwards" : "none",
  });
  active.set(panel, motion);
  if (!closing) void motion.finished.then(() => {
    if (active.get(panel) === motion) active.delete(panel);
  }).catch(() => undefined);
  return motion;
}
