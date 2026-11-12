import { createHash } from "node:crypto";
import { manualTextContainsExactIdentity } from "@/lib/manual-document-match";

export type ManualEquipmentIdentity = {
  id?: string;
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
  serial_number?: string | null;
};

export async function extractManualPdfText(bytes: Uint8Array, options: { includeEmptyPages?: boolean } = {}) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js transfers ownership of its input buffer. Keep the caller's bytes
  // intact for storage, hashing, and subsequent reads.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  try {
    if (pdf.numPages > 600) throw new Error("Manual exceeds 600 pages; split the document before processing.");
    const parts: string[] = [];
    let totalLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(item => "str" in item ? String(item.str || "") + (item.hasEOL ? "\n" : " ") : "")
        .join("").replace(/[ \t]+/g, " ").trim();
      totalLength += text.length;
      if (totalLength > 2_000_000) throw new Error("Manual exceeds the supported text size; split the document before processing.");
      if (text || options.includeEmptyPages) parts.push(`PAGE ${pageNumber}\n${text}`);
      page.cleanup();
    }
    return parts.join("\n\n");
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

