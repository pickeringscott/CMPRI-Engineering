"use client";

import { useEffect, useState } from "react";
import { createClient, getValidSession } from "@/lib/supabase/client";
import type { SourcePassage } from "@/lib/manual-source";

/** Show original pages intact when their layout cannot be safely turned into steps. */
export default function WorkOrderSourcePages({ passages, sourceUrl, assetId, sourceSha256, userId }: { passages: SourcePassage[]; sourceUrl: string; assetId: string; sourceSha256: string; userId: string }) {
  const pages = [...new Set(passages.map(passage => passage.page))];
  const [selection, setSelection] = useState<{ sourceUrl: string; page: number } | null>(null);
  const current = selection?.sourceUrl === sourceUrl && pages.includes(selection.page) ? selection.page : pages[0];
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const imageKey = JSON.stringify([assetId, sourceSha256, userId, current]);
  useEffect(() => {
    if (!current || !assetId || !sourceSha256 || !userId) return;
    const controller = new AbortController();
    let url = '';
    const { data: { subscription } } = createClient().auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) { controller.abort(); if (url) URL.revokeObjectURL(url); url = ''; setImage(null); }
    });
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token || session.user.id !== userId || controller.signal.aborted) return;
        const query = new URLSearchParams({ source: 'asset-upload', assetId, sha256: sourceSha256, pageImage: String(current) });
        const response = await fetch(`/api/maintenance-reference?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` }, signal: controller.signal, cache: 'no-store' });
        if (!response.ok) return;
        const blob = await response.blob();
        const after = await getValidSession();
        if (controller.signal.aborted || after?.user.id !== userId) return;
        url = URL.createObjectURL(blob);
        setImage({ key: imageKey, url });
      } catch { /* The source link remains available if rendering fails. */ }
    })();
    return () => { controller.abort(); subscription.unsubscribe(); if (url) URL.revokeObjectURL(url); };
  }, [assetId, sourceSha256, userId, current, imageKey]);
  if (!pages.length) return null;
  return (
    <div className="mt-1 text-sm text-slate-300">
      {passages.map((passage, index) => <section key={`${passage.page}-${index}`} className="mt-1">
        <span className="font-semibold text-sky-300">Page {passage.page}</span>
        <div className="whitespace-pre-wrap break-words text-slate-100">{passage.text}</div>
      </section>)}
      <label className="mt-1 flex items-center gap-2">
        <span className="font-semibold text-sky-300">View source page:</span>
        <select className="min-w-0 rounded border border-slate-700 bg-slate-950 px-1 text-slate-100" value={current} onChange={event => setSelection({ sourceUrl, page: Number(event.target.value) })}>
          {pages.map(page => <option key={page} value={page}>{page}</option>)}
        </select>
      </label>
      <div className="mt-1">
        {image?.key === imageKey && <img className="h-auto w-full rounded border border-slate-700" src={image.url} alt={`Manual page ${current}, including diagrams and tables`} />}
        <a className="text-sky-300 underline" href={`${sourceUrl.split('#')[0]}#page=${current}`} target="_blank" rel="noreferrer">Open page {current}</a>
      </div>
    </div>
  );
}
