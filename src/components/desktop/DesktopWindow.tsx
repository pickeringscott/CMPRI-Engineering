"use client";

import {modalTitleStyle} from "@/lib/ui/header-palette";
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  clampWindowRect,
  moveWindowRect,
  resizeWindowRect,
  RESIZE_EDGES,
  type DesktopBounds,
  type ResizeEdge,
  type WindowRect,
} from "@/lib/ui/desktop-windows";

type Interaction = {
  pointerId: number;
  mode: "move" | ResizeEdge;
  startX: number;
  startY: number;
  startRect: WindowRect;
};

const INTERACTING_CLASS = "cmpri-desktop-interacting";

export default function DesktopWindow({
  windowKey,
  title,
  accentClass,
  rect,
  bounds,
  zIndex,
  active,
  onFocus,
  onClose,
  onRectCommit,
  children,
}: {
  windowKey: string;
  title: string;
  accentClass: string;
  rect: WindowRect;
  bounds: DesktopBounds;
  zIndex: number;
  active: boolean;
  onFocus: () => void;
  onClose: () => void;
  onRectCommit: (rect: WindowRect) => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const interactionRef = useRef<Interaction | null>(null);
  const [liveRect, setLiveRect] = useState<WindowRect | null>(null);
  const shown = liveRect || clampWindowRect(rect, bounds);

  useEffect(() => () => {
    document.documentElement.classList.remove(INTERACTING_CLASS);
    delete document.documentElement.dataset.cmpriDesktopCursor;
  }, []);

  function begin(event: ReactPointerEvent<HTMLElement>, mode: Interaction["mode"]) {
    if (event.button !== 0) return;
    if (mode === "move" && (event.target as Element).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current = { pointerId: event.pointerId, mode, startX: event.clientX, startY: event.clientY, startRect: shown };
    // Iframes would otherwise swallow pointer events while the pointer crosses them.
    document.documentElement.classList.add(INTERACTING_CLASS);
    document.documentElement.dataset.cmpriDesktopCursor = mode;
  }

  function update(event: ReactPointerEvent<HTMLElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const dx = event.clientX - interaction.startX;
    const dy = event.clientY - interaction.startY;
    setLiveRect(interaction.mode === "move"
      ? moveWindowRect(interaction.startRect, dx, dy, bounds)
      : resizeWindowRect(interaction.startRect, interaction.mode, dx, dy, bounds));
  }

  function end(event: ReactPointerEvent<HTMLElement>) {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    document.documentElement.classList.remove(INTERACTING_CLASS);
    delete document.documentElement.dataset.cmpriDesktopCursor;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (liveRect) onRectCommit(liveRect);
    setLiveRect(null);
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-cmpri-desktop-window={windowKey}
      data-active={active ? "true" : "false"}
      className="cmpri-desktop-window"
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height, zIndex, borderColor:modalTitleStyle(title).borderColor }}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <div
        className="cmpri-desktop-titlebar"
        style={modalTitleStyle(title)}
        onPointerDown={(event) => begin(event, "move")}
        onPointerMove={update}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <span aria-hidden="true" style={{backgroundColor:modalTitleStyle(title).borderColor}} className={`size-2 shrink-0 rounded-full ${accentClass}`} />
        <span id={titleId} className="min-w-0 flex-1 truncate">{title}</span>
        <button type="button" data-cmpri-window-close="true" aria-label={`Close ${title}`} title="Close" onClick={onClose} className="cmpri-desktop-close">
          <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2.5"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="cmpri-desktop-window-body">{children}</div>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          aria-hidden="true"
          className={`cmpri-desktop-resize cmpri-desktop-resize-${edge}`}
          onPointerDown={(event) => begin(event, edge)}
          onPointerMove={update}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </div>
  );
}
