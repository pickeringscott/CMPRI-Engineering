"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import styles from "./GuideFlowchart.module.css";

export type GuidePhase = { node: string; highlight: string[]; title: string; text: string };
type Point = { x: number; y: number };
type Camera = Point & { zoom: number };
type ChartCommands = { fit(): void; zoom(factor: number): void; highlight(phase: GuidePhase): void };

const CHART_ASSET = "/beginners-guide/operating-cycle.svg";
const FIT: Camera = { x: 0, y: 0, zoom: 1 };
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

function separation(points: Map<number, Point>) {
  const [first, second] = points.values();
  return second && {
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

/** Route a rounded elbow across the gap that separates the note and chart. */
function elbow(start: Point, end: Point, fromRight: boolean, gutter?: number) {
  const a = fromRight ? start : { x: start.y, y: start.x };
  const b = fromRight ? end : { x: end.y, y: end.x };
  const bend = gutter ?? (a.x + b.x) / 2;
  const direction = Math.sign(b.y - a.y);
  const radius = Math.min(7, Math.abs(b.y - a.y) / 2, Math.abs(a.x - bend) / 2, Math.abs(b.x - bend) / 2);
  const point = (x: number, y: number) => fromRight ? `${x} ${y}` : `${y} ${x}`;
  return `M ${point(a.x, a.y)} L ${point(bend + radius, a.y)} Q ${point(bend, a.y)} ${point(bend, a.y + direction * radius)} L ${point(bend, b.y - direction * radius)} Q ${point(bend, b.y)} ${point(bend - radius, b.y)} L ${point(b.x, b.y)}`;
}

function makeViewport(
  viewport: HTMLDivElement, artwork: HTMLDivElement, svg: SVGSVGElement,
  frame: HTMLDivElement, note: HTMLElement, line: SVGPathElement,
) {
  const { width: chartWidth, height: chartHeight } = svg.viewBox.baseVal;
  const nodes = new Map<string, SVGGElement>();
  for (const node of svg.querySelectorAll<SVGGElement>("g.node")) {
    const key = node.id.match(/-flowchart-(.+)-\d+$/)?.[1];
    if (key) nodes.set(key, node);
  }

  const contacts = new Map<number, Point>();
  let active: SVGGElement | undefined;
  let camera = { ...FIT };
  let fitScale = 1;
  let base = { x: 0, y: 0 };
  let noteFollowsStage = false;
  artwork.style.width = `${chartWidth}px`;
  artwork.style.height = `${chartHeight}px`;

  function localPoint(clientX: number, clientY: number): Point {
    const box = viewport.getBoundingClientRect();
    return { x: clientX - box.left - viewport.clientLeft, y: clientY - box.top - viewport.clientTop };
  }

  function paint() {
    const scale = fitScale * camera.zoom;
    const visibleX = Math.min(32, viewport.clientWidth / 4);
    const visibleY = Math.min(32, viewport.clientHeight / 4);
    const x = clamp(base.x + camera.x, visibleX - chartWidth * scale, viewport.clientWidth - visibleX);
    const y = clamp(base.y + camera.y, visibleY - chartHeight * scale, viewport.clientHeight - visibleY);
    camera.x = x - base.x;
    camera.y = y - base.y;
    artwork.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  function draw(reveal = false) {
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    paint();
    if (!active) return;

    const viewportBox = viewport.getBoundingClientRect();
    const left = viewportBox.left + viewport.clientLeft;
    const top = viewportBox.top + viewport.clientTop;
    const right = left + viewport.clientWidth;
    const bottom = top + viewport.clientHeight;
    let bounds = active.getBoundingClientRect();

    if (reveal) {
      const x = (bounds.left + bounds.right) / 2;
      const y = (bounds.top + bounds.bottom) / 2;
      if (x < left || x > right || y < top || y > bottom) {
        camera.x += (left + right) / 2 - x;
        camera.y += (top + bottom) / 2 - y;
        paint();
        bounds = active.getBoundingClientRect();
      }
    }

    const stage = frame.getBoundingClientRect();
    if (noteFollowsStage) {
      const height = note.offsetHeight;
      const desired = (bounds.top + bounds.bottom - height) / 2 - stage.top;
      note.style.setProperty("--guide-note-offset", `${clamp(desired, 0, Math.max(0, frame.clientHeight - height))}px`);
    }

    if (bounds.right <= left || bounds.left >= right || bounds.bottom <= top || bounds.top >= bottom) {
      line.removeAttribute("d");
      return;
    }

    const card = note.getBoundingClientRect();
    const fromRight = card.left >= viewportBox.right - 1;
    const start = fromRight
      ? { x: card.left, y: card.top + Math.min(21, card.height / 2) }
      : { x: card.left + Math.min(21, card.width / 2), y: card.top };
    const end = fromRight
      ? { x: Math.min(bounds.right, right), y: clamp((bounds.top + bounds.bottom) / 2, top, bottom) }
      : { x: clamp((bounds.left + bounds.right) / 2, left, right), y: Math.min(bounds.bottom, bottom) };
    line.setAttribute("d", elbow(
      { x: start.x - stage.left, y: start.y - stage.top },
      { x: end.x - stage.left, y: end.y - stage.top },
      fromRight,
      fromRight && noteFollowsStage ? (viewportBox.right + card.left) / 2 - stage.left : undefined,
    ));
  }

  function measure() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    noteFollowsStage = getComputedStyle(note).alignSelf === "start";
    fitScale = Math.min(Math.max(1, width - 12) / chartWidth, Math.max(1, height - 12) / chartHeight);
    base = { x: (width - chartWidth * fitScale) / 2, y: (height - chartHeight * fitScale) / 2 };
    draw(true);
  }

  function zoomAt(factor: number, origin: Point, destination = origin) {
    const zoom = clamp(camera.zoom * factor, 0.65, 8);
    const ratio = zoom / camera.zoom;
    camera = {
      x: destination.x - base.x - (origin.x - base.x - camera.x) * ratio,
      y: destination.y - base.y - (origin.y - base.y - camera.y) * ratio,
      zoom,
    };
    draw();
  }

  function zoom(factor: number) {
    zoomAt(factor, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
  }

  function pan(x: number, y: number) {
    camera.x += x;
    camera.y += y;
    draw();
  }

  function fit() {
    camera = { ...FIT };
    draw(true);
  }

  function highlight(phase: GuidePhase) {
    active = nodes.get(phase.node);
    const related = new Set([phase.node, ...phase.highlight]);
    for (const [key, node] of nodes) {
      node.classList.toggle(styles.related, related.has(key));
      node.classList.toggle(styles.active, node === active);
      if (node === active) node.setAttribute("aria-current", "step");
      else node.removeAttribute("aria-current");
    }
    if (!active) line.removeAttribute("d");
    draw(true);
  }

  const controller = new AbortController();
  const { signal } = controller;
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    zoomAt(Math.exp(-event.deltaY * unit * 0.002), localPoint(event.clientX, event.clientY));
  }, { passive: false, signal });

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || contacts.size >= 2) return;
    contacts.set(event.pointerId, localPoint(event.clientX, event.clientY));
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add(styles.dragging);
  }, { signal });

  viewport.addEventListener("pointermove", (event) => {
    const previous = contacts.get(event.pointerId);
    if (!previous) return;
    const before = separation(contacts);
    const point = localPoint(event.clientX, event.clientY);
    contacts.set(event.pointerId, point);
    const after = separation(contacts);
    if (before && after && before.distance > 1) {
      zoomAt(after.distance / before.distance, before.center, after.center);
    } else pan(point.x - previous.x, point.y - previous.y);
  }, { signal });

  function endPointer(event: PointerEvent) {
    contacts.delete(event.pointerId);
    if (contacts.size === 0) viewport.classList.remove(styles.dragging);
  }
  viewport.addEventListener("pointerup", endPointer, { signal });
  viewport.addEventListener("pointercancel", endPointer, { signal });
  viewport.addEventListener("lostpointercapture", endPointer, { signal });

  const moves: Record<string, Point> = {
    ArrowLeft: { x: -35, y: 0 }, ArrowRight: { x: 35, y: 0 },
    ArrowUp: { x: 0, y: -35 }, ArrowDown: { x: 0, y: 35 },
  };
  viewport.addEventListener("keydown", (event) => {
    if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-") zoom(0.8);
    else if (event.key === "Home") fit();
    else if (moves[event.key]) pan(moves[event.key].x, moves[event.key].y);
    else return;
    event.preventDefault();
  }, { signal });

  const observer = new ResizeObserver(measure);
  observer.observe(viewport);
  observer.observe(note);
  measure();
  return { fit, zoom, highlight, dispose() { observer.disconnect(); controller.abort(); } };
}

export default function GuideFlowchart({ phase }: { phase: GuidePhase }) {
  const id = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const artworkRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLElement>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const commands = useRef<ChartCommands | null>(null);
  const currentPhase = useRef(phase);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useLayoutEffect(() => {
    currentPhase.current = phase;
    commands.current?.highlight(phase);
  }, [phase]);

  useEffect(() => {
    const frame = frameRef.current;
    const viewport = viewportRef.current;
    const artwork = artworkRef.current;
    const note = noteRef.current;
    const line = lineRef.current;
    if (!frame || !viewport || !artwork || !note || !line) return;
    const controller = new AbortController();
    let disposeViewport: (() => void) | undefined;

    void (async () => {
      try {
        // This path points to the checked-in README drawing. It has no runtime source input.
        const response = await fetch(CHART_ASSET, { signal: controller.signal });
        if (!response.ok) throw new Error("Unable to load the operating cycle.");
        const source = await response.text();
        if (controller.signal.aborted) return;
        const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
        if (!(svg instanceof SVGSVGElement) ||
            svg.id !== "cmpri-readme-operating-cycle") throw new Error("Unexpected operating cycle drawing.");
        const chart = document.importNode(svg, true);
        if (!chart.viewBox.baseVal.width || !chart.viewBox.baseVal.height) throw new Error("Missing diagram dimensions.");
        artwork.replaceChildren(chart);
        const controls = makeViewport(viewport, artwork, chart, frame, note, line);
        commands.current = controls;
        disposeViewport = controls.dispose;
        controls.highlight(currentPhase.current);
        setStatus("ready");
      } catch {
        if (!controller.signal.aborted) setStatus("unavailable");
      }
    })();

    return () => {
      controller.abort();
      disposeViewport?.();
      commands.current = null;
      artwork.replaceChildren();
    };
  }, []);

  return (
    <section className={styles.flowchart} aria-label="Work order flowchart">
      <div className={styles.toolbar}>
        <p id={`${id}-help`}>Drag to move. Scroll or pinch to zoom.</p>
        <div className={styles.controls}>
          <button type="button" aria-label="Zoom out" disabled={status !== "ready"} onClick={() => commands.current?.zoom(0.8)}>−</button>
          <button type="button" aria-label="Zoom in" disabled={status !== "ready"} onClick={() => commands.current?.zoom(1.25)}>+</button>
          <button type="button" aria-label="Fit full chart" disabled={status !== "ready"} onClick={() => commands.current?.fit()}>Fit</button>
        </div>
      </div>
      <div ref={frameRef} className={styles.frame}>
        <div
          ref={viewportRef} className={styles.viewport} role="region" tabIndex={0}
          aria-label="Operating cycle. Use arrow keys to move, plus or minus to zoom, or Home to fit the full chart."
          aria-describedby={`${id}-help`}
        >
          <div ref={artworkRef} className={styles.artwork} />
          {status !== "ready" && <p className={styles.status} role="status">{
            status === "loading" ? "Loading the work order flowchart…" : "The flowchart is unavailable. Open README.md to view it."
          }</p>}
        </div>
        <svg aria-hidden="true" className={styles.connector}>
          <defs>
            <marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 10 5 0 10Z" />
            </marker>
          </defs>
          <path ref={lineRef} className={styles.line} markerEnd={`url(#${id}-arrow)`} />
        </svg>
        <article ref={noteRef} className={styles.note} aria-live="polite" aria-atomic="true">
          <h2>{phase.title}</h2>
          <p>{phase.text}</p>
        </article>
      </div>
    </section>
  );
}
