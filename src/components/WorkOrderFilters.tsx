"use client";

import { useLayoutEffect, useRef } from "react";

export type WorkOrderListFilter = "pending" | "open" | "progress" | "priority" | "overdue" | "completed" | "closed" | "all";

const CARDS: Array<{ key: WorkOrderListFilter; label: string; compactLabel: string }> = [
  { key: "pending", label: "Pending", compactLabel: "Pending" },
  { key: "open", label: "Open", compactLabel: "Open" },
  { key: "progress", label: "In Progress", compactLabel: "Progress" },
  { key: "priority", label: "Urgent / High", compactLabel: "Urgent/High" },
  { key: "overdue", label: "Overdue", compactLabel: "Overdue" },
  { key: "completed", label: "Completed", compactLabel: "Done" },
  { key: "closed", label: "Closed", compactLabel: "Closed" },
  { key: "all", label: "All", compactLabel: "All" },
];

export default function WorkOrderFilters({ filter, searching, loading, countFor, onChange }: {
  filter: WorkOrderListFilter;
  searching: boolean;
  loading: boolean;
  countFor: (key: WorkOrderListFilter) => number;
  onChange: (key: WorkOrderListFilter) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const countSignature = CARDS.map(card => countFor(card.key)).join(",");

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!grid || !context) return;
    let disposed = false;
    let frame = 0;

    function layout() {
      if (!grid || !context || disposed || !grid.clientWidth) return;
      const available = grid.clientWidth;
      const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>("button"))
        .sort((a, b) => Number(getComputedStyle(a).order) - Number(getComputedStyle(b).order));
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 4;

      function measure(compact: boolean, font: number) {
        grid!.dataset.compact = String(compact);
        grid!.style.setProperty("--filter-font-size", `${font}px`);
        return buttons.map(button => {
          const label = button.querySelector<HTMLElement>(compact ? ".filter-label-short" : ".filter-label-full")!;
          const count = button.lastElementChild as HTMLElement;
          function textWidth(element: HTMLElement) {
            const style = getComputedStyle(element);
            context!.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const text = style.textTransform === "uppercase" ? element.textContent!.toUpperCase() : element.textContent!;
            return context!.measureText(text).width + Math.max(0, text.length - 1) * (parseFloat(style.letterSpacing) || 0);
          }
          const style = getComputedStyle(button);
          const chrome = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth, style.columnGap]
            .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
          return Math.ceil(textWidth(label) + textWidth(count) + chrome + 2);
        });
      }

      let tracks = measure(false, 11);
      let columns = 8;
      if (tracks.reduce((sum, value) => sum + value, 0) + gap * 7 > available) {
        columns = 4;
        const paired = (widths: number[]) => Array.from({ length: 4 }, (_, index) => Math.max(widths[index], widths[index + 4]));
        tracks = paired(tracks);
        if (tracks.reduce((sum, value) => sum + value, 0) + gap * 3 > available) {
          for (let font = 11; font >= 6; font -= 0.25) {
            tracks = paired(measure(true, font));
            if (tracks.reduce((sum, value) => sum + value, 0) + gap * 3 <= available) break;
          }
        }
      }
      grid.dataset.columns = String(columns);
      grid.style.setProperty("grid-template-columns", tracks.map(width => `minmax(${width}px, 1fr)`).join(" "), "important");
    }

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(grid);
    void document.fonts.ready.then(() => { if (!disposed) schedule(); });
    layout();
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [countSignature, loading]);

  return <div ref={gridRef} id="work-order-kpi-filters" role="group" aria-label="Work order filters" className="grid shrink-0">
    {CARDS.map(card => <button
      key={card.key}
      data-preview-kpi={card.key}
      type="button"
      title={card.label}
      aria-label={`${card.label}: ${loading ? "loading" : countFor(card.key)}`}
      aria-pressed={!searching && filter === card.key}
      onClick={() => onChange(card.key)}
      className="work-order-filter-button rounded border font-semibold uppercase"
    >
      <span className="work-order-filter-label"><span className="filter-label-full">{card.label}</span><span className="filter-label-short">{card.compactLabel}</span></span>
      <span className="work-order-filter-count font-bold">{loading ? "—" : countFor(card.key)}</span>
    </button>)}
  </div>;
}
