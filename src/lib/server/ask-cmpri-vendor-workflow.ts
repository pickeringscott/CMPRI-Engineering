import "server-only";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { manualAssetIdentity, numericSerialRange, serialRangeStatus } from "@/lib/manual-applicability";
import { manualTextContainsExactIdentity } from "@/lib/manual-document-match";
import { manualPdfMatchesEquipment } from "@/lib/manual-pdf-knowledge";
import { extractEquipmentSuggestions } from "@/lib/equipment-pdf-suggestions";
import { reviewPdfFields } from "@/lib/stored-pdf-link";

type Json = Record<string, unknown>;
export type AskDocumentEvidence = Awaited<ReturnType<typeof import("./ask-cmpri-vendor-document").readAskVendorEvidence>> & { sourceLabel?: string };
type Evidence = AskDocumentEvidence;
type Progress = {
  revision_opened: boolean; original_uploaded: boolean; original_reused: boolean;
  association_saved: boolean; asset_verified: boolean; uncertain_step: string | null;
};
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const object = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): Json[] => Array.isArray(value) ? value.filter(object) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

class WorkflowError extends Error {
  constructor(message: string, readonly status = 409, readonly native?: Json) { super(message); }
}

/** Every downstream path is fixed here; the opaque token supplies the scoped asset. */
function nativeRequest(original: NextRequest, path: string, method: "GET" | "POST" | "PATCH", body?: FormData | Json) {
  const headers = new Headers({ Authorization: original.headers.get("authorization") || "" });
  const property = original.headers.get("x-cmpri-property");
  if (property) headers.set("x-cmpri-property", property);
  const form = body instanceof FormData;
  if (body && !form) headers.set("Content-Type", "application/json");
  return new NextRequest(new URL(path, original.url), {
    method, headers, signal: original.signal,
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
  });
}

async function result(response: Response): Promise<Json> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new WorkflowError(object(body) && typeof body.error === "string" ? body.error : "The native document operation failed.", response.status, object(body) ? body : undefined);
  if (!object(body)) throw new WorkflowError("The native document operation returned an unreadable result.", 502);
  return body;
}

function checkedSnapshot(snapshot: Json, evidence: Evidence, expectedTimestamp?: string): string {
  const expected = manualAssetIdentity(evidence.asset);
  const identity = snapshot.asset_identity;
  if (!object(identity) || Object.entries(expected).some(([key, value]) => identity[key] !== value)) {
    throw new WorkflowError("The equipment identity changed during document review. Read the current asset and original again before continuing.");
  }
  if (typeof snapshot.updated_at !== "string" || !Number.isFinite(Date.parse(snapshot.updated_at))) throw new WorkflowError("The current equipment revision could not be verified.");
  if (expectedTimestamp && snapshot.updated_at !== expectedTimestamp) throw new WorkflowError("The equipment changed during document review. Reload its current revision before continuing.");
  return snapshot.updated_at;
}

function verifiedModel(evidence: Evidence): string {
  if (evidence.review.intended !== "verify") throw new WorkflowError("This original was reviewed for reference only. Review it for verification before requesting a verified association.");
  if (!evidence.review.complete) throw new WorkflowError("The complete original could not be read. Unreadable or unreviewed pages must be resolved before verification; the original can be saved as a reference.");
  if (evidence.review.serial.status === "unresolved") throw new WorkflowError("The document contains unresolved serial-number restrictions. Review those limits against the physical asset before verification.");
  if (evidence.review.serial.status === "range") {
    const range = numericSerialRange(evidence.review.serial.range);
    if (!range || serialRangeStatus(evidence.asset.serial_number, range) !== "match") throw new WorkflowError("The asset serial number is missing, unreadable, or outside the document's printed range. Verification cannot be confirmed.");
  }
  if (!evidence.identityMatch || !manualPdfMatchesEquipment(evidence.text, evidence.asset)) throw new WorkflowError("The complete original does not establish this asset's exact manufacturer and model. Save it as a reference or select the applicable original.");
  const model = [evidence.asset.model_number, evidence.asset.model_family].find(value => value && manualTextContainsExactIdentity(evidence.text, value));
  if (!model) throw new WorkflowError("No exact current model was found in the original document.");
  return model.trim();
}

function partialMessage(progress: Progress): string {
  const confirmed = [
    progress.revision_opened ? "an equipment revision was opened" : "",
    progress.original_uploaded ? "the original PDF was uploaded" : "",
    progress.association_saved ? "the reviewed document association was saved" : "",
    progress.asset_verified ? "the asset was verified" : "",
  ].filter(Boolean);
  return [confirmed.length ? `Confirmed changes: ${confirmed.join("; ")}.` : "",
    progress.uncertain_step ? `${progress.uncertain_step} was attempted, but its final result could not be verified.` : "",
    confirmed.length || progress.uncertain_step ? "Reload the asset and stored PDFs before retrying; do not upload a second copy blindly." : "",
  ].filter(Boolean).join(" ");
}

/** Report this exact original, even when another attached manual already has ready guidance. */
async function guideOutcome(request: NextRequest, evidence: Evidence, fileId: string, applicability: string) {
  const route = await import("@/app/api/maintenance-reference/route");
  try {
    const data = await result(await route.GET(nativeRequest(request, `/api/maintenance-reference?source=asset-upload&assetId=${encodeURIComponent(evidence.asset.id)}`, "GET")));
    const knowledge = object(data.manualKnowledge) ? data.manualKnowledge : {};
    const sources = [...records(knowledge.sources), ...(object(knowledge.source) ? [knowledge.source] : [])];
    const source = sources.find(item => item.registered_file_id === fileId && item.sha256 === evidence.sha256);
    const fromOriginal = (item: Json) => item.source_document_id === fileId && item.source_sha256 === evidence.sha256;
    const passages = records(knowledge.source_passages).filter(fromOriginal);
    const actions = passages.filter(item => typeof item.kind === "string" && item.kind !== "reference").length
      + records(knowledge.symptom_rules).filter(item => fromOriginal(item) && item.reference_only !== true).length
      + records(knowledge.error_codes).filter(fromOriginal).length;
    const coverage = source && object(source.coverage) ? source.coverage : null;
    const incomplete = Boolean(source?.search_incomplete) || Boolean(coverage && Array.isArray(coverage.needs_ocr) && coverage.needs_ocr.length);
    const nativeStatus = typeof data.documentation_status === "string" ? data.documentation_status : "unavailable";
    const status = applicability !== "confirmed_model" ? "reference"
      : source && actions > 0 && !incomplete ? "ready"
      : source && !incomplete ? "no_guidance"
      : incomplete || /processing|needs_ocr/.test(nativeStatus) ? "pending" : "unavailable";
    return { status, native_status: nativeStatus, source_present: Boolean(source), source_file_id: fileId, source_sha256: evidence.sha256,
      source_passage_count: passages.length, actionable_item_count: actions,
      reason: typeof data.documentation_reason === "string" ? data.documentation_reason : "",
      warnings: strings(data.documentation_warnings) };
  } catch (error) {
    return { status: applicability === "confirmed_model" ? "unavailable" : "reference", native_status: "unavailable", source_present: false,
      source_file_id: fileId, source_sha256: evidence.sha256, source_passage_count: 0, actionable_item_count: 0,
      reason: error instanceof Error ? error.message : "The current troubleshooting guide could not be read.",
      warnings: ["The document save completed, but current troubleshooting readiness could not be read back."] };
  }
}

/** Called only by the confirmed native write dispatcher, never by document preview. */
export async function importAskVendorDocument(request: NextRequest): Promise<Response> {
  return importAskReviewedDocument(request, async (incoming, token) => (await import("@/lib/server/ask-cmpri-vendor-document")).readAskVendorEvidence(incoming, token));
}

/** Both selected local originals and fetched vendor originals follow one native verification chain. */
export async function importAskReviewedDocument(request: NextRequest, readEvidence: (request: NextRequest, token: string) => Promise<Evidence>): Promise<Response> {
  const progress: Progress = { revision_opened: false, original_uploaded: false, original_reused: false, association_saved: false, asset_verified: false, uncertain_step: null };
  try {
    const input: unknown = await request.json().catch(() => null);
    if (!object(input) || Object.keys(input).some(key => !["documentToken", "revisionReason", "verify"].includes(key))
      || typeof input.documentToken !== "string" || !input.documentToken || input.documentToken.length > 16000
      || input.verify !== undefined && typeof input.verify !== "boolean"
      || input.revisionReason !== undefined && (typeof input.revisionReason !== "string" || input.revisionReason.trim().length < 5 || input.revisionReason.trim().length > 2000)) {
      throw new WorkflowError("Use the reviewed documentToken, optional verify:true/false, and an explicit revisionReason of 5–2000 characters when changing locked equipment.", 400);
    }
    const evidence = await readEvidence(request, input.documentToken);
    const verify = input.verify === true;
    const revisionReason = typeof input.revisionReason === "string" ? input.revisionReason.trim() : "";
    const model = verify ? verifiedModel(evidence) : "";
    if (evidence.descriptor.kind !== "asset-documentation" || evidence.bytes.length !== evidence.descriptor.size
      || createHash("sha256").update(evidence.bytes).digest("hex") !== evidence.sha256 || evidence.descriptor.sha256 !== evidence.sha256) {
      throw new WorkflowError("The retained original no longer matches its reviewed bytes. Download and review the original again.");
    }
    const docs = await import("@/app/api/assets/documentation/route");
    const assets = await import("@/app/api/assets/route");
    const snapshot = async () => result(await docs.GET(nativeRequest(request, `/api/assets/documentation?asset_id=${encodeURIComponent(evidence.asset.id)}&mode=stored`, "GET")));
    const stored = await snapshot();
    let timestamp = checkedSnapshot(stored, evidence, evidence.asset.updated_at);
    const prior = records(stored.links).find(link => link.sha256 === evidence.sha256 && typeof link.object_id === "string" && UUID.test(link.object_id));
    // A reference import must never downgrade a previously confirmed association.
    if (!verify && prior?.applicability === "confirmed_model") throw new WorkflowError("This exact original is already associated as an applicable manual. Its confirmed association was preserved; use the current document or explicitly review a requested correction.");
    if (evidence.asset.documentation_verified_at && !revisionReason) throw new WorkflowError("This equipment is verified and locked. Supply the user's explicit reason for opening a documentation revision before adding or changing its document.");

    // Recover an original retained by an earlier partial upload, even when its
    // association was never saved. Compare actual hashes through native review;
    // neither a filename nor a matching byte count establishes file identity.
    const prefix = `${evidence.asset.hotel_id}/${evidence.asset.id}/`;
    const candidates = prior ? [prior] : records(stored.files).filter(file => file.size === evidence.bytes.length
      && typeof file.storage_path === "string" && file.storage_path.startsWith(prefix)
      && typeof file.object_id === "string" && UUID.test(file.object_id));
    let inspected: Json | null = null;
    for (const candidate of candidates) {
      const review = new FormData();
      review.set("asset_id", evidence.asset.id); review.set("import_action", "review"); review.set("object_id", String(candidate.object_id));
      const read = await result(await docs.POST(nativeRequest(request, "/api/assets/documentation", "POST", review)));
      checkedSnapshot(read, evidence);
      if (read.sha256 === evidence.sha256 && object(read.file) && read.file.object_id === candidate.object_id && read.file.size === evidence.bytes.length) { inspected = read; break; }
      if (prior) throw new WorkflowError("The existing association's original changed after review. Reload the actual saved PDF; no second copy was uploaded.");
    }
    if (inspected && object(inspected.file) && inspected.file.catalog_status === "content_mismatch") throw new WorkflowError("The native document review reports a catalog/content mismatch. Read and explicitly resolve that warning before linking this original; it was not silently acknowledged.", 409, inspected);

    const suggestions = extractEquipmentSuggestions(evidence.text);
    const fields = reviewPdfFields({
      title: evidence.fileName,
      manufacturer: verify ? evidence.asset.manufacturer || "" : suggestions?.manufacturer || "",
      models: verify ? [model] : suggestions?.model_candidates || [],
      selected_model: model, applicability: verify ? "confirmed_model" : "reference",
      notes: evidence.sourceUrl,
      reason: revisionReason || (verify ? `Attach and verify the ${evidence.sourceLabel || "original vendor PDF"} against the current physical equipment.` : `Attach the ${evidence.sourceLabel || "original vendor PDF"} as a reference without asserting equipment applicability.`),
      // Preserve an existing guide selection; a new import does not deselect other manuals.
      preferred: prior?.preferred === true,
      ...(verify ? { applicability_review: { ...manualAssetIdentity(evidence.asset), confirmed: true } } : {}),
      serial_range: evidence.review.serial.status === "range" ? numericSerialRange(evidence.review.serial.range) : null,
    });

    const write = async (label: string, call: () => Promise<Response>) => {
      progress.uncertain_step = label;
      const response = await call();
      if (response.status === 401 || response.status === 403) progress.uncertain_step = null;
      const data = await result(response);
      progress.uncertain_step = null;
      return data;
    };
    if (evidence.asset.documentation_verified_at) {
      const opened = await write("Opening the equipment revision", () => assets.PATCH(nativeRequest(request, "/api/assets", "PATCH", {
        id: evidence.asset.id, begin_documentation_revision: true, expected_updated_at: timestamp, revision_reason: revisionReason,
      })));
      if (opened.revision_open !== true) {
        progress.uncertain_step = "Opening the equipment revision";
        throw new WorkflowError("The native equipment revision could not be confirmed.", 502);
      }
      progress.revision_opened = true;
      timestamp = checkedSnapshot(await snapshot(), evidence);
    }
    if (inspected) progress.original_reused = true;
    else {
      const form = new FormData();
      form.set("asset_id", evidence.asset.id);
      form.set("import_action", "upload");
      form.set("file", new File([new Uint8Array(evidence.bytes)], evidence.fileName, { type: "application/pdf" }));
      inspected = await write("Uploading the original PDF", () => docs.POST(nativeRequest(request, "/api/assets/documentation", "POST", form)));
      progress.original_uploaded = true;
    }
    if (!object(inspected.file) || typeof inspected.file.object_id !== "string" || !UUID.test(inspected.file.object_id)
      || inspected.sha256 !== evidence.sha256 || inspected.file.size !== evidence.bytes.length) {
      throw new WorkflowError("The stored original does not match the exact reviewed PDF. Its association and asset verification were not completed.", 409);
    }
    checkedSnapshot(inspected, evidence);
    if (inspected.file.catalog_status === "content_mismatch") throw new WorkflowError("The native document review reports a catalog/content mismatch. Read and explicitly resolve that warning before linking this original; it was not silently acknowledged.", 409, inspected);

    timestamp = checkedSnapshot(await snapshot(), evidence);
    const association = new FormData();
    Object.entries({ import_action: "save", asset_id: evidence.asset.id, object_id: inspected.file.object_id,
      sha256: evidence.sha256, expected_updated_at: timestamp, review_confirmed: "true", fields: JSON.stringify(fields),
    }).forEach(([key, value]) => association.set(key, value));
    const saved = await write("Saving the reviewed document association", () => docs.POST(nativeRequest(request, "/api/assets/documentation", "POST", association)));
    if (saved.association_verified !== true || !object(saved.saved) || saved.saved.object_id !== inspected.file.object_id || saved.saved.sha256 !== evidence.sha256) {
      progress.uncertain_step = "Saving the reviewed document association";
      throw new WorkflowError("The native save did not confirm this exact document association. Reload the saved asset before continuing.", 502);
    }
    progress.association_saved = true;
    if (verify) {
      timestamp = checkedSnapshot(await snapshot(), evidence);
      const verified = await write("Verifying the equipment documentation", () => assets.PATCH(nativeRequest(request, "/api/assets", "PATCH", {
        id: evidence.asset.id, verify_with_documentation: true, expected_updated_at: timestamp,
      })));
      if (verified.verified !== true) {
        progress.uncertain_step = "Verifying the equipment documentation";
        throw new WorkflowError("The reviewed association was saved, but final native asset verification could not be confirmed.", 502);
      }
      progress.asset_verified = true;
    }
    const guide = await guideOutcome(request, evidence, inspected.file.object_id, fields.applicability);
    const guidance = guide.status === "ready" ? "The current native guide contains troubleshooting guidance from this exact original. Work-order troubleshooting will read it for this saved asset."
      : guide.status === "reference" ? "It is saved as a reference; this import does not claim verified applicability or troubleshooting guidance."
      : guide.status === "no_guidance" ? "The original is attached and verified, but it contains no available troubleshooting procedures in the current guide."
      : guide.status === "pending" ? "The original is attached, but source processing or incomplete pages remain; complete troubleshooting readiness is pending."
      : "The document save is confirmed, but troubleshooting readiness for this original could not be verified.";
    const message = `${progress.original_reused ? "The existing original PDF was reused" : "The original PDF was uploaded"} and its reviewed association was saved to ${evidence.asset.name || "the selected asset"}. ${progress.asset_verified ? "Native equipment verification completed. " : ""}${guidance}`;
    return Response.json({ ok: true, message, asset_id: evidence.asset.id, file_id: inspected.file.object_id,
      sha256: evidence.sha256, file_name: evidence.fileName, source_url: evidence.sourceUrl,
      applicability: fields.applicability, association_verified: true, verified: progress.asset_verified,
      progress, troubleshooting: guide, warnings: guide.warnings,
    }, { headers: HEADERS });
  } catch (error) {
    const known = error instanceof WorkflowError ? error : null;
    const partial = partialMessage(progress);
    const message = error instanceof Error ? error.message : "The original document workflow could not be completed.";
    return Response.json({ error: [message, partial].filter(Boolean).join(" "), progress,
      ...(known ? { native_status: known.status, ...(Array.isArray(known.native?.catalog_warnings) ? { warnings: known.native.catalog_warnings } : {}) } : {}),
      ...(typeof known?.native?.storage_path === "string" ? { original_storage_path: known.native.storage_path } : {}),
    }, { status: partial ? 409 : known?.status || 400, headers: HEADERS });
  }
}
