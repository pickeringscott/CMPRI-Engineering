"use client";

import { useState } from "react";
import type { SourcePassage } from "@/lib/manual-source";

/** Show original pages intact when their layout cannot be safely turned into steps. */
export default function WorkOrderSourcePages({ passages, sourceUrl }: { passages: SourcePassage[]; sourceUrl: string }) {
  const pages = [...new Set(passages.map(passage => passage.page))];
  const [selection, setSelection] = useState<{ sourceUrl: string; page: number } | null>(null);
  const current = selection?.sourceUrl === sourceUrl && pages.includes(selection.page) ? selection.page : null;
  if (!pages.length) return null;
  return (
    <div className="mt-1 text-sm text-slate-300">
      <label className="flex items-center gap-2">
        <span className="font-semibold text-sky-300">Source page:</span>
        <select className="min-w-0 rounded border border-slate-700 bg-slate-950 px-1 text-slate-100" value={current ?? ""} onChange={event => setSelection(event.target.value ? { sourceUrl, page: Number(event.target.value) } : null)}>
          <option value="">Select page</option>
          {pages.map(page => <option key={page} value={page}>{page}</option>)}
        </select>
      </label>
      {current !== null && <div className="mt-1">
        <iframe className="h-80 w-full rounded border border-slate-700" title={`Manual source page ${current}`} src={`${sourceUrl.split('#')[0]}#page=${current}`} />
        <a className="text-sky-300 underline" href={`${sourceUrl.split('#')[0]}#page=${current}`} target="_blank" rel="noreferrer">Open page {current}</a>
      </div>}
    </div>
  );
}
