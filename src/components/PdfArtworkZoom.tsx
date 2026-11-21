"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";

import { useEffect, useState, type RefObject } from 'react';
import WorkOrderDiagramViewer, { type DiagramTouchStart } from './WorkOrderDiagramViewer';

/** Reuse the already authorized manual pixels; opening a visual makes no source request. */
export default function PdfArtworkZoom({ host, imageUrl, pageNumber }: { host: RefObject<HTMLDivElement | null>; imageUrl: string; pageNumber?: number }) {
  const { t, tt } = useUiLanguage();
  const title = pageNumber === undefined ? t("Image") : t("Page {number}", {number:pageNumber});
  const label = pageNumber === undefined ? t("Enlarge image") : t("Enlarge page {number}", {number:pageNumber});
  const [opened, setOpened] = useState<{ initialTouches?: DiagramTouchStart } | null>(null);
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const click = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      // Text remains selectable. The explicit zoom button also works over text.
      const selection = window.getSelection();
      if (element?.closest('span,button,a,[data-diagram-modal]') || (selection && !selection.isCollapsed)) return;
      setOpened({});
    };
    const pinch = (event: TouchEvent) => {
      if (event.touches.length !== 2 || (event.target instanceof Element && event.target.closest('[data-diagram-modal]'))) return;
      event.preventDefault(); event.stopPropagation();
      setOpened({ initialTouches: Array.from(event.touches).map(({ identifier, clientX, clientY }) => ({ identifier, clientX, clientY })) });
    };
    target.addEventListener('click', click);
    target.addEventListener('touchstart', pinch, { passive: false });
    return () => { target.removeEventListener('click', click); target.removeEventListener('touchstart', pinch); };
  }, [host]);
  return <>
    <button type="button" aria-label={label} title={tt(label)} onClick={event => { event.stopPropagation(); setOpened({}); }}
      className="absolute right-1 top-1 z-10 grid h-9 w-9 place-items-center rounded border shadow-sm" style={{ backgroundColor: 'var(--cmpri-modal-surface,var(--cmpri-palette-modal-base))', color: 'var(--cmpri-modal-text,var(--cmpri-palette-modal-text))', borderColor: 'var(--cmpri-outline,rgba(var(--cmpri-palette-control-rgb),.42))' }}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M10 7v6M7 10h6"/></svg>
    </button>
    {opened && <WorkOrderDiagramViewer imageUrl={imageUrl} title={title} initialTouches={opened.initialTouches} onClose={() => setOpened(null)} />}
  </>;
}
