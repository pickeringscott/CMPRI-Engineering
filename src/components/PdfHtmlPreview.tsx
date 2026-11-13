"use client";

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, TextLayer } from 'pdfjs-dist';
import { createClient, getValidSession } from '@/lib/supabase/client';
import { localOcrPaths } from '@/lib/ocr/local-ocr';
import { themeSourceDiagramBlob } from '@/lib/work-orders/diagram-theme';
import styles from './PdfHtmlPreview.module.css';
import PdfArtworkZoom from './PdfArtworkZoom';

type PdfRuntime = typeof import('pdfjs-dist');
type Document = { pdf: PDFDocumentProxy; runtime: PdfRuntime; enqueue: <T>(work: () => Promise<T>) => Promise<T> };
type Props = {
  file?: File;
  sourceUrl?: string;
  userId?: string;
  pageNumbers?: number[];
  isOpen?: boolean;
  renderPage?: (page: number, preview: ReactNode) => ReactNode;
};

/** Render whole PDF pages as HTML with their original artwork and selectable text.
 * One source read and worker per document; scrolling never discards completed pages.
 * PDF scripts, annotations, attachments and remote resource URLs are not executed.
 */
export default function PdfHtmlPreview(props: Props) {
  const scope = JSON.stringify([props.sourceUrl, props.userId]);
  // A new File can have the same name/size as its predecessor; retain object identity.
  return <PreviewDocument key={scope} {...props} />;
}

function PreviewDocument({ file, sourceUrl, userId, pageNumbers, isOpen = true, renderPage }: Props) {
  const [result, setResult] = useState<{ file?: File; sourceUrl?: string; document: Document } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const surface = useRef<HTMLDivElement>(null);
  const [paletteVersion, setPaletteVersion] = useState(0);
  useEffect(() => {
    if (!surface.current || typeof MutationObserver === 'undefined') return;
    const signature = () => { const style = getComputedStyle(surface.current!); return style.backgroundColor + '/' + style.color; };
    let previous = signature();
    const changed = () => { const next = signature(); if (next !== previous) { previous = next; setPaletteVersion(value => value + 1); } };
    const observer = new MutationObserver(changed);
    for (let node: HTMLElement | null = surface.current; node; node = node.parentElement) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-cmpri-modal-theme'] });
    window.addEventListener('cmpri-palette-change', changed);
    return () => { observer.disconnect(); window.removeEventListener('cmpri-palette-change', changed); };
  }, []);
  const [started, setStarted] = useState(isOpen);
  if (isOpen && !started) setStarted(true);
  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    let task: ReturnType<PdfRuntime['getDocument']> | undefined;
    let cancelled = false;
    const current = () => !cancelled && !controller.signal.aborted;
    const subscription = userId ? createClient().auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        controller.abort();
        void task?.destroy();
        setResult(null);
        setError('Your account changed. Reopen the manual to continue.');
      }
    }).data.subscription : undefined;
    void (async () => {
      try {
        let data: Uint8Array;
        const runtimePromise = import('pdfjs-dist');
        if (file) {
          if (file.size > 100 * 1024 * 1024) throw Error('The PDF exceeds the supported 100 MB size.');
          data = new Uint8Array(await file.arrayBuffer());
        } else {
          if (!sourceUrl || !userId) throw Error('A current manual and signed-in account are required.');
          const url = new URL(sourceUrl, window.location.origin);
          if (url.origin !== window.location.origin) throw Error('Open this manual through its current equipment source.');
          const session = await getValidSession();
          if (!current()) return;
          if (session?.user.id !== userId || !session.access_token) throw Error('Sign in again to read the manual.');
          if (url.pathname === '/api/assets/documentation/source') url.searchParams.set('format', 'pdf');
          const response = await fetch(url.pathname + url.search, {
            headers: { Authorization: `Bearer ${session.access_token}` }, signal: controller.signal, cache: 'no-store',
          });
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw Error(body?.error || `The original manual could not be loaded (${response.status}).`);
          }
          if (Number(response.headers.get('content-length')) > 100 * 1024 * 1024) throw Error('The PDF exceeds the supported 100 MB size.');
          data = new Uint8Array(await response.arrayBuffer());
          const after = await getValidSession();
          if (!current() || after?.user.id !== userId) return;
        }
        if (!current()) return;
        if (data.length > 100 * 1024 * 1024 || ![37, 80, 68, 70, 45].every((byte, index) => data[index] === byte)) throw Error('The original is not a supported PDF.');
        const runtime = await runtimePromise;
        if (!current()) return;
        const paths = localOcrPaths(window.location.origin);
        runtime.GlobalWorkerOptions.workerSrc = paths.pdfWorkerPath;
        task = runtime.getDocument({ data, useWorkerFetch: false,
          standardFontDataUrl: paths.standardFontDataUrl, cMapUrl: paths.cMapUrl,
          cMapPacked: true, wasmUrl: paths.wasmUrl, useSystemFonts: true });
        const pdf = await task.promise;
        if (!current()) return;
        if (pdf.numPages < 1 || pdf.numPages > 10000) throw Error('The PDF has an unsupported page count.');
        let running = 0;
        const waiting: (() => void)[] = [];
        const enqueue = async <T,>(work: () => Promise<T>): Promise<T> => {
          if (running >= 2) await new Promise<void>(resolve => waiting.push(resolve));
          running++;
          try { if (!current()) throw Error('Preview closed.'); return await work(); }
          finally { running--; waiting.shift()?.(); }
        };
        setError('');
        setResult({ file, sourceUrl, document: { pdf, runtime, enqueue } });
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : 'The manual preview could not be loaded.');
      }
    })();
    return () => { cancelled = true; controller.abort(); subscription?.unsubscribe(); void task?.destroy(); };
    // Keep the document open when the accordion closes; only its source/account owns it.
  }, [file, sourceUrl, userId, retry, started]);
  const document = result?.file === file && result?.sourceUrl === sourceUrl ? result?.document ?? null : null;
  const pages = pageNumbers || (document ? Array.from({ length: document.pdf.numPages }, (_, index) => index + 1) : []);
  return <div ref={surface} data-pdf-html-preview className="min-w-0 space-y-1" style={{backgroundColor:'var(--cmpri-modal-surface,#191b24)',color:'var(--cmpri-modal-text,#f0f1f6)'}}>
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button type="button" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .25))} className="underline">Zoom out</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))} className="underline">Zoom in</button>
    </div>
    {error ? <p role="alert" className="text-xs text-amber-200">{error} <button type="button" onClick={() => setRetry(value => value + 1)} className="underline">Retry preview</button></p>
      : !document ? <p role="status" className="text-xs text-slate-400">{isOpen ? 'Loading original manual for HTML preview…' : 'Open this section to preview the manual.'}</p> : null}
    {pages.map(page => {
      const preview = <div className={styles.viewport}><div style={{ width: `${zoom * 100}%` }}>
        {document && <HtmlPage key={JSON.stringify([file?.name, sourceUrl, retry, page])} document={document} pageNumber={page} isOpen={isOpen} paletteVersion={paletteVersion} />}
      </div></div>;
      return <div key={page}>{renderPage ? renderPage(page, preview) : <section aria-label={`Original PDF page ${page}`}><p className="text-xs">PDF page {page}</p>{preview}</section>}</div>;
    })}
  </div>;
}

function HtmlPage({ document, pageNumber, isOpen, paletteVersion }: { document: Document | null; pageNumber: number; isOpen: boolean; paletteVersion:number }) {
  const host = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [activated, setActivated] = useState(false);
  if (seen && isOpen && !activated) setActivated(true);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState('612 / 792');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const target = host.current;
    const resized = () => { const measured = Math.round(target.getBoundingClientRect().width); if (measured > 0) setWidth(measured); };
    resized();
    const resize = new ResizeObserver(resized); resize.observe(target);
    const intersection = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); intersection.disconnect(); }
    }, { rootMargin: '1200px 0px' });
    intersection.observe(target);
    return () => { resize.disconnect(); intersection.disconnect(); };
  }, []);
  useEffect(() => {
    if (!document || !activated || !width || !layer.current) return;
    let cancelled = false, objectUrl = '';
    let page: PDFPageProxy | undefined, rendering: ReturnType<PDFPageProxy['render']> | undefined, text: TextLayer | undefined;
    const target = layer.current;
    void document.enqueue(async () => {
      try {
        if (cancelled) return;
        page = await document.pdf.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(`${base.width} / ${base.height}`);
        const scale = width / base.width;
        const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(2_000_000 / (width * width * base.height / base.width)));
        const viewport = page.getViewport({ scale: scale * density });
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        try {
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw Error('This device could not display the PDF page.');
          rendering = page.render({ canvas, canvasContext: context, viewport, background: 'rgb(255,255,255)' });
          await rendering.promise;
          if (cancelled) return;
          const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
          if (cancelled) return;
          if (!blob) throw Error('This page could not be converted for display.');
          const textContentSource = await page.getTextContent();
          if (cancelled) return;
          const operators = await page.getOperatorList();
          if (cancelled) return;
          const raster = new Set(Object.entries(document.runtime.OPS).filter(([name]) => /paint.*Image|shadingFill|setFillColorN|setStrokeColorN/.test(name)).map(([,op]) => op));
          const vectorOnly = !operators.fnArray.some(op => raster.has(op));
          const sourceText = textContentSource.items.map(item => 'str' in item ? item.str : '').join(' ');
          const themed = await themeSourceDiagramBlob(blob,host.current,sourceText,vectorOnly);
          if (cancelled) return;
          objectUrl = URL.createObjectURL(themed.blob);
          setImage(objectUrl); setError('');
          target.replaceChildren();
          target.style.setProperty('--total-scale-factor', String(scale * (page.userUnit || 1)));
          text = new document.runtime.TextLayer({ container: target, viewport: page.getViewport({ scale }), textContentSource });
          await text.render();
        } finally { canvas.width = 0; canvas.height = 0; }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'This page could not be displayed.');
      } finally { page?.cleanup(); }
    }).catch(() => {});
    return () => { cancelled = true; rendering?.cancel(); text?.cancel(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
    // Once visited, keep the rendered page while scrolling or closing the section.
  }, [document, activated, width, pageNumber, retry, paletteVersion]);
  return <div ref={host} className={styles.page} data-pdf-html-page={pageNumber} style={{ aspectRatio: ratio }}>
    {/* Neutral page colors follow the app; diagrams, source colors and geometry remain intact. */}
    {image && <picture style={{ display: 'contents' }}><img src={image} draggable={false} alt={`Original PDF page ${pageNumber}, including complete diagrams and tables`} /></picture>}
    <div ref={layer} className={styles.textLayer} data-pdf-text-layer />
    {image && isOpen && <PdfArtworkZoom key={image} host={host} imageUrl={image} pageNumber={pageNumber} />}
    {!image && !error && <p role="status" className="absolute left-2 top-2 text-xs opacity-70">{seen ? 'Loading page…' : 'Page loads as you approach it.'}</p>}
    {error && <p role="alert" className="relative p-2 text-xs text-amber-200">{error} <button type="button" onClick={() => setRetry(value => value + 1)} className="underline">Retry page</button></p>}
  </div>;
}
