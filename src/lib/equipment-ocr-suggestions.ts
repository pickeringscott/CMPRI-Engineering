import { extractEquipmentSuggestions } from "./equipment-pdf-suggestions";

/**
 * Produce unverified suggestions only from text the user reviewed. This does
 * not upload a document, verify an asset, or change equipment fields.
 */
export function suggestionsFromReviewedOcr(pages: ReadonlyArray<{ page: number; text: string }>) {
  const text = pages.map((page) => page.text).join("\n");
  return extractEquipmentSuggestions(text);
}
