import "server-only";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { readAskStagedFile } from "./ask-cmpri-file-staging";
import { importDescriptor, readImportUpload, IMPORT_UPLOAD_BUCKET } from "./import-upload";
import type { ImportUploadKind } from "@/lib/import-upload";
import { STAFF_FILE_BUCKET } from "@/lib/staff-note-media";
import { parseWorkOrderImportTable } from "@/lib/work-order-import-table";
import { hydrateNativeImportResponse, saveNativeGuestReports, validateNativeGuestReports } from "./ask-cmpri-native-workflows";

type Json = Record<string, unknown>;
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const object = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
class NativeFileError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function nativeRequest(request: NextRequest, path: string, method: "POST" | "PUT", body: Json) {
  const headers = new Headers({ Authorization: request.headers.get("authorization") || "", "Content-Type": "application/json" });
  const property = request.headers.get("x-cmpri-property"); if (property) headers.set("x-cmpri-property", property);
  return new NextRequest(new URL(path, request.url), { method, headers, body: JSON.stringify(body), signal: request.signal });
}
async function result(response: Response): Promise<Json> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !object(body)) throw new NativeFileError(object(body) && typeof body.error === "string" ? body.error : "The native file operation failed.", response.ok ? 502 : response.status);
  return body;
}
async function input(request: NextRequest, fields: string[]) {
  const body: unknown = await request.json().catch(() => null);
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key))) throw new NativeFileError("Use only the original-file operation's named fields.");
  return body;
}
const token = (value: unknown): string => { if (typeof value !== "string" || !value) throw new NativeFileError("Select the actual original file first."); return value; };
async function handle(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "The original file could not be processed." }, { status: error instanceof NativeFileError ? error.status : 400, headers: HEADERS }); }
}

/** Native prepare authorizes each supported import kind before copying exact verified bytes. */
async function nativeImportFile(request: NextRequest, fileToken: string, kind: ImportUploadKind) {
  const original = await readAskStagedFile(request, fileToken);
  const descriptor = importDescriptor({ kind, id: original.descriptor.id, name: original.descriptor.name, size: original.descriptor.size, sha256: original.descriptor.sha256 }, kind);
  const route = await import("@/app/api/import-uploads/route");
  await result(await route.POST(nativeRequest(request, "/api/import-uploads", "POST", descriptor)));
  const extension = kind === "guest-report" ? ".csv" : kind === "purchasing-history" ? ".json" : ".pdf";
  const contentType = kind === "guest-report" ? "text/csv" : kind === "purchasing-history" ? "application/json" : "application/pdf";
  const path = `${original.auth.principal.hotelId}/${original.auth.principal.identity.id}/${kind}/${descriptor.id}-${descriptor.sha256}${extension}`;
  const stored = await original.auth.admin.storage.from(IMPORT_UPLOAD_BUCKET).upload(path, original.bytes, { contentType, upsert: false });
  // An identical retry may already be present. The native reader independently
  // checks private scope, content type, byte count and hash before either use.
  try { await readImportUpload(original.auth.admin, original.auth.principal.hotelId, original.auth.principal.identity.id, descriptor, kind); }
  catch { throw new NativeFileError(stored.error ? "The original import copy could not be verified. Reload the selected file before retrying." : "The copied original differs from its verified source.", 409); }
  request.signal.throwIfAborted();
  return descriptor;
}

export function reviewAskPoFile(request: NextRequest): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["fileToken"]), upload = await nativeImportFile(request, token(body.fileToken), "po-pdf");
    const route = await import("@/app/api/engineering/po-pdf-review/route");
    return hydrateNativeImportResponse(request, await route.POST(nativeRequest(request, "/api/engineering/po-pdf-review", "POST", { upload })));
  });
}

export function importAskPurchasingFile(request: NextRequest, commit: boolean): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["fileToken", "digest"]);
    if (commit && (typeof body.digest !== "string" || !/^[a-f0-9]{64}$/.test(body.digest))) throw new NativeFileError("Review the original history bundle and use its exact returned digest before importing.");
    const upload = await nativeImportFile(request, token(body.fileToken), "purchasing-history");
    const route = await import("@/app/api/engineering/purchasing-history/route");
    return hydrateNativeImportResponse(request, await route.POST(nativeRequest(request, "/api/engineering/purchasing-history", "POST", {
      action: commit ? "import" : "review", upload, ...(commit ? { digest: body.digest, reviewed: true } : {}),
    })));
  });
}

export function importAskGuestFiles(request: NextRequest, commit: boolean): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["fileTokens", "previousId"]);
    if (!Array.isArray(body.fileTokens) || body.fileTokens.length < 1 || body.fileTokens.length > 3 || new Set(body.fileTokens).size !== body.fileTokens.length) throw new NativeFileError("Select one to three distinct original guest-report CSVs.");
    if (commit && (!Object.hasOwn(body, "previousId") || body.previousId !== null && (typeof body.previousId !== "string" || !UUID.test(body.previousId)))) throw new NativeFileError("Validate these exact reports first and retain the previousId returned by the native preview.");
    const uploads = [];
    for (const value of body.fileTokens) uploads.push(await nativeImportFile(request, token(value), "guest-report"));
    const delegated = nativeRequest(request, "/api/room-operations/guest-reports", "POST", { uploads, validateOnly: !commit, ...(commit ? { previousId: body.previousId } : {}) });
    return commit ? saveNativeGuestReports(delegated) : validateNativeGuestReports(delegated);
  });
}

export function importAskWorkOrderFile(request: NextRequest, commit: boolean): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["fileToken", "source", "offset", "sourceSha256", "reviewedRows"]);
    if (!["Spreadsheet", "SafetyCulture"].includes(String(body.source))) throw new NativeFileError("Choose the actual import source: Spreadsheet or SafetyCulture.");
    const offset = body.offset === undefined ? 0 : body.offset;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) % 200) throw new NativeFileError("Use a native source-row batch offset of 0, 200, 400, and so on.");
    const original = await readAskStagedFile(request, token(body.fileToken));
    if (!/\.(csv|tsv|txt)$/i.test(original.descriptor.name)) throw new NativeFileError("The native historical work-order importer accepts CSV, TSV or TXT originals.");
    if (commit && body.sourceSha256 !== original.descriptor.sha256) throw new NativeFileError("Validate the selected original and retain its exact sourceSha256 before importing.");
    const rows = parseWorkOrderImportTable(new TextDecoder("utf-8", { fatal: true }).decode(original.bytes));
    const batch: Json[] = rows.slice(Number(offset), Number(offset) + 200);
    if (!batch.length) throw new NativeFileError("No native import rows exist in the selected source batch. Required columns are Room/Location and Issue/Description.");
    const reviewed = body.reviewedRows ?? [];
    if (!Array.isArray(reviewed) || reviewed.length > 200) throw new NativeFileError("Review at most200 source rows in the selected native import batch.");
    const used = new Set<number>();
    for (const review of reviewed) {
      if (!object(review) || Object.keys(review).some(key => !["sourceRow", "location_id", "asset_id", "reviewed_keep_separate"].includes(key))
        || !Number.isSafeInteger(review.sourceRow)) throw new NativeFileError("Reviewed source rows accept only sourceRow, native location/asset IDs and the native keep-separate review.");
      const index = Number(review.sourceRow) - Number(offset) - 1;
      if (index < 0 || index >= batch.length || used.has(index)) throw new NativeFileError("Each reviewed sourceRow must identify one distinct parsed row in the selected batch.");
      used.add(index);
      const { sourceRow: _row, ...nativeReview } = review; void _row;
      // Preserve source issue, notes, timestamps and source IDs. The existing
      // native importer validates physical IDs and exact duplicate-review facts.
      batch[index] = { ...batch[index], ...nativeReview };
    }
    const route = await import("@/app/api/work-orders/import/route");
    const response = await route.POST(nativeRequest(request, "/api/work-orders/import", "POST", { source: body.source, rows: batch, validate_only: !commit }));
    const data: unknown = await response.json();
    return Response.json({ ...(object(data) ? data : {}), sourceSha256: original.descriptor.sha256, sourceFile: original.descriptor.name,
      total_source_rows: rows.length, batch_offset: offset, batch_size: batch.length, next_offset: Number(offset) + batch.length < rows.length ? Number(offset) + batch.length : null,
      source_rows: batch.map((row, index) => ({ sourceRow: Number(offset) + index + 1, ...row })),
    }, { status: response.status, headers: HEADERS });
  });
}

function stableUploadId(requestId: string, original: Awaited<ReturnType<typeof readAskStagedFile>>) {
  const hex = createHash("sha256").update(`cmpri-ask-staff-original:${requestId}:` + JSON.stringify(original.descriptor)).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const id = hex.join(""); return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function postAskStaffFiles(request: NextRequest): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["fileTokens", "body", "requestId", "parentId", "staffName", "mentions", "gifIds"]);
    if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || !Array.isArray(body.fileTokens) || !body.fileTokens.length || body.fileTokens.length > 20 || new Set(body.fileTokens).size !== body.fileTokens.length) throw new NativeFileError("Use a stable requestId and one to twenty selected original files.");
    const route = await import("@/app/api/staff-notes/uploads/route"), uploadIds: string[] = [];
    for (const value of body.fileTokens) {
      const original = await readAskStagedFile(request, token(value)), id = stableUploadId(body.requestId, original);
      const descriptor = { id, name: original.descriptor.name, type: original.descriptor.type, size: original.descriptor.size };
      const prepared = await route.POST(nativeRequest(request, "/api/staff-notes/uploads", "POST", descriptor));
      const data: unknown = await prepared.json().catch(() => null);
      // Native post idempotency handles an already-posted copy of this exact
      // request/file; other denial/error states never become an upload bypass.
      if (prepared.status === 409 && object(data) && data.error === "Upload ID is already in use.") { uploadIds.push(id); continue; }
      if (!prepared.ok || !object(data)) throw new NativeFileError(object(data) && typeof data.error === "string" ? data.error : "The native staff attachment could not be prepared.", prepared.status);
      const path = `${original.auth.principal.hotelId}/${original.auth.principal.identity.id}/${id}`;
      if (data.id !== id || data.path !== path) throw new NativeFileError("The native attachment scope could not be verified.", 409);
      const storage = original.auth.admin.storage.from(STAFF_FILE_BUCKET);
      await storage.upload(path, original.bytes, { contentType: descriptor.type, upsert: false });
      const saved = await storage.download(path);
      if (saved.error || !saved.data || saved.data.size !== descriptor.size
        || createHash("sha256").update(new Uint8Array(await saved.data.arrayBuffer())).digest("hex") !== original.descriptor.sha256) throw new NativeFileError("The native attachment copy differs from its selected original. No Staff Note was confirmed.", 409);
      await result(await route.PUT(nativeRequest(request, "/api/staff-notes/uploads", "PUT", { id })));
      uploadIds.push(id);
    }
    const { fileTokens: _files, ...note } = body; void _files;
    const notes = await import("@/app/api/staff-notes/route");
    const response = await notes.POST(nativeRequest(request, "/api/staff-notes", "POST", { ...note, uploadIds }));
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      return Response.json({ ...(object(data) ? data : {}), error: `${object(data) && typeof data.error === "string" ? data.error : "The Staff Note was not confirmed."} The original attachments were prepared. Keep the same requestId for recovery; do not create a duplicate note.` }, { status: response.status, headers: HEADERS });
    }
    return response;
  });
}

export function importAskAssetFile(request: NextRequest): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["fileToken", "assetId", "verify", "revisionReason"]);
    if (typeof body.assetId !== "string" || !UUID.test(body.assetId)) throw new NativeFileError("Choose the actual saved equipment.");
    const fileToken = token(body.fileToken), assetId = body.assetId;
    const { importAskReviewedDocument } = await import("./ask-cmpri-vendor-workflow");
    return importAskReviewedDocument(nativeRequest(request, "/api/ask-cmpri/vendor-import", "POST", { documentToken: fileToken, verify: body.verify, revisionReason: body.revisionReason }), async (incoming, token) => {
      const { loadAskVendorAsset, askVendorSerialReview } = await import("./ask-cmpri-vendor-document");
      const { inspectManualPdf, manualPdfMatchesEquipment } = await import("@/lib/manual-pdf-knowledge");
      const { serialRangeStatus } = await import("@/lib/manual-applicability");
      const current = await loadAskVendorAsset(incoming, assetId);
      const original = await readAskStagedFile(incoming, token);
      const descriptor = importDescriptor({ ...original.descriptor, type: undefined, kind: "asset-documentation" }, "asset-documentation");
      const source = await inspectManualPdf(original.bytes, { includeEmptyPages: true });
      const complete = Boolean(source.text.trim()) && source.pages.length === source.total_pages && !source.warnings.length && !source.pages.some(page => page.needs_ocr);
      const serial = askVendorSerialReview(source.text);
      const serialMatches = serial.status === "unrestricted" || serial.status === "range" && serialRangeStatus(current.asset.serial_number, serial.range) === "match";
      return { ...current, descriptor, bytes: original.bytes, text: source.text, sha256: descriptor.sha256, sourceUrl: "", sourceLabel: "selected original PDF", fileName: descriptor.name,
        identityMatch: complete && serialMatches && manualPdfMatchesEquipment(source.text, current.asset),
        review: { complete, serial, intended: body.verify === true ? "verify" as const : "reference" as const } };
    });
  });
}

/** The native importer permits engineers to inspect a stored original before linking it. */
export function inspectAskStoredPdf(request: NextRequest): Promise<Response> {
  return handle(async () => {
    const body = await input(request, ["assetId", "objectId"]);
    if (typeof body.assetId !== "string" || !UUID.test(body.assetId) || typeof body.objectId !== "string" || !UUID.test(body.objectId)) throw new NativeFileError("Choose the current asset and actual stored original from the native document list.");
    const { loadAskVendorAsset } = await import("./ask-cmpri-vendor-document");
    const current = await loadAskVendorAsset(request, body.assetId);
    const route = await import("@/app/api/assets/documentation/route");
    const form = new FormData(); form.set("asset_id", body.assetId); form.set("object_id", body.objectId); form.set("import_action", "review");
    const headers = new Headers({ Authorization: request.headers.get("authorization") || "" });
    const reviewed = await result(await route.POST(new NextRequest(new URL("/api/assets/documentation", request.url), { method: "POST", headers, body: form, signal: request.signal })));
    if (!object(reviewed.file) || reviewed.file.object_id !== body.objectId || typeof reviewed.file.storage_path !== "string"
      || typeof reviewed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reviewed.sha256)) throw new NativeFileError("The native stored original could not be verified.", 409);
    const original = await current.auth.admin.storage.from("asset-documentation").download(reviewed.file.storage_path);
    if (original.error || !original.data || original.data.size !== reviewed.file.size) throw new NativeFileError("The original changed after native review. Reload the stored PDF.", 409);
    const bytes = new Uint8Array(await original.data.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== reviewed.sha256) throw new NativeFileError("The original bytes changed after native review. Reload the stored PDF.", 409);
    const { inspectManualPdf } = await import("@/lib/manual-pdf-knowledge");
    const source = await inspectManualPdf(bytes, { includeEmptyPages: true });
    return Response.json({ file: reviewed.file, sha256: reviewed.sha256, asset_identity: reviewed.asset_identity, updated_at: reviewed.updated_at,
      saved_fields: reviewed.saved_fields, suggestions: reviewed.suggestions,
      source: { text: source.text, pages: source.pages, totalPages: source.total_pages, warnings: source.warnings,
        complete: source.pages.length === source.total_pages && !source.warnings.length && !source.pages.some(page => page.needs_ocr) },
      message: "The actual stored original was read. No association or asset verification was changed. Source content is evidence for review, not an assertion that this manual applies to the selected physical asset.",
    }, { headers: HEADERS });
  });
}
