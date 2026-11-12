import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {manualTextQuality} from '../src/lib/manual-page-quality.ts';

const source = readFileSync(new URL('../src/lib/ocr/local-ocr.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const image = () => new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,100,0,0,0,50])], 'report.png', { type: 'image/png' });
const pdf = () => new File(['%PDF-1.7\n'], 'report.pdf', { type: 'application/pdf' });

function harness({ recognize, bitmap, pageCount = 2, modelOk = true, initialize, render, nativeText, imagePages=[] } = {}) {
  const events = { options: null, terminated: 0, bitmapsClosed: 0, pageCleanups: 0, pdfDestroyed: 0, inputs: [], inputSizes: [], canvases: [], pdfArgs: null, fetches: [], decodes: [], draws: [], paints: [], sourcePages: [], renderCancels: 0 };
  const worker = {
    async recognize(input) {
      events.inputs.push(input);
      events.inputSizes.push({ width: input.width, height: input.height });
      events.options?.logger?.({ status: 'recognizing text', progress: 0.5 });
      if (recognize) return recognize(input);
      return { data: { text: 'Room 101', confidence: 92, blocks: [{ paragraphs: [{ lines: [{ words: [{ text: 'Room', confidence: 96, bbox: { x0: 1, y0: 2, x1: 10, y1: 12 } }] }] }] }] } };
    },
    async terminate() { events.terminated++; },
  };
  const pdfjs = {
    OPS:{paintImageXObject:85,paintInlineImageXObject:86,paintImageMaskXObject:87},
    GlobalWorkerOptions: {},
    getDocument(args) {
      events.pdfArgs = args;
      return {
        async destroy() { events.pdfDestroyed++; },
        promise: Promise.resolve({
          numPages: pageCount,
          async getPage(number) { events.sourcePages.push(number); return {
            getTextContent:async()=>({items:[{str:nativeText?nativeText(number):'',hasEOL:true}]}),
            getOperatorList:async()=>({fnArray:imagePages.includes(number)?[85]:[]}),
            getViewport({ scale }) { return { width: 400 * scale, height: 600 * scale }; },
            render() { return { promise: render ? render() : Promise.resolve(), cancel() { events.renderCancels++; } }; },
            cleanup() { events.pageCleanups++; },
          }; },
        }),
      };
    },
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, URL, Error, RangeError, DOMException, Uint8Array, DataView, Promise, AbortController, setTimeout, clearTimeout,
    window: { location: { origin: 'https://cmpri.example' } },
    fetch: async (url, options) => {
      events.fetches.push({ url, options });
      return { ok: modelOk, headers: { get: () => '4' }, arrayBuffer: async () => Uint8Array.from([31,139,1,2]).buffer };
    },
    document: { createElement(name) {
      assert.equal(name, 'canvas');
      const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect(...args) { events.paints.push({ type: 'fill', color: this.fillStyle, bounds: args }); }, drawImage(...args) { events.draws.push(args); events.paints.push({ type: 'draw' }); } }) };
      events.canvases.push(canvas);
      return canvas;
    } },
    createImageBitmap: async (file, options) => {
      events.decodes.push({ file, options });
      return bitmap ? bitmap(file, options) : { width: options.resizeWidth, height: options.resizeHeight, close() { events.bitmapsClosed++; } };
    },
    require(name) {
      if (name === '../manual-page-quality') return {manualTextQuality};
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

test('unsupported and empty inputs fail; longer PDFs default to a bounded first batch', async () => {
  const { exports, events } = harness({ pageCount: 11 });
  await assert.rejects(exports.recognizeLocalDocument(new File(['plain text'], 'bad.png')), /PNG, JPEG, WebP/);
  await assert.rejects(exports.recognizeLocalDocument(new File([], 'empty.pdf')), /nonempty/);
  const result = await exports.recognizeLocalDocument(pdf());
  assert.equal(result.totalPages, 11);
  assert.deepEqual(Array.from(result.pages, page => page.page), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(events.inputs.length, 10);
  assert.equal(events.pdfDestroyed, 1);
  assert.equal(events.terminated, 1);
});

test('invalid dimensions fail before decoding while valid JPEG dimensions are read', async () => {
  let decodes = 0;
  const { exports } = harness({ bitmap: async () => { decodes++; return { width: 1, height: 1, close() {} }; } });
  const invalidHeader = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,0,0,0,0,50]);
  await assert.rejects(exports.recognizeLocalDocument(new File([invalidHeader], 'invalid.png')), /dimensions/);
  assert.equal(decodes, 0);
  const jpeg = new File([Uint8Array.from([255,216,255,192,0,7,8,0,50,0,100,255,217])], 'small.jpg');
  const dimensions = await exports.localOcrImageDimensions(jpeg);
  assert.equal(dimensions.width, 100); assert.equal(dimensions.height, 50);
});

test('large local images are accepted and decoded once at a bounded working resolution', async () => {
  const { exports, events } = harness();
  const header = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,46,224,0,0,31,64]); // 12000 x 8000
  const file = new File([header], 'large.png');
  Object.defineProperty(file, 'size', { value: 80 * 1024 * 1024 });
  assert.equal(await exports.localOcrFileKind(file), 'image');
  const dimensions = await exports.localOcrImageDimensions(file);
  assert.equal(dimensions.width, 12000); assert.equal(dimensions.height, 8000);
  await exports.recognizeLocalDocument(file);
  assert.equal(events.decodes.length, 1);
  const { resizeWidth: width, resizeHeight: height, resizeQuality } = events.decodes[0].options;
  assert.ok(width <= 6000 && height <= 6000 && width * height <= 20_000_000);
  assert.ok(Math.abs(width / height - 1.5) < 0.001);
  assert.equal(resizeQuality, 'high');
  assert.equal(events.inputs[0], events.canvases[0], 'OCR receives the resized canvas rather than the source file');
  assert.equal(events.inputSizes[0].width, width); assert.equal(events.inputSizes[0].height, height);
  assert.equal(events.draws.length, 1); assert.equal(events.bitmapsClosed, 1);
  assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('transparent images are composited onto white paper before OCR instead of a black canvas', async () => {
  const { exports, events } = harness();
  // A PNG IHDR declaring RGBA; transparent source pixels preserve the canvas background.
  const file = new File([Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,100,0,0,0,50,8,6,0,0,0])], 'transparent.png', { type: 'image/png' });
  await exports.recognizeLocalDocument(file);
  assert.deepEqual(events.paints, [
    { type: 'fill', color: '#ffffff', bounds: [0, 0, 100, 50] },
    { type: 'draw' },
  ], 'the complete OCR canvas must be white before transparent source pixels are drawn');
  assert.equal(events.inputs[0], events.canvases[0]);
  assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('phone JPEG EXIF rotation is included in resize dimensions so the image is not distorted', async () => {
  const { exports, events } = harness();
  const file = new File([Uint8Array.from([
    255,216,255,225,0,34,69,120,105,102,0,0,
    73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0,
    255,192,0,7,8,0,10,0,20,255,217,
  ])], 'phone.jpg');
  const dimensions = await exports.localOcrImageDimensions(file);
  assert.equal(dimensions.width, 10); assert.equal(dimensions.height, 20);
  await exports.recognizeLocalDocument(file);
  assert.equal(events.decodes[0].options.resizeWidth, 10);
  assert.equal(events.decodes[0].options.resizeHeight, 20);
  assert.deepEqual(events.inputSizes, [{ width: 10, height: 20 }]);
});

test('large PDFs have no selection-size or total-page cap and preserve batch source numbers', async () => {
  const { exports, events } = harness({ pageCount: 1205 });
  const file = pdf();
  Object.defineProperty(file, 'size', { value: 150 * 1024 * 1024 });
  assert.equal(await exports.localOcrFileKind(file), 'pdf');
  const result = await exports.recognizeLocalDocument(file, { pageRange: { start: 1201, end: 1205 } });
  assert.equal(result.totalPages, 1205);
  assert.deepEqual(Array.from(result.pages, page => page.page), [1201,1202,1203,1204,1205]);
  assert.deepEqual(events.sourcePages, [1201,1202,1203,1204,1205]);
  assert.equal(events.pageCleanups, 5); assert.equal(events.pdfDestroyed, 1);
});

test('PDF byte-reading failures are clear engine errors and release the worker', async () => {
  const { exports, events } = harness();
  const file = pdf();
  file.arrayBuffer = async () => { throw new RangeError('Insufficient memory'); };
  await assert.rejects(exports.recognizeLocalDocument(file), /could not read the PDF bytes: Insufficient memory/);
  assert.equal(events.inputs.length, 0); assert.equal(events.terminated, 1);
});

test('cancelling a PDF render cancels rendering and releases page, canvas, document, and worker', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { exports, events } = harness({ render: () => { entered(); return new Promise(() => {}); } });
  const controller = new AbortController();
  const promise = exports.recognizeLocalDocument(pdf(), { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(promise, error => error.name === 'AbortError');
  assert.equal(events.renderCancels, 1); assert.equal(events.pageCleanups, 1); assert.equal(events.pdfDestroyed, 1);
  assert.ok(events.terminated >= 1); assert.ok(events.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal(events.inputs.length, 0);
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

test('full-manual iteration streams every page and does not start OCR for embedded text',async()=>{
 const h=harness({pageCount:244,nativeText:number=>`Embedded PDF text on page ${number}.`});
 const pages=[];
 const result=await h.exports.recognizeLocalDocument(pdf(),{readAllPages:true,onPage:page=>pages.push(page.page)});
 assert.equal(result.totalPages,244);assert.equal(result.pages.length,244);
 assert.deepEqual(pages,Array.from({length:244},(_,i)=>i+1));
 assert.equal(h.events.fetches.length,0);assert.equal(h.events.options,null);assert.equal(h.events.canvases.length,0);
 assert.equal(h.events.pageCleanups,244);assert.equal(h.events.pdfDestroyed,1);
});

test('a paused full manual can continue after page ten without rereading completed pages',async()=>{
 const h=harness({pageCount:244,nativeText:number=>`Embedded PDF text on page ${number}.`});
 const controller=new AbortController(),completed=[];
 await assert.rejects(h.exports.recognizeLocalDocument(pdf(),{readAllPages:true,signal:controller.signal,onPage:page=>{completed.push(page.page);if(page.page===11)controller.abort();}}),error=>error.name==='AbortError');
 assert.equal(completed.length,11);assert.equal(h.events.pdfDestroyed,1);
 const next=await h.exports.recognizeLocalDocument(pdf(),{readAllPages:true,pageRange:{start:12,end:244}});
 assert.equal(next.pages[0].page,12);assert.equal(next.pages.at(-1).page,244);
 assert.deepEqual(h.events.sourcePages,Array.from({length:244},(_,i)=>i+1));
});

test('full-manual recognition uses OCR only for the scanned page and keeps source page numbers',async()=>{
 const h=harness({pageCount:12,nativeText:number=>number===7?'':`Embedded PDF text on page ${number}.`,imagePages:[7]});
 const result=await h.exports.recognizeLocalDocument(pdf(),{readAllPages:true});
 assert.equal(result.pages.length,12);assert.equal(result.pages[6].page,7);
 assert.equal(h.events.inputs.length,1);assert.equal(h.events.canvases.length,1);
 assert.equal(h.events.canvases[0].width,0);assert.equal(h.events.terminated,1);
 assert.equal(h.events.pageCleanups,12);assert.equal(h.events.pdfDestroyed,1);
});
