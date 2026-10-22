"use client";

import { useEffect, useId, useRef, useState } from "react";

type Action = { key: string; label: string; tone?: string };

/** Presentation only: callers supply the already permission-filtered actions. */
export default function MobileDashboardMenus<T extends Action>({ groups, onLaunch, desktop = false }: {
  desktop?: boolean;
  groups: Array<{ label: string; items: T[] }>;
  onLaunch: (action: T, clickedAt: number) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const lastItem = useRef(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const items = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    (lastItem.current ? items?.[items.length - 1] : items?.[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const resized = () => setOpen(null);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resized);
    };
  }, [open]);

  return <div ref={root} data-chief-mobile-menus className={desktop ? "relative hidden min-w-0 flex-wrap gap-1 lg:flex" : "relative flex w-full min-w-0 flex-wrap gap-1 lg:hidden"}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(null); }}>
    {groups.map((group, index) => {
      const expanded = open === group.label;
      return <div key={group.label} className={desktop ? "relative" : undefined}>
        <button type="button" id={`${id}-trigger-${index}`} ref={(node) => { if (node) triggers.current.set(group.label, node); else triggers.current.delete(group.label); }}
          aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? `${id}-menu-${index}` : undefined}
          className="min-h-8 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
          onClick={() => { lastItem.current = false; setOpen(expanded ? null : group.label); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); lastItem.current = event.key === "ArrowUp"; setOpen(group.label);
            }
          }}>{group.label} <span aria-hidden="true">▾</span></button>
        {expanded && <div role="menu" id={`${id}-menu-${index}`} aria-labelledby={`${id}-trigger-${index}`}
          className={`${desktop ? "absolute left-0 w-max max-w-[min(320px,90vw)]" : "absolute inset-x-0"} top-full z-10 mt-1 max-h-[45svh] overflow-y-auto rounded-md border border-slate-700 bg-slate-900 p-1 text-slate-200 shadow-xl`}
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation(); setOpen(null); triggers.current.get(group.label)?.focus();
            } else if (event.key === "Tab") {
              setOpen(null); triggers.current.get(group.label)?.focus();
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              const candidates = [...items.slice(current + 1), ...items.slice(0, current + 1)];
              candidates.find(item => item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()))?.focus();
            }
          }}>
          {group.items.map(action => <button key={`${action.key}:${action.label}`} type="button" role="menuitem" data-cmpri-desktop-launch={action.key} tabIndex={-1}
            className={desktop ? `cmpri-desktop-launch my-0.5 block w-full whitespace-nowrap rounded border px-1 py-0.5 text-left font-semibold shadow-sm shadow-black/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300 ${action.tone || ""}` : `my-0.5 block min-h-10 w-full rounded border px-3 py-2 text-left text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300 ${action.tone || "text-slate-200"}`}
            onClick={() => { setOpen(null); onLaunch(action, Date.now()); }}>{action.label}</button>)}
        </div>}
      </div>;
    })}
  </div>;
}
