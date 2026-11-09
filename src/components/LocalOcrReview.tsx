"use client";

import { useEffect, useRef, useState } from "react";
import { localOcrFileKind, localOcrImageDimensions, recognizeLocalDocument } from "@/lib/ocr/local-ocr";
import { createClient } from "@/lib/supabase/client";

export type ReviewedOcrText = {
  fileName: string;
  pages: { page: number; text: string }[];
};

type Props = {
  /** Pass reviewed text into an editor; this component never saves a record. */
  onUseText?: (result: ReviewedOcrText) => void;
  useTextLabel?: string;
};

/** An on-device reference tool. Extracted text is never applied automatically. */
export default function LocalOcrReview({ onUseText, useTextLabel = "Use reviewed text" }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<"image" | "pdf" | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [pages, setPages] = useState<ReviewedOcrText["pages"]>([]);
  const [documentPages, setDocumentPages] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [firstPage, setFirstPage] = useState("");
  const [lastPage, setLastPage] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const selectionRef = useRef(0);
  const previewRef = useRef("");

  useEffect(() => {
    let active = true;
    let previousUser: string | null | undefined;
    const { data: { subscription } } = createClient().auth.onAuthStateChange((event, session) => {
      if (!active) return;
      const user = session?.user?.id || null;
      if (event === "SIGNED_OUT" || (previousUser !== undefined && previousUser !== user)) {
        selectionRef.current++;
        abortRef.current?.abort();
        abortRef.current = null;
        if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        previewRef.current = "";
        setFile(null); setFileKind(null); setPreviewUrl(""); setShowImagePreview(false); setPages([]); setDocumentPages(null); setReviewed(false);
        setFirstPage(""); setLastPage(""); setBusy(false); setStatus(""); setError("");
      }
      previousUser = user;
      setAuthenticated(Boolean(user));
    });
    return () => {
      active = false;
      subscription.unsubscribe();
      // Invalidate any selection that is still awaiting header validation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      selectionRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = "";
    };
  }, []);

  async function selectFile(selected: File | null) {
    const selection = ++selectionRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setPages([]);
    setDocumentPages(null);
    setShowImagePreview(false);
    setReviewed(false);
    setFirstPage("");
    setLastPage("");
    setStatus("");
    setError("");
    setFile(null);
    setFileKind(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = "";
    setPreviewUrl("");
    if (!selected) return;
    const extension = selected.name.split(".").pop()?.toLowerCase() || "";
    if (!selected.size || !["pdf", "png", "jpg", "jpeg", "webp"].includes(extension)) {
      setError("Choose a nonempty PDF, PNG, JPEG, or WebP image.");
      return;
    }
    try {
      // Inspect magic bytes before creating a URL or displaying the document.
      // In particular, never render an arbitrary file renamed to .pdf/.png.
      const kind = await localOcrFileKind(selected);
      if (selection !== selectionRef.current) return;
      if ((kind === "pdf") !== (extension === "pdf")) throw new Error("The file contents do not match its extension.");
      let showImage = false;
      if (kind === "image") {
        const dimensions = await localOcrImageDimensions(selected);
        // Leave large originals for the user's viewer. Recognition decodes at
        // its working resolution, avoiding an eager full-size browser preview.
        showImage = dimensions.width <= 6000 && dimensions.height <= 6000 && dimensions.width * dimensions.height <= 20_000_000;
      }
      if (selection !== selectionRef.current) return;
      const mime = kind === "pdf" ? "application/pdf" : ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[extension];
      const url = URL.createObjectURL(new Blob([selected], { type: mime }));
      previewRef.current = url;
      setFile(selected);
      setFileKind(kind);
      setPreviewUrl(url);
      setShowImagePreview(showImage);
    } catch (cause) {
      if (selection === selectionRef.current) setError(cause instanceof Error ? cause.message : "The document could not be opened safely.");
    }
  }

  async function recognize(requestedRange?: { start: number; end: number }) {
    if (!file || abortRef.current) return;
    let pageRange = requestedRange;
    if (!pageRange && fileKind === "pdf" && (firstPage || lastPage)) {
      const start = Number(firstPage), end = Number(lastPage);
      if (!firstPage || !lastPage || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 10) {
        setError("Enter a valid page range of up to 10 pages.");
        return;
      }
      pageRange = { start, end };
    }
    if (pageRange) { setFirstPage(String(pageRange.start)); setLastPage(String(pageRange.end)); }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setPages([]);
    setReviewed(false);
    setError("");
    setStatus("Preparing on-device text recognition…");
    try {
      const result = await recognizeLocalDocument(file, {
        signal: controller.signal,
        maxPages: 10,
        ...(pageRange ? { pageRange } : {}),
        onProgress: progress => {
          if (abortRef.current !== controller || controller.signal.aborted) return;
          const percent = Number.isFinite(progress.progress) ? Math.max(0, Math.min(100, Math.round(progress.progress * 100))) : 0;
          setStatus(progress.page > 0
            ? `Reading page ${progress.page} of ${progress.totalPages} (${percent}%).`
            : "Preparing on-device text recognition…");
        },
      });
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setPages(result.pages.map(page => ({ page: page.page, text: page.text })));
      setDocumentPages(result.totalPages);
      if (fileKind === "pdf" && result.pages.length) {
        const start = result.pages[0].page, end = result.pages[result.pages.length - 1].page;
        setFirstPage(String(start)); setLastPage(String(end));
        setStatus(`Pages ${start}–${end} of ${result.totalPages} are ready to review.`);
      } else setStatus(result.pages.length ? "Text is ready to review." : "No pages could be read.");
    } catch (cause) {
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "The document could not be read on this device.");
      setStatus("");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStatus("Text recognition stopped. No records were changed.");
  }

  function editPage(page: number, text: string) {
    setPages(current => current.map(item => item.page === page ? { ...item, text } : item));
    setReviewed(false);
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(pages.map(page => `Page ${page.page}\n${page.text}`).join("\n\n"));
      setStatus("Reviewed text copied. No records were changed.");
    } catch {
      setError("Copy was unavailable. You can select and copy the text from the fields below.");
    }
  }

  const nextPage = pages.length ? pages[pages.length - 1].page + 1 : 1;
  const nextBatchEnd = documentPages ? Math.min(nextPage + 9, documentPages) : 0;

  return (
    <section aria-label="On-device text recognition" className="space-y-3 rounded-xl border border-slate-600 bg-slate-900/70 p-3 text-sm text-slate-100">
      <div>
        <h3 className="font-bold">Read text on this device</h3>
        <p className="mt-1 text-xs text-slate-300">Choose a PNG, JPEG, WebP image, or PDF. Large images are resized locally for recognition. PDFs are read in batches of up to 10 pages. Recognition runs on this device; the selected file is not sent to OpenAI. This tool does not save or import records.</p>
        <p className="mt-1 text-xs text-amber-200">Recognition can miss or misread text, entire rows, and checkboxes. Compare each page in this pass with the original before using any text.</p>
      </div>
      <label className="block font-semibold">
        Choose a document or image
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp" disabled={busy || !authenticated} onChange={event => { void selectFile(event.currentTarget.files?.[0] || null); event.currentTarget.value = ""; }} className="mt-1 block w-full text-xs" />
      </label>
      {!authenticated && <p role="status" className="text-xs text-slate-300">Sign in to use the document reader.</p>}
      {fileKind === "pdf" && <fieldset className="flex flex-wrap items-end gap-2 text-xs text-slate-200">
        <legend className="font-semibold">PDF page range (up to 10 pages per batch)</legend>
        <label>First page <input aria-label="First PDF page" type="number" min={1} step={1} value={firstPage} disabled={busy} onChange={event => { setFirstPage(event.target.value); setPages([]); setReviewed(false); setStatus(""); }} className="ml-1 w-20 rounded border border-slate-600 bg-slate-950 p-1 text-white" /></label>
        <label>Last page <input aria-label="Last PDF page" type="number" min={1} step={1} value={lastPage} disabled={busy} onChange={event => { setLastPage(event.target.value); setPages([]); setReviewed(false); setStatus(""); }} className="ml-1 w-20 rounded border border-slate-600 bg-slate-950 p-1 text-white" /></label>
        <span>Leave blank to read the first batch, or select a range.</span>
      </fieldset>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!authenticated || !file || busy} onClick={() => void recognize()} className="min-h-10 rounded-lg border border-sky-600 px-3 py-1 font-semibold text-sky-100 disabled:opacity-50">{busy ? "Reading…" : "Read text"}</button>
        {busy && <button type="button" onClick={stop} className="min-h-10 rounded-lg border border-slate-500 px-3 py-1">Stop reading</button>}
        {file && !busy && <button type="button" onClick={() => void selectFile(null)} className="min-h-10 rounded-lg border border-slate-500 px-3 py-1">Clear document</button>}
      </div>
      {status && <p role="status" className="text-xs text-slate-200">{status}</p>}
      {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
      {file && previewUrl && <div className="grid gap-3 lg:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <h4 className="font-semibold">Original: {file.name}</h4>
          {fileKind === "pdf"
            ? <p className="text-xs text-slate-300">Open the downloaded original in a trusted PDF viewer to compare the pages in this pass. PDF content is not embedded here.</p>
            : !showImagePreview ? <p className="text-xs text-slate-300">This large image will be resized locally for recognition. Open the downloaded original to compare the result.</p>
            // This is a validated local image blob. A remote image optimizer must not receive it.
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={previewUrl} alt={`Original document: ${file.name}`} className="max-h-96 w-full rounded-lg border border-slate-700 object-contain" />}
          <a href={previewUrl} download={file.name} className="inline-block text-xs text-sky-300 underline">Download original for comparison</a>
        </div>
        <div className="min-w-0 space-y-3">
          <h4 className="font-semibold">Extracted text</h4>
          {!pages.length && <p className="text-xs text-slate-400">Select Read text to begin.</p>}
          {pages.map(page => <label key={page.page} className="block text-xs font-semibold">Page {page.page}
            <textarea aria-label={`Extracted text, page ${page.page}`} value={page.text} onChange={event => editPage(page.page, event.target.value)} rows={10} spellCheck={false} className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-950 p-2 font-mono text-xs text-white" />
          </label>)}
        </div>
      </div>}
      {pages.length > 0 && <div className="space-y-2">
        <label className="flex items-start gap-2 text-xs text-amber-100">
          <input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
          I compared each page in this pass and corrected the text I intend to use. I understand entire rows or fields may be missing{firstPage && lastPage ? `, and pages outside ${firstPage}–${lastPage} were not read` : ""}.
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!reviewed} onClick={() => void copyText()} className="min-h-10 rounded-lg border border-slate-500 px-3 py-1 disabled:opacity-50">Copy reviewed text</button>
          {onUseText && <button type="button" disabled={!reviewed || !file} onClick={() => file && onUseText({ fileName: file.name, pages: pages.map(page => ({ ...page })) })} className="min-h-10 rounded-lg border border-sky-500 px-3 py-1 font-semibold text-sky-100 disabled:opacity-50">{useTextLabel}</button>}
        </div>
        {fileKind === "pdf" && documentPages && nextPage <= documentPages && <div className="space-y-1">
          <p className="text-xs text-slate-300">Copy or use this batch before continuing. Reading the next batch replaces the text above.</p>
          <button type="button" disabled={!reviewed || busy} onClick={() => void recognize({ start: nextPage, end: nextBatchEnd })} className="min-h-10 rounded-lg border border-slate-500 px-3 py-1 disabled:opacity-50">Read pages {nextPage}–{nextBatchEnd}</button>
        </div>}
      </div>}
    </section>
  );
}
