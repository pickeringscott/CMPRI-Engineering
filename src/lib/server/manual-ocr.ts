import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

export type RecognizedManualPage = { page: number; text: string; confidence: number };
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 600;
const MAX_BATCH = 10;
const MAX_PIXELS = 4_000_000;

/** Read the source page count before scheduling bounded OCR batches. */
export async function manualOcrPageCount(bytes: Uint8Array): Promise<number> {
  if (!bytes.length || bytes.length > MAX_BYTES || Buffer.from(bytes.subarray(0,5)).toString() !== '%PDF-') throw new Error('The source must be a PDF within the supported size.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGES) throw new Error('The source has an unsupported page count.');
    return pdf.numPages;
  } finally { await task.destroy(); }
}

/** Read a bounded batch using CMPRI's installed Tesseract language data. */
export async function recognizeManualPages(bytes: Uint8Array, pages: number[]): Promise<{ totalPages: number; pages: RecognizedManualPage[] }> {
  if (!bytes.length || bytes.length > MAX_BYTES || Buffer.from(bytes.subarray(0,5)).toString() !== '%PDF-') throw new Error('The source must be a PDF within the supported size.');
  if (!pages.length || pages.length > MAX_BATCH || new Set(pages).size !== pages.length || pages.some(page => !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES)) throw new Error('Select up to ten distinct source pages.');
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const tessRoot = path.dirname(require.resolve('tesseract.js-core/package.json'));
  const langRoot = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + path.sep, cMapUrl: path.join(pdfRoot, 'cmaps') + path.sep, cMapPacked: true, wasmUrl: path.join(pdfRoot, 'wasm') + path.sep, useWorkerFetch: false, useSystemFonts: false, maxImageSize: 64_000_000, canvasMaxAreaInBytes: 32_000_000, verbosity: 0 });
  let worker: Awaited<ReturnType<typeof import('tesseract.js').createWorker>> | undefined;
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES || pages.some(page => page > pdf.numPages)) throw new Error('The selected pages exceed the source PDF.');
    const { createWorker, OEM } = await import('tesseract.js');
    worker = await createWorker('eng', OEM.LSTM_ONLY, { langPath: langRoot, corePath: tessRoot, cacheMethod: 'none', gzip: true });
    const result: RecognizedManualPage[] = [];
    for (const number of pages) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('A PDF page has invalid dimensions.');
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      try {
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0,0,canvas.width,canvas.height);
        await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
        const recognized = await worker.recognize(canvas.toBuffer('image/png'));
        result.push({ page: number, text: recognized.data.text || '', confidence: recognized.data.confidence });
      } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
    }
    return { totalPages: pdf.numPages, pages: result };
  } finally { try { if (worker) await worker.terminate(); } finally { await task.destroy(); } }
}
