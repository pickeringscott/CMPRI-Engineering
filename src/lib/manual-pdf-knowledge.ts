import { createHash } from "node:crypto";
import { manualTextContainsExactIdentity } from "@/lib/manual-document-match";

export type ManualEquipmentIdentity = {
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
};

export async function extractManualPdfText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js transfers ownership of its input buffer. Keep the caller's bytes
  // intact for storage, hashing, and subsequent reads.
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pageCount = Math.min(pdf.numPages, 40);
  const parts: string[] = [];
  let totalLength = 0;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? String(item.str || "") : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const piece = `PAGE ${pageNumber}\n${text}`;
    parts.push(piece);
    totalLength += piece.length;
    if (totalLength > 110_000) break;
  }

  return parts.join("\n\n").slice(0, 110_000);
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
