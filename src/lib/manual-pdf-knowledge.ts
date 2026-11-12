import { createHash } from "node:crypto";
import { manualTextContainsExactIdentity } from "@/lib/manual-document-match";
import { manualTextQuality, type ManualPageQuality } from './manual-page-quality';
import * as nodeModule from 'node:module';
import path from 'node:path';

export function manualPdfOptions(bytes: Uint8Array) {
  // Keep this lookup in Node; webpack rewrites named createRequire imports.
  const nodeRequire=nodeModule.createRequire(path.join(process.cwd(),'package.json'));
  const root=path.dirname(nodeRequire.resolve('pdfjs-dist/package.json'));
  return {data:bytes.slice(),standardFontDataUrl:path.join(root,'standard_fonts')+path.sep,cMapUrl:path.join(root,'cmaps')+path.sep,cMapPacked:true,wasmUrl:path.join(root,'wasm')+path.sep,useWorkerFetch:false,verbosity:0};
}

export type ManualEquipmentIdentity = {
  id?: string;
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
  serial_number?: string | null;
};

export async function extractManualPdfText(bytes: Uint8Array, options: { includeEmptyPages?: boolean } = {}) {
  return (await inspectManualPdf(bytes,options)).text;
}

export async function inspectManualPdf(bytes: Uint8Array, options: { includeEmptyPages?: boolean; cachedPages?:ManualPageQuality[]; onBatch?:(pages:ManualPageQuality[])=>Promise<void> } = {}) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js transfers ownership of its input buffer. Keep the caller's bytes
  // intact for storage, hashing, and subsequent reads.
  const task = pdfjs.getDocument(manualPdfOptions(bytes));
  const pdf = await task.promise;
  try {
    if (pdf.numPages > 10000) throw new Error("This original exceeds the reader's page budget. The original is preserved for reference.");
    const parts: string[] = [];
    const pages: ManualPageQuality[] = [], warnings:string[]=[];
    const page_labels:Record<string,string>={};
    const labels=await pdf.getPageLabels();
    const cached=new Map((options.cachedPages||[]).map(page=>[page.page,page]));
    let totalLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const existing=cached.get(pageNumber);
      if(existing){totalLength+=existing.text.length;if(totalLength>20_000_000){warnings.push(`Text indexing paused at PDF page ${pageNumber}; the complete original remains available.`);break;}pages.push(existing);if(existing.text||options.includeEmptyPages)parts.push(`PAGE ${pageNumber}\n${existing.text}`);if(existing.printed_label)page_labels[String(pageNumber)]=existing.printed_label;continue;}
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(item => "str" in item ? String(item.str || "") + (item.hasEOL ? "\n" : " ") : "")
        .join("").replace(/[ \t]+/g, " ").trim();
      totalLength += text.length;
      if (totalLength > 20_000_000) { warnings.push(`Text indexing paused at PDF page ${pageNumber}; the complete original remains available.`); page.cleanup(); break; }
      const operators=await page.getOperatorList();
      const hasImage=operators.fnArray.some(op=>[pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageMaskXObject].includes(op));
      const quality=manualTextQuality(text,hasImage);
      // Labels supplied by the PDF are authoritative. Otherwise accept only a lone
      // footer page token, keeping printed labels distinct from physical positions.
      const footer=content.items.filter(item=>'str'in item && item.transform[5]<35 && /^\s*[–—-]?\s*\d{1,4}\s*[–—-]?\s*$/.test(item.str));
      const label=labels?.[pageNumber-1] || (footer.length===1?('str'in footer[0]?footer[0].str.replace(/[^0-9]/g,''):''):undefined);
      if(label)page_labels[String(pageNumber)]=label;
      pages.push({page:pageNumber,text,...quality,...(label?{printed_label:label}:{})});
      if (text || options.includeEmptyPages) parts.push(`PAGE ${pageNumber}\n${text}`);
      page.cleanup();
      if(pageNumber%25===0){const batch=pages.slice(-25);if(batch.some(page=>!cached.has(page.page)))await options.onBatch?.(batch);await new Promise(resolve=>setTimeout(resolve,0));}
    }
    if(pages.length%25){const batch=pages.slice(-(pages.length%25));if(batch.some(page=>!cached.has(page.page)))await options.onBatch?.(batch);}
    return {text:parts.join("\n\n"),pages,page_labels,total_pages:pdf.numPages,warnings};
  } finally {
    await task.destroy();
  }
}

/** Validate a scanned original without treating OCR or page images as verified instructions. */
export async function hasScannedManualContent(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const paintOps = new Set([
    pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintInlineImageXObjectGroup, pdfjs.OPS.paintImageXObjectRepeat,
    pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageMaskXObjectGroup,
    pdfjs.OPS.paintImageMaskXObjectRepeat, pdfjs.OPS.stroke, pdfjs.OPS.fill,
    pdfjs.OPS.eoFill, pdfjs.OPS.fillStroke, pdfjs.OPS.eoFillStroke,
    pdfjs.OPS.closeStroke, pdfjs.OPS.closeFillStroke, pdfjs.OPS.closeEOFillStroke,
  ]);
  try {
    const pdf = await task.promise;
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 600) return false;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try { if ((await page.getOperatorList()).fnArray.some(operator => paintOps.has(operator))) return true; }
      finally { page.cleanup(); }
    }
    return false;
  } finally { await task.destroy(); }
}

function identityPhraseMatches(text: string, identity: string | null | undefined) {
  return manualTextContainsExactIdentity(text, identity);
}

export function manualPdfMatchesEquipment(text: string, equipment: ManualEquipmentIdentity) {
  if (!identityPhraseMatches(text, equipment.manufacturer)) return false;
  return manualPdfContainsEquipmentModel(text, equipment);
}

export function manualPdfContainsEquipmentModel(
  text: string,
  equipment: Pick<ManualEquipmentIdentity, "model_family" | "model_number">,
) {
  const familyMatches = identityPhraseMatches(text, equipment.model_family);
  const modelMatches = identityPhraseMatches(text, equipment.model_number);
  return familyMatches || modelMatches;
}

export function manualPdfSha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

