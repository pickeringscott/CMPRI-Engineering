import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/ocr/local-ocr.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const image = () => new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,100,0,0,0,50])], 'report.png', { type: 'image/png' });
const pdf = () => new File(['%PDF-1.7\n'], 'report.pdf', { type: 'application/pdf' });

function harness({ recognize, bitmap, pageCount = 2, modelOk = true, initialize } = {}) {
  const events = { options: null, terminated: 0, bitmapsClosed: 0, pageCleanups: 0, pdfDestroyed: 0, inputs: [], canvases: [], pdfArgs: null, fetches: [] };
  const worker = {
    async recognize(input) {
      events.inputs.push(input);
      events.options?.logger?.({ status: 'recognizing text', progress: 0.5 });
      if (recognize) return recognize(input);
      return { data: { text: 'Room 101', confidence: 92, blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Room', confidence: 96, bbox: { x0: 1, y0: 2, x1: 10, y1: 12 } }] }] }] }] } };
    },
    async terminate() { events.terminated++; },
  };
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument(args) {
      events.pdfArgs = args;
      return {
        async destroy() { events.pdfDestroyed++; },
        promise: Promise.resolve({
          numPages: pageCount,
          async getPage() { return {
            getViewport({ scale }) { return { width: 400 * scale, height: 600 * scale }; },
            render() { return { promise: Promise.resolve(), cancel() {} }; },
            cleanup() { events.pageCleanups++; },
          }; },
        }),
      };
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, URL, DOMException, Uint8Array, DataView, Promise, AbortController, setTimeout, clearTimeout,
    window: { location: { origin: 'https://cmpri.example' } },
    fetch: async (url, options) => {
      events.fetches.push({ url, options });
      return { ok: modelOk, headers: { get: () => '4' }, arrayBuffer: async () => Uint8Array.from([31,139,1,2]).buffer };
    },
    document: { createElement(name) {
      assert.equal(name, 'canvas');
      const canvas = { width: 0, height: 0, getContext: () => ({}) };
      events.canvases.push(canvas);
      return canvas;
    } },
    createImageBitmap: bitmap || (async () => ({ width: 100, height: 50, close() { events.bitmapsClosed++; } })),
    require(name) {
      if (name === 'tesseract.js') return { OEM: { LSTM_ONLY: 1 }, createWorker: async (_lang, _oem, options) => { events.options = options; return initialize ? initialize(worker, options) : worker; } };
      if (name === 'pdfjs-dist') return pdfjs;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return { exports, events, pdfjs };
}

test('image OCR only configures same-origin engine assets and returns editable text', async () => {
  const { exports, events } = harness();
  const result = await exports.recognizeLocalDocument(image());
  assert.equal(result.pages[0].text, 'Room 101');
  assert.equal(result.pages[0].words[0].bbox.x0, 1);
  assert.equal(events.inputs.length, 1);
  for (const key of ['workerPath', 'corePath', 'langPath']) assert.equal(new URL(events.options[key]).origin, 'https://cmpri.example');
  assert.equal(new URL(events.fetches[0].url).origin, 'https://cmpri.example');
  assert.equal(events.fetches[0].options.mode, 'same-origin');
  assert.equal(events.fetches[0].options.redirect, 'error');
  assert.equal(events.options.workerBlobURL, false);
  assert.match(events.options.cachePath, /tesseract-7\.0\.0-core-7\.0\.0-eng-1\.0\.0-pdf-6\.3\.289-app-v1/);
  assert.equal(events.bitmapsClosed, 1);
  assert.equal(events.terminated, 1);
});

test('missing local language model fails before a worker is started', async () => {
  const { exports, events } = harness({ modelOk: false });
  await assert.rejects(exports.recognizeLocalDocument(image()), /language model is unavailable/);
  assert.equal(events.options, null);
  assert.equal(events.inputs.length, 0);
  assert.equal(events.fetches.length, 1);
});

test('PDF OCR uses a same-origin PDF worker, recognizes every bounded page, and frees resources', async () => {
  const { exports, events, pdfjs } = harness();
  const result = await exports.recognizeLocalDocument(pdf());
  assert.deepEqual(Array.from(result.pages, page => page.page), [1, 2]);
  assert.equal(new URL(pdfjs.GlobalWorkerOptions.workerSrc).origin, 'https://cmpri.example');
  assert.equal(events.pdfArgs.useWorkerFetch, false);
  assert.equal(events.inputs.length, 2);
  assert.equal(events.pageCleanups, 2);
  assert.equal(events.pdfDestroyed, 1);
  assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal(events.terminated, 1);
});

test('unsupported, oversized, and over-page-limit inputs fail without recognition', async () => {
  const { exports, events } = harness({ pageCount: 11 });
  await assert.rejects(exports.recognizeLocalDocument(new File(['plain text'], 'bad.png')), /PNG, JPEG, WebP/);
  await assert.rejects(exports.recognizeLocalDocument(new File([Uint8Array.from([137,80,78,71,13,10,26,10]), new Uint8Array(10 * 1024 * 1024)], 'large.png')), /10 MiB/);
  await assert.rejects(exports.recognizeLocalDocument(pdf()), /at most 10 pages/);
  assert.equal(events.inputs.length, 0);
  assert.equal(events.pdfDestroyed, 1);
  assert.equal(events.terminated, 1);
});

test('image headers are checked for dangerous dimensions before browser decoding', async () => {
  let decodes = 0;
  const { exports } = harness({ bitmap: async () => { decodes++; return { width: 1, height: 1, close() {} }; } });
  const largeHeader = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,1,0,0,0,1,0,0]);
  await assert.rejects(exports.recognizeLocalDocument(new File([largeHeader], 'large.png')), /dimensions/);
  assert.equal(decodes, 0);
  const jpeg = new File([Uint8Array.from([255,216,255,192,0,7,8,0,50,0,100,255,217])], 'small.jpg');
  const dimensions = await exports.localOcrImageDimensions(jpeg);
  assert.equal(dimensions.width, 100); assert.equal(dimensions.height, 50);
});

test('a longer PDF can be processed in an explicit, bounded page range', async () => {
  const { exports, events } = harness({ pageCount: 100 });
  const progress = [];
  const result = await exports.recognizeLocalDocument(pdf(), { pageRange: { start: 20, end: 22 }, onProgress: event => progress.push(event) });
  assert.deepEqual(Array.from(result.pages, page => page.page), [20, 21, 22]);
  assert.deepEqual(progress.filter(event => event.page > 0).map(event => [event.page, event.totalPages]), [[20, 100], [21, 100], [22, 100]]);
  assert.equal(events.inputs.length, 3);
  await assert.rejects(exports.recognizeLocalDocument(pdf(), { pageRange: { start: 1, end: 11 } }), /at most 10 pages/);
  await assert.rejects(exports.recognizeLocalDocument(pdf(), { pageRange: { start: 98, end: 101 } }), /only 100 pages/);
});

test('cancelling an active recognition releases its worker and rejects promptly', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { exports, events } = harness({ recognize: () => { entered(); return new Promise(() => {}); } });
  const controller = new AbortController();
  const promise = exports.recognizeLocalDocument(image(), { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.ok(events.terminated >= 1);
});

test('worker initialization errors are surfaced instead of hanging', async () => {
  const { exports } = harness({ initialize: (_worker, options) => {
    options.errorHandler('invalid model');
    return new Promise(() => {});
  } });
  await assert.rejects(exports.recognizeLocalDocument(image()), /local OCR engine could not start/);
});

test('a worker that finishes initialization after cancellation is terminated', async () => {
  let finish;
  const { exports, events } = harness({ initialize: worker => new Promise(resolve => { finish = () => resolve(worker); }) });
  const controller = new AbortController();
  const promise = exports.recognizeLocalDocument(image(), { signal: controller.signal });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.terminated >= 1);
});

test('a bitmap that finishes decoding after cancellation is closed', async () => {
  let resolveBitmap, closed = 0;
  const { exports } = harness({ bitmap: () => new Promise(resolve => { resolveBitmap = resolve; }) });
  const controller = new AbortController();
  const promise = exports.recognizeLocalDocument(image(), { signal: controller.signal });
  while (!resolveBitmap) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  resolveBitmap({ width: 100, height: 50, close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});
