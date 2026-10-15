/** Validation for the existing importer; it does not infer equipment matches. */
export type StoredPdf = { object_id: string; storage_path: string; object_version: string | null; etag: string | null; size: number; title: string };
export type PdfReview = { title: string; manufacturer: string; models: string[]; selected_model: string; applicability: "reference" | "confirmed_model"; notes: string; reason: string; extracted_fields?: Record<string,string>; preferred?: boolean };
export function preservePdfReview(currentId: string | null, nextId: string, current: PdfReview, saved: PdfReview | null, suggestions: PdfReview): PdfReview {
  return currentId === nextId ? current : saved ? { ...saved, reason: "" } : suggestions;
}
export function sameReviewedFields(saved: Record<string,unknown>, reviewed: PdfReview) {
  const canonical=(value: unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
  return Object.entries(reviewed).every(([key,value])=>canonical(saved[key])===canonical(value));
}
export function reviewPdfFields(value: unknown): PdfReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review the document fields before saving.");
  const v = value as Record<string, unknown>;
  const text = (key: string, max: number) => {
    if (typeof v[key] !== "string" || v[key].length > max) throw new Error(`Invalid ${key.replaceAll("_", " ")}.`);
    return v[key].trim();
  };
  const title=text("title",500), manufacturer=text("manufacturer",200), selected_model=text("selected_model",200), notes=text("notes",4000), reason=text("reason",2000);
  if (!title || reason.length < 5) throw new Error("Enter a document title and a reason of at least five characters.");
  if (!Array.isArray(v.models) || v.models.length>100 || v.models.some(m=>typeof m!=="string"||m.length>200)) throw new Error("Enter the model list explicitly.");
  const models=Array.from(new Set((v.models as string[]).map(m=>m.trim()).filter(Boolean)));
  if (v.applicability!=="reference" && v.applicability!=="confirmed_model") throw new Error("Choose reference or user-confirmed model applicability.");
  if (v.applicability==="confirmed_model" && (!manufacturer || !selected_model || !models.includes(selected_model))) throw new Error("Choose the confirmed equipment model from the document's model list and enter its manufacturer.");
  const extra=v.extracted_fields ?? {};
  if (!extra || typeof extra!=="object" || Array.isArray(extra) || Object.entries(extra).some(([key,val])=>!["asset_type","model_family","serial_number","generation","install_year"].includes(key)||typeof val!=="string"||val.length>300)) throw new Error("Invalid edited equipment fields.");
  if (v.preferred!==undefined && typeof v.preferred!=="boolean") throw new Error("Invalid guide selection.");
  return {title,manufacturer,models,selected_model,notes,reason,applicability:v.applicability,extracted_fields:extra as Record<string,string>,preferred:v.preferred===true};
}
export function validateStoredPdf(bytes: Uint8Array, file: StoredPdf, expectedHash: string | null, actualHash: string) {
  if (!bytes.length) throw new Error("The stored PDF is empty. Its original has been preserved.");
  if (bytes.length > 50 * 1024 * 1024) throw new Error("The stored PDF exceeds the 50 MB import limit.");
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("The selected stored file is not a PDF, even if its filename ends in .pdf.");
  if (file.size !== bytes.length) throw new Error("The stored file changed or its saved size does not match. Reload it before saving links.");
  if (expectedHash && expectedHash !== actualHash) throw new Error("The PDF changed since you reviewed it. Reload and review the current original.");
}
