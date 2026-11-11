import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { TroubleshootingStepMedia } from '../manual-knowledge';

type Rect = [number, number, number, number];
type Matrix = [number, number, number, number, number, number];
type Caption = { reference: string; text: string; rect: Rect };
export type InspectedUploadedGuideMedia = {
  descriptor: TroubleshootingStepMedia;
  /** Private page-viewport coordinates at scale 1: x, y, width, height. */
  region: Rect;
  sourceSha256: string;
};

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 600;
const MAX_INSPECTED_PAGES = 24;
const MAX_STEPS = 128;
const MAX_MEDIA = 24;
const MAX_OUTPUT_DIMENSION = 1400;
const MAX_OUTPUT_PIXELS = 2_000_000;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const figureExpression = /\bfig(?:ure)?\.?\s*([a-z]?\d+(?:[.-]\d+)*[a-z]?)\b/ig;

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateSource(bytes: Uint8Array, sha256: string) {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || !/^[a-f0-9]{64}$/.test(sha256)
    || hash(bytes) !== sha256 || Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') {
    throw new Error('The uploaded PDF source or its SHA-256 fingerprint changed.');
  }
}

async function openPdf(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Resolve local PDF assets from the deployed application root. A bundled
  // import.meta.url can contain the build machine's original source path.
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const options = {
    data: bytes.slice(),
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep,
    cMapUrl: path.join(root, 'cmaps') + path.sep,
    cMapPacked: true,
    wasmUrl: path.join(root, 'wasm') + path.sep,
    useWorkerFetch: false,
    useSystemFonts: false,
    // A skipped oversized/corrupt main image must not leave a logo as the
    // apparent unique illustration for its caption.
    stopAtErrors: true,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 32_000_000,
    verbosity: 0,
  };
  const task = pdfjs.getDocument(options);
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES) throw new Error('The PDF exceeds the supported page count.');
    return { pdf, task, OPS: pdfjs.OPS };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function numeric(value: unknown, length: number): number[] | null {
  if (!value || typeof value !== 'object' || !('length' in value)
    || (value as { length: number }).length !== length) return null;
  const numbers = Array.from(value as ArrayLike<number>);
  return numbers.every(Number.isFinite) ? numbers : null;
}

function bounds(matrix: Matrix, box: number[]): number[] {
  const points = [[box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]]]
    .map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}

function viewportRect(page: PDFPageProxy, box: number[]): Rect {
  const converted = bounds(page.getViewport({ scale: 1 }).transform as Matrix, box);
  return [converted[0], converted[1], converted[2] - converted[0], converted[3] - converted[1]];
}

function overlap(a: Rect, b: Rect, padding = 0) {
  return a[0] <= b[0] + b[2] + padding && b[0] <= a[0] + a[2] + padding
    && a[1] <= b[1] + b[3] + padding && b[1] <= a[1] + a[3] + padding;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

async function captions(page: PDFPageProxy): Promise<Caption[]> {
  const content = await page.getTextContent();
  if (content.items.length > 10_000) return [];
  const items = content.items.flatMap(item => {
    if (!('str' in item) || !item.str.trim() || Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01) return [];
    return [{ text: item.str.trim(), x: item.transform[4], y: item.transform[5],
      rect: viewportRect(page, [item.transform[4], item.transform[5], item.transform[4] + item.width, item.transform[5] + item.height]) }];
  }).sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : b.y - a.y);
  const lines: { text: string; y: number; rect: Rect }[] = [];
  for (const item of items) {
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.y - item.y) < 2
      && item.rect[0] - (previous.rect[0] + previous.rect[2]) < 40) {
      previous.text += ' ' + item.text;
      previous.rect = union(previous.rect, item.rect);
    } else lines.push({ text: item.text, y: item.y, rect: item.rect });
  }
  return lines.flatMap(line => {
    const match = line.text.match(/^fig(?:ure)?\.?\s*([a-z]?\d+(?:[.-]\d+)*[a-z]?)\b(?:\s*[:.—-]\s*|\s+|$)(.*)$/i);
    return match ? [{ reference: match[1].toUpperCase(), text: line.text, rect: line.rect }] : [];
  });
}

async function illustrations(page: PDFPageProxy, OPS: Record<string, number>): Promise<Rect[]> {
  const operators = await page.getOperatorList();
  if (operators.fnArray.length > 100_000) return [];
  let matrix: Matrix = [...IDENTITY];
  const stack: Matrix[] = [];
  const primitives: Rect[] = [];
  let unsupportedGeometry = false;
  const viewport = page.getViewport({ scale: 1 });
  const add = (box: number[]) => {
    const rect = viewportRect(page, bounds(matrix, box));
    if (!rect.every(Number.isFinite) || rect[2] < 0 || rect[3] < 0
      || rect[0] < -2 || rect[1] < -2 || rect[0] + rect[2] > viewport.width + 2 || rect[1] + rect[3] > viewport.height + 2) {
      unsupportedGeometry = true;
      return;
    }
    primitives.push(rect);
  };
  for (let index = 0; index < operators.fnArray.length; index++) {
    const operation = operators.fnArray[index];
    const args = operators.argsArray[index] as unknown[] | null;
    if (operation === OPS.save || operation === OPS.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (operation === OPS.paintFormXObjectBegin) {
        const transform = numeric(args?.[0], 6);
        if (transform) matrix = multiply(matrix, transform as Matrix);
      }
    } else if (operation === OPS.restore || operation === OPS.paintFormXObjectEnd) {
      matrix = stack.pop() || [...IDENTITY];
    } else if (operation === OPS.transform) {
      const transform = numeric(args, 6);
      if (!transform) return [];
      matrix = multiply(matrix, transform as Matrix);
    } else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(operation)) {
      add([0, 0, 1, 1]);
    } else if ([OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.shadingFill, OPS.beginGroup].includes(operation)) {
      // These forms need additional geometry/clip handling. Do not discard
      // an unsupported main graphic and then select a simpler nearby logo.
      return [];
    } else if (operation === OPS.constructPath) {
      // pdf.js exposes path bounds for painted vector paths. Empty/reset paths
      // have no bounds. Rendering the selected crop retains vectors and labels.
      const pathBounds = numeric(args?.[2], 4);
      if (pathBounds) add(pathBounds);
    }
    if (primitives.length > 3000) return [];
  }
  if (unsupportedGeometry) return [];
  const groups: Rect[] = [];
  for (const primitive of primitives) {
    let merged = primitive;
    for (let index = groups.length - 1; index >= 0; index--) {
      if (overlap(merged, groups[index], 3)) { merged = union(merged, groups[index]); groups.splice(index, 1); index = groups.length; }
    }
    groups.push(merged);
  }
  // Retain oversized graphics while resolving association. Removing a large
  // actual illustration here could leave an unrelated nearby logo as the only
  // candidate for its caption. Rendering limits are applied after ambiguity.
  return groups.filter(rect => rect[2] > 0 || rect[3] > 0);
}

function associates(caption: Caption, graphic: Rect, allCaptions: Caption[]) {
  const horizontal = Math.max(0, Math.min(caption.rect[0] + caption.rect[2], graphic[0] + graphic[2]) - Math.max(caption.rect[0], graphic[0]));
  if (horizontal < Math.min(caption.rect[2], graphic[2]) * 0.25) return false;
  const captionBottom = caption.rect[1] + caption.rect[3], graphicBottom = graphic[1] + graphic[3];
  const gap = graphic[1] >= captionBottom - 2 ? graphic[1] - captionBottom
    : caption.rect[1] >= graphicBottom - 2 ? caption.rect[1] - graphicBottom : -1;
  if (gap < -2 || gap > 160) return false;
  const top = Math.min(captionBottom, graphicBottom), bottom = Math.max(caption.rect[1], graphic[1]);
  return !allCaptions.some(other => other !== caption && other.rect[1] >= top && other.rect[1] + other.rect[3] <= bottom
    && overlap([graphic[0], top, graphic[2], Math.max(0, bottom - top)], other.rect));
}

function outputSize(region: Rect) {
  const scale = Math.min(2, MAX_OUTPUT_DIMENSION / region[2], MAX_OUTPUT_DIMENSION / region[3], Math.sqrt(MAX_OUTPUT_PIXELS / (region[2] * region[3])));
  const width = Math.max(1, Math.floor(region[2] * scale)), height = Math.max(1, Math.floor(region[3] * scale));
  return { width, height, scale: Math.min(width / region[2], height / region[3]) };
}

function mediaId(sourceSha256: string, descriptor: Omit<TroubleshootingStepMedia, 'id'>, region: Rect) {
  return 'media-' + createHash('sha256').update(JSON.stringify({ version: 1, sourceSha256, ...descriptor, region })).digest('hex');
}

/** Only explicit figure references with a unique caption/illustration pair. */
export async function inspectUploadedGuideMedia(bytes: Uint8Array, input: {
  sha256: string;
  steps: { stepLabel: string; sourcePages: number[] }[];
}): Promise<InspectedUploadedGuideMedia[]> {
  validateSource(bytes, input.sha256);
  const steps = input.steps.slice(0, MAX_STEPS).flatMap(step => {
    if (typeof step.stepLabel !== 'string' || step.stepLabel.length > 3000 || !Array.isArray(step.sourcePages)) return [];
    const references = [...step.stepLabel.matchAll(figureExpression)].map(match => match[1].toUpperCase());
    return references.length && references.length <= 3 ? [{ ...step, references: [...new Set(references)] }] : [];
  });
  if (!steps.length) return [];
  const { pdf, task, OPS } = await openPdf(bytes);
  const result: InspectedUploadedGuideMedia[] = [];
  try {
    const pages = [...new Set(steps.flatMap(step => step.sourcePages))].filter(page => Number.isSafeInteger(page) && page > 0 && page <= pdf.numPages).sort((a, b) => a - b).slice(0, MAX_INSPECTED_PAGES);
    for (const number of pages) {
      const page = await pdf.getPage(number);
      try {
        const labels = await captions(page);
        if (!labels.length) continue;
        let graphics: Rect[];
        try { graphics = await illustrations(page, OPS); }
        catch { continue; }
        const viewport = page.getViewport({ scale: 1 });
        for (const step of steps.filter(step => step.sourcePages.includes(number))) {
          for (const reference of step.references) {
            const matching = labels.filter(label => label.reference === reference);
            if (matching.length !== 1) continue;
            const caption = matching[0];
            const candidates = graphics.filter(graphic => associates(caption, graphic, labels));
            if (candidates.length !== 1 || labels.filter(label => associates(label, candidates[0], labels)).length !== 1) continue;
            const graphic = candidates[0];
            if (graphic[2] < 24 || graphic[3] < 24 || graphic[2] * graphic[3] < 900
              || graphic[2] * graphic[3] > viewport.width * viewport.height * 0.65) continue;
            const x = Math.max(0, graphic[0] - 4), y = Math.max(0, graphic[1] - 4);
            const region: Rect = [x, y, Math.min(viewport.width, graphic[0] + graphic[2] + 4) - x, Math.min(viewport.height, graphic[1] + graphic[3] + 4) - y].map(value => Math.round(value * 100) / 100) as Rect;
            const size = outputSize(region);
            const descriptor = { stepLabel: step.stepLabel, sourcePage: number, caption: caption.text, width: size.width, height: size.height };
            const id = mediaId(input.sha256, descriptor, region);
            if (!result.some(item => item.descriptor.id === id)) result.push({ descriptor: { id, ...descriptor }, region, sourceSha256: input.sha256 });
            if (result.length >= MAX_MEDIA) return result;
          }
        }
      } finally { page.cleanup(); }
    }
    return result;
  } finally { await task.destroy(); }
}

/** Render a trusted inspection crop; no URL, path or client geometry is read. */
export async function renderUploadedGuideMedia(bytes: Uint8Array, selection: InspectedUploadedGuideMedia): Promise<Uint8Array> {
  validateSource(bytes, selection.sourceSha256);
  const { id, ...descriptor } = selection.descriptor;
  const region = selection.region;
  if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite) || region[0] < 0 || region[1] < 0 || region[2] < 24 || region[3] < 24
    || !Number.isSafeInteger(descriptor.sourcePage) || descriptor.sourcePage < 1
    || mediaId(selection.sourceSha256, descriptor, region) !== id) throw new Error('The uploaded diagram selection is invalid.');
  const size = outputSize(region);
  if (descriptor.width !== size.width || descriptor.height !== size.height || size.width * size.height > MAX_OUTPUT_PIXELS) throw new Error('The uploaded diagram dimensions are invalid.');
  const { pdf, task } = await openPdf(bytes);
  try {
    if (descriptor.sourcePage > pdf.numPages) throw new Error('The uploaded diagram page is unavailable.');
    const page = await pdf.getPage(descriptor.sourcePage);
    try {
      const plainViewport = page.getViewport({ scale: 1 });
      if (region[0] + region[2] > plainViewport.width + 0.01 || region[1] + region[3] > plainViewport.height + 0.01) throw new Error('The uploaded diagram crop is outside its source page.');
      const canvas = createCanvas(size.width, size.height);
      const context = canvas.getContext('2d');
      const rendered = page.render({ canvas: canvas as never, canvasContext: context as never,
        viewport: page.getViewport({ scale: size.scale }), transform: [1, 0, 0, 1, -region[0] * size.scale, -region[1] * size.scale], background: 'rgb(255,255,255)' });
      await rendered.promise;
      return new Uint8Array(canvas.toBuffer('image/png'));
    } finally { page.cleanup(); }
  } finally { await task.destroy(); }
}

/** Render an entire source page so tables and diagrams remain visible on mobile. */
export async function renderUploadedGuidePage(bytes: Uint8Array, sha256: string, pageNumber: number): Promise<Uint8Array> {
  validateSource(bytes, sha256);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 600) throw new Error('The source page is invalid.');
  const { pdf, task } = await openPdf(bytes);
  try {
    if (pageNumber > pdf.numPages) throw new Error('The source page is unavailable.');
    const page = await pdf.getPage(pageNumber);
    try {
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, 1400 / base.width, Math.sqrt(3000000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport, background: 'rgb(255,255,255)' }).promise;
      return new Uint8Array(canvas.toBuffer('image/png'));
    } finally { page.cleanup(); }
  } finally { await task.destroy(); }
}
