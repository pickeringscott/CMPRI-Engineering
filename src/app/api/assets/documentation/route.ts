import { extractEquipmentSuggestions, withAssetManufacturer } from "@/lib/equipment-pdf-suggestions";
import * as baseline from "@/lib/server/pre-consolidation/documentation-route";
import { dispatchConsolidation } from "@/lib/server/consolidation-stage";
import { listRegisteredAssetFiles, registerAssetFile } from "@/lib/server/asset-file-register";
import { inspectStoredPdf } from "@/lib/server/stored-pdf-import";
import { prepareDirectPdf } from "@/lib/server/pdf-direct-upload";
import { reviewPdfFields, sameReviewedFields } from "@/lib/stored-pdf-link";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { canEditEquipment, canReadEquipment } from "@/lib/server/roles";
import { prepareUploadedGuide } from "@/lib/manual-source";
import { extractManualPdfText, manualPdfSha256 } from "@/lib/manual-pdf-knowledge";
import { catalogManualMatchesEquipment } from "@/lib/manual-document-catalog";
import { loadVerifiedCatalogManuals } from "@/lib/server/verified-manual-catalog";

const BUCKET = "asset-documentation";
const VERIFY_MARKER = "_cmpri-verification.json";
const MAX_PDF_BYTES = 50 * 1024 * 1024;

function safePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140) || "document.pdf";
}
async function extractPdfText(bytes: Uint8Array) {
  try {
    return await extractManualPdfText(bytes);
  } catch {
    return "";
  }
}

async function ensureBucket(admin: SupabaseClient) {
  const { data: bucket, error: lookupError } = await admin.storage.getBucket(BUCKET);
  if (bucket) return null;
  if (lookupError && !/not found/i.test(lookupError.message)) return lookupError;
  const { error } = await admin.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: MAX_PDF_BYTES,
    allowedMimeTypes: ["application/pdf", "application/json"],
  });
  return error && !/already exists/i.test(error.message) ? error : null;
}

export async function GET(request: NextRequest) {
  const staged = await dispatchConsolidation(request, baseline.GET);
  if (staged) return staged;
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canReadEquipment(auth.principal.profile.role)) {
    return NextResponse.json({ error: "Equipment documentation access is required." }, { status: 403 });
  }
  if (request.nextUrl.searchParams.get("mode") === "stored") {
    if (!canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
    const { data: files, error } = await auth.admin.rpc("cmpri_import_stored_pdfs");
    const { data: row, error: assetError } = await auth.admin.from("assets").select("id,updated_at,pdf_import_links").eq("id", request.nextUrl.searchParams.get("asset_id") || "").eq("hotel_id", HOTEL_ID).maybeSingle();
    if (error || assetError) return NextResponse.json({ error: "The stored-PDF importer database update is unavailable." }, { status: 503 });
    if (!row) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    return NextResponse.json({ files: files || [], links: (row.pdf_import_links || []).filter((l: { storage_path?: string }) => !l.storage_path?.endsWith(VERIFY_MARKER)), updated_at: row.updated_at });
  }
  const assetId = request.nextUrl.searchParams.get("asset_id")?.trim() || "";
  if (!assetId) return NextResponse.json({ error: "asset_id is required." }, { status: 400 });
  const { data: asset, error: assetError } = await auth.admin.from("assets")
    .select("id, manufacturer, model_family, model_number, documentation_verified_at, documentation_revision_id")
    .eq("id", assetId)
    .eq("hotel_id", HOTEL_ID)
    .maybeSingle();
  if (assetError) return NextResponse.json({ error: "Equipment could not be verified." }, { status: 503 });
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  const { data: assetFiles, error: fileError } = await listRegisteredAssetFiles(auth.admin, assetId);
  if (fileError) return NextResponse.json({ error: "Equipment documentation could not be listed." }, { status: 503 });
  const verified = !asset.documentation_revision_id && (Boolean(asset.documentation_verified_at) || assetFiles.some((file) => file.name === VERIFY_MARKER));
  const assetDocuments = await Promise.all(assetFiles.filter((file) => file.name !== VERIFY_MARKER).map(async (file) => {
    const storagePath = file.storage_path;
    const { data: signed } = await auth.admin.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
    return {
      name: file.name,
      id: file.id,
      updated_at: file.updated_at,
      created_at: file.created_at,
      storage_path: storagePath,
      url: signed?.signedUrl || null,
      source: "asset",
      selected_guide: file.preferred,
      verified,
    };
  }));
  let catalogDocuments: Awaited<ReturnType<typeof loadVerifiedCatalogManuals>>["documents"] = [];
  let catalogWarnings: string[] = [];
  try {
    const catalog = await loadVerifiedCatalogManuals(auth.admin, asset);
    catalogDocuments = catalog.documents;
    catalogWarnings = catalog.warnings;
  } catch (catalogError) {
    return NextResponse.json({
      error: catalogError instanceof Error ? catalogError.message : "Manufacturer documentation could not be loaded.",
    }, { status: 503 });
  }
  const signedCatalogDocuments = await Promise.all(catalogDocuments.map(async (document) => {
    const { data: signed, error: signedError } = await auth.admin.storage.from(BUCKET)
      .createSignedUrl(document.storagePath, 60 * 60);
    if (signedError || !signed?.signedUrl) return null;
    return {
      name: document.name,
      document_key: document.documentKey,
      document_type: document.documentType,
      storage_path: document.storagePath,
      url: signed.signedUrl,
      source: "catalog",
      verified: true,
    };
  }));
  if (signedCatalogDocuments.some((document) => document === null)) {
    return NextResponse.json({ error: "A verified manufacturer PDF could not be opened." }, { status: 503 });
  }
  const documents = [...assetDocuments, ...signedCatalogDocuments.filter(d => !assetDocuments.some(a => a.storage_path === d?.storage_path))];
  return NextResponse.json({ documents, verified, catalog_warnings: catalogWarnings });
}

export async function POST(request: NextRequest) {
  const staged = await dispatchConsolidation(request, baseline.POST);
  if (staged) return staged;
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
  if (!canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Only engineers can edit equipment documentation." }, { status: 403 });
  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "A valid multipart form is required." }, { status: 400 }); }

  const importAction = String(form.get("import_action") || "");
  if (importAction) {
    if (!["review", "save", "unlink", "upload", "upload_prepare", "upload_complete"].includes(importAction)) return NextResponse.json({ error: "Unknown importer action." }, { status: 400 });
    const assetId = String(form.get("asset_id") || "");
    const { data: asset, error: assetError } = await auth.admin.from("assets").select("id,manufacturer,updated_at,pdf_import_links,documentation_verified_at,documentation_revision_id").eq("id", assetId).eq("hotel_id", HOTEL_ID).maybeSingle();
    if (assetError) return NextResponse.json({ error: "The stored-PDF importer database update is unavailable." }, { status: 503 });
    if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    try {
      let objectId = String(form.get("object_id") || "");
      if (importAction === "upload_prepare" || importAction === "upload_complete") {
        if (asset.documentation_verified_at) throw new Error("Open an equipment revision before adding a PDF.");
        const direct = await prepareDirectPdf(auth.admin, HOTEL_ID, assetId, form, importAction === "upload_complete");
        if (importAction === "upload_prepare") return NextResponse.json(direct, { headers: { "Cache-Control": "no-store" } });
        objectId = direct.object_id || "";
      }
      if (importAction === "upload") {
        if (asset.documentation_verified_at) throw new Error("Open an equipment revision before adding a PDF.");
        const file = form.get("file");
        if (!(file instanceof File) || file.size < 1 || file.size > MAX_PDF_BYTES) throw new Error("Choose a nonempty PDF of at most 50 MB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("The selected file is not a PDF.");
        const bucketError = await ensureBucket(auth.admin);
        if (bucketError) throw new Error("Documentation storage is unavailable.");
        const path = `${HOTEL_ID}/${assetId}/${crypto.randomUUID()}-${safePart(file.name)}`;
        const { error: uploadError } = await auth.admin.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false, metadata: { original_name: file.name, uploaded_by_user_id: auth.principal.identity.id } });
        if (uploadError) throw new Error("PDF upload failed.");
        const { data: files, error: listError } = await auth.admin.rpc("cmpri_import_stored_pdfs");
        objectId = (files || []).find((f: { storage_path: string }) => f.storage_path === path)?.object_id || "";
        if (listError || !objectId) return NextResponse.json({ error: "Original uploaded, but it could not be opened for review. Reload stored PDFs; do not upload a second copy.", storage_path: path }, { status: 503 });
      }
      const prior = (asset.pdf_import_links || []).find((l: { object_id: string }) => l.object_id === objectId);
      if (importAction === "unlink") {
        if (!prior) throw new Error("The selected link no longer exists.");
        const reason = String(form.get("reason") || "").trim();
        if (reason.length < 5 || reason.length > 2000) throw new Error("Enter a correction reason of 5–2000 characters.");
        const { data, error } = await auth.admin.rpc("cmpri_save_import_pdf_link", { p_asset_id: assetId, p_expected_updated_at: String(form.get("expected_updated_at") || ""), p_actor_id: auth.principal.identity.id, p_link: { object_id: objectId, reason }, p_remove: true });
        if (error) return NextResponse.json({ error: error.message }, { status: 409 });
        return NextResponse.json({ ...data, removed: true, original_preserved: true });
      }
      const expectedHash = importAction === "save" || importAction === "upload_complete" ? String(form.get("sha256") || "") : null;
      if (importAction === "save" && !/^[a-f0-9]{64}$/.test(expectedHash || "")) throw new Error("Open and review the stored PDF before saving its association.");
      const inspected = await inspectStoredPdf(auth.admin, objectId, expectedHash);
      if (importAction !== "save") return NextResponse.json({ file: inspected.file, sha256: inspected.sha256, url: inspected.url, saved_fields: prior || null, suggestions: withAssetManufacturer(extractEquipmentSuggestions(inspected.text), asset.manufacturer), readable_text: Boolean(inspected.text.trim()), updated_at: asset.updated_at });
      if (form.get("review_confirmed") !== "true") throw new Error("Confirm that you reviewed this document and selected its intended asset and model.");
      const fields = reviewPdfFields(JSON.parse(String(form.get("fields") || "null")));
      const link = { ...inspected.file, ...fields, sha256: inspected.sha256, compatibility_basis: fields.applicability === "confirmed_model" ? "user_confirmed" : "general_reference", file_verified: true };
      const { data, error } = await auth.admin.rpc("cmpri_save_import_pdf_link", { p_asset_id: assetId, p_expected_updated_at: String(form.get("expected_updated_at") || ""), p_actor_id: auth.principal.identity.id, p_link: link, p_remove: false });
      if (error) return NextResponse.json({ error: error.message }, { status: 409 });
      // Read back independently: never report a saved association based only on a write acknowledgement.
      const { data: readback, error: readError } = await auth.admin.from("assets").select("pdf_import_links,updated_at").eq("id",assetId).eq("hotel_id",HOTEL_ID).single();
      const saved = readback?.pdf_import_links?.find((l: { object_id: string }) => l.object_id === objectId);
      if (readError || !saved || saved.sha256 !== link.sha256 || saved.storage_path !== link.storage_path || !sameReviewedFields(saved,fields)) return NextResponse.json({ error: "The save returned, but the association could not be verified. Reload before retrying." }, { status: 503 });
      return NextResponse.json({ ...data, saved, url: inspected.url, association_verified: true, compatibility_basis: link.compatibility_basis });
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Stored PDF import failed." }, { status: 422 }); }
  }
  const assetId = String(form.get("asset_id") || "").trim();
  const existingPath = String(form.get("storage_path") || "").trim();
  const documentKey = String(form.get("document_key") || "").trim();
  const file = form.get("file");
  if (!assetId) return NextResponse.json({ error: "Equipment is required." }, { status: 400 });
  if (existingPath && documentKey) return NextResponse.json({ error: "Choose one stored document source." }, { status: 400 });

  const { data: asset, error: assetError } = await auth.admin.from("assets")
    .select("id, manufacturer, model_family, model_number, documentation_verified_at, documentation_revision_id")
    .eq("id", assetId)
    .eq("hotel_id", HOTEL_ID)
    .maybeSingle();
  if (assetError) return NextResponse.json({ error: "Equipment could not be verified." }, { status: 503 });
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  if (!existingPath && !documentKey && asset.documentation_verified_at && !asset.documentation_revision_id) {
    return NextResponse.json({ error: "Open a documented revision before adding files to verified equipment." }, { status: 409 });
  }

  const bucketError = await ensureBucket(auth.admin);
  if (bucketError) return NextResponse.json({ error: `Unable to prepare documentation storage: ${bucketError.message}` }, { status: 500 });

  let storagePath: string;
  let originalName: string;
  let uploaded = false;
  let text = "";
  let sourceHash = "";
  let sourceBytes: Uint8Array | undefined;

  if (documentKey) {
    const { data: catalogManual, error: catalogError } = await auth.admin.from("maintenance_documents")
      .select("document_key,title,document_type,manufacturer,equipment,model_pattern,storage_path,source_file_name,active,ingestion_status")
      .eq("hotel_id", HOTEL_ID)
      .eq("document_key", documentKey)
      .eq("active", true)
      .eq("ingestion_status", "complete")
      .maybeSingle();
    if (catalogError) return NextResponse.json({ error: "Manufacturer documentation could not be verified." }, { status: 503 });
    if (!catalogManual || !catalogManualMatchesEquipment(asset, catalogManual)) {
      return NextResponse.json({ error: "This manual is not an exact manufacturer and model-family match for the selected equipment." }, { status: 409 });
    }
    let catalog: Awaited<ReturnType<typeof loadVerifiedCatalogManuals>>;
    try {
      catalog = await loadVerifiedCatalogManuals(auth.admin, asset);
    } catch (catalogError) {
      return NextResponse.json({
        error: catalogError instanceof Error ? catalogError.message : "Manufacturer documentation could not be verified.",
      }, { status: 503 });
    }
    const matchedDocument = catalog.documents.find((document) => document.documentKey === documentKey);
    if (!matchedDocument) {
      return NextResponse.json({ error: catalog.warnings[0] || "The selected manual PDF could not be verified against this equipment." }, { status: 409 });
    }
    storagePath = matchedDocument.storagePath;
    originalName = matchedDocument.name;
    text = matchedDocument.text;
    sourceHash = matchedDocument.sha256;
  } else if (existingPath) {
    const { data: registered, error: registeredError } = await listRegisteredAssetFiles(auth.admin, assetId);
    if (registeredError || !registered.some(f => f.storage_path === existingPath) || existingPath.endsWith(VERIFY_MARKER)) {
      return NextResponse.json({ error: "Invalid stored document path." }, { status: 400 });
    }
    const { data: stored, error: downloadError } = await auth.admin.storage.from(BUCKET).download(existingPath);
    if (downloadError || !stored) return NextResponse.json({ error: "Stored PDF could not be read." }, { status: 400 });
    const bytes = new Uint8Array(await stored.arrayBuffer());
    sourceBytes = bytes;
    if (!bytes.byteLength) return NextResponse.json({ error: "The saved PDF is empty. Upload the original PDF again after opening a revision if the record is verified. The existing file is preserved." }, { status: 422 });
    sourceHash = manualPdfSha256(bytes);
    text = await extractPdfText(bytes);
    storagePath = existingPath;
    originalName = existingPath.split("/").pop()?.replace(/^\d+-/, "") || "documentation.pdf";
  } else {
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a PDF to upload." }, { status: 400 });
    if (file.size < 1 || file.size > MAX_PDF_BYTES) return NextResponse.json({ error: "PDF size must be between 1 byte and 50 MB." }, { status: 400 });
    if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Documentation must be a PDF." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    sourceBytes = bytes;
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return NextResponse.json({ error: "The selected file is not a PDF." }, { status: 400 });
    const originalSize = bytes.byteLength;
    sourceHash = manualPdfSha256(bytes);
    text = await extractPdfText(bytes);
    if (!bytes.byteLength || bytes.byteLength !== originalSize) return NextResponse.json({ error: "PDF bytes changed during processing. Nothing was uploaded." }, { status: 500 });
    originalName = file.name;
    storagePath = `${HOTEL_ID}/${assetId}/${Date.now()}-${safePart(file.name)}`;
    const { error: uploadError } = await auth.admin.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: "application/pdf",
      upsert: false,
      metadata: {
        asset_id: assetId,
        original_name: file.name,
        cmpri_type: "equipment_documentation",
        uploaded_by_user_id: auth.principal.identity.id,
        uploaded_by_name: auth.principal.profile.full_name || auth.principal.identity.email || "Unknown User",
      },
    });
    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 400 });
    uploaded = true;
  }

  if (!documentKey) {
    const { error: linkError } = await registerAssetFile(auth.admin, assetId, storagePath);
    if (linkError) return NextResponse.json({ error: "Original preserved, but its association could not be saved.", storage_path: storagePath }, { status: 503 });
  }
  let ocrQueued = false;
  if (!documentKey && !text.trim() && sourceBytes) {
    try {
      const { enqueueManualOcr } = await import("@/lib/server/manual-ocr-queue");
      await enqueueManualOcr(auth.admin, { hotelId: HOTEL_ID, assetId, path: storagePath, sha256: sourceHash, bytes: sourceBytes }, true);
      ocrQueued = true;
    } catch {
      return NextResponse.json({ error: "The PDF was saved, but text recognition could not be queued. Retry processing this stored file.", storage_path: storagePath }, { status: 503 });
    }
  }
  const guide = prepareUploadedGuide(text, asset, originalName, sourceHash);
  // Content-addressed key makes retries idempotent, leaving earlier document revisions intact.
  const guideKey = documentKey || `upload-${assetId}-${sourceHash}`;
  if (!documentKey) {
    const { error: knowledgeError } = await auth.admin.from("troubleshooting_cache").upsert({
      hotel_id: HOTEL_ID, cache_type: "asset_manual_knowledge", cache_key: guideKey,
      payload: guide.knowledge, expires_at: null,
    }, { onConflict: "hotel_id,cache_type,cache_key" });
    if (knowledgeError) return NextResponse.json({ error: "PDF preserved, but its guide could not be saved. Retry processing this stored file.", storage_path: storagePath, processing_status: "failed" }, { status: 503 });
  }
  const { error: guideError } = documentKey ? { error: null } : await auth.admin.rpc("cmpri_upsert_asset_catalog", { p_asset_id: assetId, p_record: {
    hotel_id: HOTEL_ID, document_key: guideKey, title: originalName,
    document_type: "Uploaded equipment document", manufacturer: asset.manufacturer,
    equipment: asset.model_family || asset.model_number, model_pattern: asset.model_number || asset.model_family,
    storage_path: storagePath, source_file_name: originalName, active: true,
    ingestion_status: guide.state === "ready" || guide.state === "pending_guidance" ? "complete" : "pending",
    ingestion_error: guide.state === "ready" ? null : guide.message,
    troubleshooting_cache_key: guideKey,
  } });
  if (guideError) return NextResponse.json({ error: "PDF preserved, but its guide record could not be saved. Retry processing this stored file.", storage_path: storagePath, processing_status: "failed" }, { status: 503 });
  const suggestions = text ? extractEquipmentSuggestions(text) : null;
  const { data: signed } = await auth.admin.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  return NextResponse.json({
    document: {
      asset_id: assetId,
      original_name: originalName,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      document_key: guideKey,
      url: signed?.signedUrl || null,
    },
    uploaded,
    suggestions,
    processing_status: ocrQueued ? "pending_guidance" : guide.state,
    processing_message: ocrQueued ? "Text recognition is processing the attached PDF." : guide.message,
  });
}
