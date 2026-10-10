import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { canEditEquipment, canReadEquipment } from "@/lib/server/roles";
import { extractManualPdfText } from "@/lib/manual-pdf-knowledge";
import { catalogManualMatchesEquipment } from "@/lib/manual-document-catalog";
import { loadVerifiedCatalogManuals } from "@/lib/server/verified-manual-catalog";

const BUCKET = "asset-documentation";
const VERIFY_MARKER = "_cmpri-verification.json";
const MAX_PDF_BYTES = 50 * 1024 * 1024;

type Suggestions = {
  asset_type?: string;
  manufacturer?: string;
  model_family?: string;
  model_number?: string;
  model_candidates?: string[];
  serial_number?: string;
  generation?: string;
  install_year?: number;
};

function safePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140) || "document.pdf";
}

function cleanPhrase(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,#=-]+|[\s:;,=-]+$/g, "")
    .trim();
}

function firstCapture(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = cleanPhrase(String(match?.[1] || ""));
    if (value) return value;
  }
  return "";
}

/**
 * Extract only explicitly labelled equipment identifiers from readable PDF
 * text. This is deliberately conservative: it does not guess a model,
 * manufacturer or serial number from arbitrary numbers in a manual.
 */
function extractEquipmentSuggestions(text: string): Suggestions | null {
  const flattened = text.replace(/\bPAGE\s+\d+\b/gi, " ").replace(/\s+/g, " ").trim();
  if (!flattened) return null;

  const model = firstCapture(flattened, [
    /\bmodel(?:\s+(?:number|no\.?))?\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{2,60})/i,
    /\bmodel\s+id\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{2,60})/i,
  ]);
  const serial = firstCapture(flattened, [
    /\bserial(?:\s+(?:number|no\.?))?\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{2,80})/i,
    /\bs\/n\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{2,80})/i,
  ]);
  const manufacturer = firstCapture(flattened, [
    /\bmanufacturer(?:\s+name)?\s*[:#=-]?\s*([A-Za-z][A-Za-z0-9&.'()\/ -]{1,80}?)(?=\s+(?:model|serial|s\/n|generation|gen|install(?:ed|ation)|voltage|power|equipment|product|unit)\b|[.;]|$)/i,
    /\bmanufactured\s+by\s*[:#=-]?\s*([A-Za-z][A-Za-z0-9&.'()\/ -]{1,80}?)(?=\s+(?:model|serial|s\/n|generation|gen|install(?:ed|ation)|voltage|power|equipment|product|unit)\b|[.;]|$)/i,
  ]);
  const modelFamily = firstCapture(flattened, [
    /\b(?:model|equipment)\s+family\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9&.'()\/ -]{1,100}?)(?=\s+(?:model|serial|s\/n|manufacturer|generation|gen|install(?:ed|ation)|voltage|power|equipment|product|unit)\b|[.;]|$)/i,
  ]);
  const generation = firstCapture(flattened, [
    /\bgeneration\s*[:#=-]?\s*([A-Za-z0-9][A-Za-z0-9._\/-]{0,30})/i,
    /\bgen(?:eration)?\.?\s*[:#=-]?\s*(\d+[A-Za-z]?)/i,
  ]);
  const assetType = firstCapture(flattened, [
    /\b(?:equipment|product|unit)\s+type\s*[:#=-]?\s*([A-Za-z][A-Za-z0-9&.'()\/ -]{1,80}?)(?=\s+(?:model|serial|manufacturer|generation|gen|install(?:ed|ation)|voltage|power)\b|[.;]|$)/i,
  ]);
  const installYearText = firstCapture(flattened, [
    /\b(?:installation\s+year|year\s+installed|installed\s+in)\s*[:#=-]?\s*((?:19|20)\d{2})\b/i,
  ]);

  const result: Suggestions = {};
  const modelListMatch = flattened.match(/\b(?:applicable\s+)?models?\s*[:#=-]\s*([A-Za-z0-9][A-Za-z0-9._/-]*(?:\s*[,;]\s*[A-Za-z0-9][A-Za-z0-9._/-]*){1,20})/i);
  const modelCandidates = modelListMatch?.[1]
    .split(/[,;]/)
    .map((value) => cleanPhrase(value))
    .filter(Boolean) || [];
  if (assetType) result.asset_type = assetType;
  if (manufacturer) result.manufacturer = manufacturer;
  if (modelFamily) result.model_family = modelFamily;
  if (model) result.model_number = model;
  if (modelCandidates.length > 1) result.model_candidates = Array.from(new Set(modelCandidates));
  if (serial) result.serial_number = serial;
  if (generation) result.generation = generation;
  if (installYearText) result.install_year = Number(installYearText);
  return Object.keys(result).length ? result : null;
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
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canReadEquipment(auth.principal.profile.role)) {
    return NextResponse.json({ error: "Equipment documentation access is required." }, { status: 403 });
  }
  const assetId = request.nextUrl.searchParams.get("asset_id")?.trim() || "";
  if (!assetId) return NextResponse.json({ error: "asset_id is required." }, { status: 400 });
  const { data: asset, error: assetError } = await auth.admin.from("assets")
    .select("id, manufacturer, model_family, model_number")
    .eq("id", assetId)
    .maybeSingle();
  if (assetError) return NextResponse.json({ error: "Equipment could not be verified." }, { status: 503 });
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  const prefix = `${HOTEL_ID}/${assetId}`;
  const assetFiles: Array<{ name: string; id?: string | null; updated_at?: string | null; created_at?: string | null }> = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await auth.admin.storage.from(BUCKET).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: "created_at", order: "desc" },
    });
    if (error) {
      if (/not found|bucket/i.test(error.message)) break;
      return NextResponse.json({ error: "Equipment documentation could not be listed." }, { status: 503 });
    }
    assetFiles.push(...(data || []));
    if ((data || []).length < 100) break;
  }
  const verified = assetFiles.some((file) => file.name === VERIFY_MARKER);
  const assetDocuments = await Promise.all(assetFiles.filter((file) => file.name !== VERIFY_MARKER).map(async (file) => {
    const storagePath = `${prefix}/${file.name}`;
    const { data: signed } = await auth.admin.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
    return {
      name: file.name,
      id: file.id,
      updated_at: file.updated_at,
      created_at: file.created_at,
      storage_path: storagePath,
      url: signed?.signedUrl || null,
      source: "asset",
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
  const documents = [...assetDocuments, ...signedCatalogDocuments];
  return NextResponse.json({ documents, verified, catalog_warnings: catalogWarnings });
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
  if (!canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Only engineers can edit equipment documentation." }, { status: 403 });
  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "A valid multipart form is required." }, { status: 400 }); }

  const assetId = String(form.get("asset_id") || "").trim();
  const existingPath = String(form.get("storage_path") || "").trim();
  const documentKey = String(form.get("document_key") || "").trim();
  const file = form.get("file");
  if (!assetId) return NextResponse.json({ error: "Equipment is required." }, { status: 400 });
  if (existingPath && documentKey) return NextResponse.json({ error: "Choose one stored document source." }, { status: 400 });

  const { data: asset, error: assetError } = await auth.admin.from("assets")
    .select("id, manufacturer, model_family, model_number")
    .eq("id", assetId)
    .maybeSingle();
  if (assetError) return NextResponse.json({ error: "Equipment could not be verified." }, { status: 503 });
  if (!asset) return NextResponse.json({ error: "Asset not found." }, { status: 404 });

  const bucketError = await ensureBucket(auth.admin);
  if (bucketError) return NextResponse.json({ error: `Unable to prepare documentation storage: ${bucketError.message}` }, { status: 500 });

  let storagePath: string;
  let originalName: string;
  let uploaded = false;
  let text = "";

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
  } else if (existingPath) {
    const requiredPrefix = `${HOTEL_ID}/${assetId}/`;
    if (!existingPath.startsWith(requiredPrefix) || existingPath.endsWith(VERIFY_MARKER)) {
      return NextResponse.json({ error: "Invalid stored document path." }, { status: 400 });
    }
    const { data: stored, error: downloadError } = await auth.admin.storage.from(BUCKET).download(existingPath);
    if (downloadError || !stored) return NextResponse.json({ error: "Stored PDF could not be read." }, { status: 400 });
    const bytes = new Uint8Array(await stored.arrayBuffer());
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
    text = await extractPdfText(bytes);
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

  const suggestions = text ? extractEquipmentSuggestions(text) : null;
  const { data: signed } = await auth.admin.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  return NextResponse.json({
    document: {
      asset_id: assetId,
      original_name: originalName,
      storage_bucket: BUCKET,
      storage_path: storagePath,
      document_key: documentKey || null,
      url: signed?.signedUrl || null,
    },
    uploaded,
    suggestions,
    processing_status: text ? "processed" : "failed",
    processing_message: text
      ? suggestions
        ? "PDF text read locally and labelled equipment information was extracted for review."
        : "PDF text read locally, but no labelled equipment identifiers were found. Review the document and enter any missing equipment details manually."
      : "PDF stored, but readable text could not be extracted. Review the PDF and enter equipment details manually.",
  });
}
