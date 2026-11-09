"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { SourceSemantics } from "@/lib/work-orders/source-semantics";

type Props = { imageUrl: string; title: string; onClose: () => void; semantics?: SourceSemantics | null };
const surfaceStyle = { backgroundColor: "var(--cmpri-modal-surface,#191b24)", color: "var(--cmpri-modal-text,#f0f1f6)", borderColor: "var(--cmpri-outline,rgba(162,171,209,.42))" };
const controlStyle = { backgroundColor: "rgba(var(--cmpri-action-rgb,162,171,209),.14)", borderColor: "var(--cmpri-outline,rgba(162,171,209,.42))" };
type Point = { x: number; y: number };
type View = { scale: number; x: number; y: number };
type Geometry = { width: number; height: number; imageWidth: number; imageHeight: number };
type Gesture =
  | { kind: "pan"; id: number; point: Point; view: View }
  | { kind: "pinch"; ids: number[]; midpoint: Point; distance: number; view: View };

const INITIAL_VIEW: View = { scale: 1, x: 0, y: 0 };
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function bounded(view: View, geometry: Geometry): View {
  const scale = clamp(view.scale, 1, 6);
  const horizontal = Math.max(0, (geometry.imageWidth * scale - geometry.width) / 2);
  const vertical = Math.max(0, (geometry.imageHeight * scale - geometry.height) / 2);
  return { scale, x: clamp(view.x, -horizontal, horizontal), y: clamp(view.y, -vertical, vertical) };
}

/** The parent supplies an authorized image; no extra fetch or proxy is used. */
export default function WorkOrderDiagramViewer({ imageUrl, title, onClose, semantics }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const viewRef = useRef<View>(INITIAL_VIEW);
  const [frame, setFrame] = useState({ source: imageUrl, view: INITIAL_VIEW });
  const [imageState, setImageState] = useState<{ source: string; state: "loading" | "ready" | "error" }>({ source: imageUrl, state: "loading" });
  const view = frame.source === imageUrl ? frame.view : INITIAL_VIEW;
  const phase = imageState.source === imageUrl ? imageState.state : "loading";

  function geometry(): Geometry {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { width: rect?.width || 0, height: rect?.height || 0, imageWidth: imageRef.current?.offsetWidth || 0, imageHeight: imageRef.current?.offsetHeight || 0 };
  }
  function commit(next: View) {
    const value = bounded(next, geometry());
    viewRef.current = value;
    setFrame(previous => previous.source === imageUrl && previous.view.scale === value.scale && previous.view.x === value.x && previous.view.y === value.y ? previous : { source: imageUrl, view: value });
  }
  function releasePointers() {
    const viewport = viewportRef.current;
    for (const id of pointers.current.keys()) {
      try { if (viewport?.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch { /* The browser can release capture before cancellation. */ }
    }
    pointers.current.clear();
    gesture.current = null;
  }
  function reset() { releasePointers(); commit(INITIAL_VIEW); }
  function beginGesture() {
    const current = [...pointers.current];
    if (current.length >= 2) {
      const [[firstId, first], [secondId, second]] = current;
      gesture.current = { kind: "pinch", ids: [firstId, secondId], midpoint: midpoint(first, second), distance: Math.max(1, distance(first, second)), view: { ...viewRef.current } };
    } else if (current.length === 1) {
      gesture.current = { kind: "pan", id: current[0][0], point: current[0][1], view: { ...viewRef.current } };
    } else gesture.current = null;
  }
  function point(event: React.PointerEvent<HTMLDivElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  }
  function zoom(factor: number) {
    releasePointers();
    const current = viewRef.current;
    const scale = clamp(current.scale * factor, 1, 6);
    commit({ scale, x: current.x * scale / current.scale, y: current.y * scale / current.scale });
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    // A different source must never inherit another diagram's gesture or zoom.
    viewRef.current = INITIAL_VIEW;
    const viewport = viewportRef.current;
    const activePointers = pointers.current;
    const resetBounds = () => {
      const rect = viewport?.getBoundingClientRect();
      const next = bounded(viewRef.current, { width: rect?.width || 0, height: rect?.height || 0, imageWidth: imageRef.current?.offsetWidth || 0, imageHeight: imageRef.current?.offsetHeight || 0 });
      viewRef.current = next;
      setFrame(previous => previous.source === imageUrl && previous.view.scale === next.scale && previous.view.x === next.x && previous.view.y === next.y ? previous : { source: imageUrl, view: next });
      for (const id of activePointers.keys()) {
        try { if (viewport?.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch { /* The browser may have cancelled this gesture. */ }
      }
      activePointers.clear(); gesture.current = null;
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resetBounds);
    if (viewport) observer?.observe(viewport);
    window.addEventListener("resize", resetBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resetBounds);
      for (const id of activePointers.keys()) {
        try { if (viewport?.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch { /* Capture may already be released. */ }
      }
      activePointers.clear(); gesture.current = null;
    };
  }, [imageUrl]);

  return <dialog ref={dialogRef} aria-label={title} aria-modal="true" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }} data-diagram-modal="true" style={{ ...surfaceStyle, borderColor: semantics?.color || surfaceStyle.borderColor }} className="m-auto h-[min(92dvh,58rem)] w-[min(96vw,80rem)] max-w-none overflow-hidden rounded-xl border p-0 shadow-2xl backdrop:bg-black/70">
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 sm:p-3" style={{ backgroundColor: "rgba(var(--cmpri-action-rgb,162,171,209),.12)", borderColor: "var(--cmpri-outline,rgba(162,171,209,.42))" }}>
        <h2 className="min-w-0 flex-1 break-words text-sm font-semibold">{title}</h2>
        {semantics && <span style={{ color: semantics.color }} className="text-xs font-semibold">{semantics.label}</span>}
        <button ref={closeRef} type="button" aria-label="Close diagram" onClick={onClose} style={controlStyle} className="min-h-11 rounded-lg border px-3 text-sm">Close</button>
        <div className="flex w-full items-center justify-center gap-2 sm:w-auto" role="group" aria-label="Diagram zoom controls">
          <button type="button" aria-label="Zoom out" disabled={phase !== "ready" || view.scale <= 1} onClick={() => zoom(1 / 1.5)} style={controlStyle} className="min-h-11 min-w-11 rounded-lg border px-3 disabled:opacity-40">−</button>
          <output aria-live="polite" className="min-w-14 text-center text-xs">{Math.round(view.scale * 100)}%</output>
          <button type="button" aria-label="Zoom in" disabled={phase !== "ready" || view.scale >= 6} onClick={() => zoom(1.5)} style={controlStyle} className="min-h-11 min-w-11 rounded-lg border px-3 disabled:opacity-40">+</button>
          <button type="button" aria-label="Reset zoom" disabled={phase !== "ready"} onClick={reset} style={controlStyle} className="min-h-11 rounded-lg border px-3 text-sm disabled:opacity-40">Reset</button>
        </div>
      </div>
      <p className="shrink-0 px-3 py-1.5 text-center text-xs" style={{ color: "var(--cmpri-modal-muted,#a4a6af)" }}>Pinch to zoom or use the zoom controls. Drag the enlarged diagram to move it.</p>
      {phase === "loading" && <p role="status" className="px-3 py-1 text-xs text-slate-300">Loading diagram…</p>}
      {phase === "error" && <p role="alert" className="px-3 py-1 text-sm text-amber-200">This diagram could not be opened. Close it and try the source again.</p>}
      <div ref={viewportRef} data-diagram-viewport="true" data-diagram-scale={view.scale} data-diagram-x={view.x} data-diagram-y={view.y} role="region" aria-label="Diagram image. Pinch or use the zoom controls, then drag to move." tabIndex={0} className="relative min-h-0 flex-1 overflow-hidden outline-offset-[-3px] focus-visible:outline focus-visible:outline-2" style={{ ...surfaceStyle, outlineColor: "var(--cmpri-modal-text,#f0f1f6)", touchAction: "none", cursor: view.scale > 1 ? "grab" : "default" }} onPointerDown={event => {
        if (phase !== "ready" || event.button !== 0 && event.pointerType === "mouse") return;
        event.preventDefault(); event.stopPropagation();
        pointers.current.set(event.pointerId, point(event));
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Tests and interrupted pointers may lack capture. */ }
        beginGesture();
      }} onPointerMove={event => {
        if (!pointers.current.has(event.pointerId)) return;
        event.preventDefault(); event.stopPropagation();
        pointers.current.set(event.pointerId, point(event));
        const current = gesture.current;
        if (current?.kind === "pan") {
          const next = pointers.current.get(current.id);
          if (next) commit({ ...current.view, x: current.view.x + next.x - current.point.x, y: current.view.y + next.y - current.point.y });
        } else if (current?.kind === "pinch") {
          const first = pointers.current.get(current.ids[0]), second = pointers.current.get(current.ids[1]);
          if (!first || !second) return;
          const center = midpoint(first, second);
          const scale = clamp(current.view.scale * distance(first, second) / current.distance, 1, 6);
          const ratio = scale / current.view.scale;
          commit({ scale, x: center.x - (current.midpoint.x - current.view.x) * ratio, y: center.y - (current.midpoint.y - current.view.y) * ratio });
        }
      }} onPointerUp={event => {
        if (!pointers.current.delete(event.pointerId)) return;
        event.preventDefault(); event.stopPropagation();
        try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Capture may already be released. */ }
        beginGesture();
      }} onPointerCancel={event => {
        pointers.current.delete(event.pointerId);
        event.stopPropagation();
        try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* A cancelled pointer can already have lost capture. */ }
        beginGesture();
      }} onLostPointerCapture={event => { if (pointers.current.delete(event.pointerId)) beginGesture(); }} onKeyDown={event => {
        if (phase !== "ready" || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === "+" || event.key === "=") zoom(1.5);
        else if (event.key === "-") zoom(1 / 1.5);
        else if (event.key === "0" || event.key === "Home") reset();
        else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          const current = viewRef.current;
          commit({ ...current, x: current.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0), y: current.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0) });
        } else return;
        event.preventDefault(); event.stopPropagation();
      }}>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {/* This approved local image is supplied by the parent; Next's optimizer must not refetch it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={imageUrl} ref={imageRef} data-diagram-image="true" src={imageUrl} alt={title} draggable={false} className="max-h-full max-w-full select-none object-contain" style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`, transformOrigin: "center" }} onLoad={() => { setImageState({ source: imageUrl, state: "ready" }); reset(); }} onError={() => { releasePointers(); setImageState({ source: imageUrl, state: "error" }); }} />
        </div>
      </div>
    </div>
  </dialog>;
}
