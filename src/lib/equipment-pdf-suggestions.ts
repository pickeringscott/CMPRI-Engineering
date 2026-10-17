import type { PdfReview } from "./stored-pdf-link";

export type EquipmentSuggestions = {
  manufacturer?: string;
  manufacturer_source?: "document" | "asset";
  model_number?: string;
  model_candidates?: string[];
  asset_type?: string;
  model_family?: string;
  serial_number?: string;
  generation?: string;
  install_year?: number;
};

/** Read explicit labels and model-table headings, never arbitrary surrounding prose. */
export function extractEquipmentSuggestions(text: string): EquipmentSuggestions | null {
  if (!text.trim()) return null;
  const result: EquipmentSuggestions = {};
  const label = (name: string) => {
    const match = text.match(new RegExp(`\\b(?:${name})\\s*[:#=]\\s*([^\\n]+)`, "i"));
    return match?.[1].split(/\s+(?=(?:model(?: number| family)?|serial(?: number| no\.?)?|s\/n|manufacturer|generation|installation year|year installed|equipment type|voltage|power)\s*[:#=])/i)[0].trim() || "";
  };
  const manufacturer = (label("manufacturer|manufactured by") || text.match(/(?:^|\n)\s*Manufactured by\s+([^\n]+?)(?=\s+(?:Model|Serial|S\/N)\b|$)/i)?.[1]?.trim() || "").replace(/\.$/, "");
  if (manufacturer && manufacturer.length <= 200) {
    result.manufacturer = manufacturer;
    result.manufacturer_source = "document";
  }
  const headings = /(?:^|\n)\s*(?:applicable\s+)?models?(?:\s+(?:number|no\.?))?\s*(?:[:#=\-]\s*)?([^\n]*)|\bmodels?(?:\s+(?:number|no\.?))?\s*[:#=]\s*([^\n]+)/gi;
  const groups: string[][] = [];
  for (const match of text.matchAll(headings)) {
    const line = (match[1] || match[2] || "").trim();
    const tokens = line.split(/[\s,;]+/).filter(Boolean);
    const models: string[] = [];
    for (const token of tokens) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,60}$/.test(token) || !/[A-Za-z]/.test(token) || !/\d/.test(token)) break;
      models.push(token);
    }
    if (models.length) groups.push(models);
  }
  // Prefer the first full model table over later performance tables using shorter families.
  const models = Array.from(new Set(groups.find(group => group.length > 1) || groups[0] || []));
  if (models.length) result.model_candidates = models;
  if (models.length === 1) result.model_number = models[0];
  for (const [key, heading] of [["asset_type", "equipment type|product type|unit type"], ["model_family", "model family|equipment family"], ["generation", "generation"]] as const) {
    const value = label(heading);
    if (value && value.length <= 200) result[key] = value;
  }
  const serial = label("serial number|serial no\\.?|s/n");
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]{2,80}$/.test(serial)) result.serial_number = serial;
  const year = label("installation year|year installed");
  if (/^(19|20)\d{2}$/.test(year)) result.install_year = Number(year);
  return Object.keys(result).length ? result : null;
}

/** Existing identity is a labeled default, not evidence extracted from the manual. */
export function withAssetManufacturer(suggestions: EquipmentSuggestions | null, manufacturer: string | null | undefined) {
  if (suggestions?.manufacturer || !manufacturer?.trim()) return suggestions;
  return { ...suggestions, manufacturer: manufacturer.trim(), manufacturer_source: "asset" as const };
}

export function pdfReviewSuggestions(title: string, suggestions: EquipmentSuggestions | null): PdfReview {
  const extracted_fields: Record<string, string> = {};
  for (const key of ["asset_type", "model_family", "serial_number", "generation", "install_year"] as const) {
    const value = suggestions?.[key];
    if (value !== undefined && value !== "") extracted_fields[key] = String(value);
  }
  return {
    title, manufacturer: suggestions?.manufacturer || "",
    models: Array.from(new Set([...(suggestions?.model_candidates || []), ...(suggestions?.model_number ? [suggestions.model_number] : [])])),
    selected_model: "", applicability: "reference", notes: "", reason: "", extracted_fields,
  };
}
