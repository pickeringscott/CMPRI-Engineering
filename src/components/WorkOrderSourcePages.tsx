"use client";

import { useEffect, useRef, useState } from "react";
// Native picture keeps the authenticated page-image blob browser-local and preserves its dimensions.
import { createClient, getValidSession } from "@/lib/supabase/client";
import { sourcePageHtml } from "@/lib/manual-document-html";
import ManualSourceLink from "./ManualSourceLink";
import type { SourcePassage } from "@/lib/manual-source";
import {themeSourceDiagramBlob} from '@/lib/work-orders/diagram-theme';

/** Show original pages intact when their layout cannot be safely turned into steps. */
export default function WorkOrderSourcePages({ passages, sourceUrl, assetId, sourceSha256, userId }: { passages: SourcePassage[]; sourceUrl: string; assetId: string; sourceSha256: string; userId: string }) {
  const host=useRef<HTMLDivElement>(null);
  const [paletteVersion,setPaletteVersion]=useState(0);
  const hasPages=passages.length>0;
  useEffect(()=>{
    if(!host.current||typeof MutationObserver==='undefined')return;
    const signature=()=>{const style=getComputedStyle(host.current!);return style.backgroundColor+'/'+style.color;};
    let previous=signature();
    const changed=()=>{const next=signature();if(next!==previous){previous=next;setPaletteVersion(value=>value+1);}};
    const observer=new MutationObserver(changed);
    for(let ancestor:HTMLElement|null=host.current.parentElement;ancestor;ancestor=ancestor.parentElement)observer.observe(ancestor,{attributes:true,attributeFilter:['style','class','data-theme','data-cmpri-modal-theme']});
    window.addEventListener('cmpri-palette-change',changed);
    return()=>{observer.disconnect();window.removeEventListener('cmpri-palette-change',changed);};
  },[hasPages]);
  // A page number is local to one source document, never global to the asset.
  const pageKey = (passage: SourcePassage) => JSON.stringify([passage.source_document_id || sourceUrl, passage.source_sha256 || sourceSha256, passage.page]);
  const pages = [...new Map(passages.map(passage => [pageKey(passage), passage])).entries()];
  const [selection, setSelection] = useState<string | null>(null);
  const selected = pages.find(([key]) => key === selection) || pages[0];
  const currentKey = selected?.[0];
  const current = selected?.[1].page;
  const currentFileId = selected?.[1].source_document_id;
  const currentSha256 = selected?.[1].source_sha256 || sourceSha256;
  const currentSourceUrl = selected?.[1].source_url || sourceUrl;
  const currentText=selected?.[1].text||'';
  const [image, setImage] = useState<{ key: string; url: string;adapted:boolean } | null>(null);
  const imageKey = JSON.stringify([assetId, currentSha256, userId, currentKey,paletteVersion]);
  useEffect(() => {
    if (!current || !assetId || !currentSha256 || !userId) return;
    const controller = new AbortController();
    let url = '';
    const { data: { subscription } } = createClient().auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { controller.abort(); if (url) URL.revokeObjectURL(url); url = ''; setImage(null); }
    });
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token || session.user.id !== userId || controller.signal.aborted) return;
        const query = new URLSearchParams({ source: 'asset-upload', assetId, sha256: currentSha256, pageImage: String(current) });
        if (currentFileId) query.set('fileId', currentFileId);
        const response = await fetch(`/api/maintenance-reference?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` }, signal: controller.signal, cache: 'no-store' });
        if (!response.ok) return;
        const blob = await response.blob();
        const after = await getValidSession();
        if (controller.signal.aborted || after?.user.id !== userId) return;
        const display=await themeSourceDiagramBlob(blob,host.current,currentText,response.headers?.get('X-CMPRI-Source-Artwork')==='vector');
        if(controller.signal.aborted)return;
        url = URL.createObjectURL(display.blob);
        setImage({ key: imageKey, url,adapted:display.adapted });
      } catch { /* The source link remains available if rendering fails. */ }
    })();
    return () => { controller.abort(); subscription.unsubscribe(); if (url) URL.revokeObjectURL(url); };
  }, [assetId, currentSha256, currentFileId, userId, current, imageKey,currentText]);
  if (!pages.length) return null;
  const chart=/\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(selected?.[1].text || '');
  const originalPage=image?.key === imageKey && <picture style={{ display: 'contents' }}><img data-diagram-adapted={image.adapted?'true':'false'} className="h-auto w-full rounded border border-slate-700" src={image.url} alt={`Manual page ${current}, including diagrams and tables`} /></picture>;
  const transcription=passages.filter(passage => pageKey(passage) === currentKey).map((passage, index) => <section key={`${passage.page}-${index}`} className="mt-1">
    <div className="break-words text-slate-100 [&_h2]:font-semibold [&_h2]:text-sky-300 [&_h3]:mt-2 [&_h3]:font-semibold [&_p]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1 [&_.manual-source-table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-slate-700 [&_th]:p-1 [&_td]:border [&_td]:border-slate-700 [&_td]:p-1" dangerouslySetInnerHTML={{ __html: sourcePageHtml(passage.text, passage.page, passage.origin || "pdf") }} />
  </section>);
  return (
    <div ref={host} data-source-page-surface className="mt-1 text-sm" style={{backgroundColor:'var(--cmpri-modal-surface,#191b24)',color:'var(--cmpri-modal-text,#f0f1f6)'}}>
      <label className="mt-1 flex items-center gap-2">
        <span className="font-semibold text-sky-300">Matching source pages ({pages.length}):</span>
        <select className="min-w-0 rounded border border-slate-700 bg-slate-950 px-1 text-slate-100" value={currentKey} onChange={event => setSelection(event.target.value)}>
          {pages.map(([key, passage]) => <option key={key} value={key}>{passage.source_file_name || "Source"} · PDF page {passage.page}{passage.printed_label && passage.printed_label!==String(passage.page) ? ` (printed ${passage.printed_label})` : ""}</option>)}
        </select>
      </label>
      <p className="mt-1 text-xs text-slate-400">Source references are not a diagnosis. Compare the complete page and its warnings before using a procedure.</p>
      {chart&&<div className="mt-1" data-original-chart>
        <p className="font-semibold text-sky-300">Original chart · PDF page {current}</p>
        {originalPage||<p className="text-xs text-slate-400">Open the original PDF to read the chart and its connections.</p>}
      </div>}
      {chart?<details className="mt-1" key={currentKey} data-source-transcription>
        <summary className="cursor-pointer text-xs text-sky-300">Extracted text from PDF page {current}</summary>
        <p className="text-xs text-slate-400">This text does not retain chart connections. Use the original diagram when following a branch.</p>
        {transcription}
      </details>:transcription}
      <div className="mt-1">
        {!chart&&originalPage}
        <ManualSourceLink userId={userId} className="text-sky-300 underline" href={`${currentSourceUrl.split('#')[0]}#page=${current}`}>Open PDF page {current}</ManualSourceLink>
      </div>
    </div>
  );
}
