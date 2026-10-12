"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";

/** Render the local PDF inside the modal, including browsers without an inline PDF plug-in. */
export default function GuidePdfViewer({ src }: { src: string }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading guide…");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let task: PDFDocumentLoadingTask | undefined;
    const pages = pagesRef.current;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (disposed || !pages) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      task = pdfjs.getDocument({ url: src });
      const document = await task.promise;
      for (let number = 1; number <= document.numPages; number += 1) {
        if (disposed) return;
        const page = await document.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const width = Math.max(240, pages.clientWidth);
        const viewport = page.getViewport({ scale: width / base.width * Math.min(window.devicePixelRatio || 1, 2) });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.className = "mb-3 block h-auto w-full bg-white";
        canvas.setAttribute("aria-hidden", "true");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const text = await page.getTextContent();
        if (disposed) return;
        const accessibleText = window.document.createElement("p");
        accessibleText.className = "sr-only";
        accessibleText.textContent = `Page ${number}. ` + text.items.map(item => "str" in item ? item.str : "").join(" ");
        pages.append(canvas, accessibleText);
      }
      if (!disposed) setStatus("");
    })().catch(() => {
      if (!disposed) { setFailed(true); setStatus("The guide could not be displayed. Close it and try again."); }
    });
    return () => { disposed = true; void task?.destroy(); pages?.replaceChildren(); };
  }, [src]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-slate-800 p-2">
      {status && <p role={failed ? "alert" : "status"} className="p-3 text-sm text-white">{status}</p>}
      <div ref={pagesRef} data-guide-pdf={src} aria-label="Guide pages" />
    </div>
  );
}
