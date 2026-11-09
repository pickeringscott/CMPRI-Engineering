/** Browser-only OCR. Recognition does not upload documents or extracted text. */
export type LocalOcrWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};
export type LocalOcrPage = { page: number; text: string; confidence: number; words: LocalOcrWord[] };
export type LocalOcrResult = { fileName: string; pages: LocalOcrPage[]; totalPages: number };
export type LocalOcrProgress = { status: string; progress: number; page: number; totalPages: number };
export type LocalOcrOptions = {
  signal?: AbortSignal;
  onProgress?: (event: LocalOcrProgress) => void;
  /** Callers may lower the bound; each batch contains at most ten pages. */
  maxPages?: number;
  /** Process a bounded section of a longer PDF; page numbers are 1-based. */
  pageRange?: { start: number; end: number };
};

const MAX_PIXELS = 20_000_000;
const MAX_DIMENSION = 6000;
const MAX_PAGES = 10;
const ASSET_ROOT = '/local-ocr/tesseract-7.0.0-core-7.0.0-eng-1.0.0-pdf-6.3.289-app-v1';

function cancelled() { return new DOMException('Text recognition was cancelled.', 'AbortError'); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw cancelled(); }

/** Paths are fixed to this application's origin; the OCR library must never use CDN defaults. */
export function localOcrPaths(origin: string) {
  const parsed = new URL(origin);
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) throw new Error('A valid application origin is required.');
  const path = (name: string) => new URL(`${ASSET_ROOT}/${name}`, origin).href;
  return { workerPath: path('worker-bootstrap.js'), corePath: path(''), langPath: path(''), modelPath: path('eng.traineddata.gz'), pdfWorkerPath: path('pdf.worker.min.mjs') };
}

type OcrKind = 'image' | 'pdf';

/** Phone JPEGs may store pixels sideways and describe their display rotation in EXIF. */
function exifOrientation(bytes: Uint8Array, start: number, length: number): number | undefined {
  const end = Math.min(bytes.length, start + length);
  if (end - start < 14 || String.fromCharCode(...bytes.slice(start, start + 6)) !== 'Exif\0\0') return undefined;
  const tiff = start + 6;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  if (!little && !(bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)) return 1;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const directory = tiff + view.getUint32(tiff + 4, little);
  if (directory < tiff || directory + 2 > end) return 1;
  const count = view.getUint16(directory, little);
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x112 && view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) {
      const orientation = view.getUint16(entry + 8, little);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

/** Inspect only the signature here; resource handling belongs to recognition. */
export async function localOcrFileKind(file: File): Promise<OcrKind> {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('Choose a nonempty image or PDF.');
  }
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isPdf = bytes.length >= 5 && [37,80,68,70,45].every((v, i) => bytes[i] === v);
  const isPng = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  const isJpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const isWebp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (isPdf) return 'pdf';
  if (isPng || isJpeg || isWebp) return 'image';
  throw new Error('Choose a PNG, JPEG, WebP image, or PDF.');
}

/** Read bounded image headers before choosing a working resolution. */
export async function localOcrImageDimensions(file: File): Promise<{ width: number; height: number }> {
  // JPEG metadata can precede dimensions; cap the read and fail closed if the
  // image header is unusually large or incomplete.
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  let width = 0, height = 0, orientation = 1;
  const be16 = (offset: number) => bytes[offset] * 256 + bytes[offset + 1];
  const le16 = (offset: number) => bytes[offset] + bytes[offset + 1] * 256;
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let pos = 2;
    while (pos + 4 < bytes.length) {
      if (bytes[pos++] !== 255) break;
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 1 >= bytes.length) break;
      const size = be16(pos);
      if (size < 2 || pos + size > bytes.length) break;
      if (marker === 0xe1) orientation = exifOrientation(bytes, pos + 2, size - 2) ?? orientation;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 7) {
        height = be16(pos + 3); width = be16(pos + 5);
      }
      pos += size;
    }
  } else if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === 'VP8X') {
      width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
    } else if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = le16(26) & 0x3fff; height = le16(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + (bytes[22] & 0x3f) * 256;
      height = 1 + (bytes[22] >> 6) + bytes[23] * 4 + (bytes[24] & 0x0f) * 1024;
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('The image dimensions are missing or invalid.');
  }
  if (orientation >= 5) return { width: height, height: width };
  return { width, height };
}

/** Race work against cancellation; late-created workers are terminated by the caller. */
async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  checkAbort(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([work, aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

/** Fetch the public model before creating a worker; a missing model fails fast. */
async function loadLocalModel(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  checkAbort(signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'force-cache', mode: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('The local OCR language model is unavailable.');
    const size = Number(response.headers.get('content-length') || 0);
    if (size > 8 * 1024 * 1024) throw new Error('The local OCR language model is invalid.');
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('The local OCR language model is invalid.');
    return data;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (timedOut) throw new Error('Loading the local OCR language model timed out. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function pdfScale(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The PDF page has invalid dimensions.');
  const scale = Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / (width * height)));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('The PDF page has invalid dimensions.');
  return scale;
}

/** Decode once at a bounded working resolution; never pass the original to OCR. */
async function imageCanvas(file: File, signal?: AbortSignal): Promise<HTMLCanvasElement> {
  const dimensions = await localOcrImageDimensions(file);
  checkAbort(signal);
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot prepare the image for recognition. Try a current browser.');
  const scale = Math.min(1, MAX_DIMENSION / dimensions.width, MAX_DIMENSION / dimensions.height, Math.sqrt(MAX_PIXELS / dimensions.width / dimensions.height));
  const width = Math.max(1, Math.floor(dimensions.width * scale));
  const height = Math.max(1, Math.floor(dimensions.height * scale));
  const canvas = document.createElement('canvas');
  let released = false;
  const release = (bitmap: ImageBitmap) => { if (!released) { released = true; bitmap.close(); } };
  try {
    const decode = createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    // A decoder can finish after the caller has cancelled and left this scope.
    void decode.then(bitmap => { if (signal?.aborted) release(bitmap); }, () => {});
    const bitmap = await abortable(decode, signal);
    try {
      checkAbort(signal);
      if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1) throw new Error('The decoded image has invalid dimensions.');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('This device could not prepare the image for recognition.');
      // Transparent scans need a paper background; opaque canvases start black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
    } finally { release(bitmap); }
    return canvas;
  } catch (error) {
    canvas.width = 0; canvas.height = 0;
    if (signal?.aborted) throw cancelled();
    throw new Error(`This device could not prepare the image for recognition: ${error instanceof Error ? error.message : 'image decoding failed'}`);
  }
}

/**
 * Recognize a single image or a bounded PDF batch entirely in the browser. The result
 * is an editable suggestion: OCR can misread or omit text and is not a save.
 * Worker/model/PDF runtime files load only from pinned same-origin assets.
 */
export async function recognizeLocalDocument(file: File, options: LocalOcrOptions = {}): Promise<LocalOcrResult> {
  if (typeof window === 'undefined' || typeof document === 'undefined') throw new Error('Text recognition requires a supported browser.');
  const { signal, onProgress } = options;
  checkAbort(signal);
  const kind = await localOcrFileKind(file);
  checkAbort(signal);
  const maxPages = options.maxPages ?? MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new Error('The page limit must be between 1 and 10.');
  const range = options.pageRange;
  if (range && (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end - range.start + 1 > maxPages)) {
    throw new Error(`Select a valid range of at most ${maxPages} pages.`);
  }
  if (kind === 'image' && range && (range.start !== 1 || range.end !== 1)) throw new Error('An image has only one page.');
  const paths = localOcrPaths(window.location.origin);

  let currentPage = 0;
  let totalPages = 1;
  onProgress?.({ status: 'loading local OCR model', progress: 0, page: 0, totalPages });
  await loadLocalModel(paths.modelPath, signal);
  checkAbort(signal);
  const { createWorker, OEM } = await import('tesseract.js');
  checkAbort(signal);
  const nonce = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : '';
  const channel = nonce && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`cmpri-local-ocr-${nonce}`) : null;
  const cancelInitialization = () => { channel?.postMessage('cancel'); };
  signal?.addEventListener('abort', cancelInitialization, { once: true });
  let initializationFailed: (error: Error) => void = () => {};
  const initializationError = new Promise<never>((_, reject) => { initializationFailed = reject; });
  // The worker reads the same-origin model from HTTP/IndexedDB cache. Passing
  // an inline Lang object is unsafe with Tesseract.js 7's initialization path.
  const workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: `${paths.workerPath}${nonce ? `#${nonce}` : ''}`,
    corePath: paths.corePath,
    langPath: paths.langPath,
    workerBlobURL: false,
    gzip: true,
    // Language data contains no document content. Reuse it locally to avoid
    // downloading the model on every recognition request. Include the asset
    // version so an older unrelated Tesseract model cannot be reused.
    cachePath: ASSET_ROOT,
    cacheMethod: 'write',
    errorHandler: () => initializationFailed(new Error('The local OCR engine could not start. Try again or use CSV.')),
    logger: event => { if (!signal?.aborted) onProgress?.({ status: event.status, progress: event.progress, page: currentPage, totalPages }); },
  });
  // If cancellation happens before initialization finishes, dispose the late worker.
  let abandoned = false;
  void workerPromise.then(worker => { if (signal?.aborted || abandoned) void worker.terminate(); }, () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { cancelInitialization(); reject(new Error('The local OCR engine timed out while starting. Try again or use CSV.')); }, 45_000);
  });
  let worker: Awaited<typeof workerPromise>;
  try { worker = await abortable(Promise.race([workerPromise, initializationError, deadline]), signal); }
  catch (error) { abandoned = true; cancelInitialization(); throw error; }
  finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', cancelInitialization);
    channel?.close();
  }
  const terminateOnAbort = () => { void worker.terminate(); };
  signal?.addEventListener('abort', terminateOnAbort, { once: true });
  let pdfTask: { destroy: () => Promise<void> } | undefined;
  try {
    const pages: LocalOcrPage[] = [];
    const recognize = async (input: HTMLCanvasElement, page: number) => {
      checkAbort(signal);
      currentPage = page;
      const result = await abortable(worker.recognize(input, {}, { text: true, blocks: true }), signal);
      checkAbort(signal);
      const words = (result.data.blocks || []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words)))
        .map(word => ({ text: word.text, confidence: word.confidence, bbox: { ...word.bbox } }));
      pages.push({ page, text: result.data.text || '', confidence: result.data.confidence, words });
    };
    if (kind === 'image') {
      const canvas = await imageCanvas(file, signal);
      try { await recognize(canvas, 1); }
      finally { canvas.width = 0; canvas.height = 0; }
    } else {
      const pdfjs = await import('pdfjs-dist');
      checkAbort(signal);
      pdfjs.GlobalWorkerOptions.workerSrc = paths.pdfWorkerPath;
      let data: Uint8Array;
      try { data = new Uint8Array(await abortable(file.arrayBuffer(), signal)); }
      catch (error) {
        if (signal?.aborted) throw cancelled();
        throw new Error(`This device could not read the PDF bytes: ${error instanceof Error ? error.message : 'file reading failed'}`);
      }
      checkAbort(signal);
      const task = pdfjs.getDocument({ data, useSystemFonts: true, useWorkerFetch: false });
      pdfTask = task;
      const pdf = await abortable(task.promise, signal);
      if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('The PDF has an invalid page count.');
      if (range && range.end > pdf.numPages) throw new Error(`This PDF has only ${pdf.numPages} pages.`);
      const start = range?.start ?? 1;
      const end = range?.end ?? Math.min(pdf.numPages, maxPages);
      // Progress reports the source page number, so show the document's page
      // count rather than the size of the selected range (e.g. page 20 of 100).
      totalPages = pdf.numPages;
      for (let number = start; number <= end; number++) {
        checkAbort(signal);
        const page = await abortable(pdf.getPage(number), signal);
        const canvas = document.createElement('canvas');
        let render: ReturnType<typeof page.render> | undefined;
        const cancelRender = () => render?.cancel();
        try {
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: pdfScale(base.width, base.height) });
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('The browser could not render this PDF page.');
          render = page.render({ canvas, canvasContext: context, viewport });
          signal?.addEventListener('abort', cancelRender, { once: true });
          await abortable(render.promise, signal);
          await recognize(canvas, number);
        } finally {
          signal?.removeEventListener('abort', cancelRender);
          canvas.width = 0; canvas.height = 0;
          page.cleanup();
        }
      }
    }
    return { fileName: file.name, pages, totalPages };
  } finally {
    signal?.removeEventListener('abort', terminateOnAbort);
    if (pdfTask) await pdfTask.destroy().catch(() => {});
    await worker.terminate().catch(() => {});
  }
}
