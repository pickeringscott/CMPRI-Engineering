// Exact baseline compatibility path; retired by the atomic schema marker.
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { extractManualPdfText, manualPdfSha256, type ManualEquipmentIdentity } from "@/lib/manual-pdf-knowledge";
import { catalogManualMatchesEquipment, catalogManualModelFamily, catalogManualPdfMatchesEquipment, type CatalogManual } from "@/lib/manual-document-catalog";

const BUCKET = "asset-documentation";


type CatalogRow = CatalogManual & {
  document_key: string;
  storage_path: string;
  source_file_name: string | null;
  troubleshooting_cache_key: string | null;
  ingestion_error?: string | null;
};

export type VerifiedCatalogPdf = {
  documentKey: string;
  name: string;
  documentType: string | null;
  manufacturer: string;
  modelFamily: string | null;
  storagePath: string;
  text: string;
  sha256: string;
  knowledgeKey: string | null;
  knowledge: Record<string, unknown> | null;
};

export async function loadVerifiedCatalogManuals(
  admin: SupabaseClient,
  equipment: ManualEquipmentIdentity,
): Promise<{ documents: VerifiedCatalogPdf[]; warnings: string[] }> {
  const rows: CatalogRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await admin.from("maintenance_documents")
      .select("document_key,title,document_type,manufacturer,equipment,model_pattern,storage_path,source_file_name,active,ingestion_status,troubleshooting_cache_key,ingestion_error")
      .eq("hotel_id", HOTEL_ID).eq("active", true).order("document_key", { ascending: true }).range(offset, offset + 99);
    if (error) throw new Error("The verified manufacturer manual catalog could not be loaded.");
    rows.push(...(data || []) as CatalogRow[]);
    if (!data || data.length < 100) break;
  }

  const warnings = ((rows || []) as CatalogRow[]).filter(manual => equipment.id && manual.document_key.startsWith(`upload-${equipment.id}-`) && manual.ingestion_status !== "complete").map(manual => `${manual.title}: ${manual.ingestion_error || "Document processing is pending."}`);
  const candidates = ((rows || []) as CatalogRow[]).filter((manual) =>
    catalogManualMatchesEquipment(equipment, manual),
  );
  if (!candidates.length) return { documents: [], warnings };

  const documents: VerifiedCatalogPdf[] = [];
  for (const manual of candidates) {
    const name = manual.source_file_name || (manual.storage_path || "").split("/").pop() || "";
    if (!name || !manual.storage_path || !name.toLowerCase().endsWith(".pdf")) {
      warnings.push(`${manual.title}: the catalog PDF is missing from shared storage.`);
      continue;
    }

    const storagePath = manual.storage_path;
    if (storagePath.startsWith("/") || storagePath.split("/").some(part => part === "..") ||
        !(/^asset docs\//i.test(storagePath) || storagePath.startsWith(`${HOTEL_ID}/`))) {
      warnings.push(`${manual.title}: invalid CMPRI document path.`);
      continue;
    }
    const { data: stored, error: downloadError } = await admin.storage.from(BUCKET).download(storagePath);
    if (downloadError || !stored) {
      warnings.push(`${manual.title}: saved PDF could not be read.`);
      continue;
    }

    const bytes = new Uint8Array(await stored.arrayBuffer());
    const sha256 = manualPdfSha256(bytes);
    let knowledge: Record<string, unknown> | null = null;
    if (manual.troubleshooting_cache_key) {
      const { data: cached, error } = await admin.from("troubleshooting_cache").select("payload")
        .eq("hotel_id", HOTEL_ID).eq("cache_type", "asset_manual_knowledge")
        .eq("cache_key", manual.troubleshooting_cache_key).maybeSingle();
      if (error) throw new Error("Saved manual guidance could not be loaded.");
      knowledge = cached?.payload || null;
      const source = knowledge?.source as { sha256?: string } | undefined;
      if (source?.sha256 && source.sha256 !== sha256) {
        warnings.push(`${manual.title}: PDF changed since guidance was prepared; reprocess this document.`);
        continue;
      }
    }
    let text: string;
    try {
      text = await extractManualPdfText(bytes);
    } catch {
      warnings.push(`${manual.title}: the catalog PDF could not be read.`);
      continue;
    }
    if (!text || !catalogManualPdfMatchesEquipment(text, equipment, manual)) {
      warnings.push(`${manual.title}: the PDF content did not verify the exact cataloged model family.`);
      continue;
    }

    documents.push({
      documentKey: manual.document_key,
      name,
      documentType: manual.document_type,
      manufacturer: manual.manufacturer || "",
      modelFamily: catalogManualModelFamily(equipment, manual),
      storagePath,
      text,
      sha256: manualPdfSha256(bytes),
      knowledgeKey: manual.troubleshooting_cache_key || null,
      knowledge,
    });
  }

  return { documents, warnings };
}
