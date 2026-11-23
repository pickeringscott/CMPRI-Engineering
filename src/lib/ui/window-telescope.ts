export type WindowLauncher = {
  element: HTMLElement;
  rect: DOMRect;
  rail: HTMLElement | null;
  layoutKey?: string;
};

const active = new WeakMap<HTMLElement, Animation>();

function visibleRect(element: HTMLElement | null): DOMRect | null {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function captureWindowLauncher(element?: HTMLElement | null): WindowLauncher | undefined {
  const rect = visibleRect(element ?? null);
  if (!element || !rect) return undefined;
  return {
    element, rect, rail: element.closest(".cmpri-dashboard-menu-rail, header.cmpri-dashboard-titlebar"),
    layoutKey: element.dataset.layoutKey,
  };
}

export function currentWindowLauncher(launcher: WindowLauncher): HTMLElement | null {
  if (launcher.element.isConnected) return launcher.element;
  if (!launcher.rail || !launcher.layoutKey) return null;
  // The menu can remount after syncing its saved layout. Use the exact action,
  // including its label, because a route can have multiple launch buttons.
  return launcher.rail.querySelector<HTMLElement>(`[data-layout-key="${CSS.escape(launcher.layoutKey)}"]`);
}

export function clearWindowTelescope(panel: HTMLElement) {
  active.get(panel)?.cancel();
  active.delete(panel);
}

export function animateWindowTelescope(panel: HTMLElement | null, launcher: WindowLauncher | undefined, direction: "open" | "close"): Animation | null {
  if (!panel || !launcher || typeof panel.animate !== "function") return null;
  const target = direction === "open" ? launcher.rect : visibleRect(currentWindowLauncher(launcher));
  if (!target) return null;

  const previous = active.get(panel);
  const interrupted = direction === "close" && previous?.playState === "running" ? getComputedStyle(panel) : null;
  const full = {
    transform: interrupted?.transform ?? "translate(0, 0) scale(1)",
    opacity: interrupted?.opacity ?? 1,
    transformOrigin: "center",
  };
  clearWindowTelescope(panel);
  const bounds = visibleRect(panel);
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
