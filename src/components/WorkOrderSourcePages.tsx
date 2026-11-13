"use client";

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import ManualSourceLink from './ManualSourceLink';
import PdfHtmlPreview from './PdfHtmlPreview';
import type { SourcePassage } from '@/lib/manual-source';

type Props = { passages: SourcePassage[]; sourceUrl: string; assetId: string; sourceSha256: string; userId: string; sourceOrder?: string[]; contextKey?: string; isOpen?: boolean; startAtTop?: boolean };
const documentKey = (page: SourcePassage) => JSON.stringify([page.source_document_id || page.source_url, page.source_sha256]);
const pageKey = (page: SourcePassage) => JSON.stringify([documentKey(page), page.page]);

/** Each original is opened once. HTML pages retain their layout and complete artwork. */
export default function WorkOrderSourcePages({ passages, sourceUrl, assetId, sourceSha256, userId, sourceOrder = [], contextKey = '', isOpen = true, startAtTop = true }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const documents = [...new Set([...sourceOrder, ...passages.map(page => page.source_document_id || page.source_url || sourceUrl)])];
  const pages = [...new Map(passages.map(page => [pageKey(page), page])).values()].sort((a, b) =>
    documents.indexOf(a.source_document_id || a.source_url || sourceUrl) - documents.indexOf(b.source_document_id || b.source_url || sourceUrl) || a.page - b.page);
  const hasPages = pages.length > 0;
  const viewKey = JSON.stringify([assetId, sourceSha256, userId, contextKey, pages.map(pageKey)]);
  const entered = useRef('');
  useLayoutEffect(() => {
    if (!isOpen) { entered.current = ''; return; }
    if (!hasPages || !startAtTop || entered.current === viewKey) return;
    const target = host.current; if (!target) return;
    const editing = target.ownerDocument.activeElement;
    if (editing?.matches('input,textarea,[contenteditable="true"]') && !target.closest('[data-ticket-accordion="troubleshooting"]')?.contains(editing)) return;
    entered.current = viewKey;
    const header = target.closest('[data-ticket-layout]')?.querySelector('[data-preview-locked-pane]');
    target.style.scrollMarginTop = ((header?.getBoundingClientRect().height || 0) + 8) + 'px';
    target.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, [isOpen, hasPages, startAtTop, viewKey]);
  if (!hasPages) return null;
  const groups = Map.groupBy(pages, documentKey);
  return <div ref={host} data-source-page-surface className="mt-1 min-w-0 text-sm">
    {[...groups].map(([key, group]) => <PdfHtmlPreview key={JSON.stringify([assetId, sourceSha256, userId, key])}
      sourceUrl={group[0].source_url || sourceUrl} userId={userId} pageNumbers={group.map(page => page.page)} isOpen={isOpen}
      renderPage={(number, preview) => <SourcePage passage={group.find(page => page.page === number)!} sourceUrl={sourceUrl} userId={userId} preview={preview} />} />)}
  </div>;
}

function SourcePage({ passage, sourceUrl, userId, preview }: { passage: SourcePassage; sourceUrl: string; userId: string; preview: ReactNode }) {
  const url = passage.source_url || sourceUrl;
  const chart = /\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(passage.text);
  return <section data-continuous-source-page={passage.page} data-source-document={passage.source_document_id} className="mt-1 min-w-0 border-t border-slate-700">
    <ManualSourceLink userId={userId} className="text-xs text-sky-300 underline" href={url.split('#')[0] + '#page=' + passage.page}>Page {passage.page}</ManualSourceLink>
    <div data-original-chart={chart ? 'true' : undefined}>{preview}</div>
  </section>;
}
