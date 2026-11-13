"use client";

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { sourcePageHtml } from '@/lib/manual-document-html';
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
    <p className="font-semibold text-sky-300">Source pages ({pages.length})</p>
    <p className="text-xs text-slate-400">Original page layout, diagrams and selectable text. Pages follow their original order.</p>
    {[...groups].map(([key, group]) => <PdfHtmlPreview key={JSON.stringify([assetId, sourceSha256, userId, key])}
      sourceUrl={group[0].source_url || sourceUrl} userId={userId} pageNumbers={group.map(page => page.page)} isOpen={isOpen}
      renderPage={(number, preview) => <SourcePage passage={group.find(page => page.page === number)!} sourceUrl={sourceUrl} userId={userId} preview={preview} />} />)}
  </div>;
}

function SourcePage({ passage, sourceUrl, userId, preview }: { passage: SourcePassage; sourceUrl: string; userId: string; preview: ReactNode }) {
  const url = passage.source_url || sourceUrl;
  const chart = /\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(passage.text);
  return <section data-continuous-source-page={passage.page} data-source-document={passage.source_document_id} className="mt-1 min-w-0 border-t border-slate-700">
    <p className="font-semibold text-sky-300">{passage.source_file_name || 'Source'} · PDF page {passage.page}{passage.printed_label && passage.printed_label !== String(passage.page) ? ' (printed ' + passage.printed_label + ')' : ''}</p>
    <div data-original-chart={chart ? 'true' : undefined}>{preview}</div>
    <ManualSourceLink userId={userId} className="text-sky-300 underline" href={url.split('#')[0] + '#page=' + passage.page}>Open PDF page {passage.page}</ManualSourceLink>
    <details className="mt-1" data-source-transcription>
      <summary className="cursor-pointer text-xs text-sky-300">Extracted text from PDF page {passage.page}</summary>
      {chart && <p className="text-xs text-slate-400">Use the complete diagram above when following a branch.</p>}
      <div className="break-words [&_h2]:font-semibold [&_h2]:text-sky-300 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_.manual-source-table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700" dangerouslySetInnerHTML={{ __html: sourcePageHtml(passage.text, passage.page, passage.origin || 'pdf') }} />
    </details>
  </section>;
}
