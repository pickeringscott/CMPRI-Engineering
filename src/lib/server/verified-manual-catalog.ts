import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { extractManualPdfText, manualPdfSha256, type ManualEquipmentIdentity } from "@/lib/manual-pdf-knowledge";
import { catalogManualMatchesEquipment, catalogManualModelFamily, catalogManualPdfMatchesEquipment, type CatalogManual } from "@/lib/manual-document-catalog";

const BUCKET = "asset-documentation";
const CATALOG_FOLDER = "Asset Docs";

type CatalogRow = CatalogManual & {
  document_key: string;
  storage_path: string;
  source_file_name: string | null;
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
};

export async function loadVerifiedCatalogManuals(
  admin: SupabaseClient,
  equipment: ManualEquipmentIdentity,
): Promise<{ documents: VerifiedCatalogPdf[]; warnings: string[] }> {
  if (!equipment.manufacturer || (!equipment.model_family && !equipment.model_number)) {
    return { documents: [], warnings: [] };
  }

  const { data: rows, error: catalogError } = await admin
    .from("maintenance_documents")
    .select("document_key,title,document_type,manufacturer,equipment,model_pattern,storage_path,source_file_name,active,ingestion_status")
    .eq("hotel_id", HOTEL_ID)
    .eq("active", true)
    .eq("ingestion_status", "complete")
    .order("title", { ascending: true })
    .limit(250);
  if (catalogError) throw new Error("The verified manufacturer manual catalog could not be loaded.");

  const candidates = ((rows || []) as CatalogRow[]).filter((manual) =>
    catalogManualMatchesEquipment(equipment, manual),
  );
  if (!candidates.length) return { documents: [], warnings: [] };

  const { data: files, error: listError } = await admin.storage.from(BUCKET).list(CATALOG_FOLDER, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (listError) throw new Error("The shared manufacturer-document folder could not be listed.");

  const fileNames = new Set((files || []).map((file) => file.name));
  const documents: VerifiedCatalogPdf[] = [];
  const warnings: string[] = [];
  for (const manual of candidates) {
    const name = manual.source_file_name || manual.storage_path.split("/").pop() || "";
    if (!name || !fileNames.has(name) || !name.toLowerCase().endsWith(".pdf")) {
      warnings.push(`${manual.title}: the catalog PDF is missing from shared storage.`);
      continue;
    }

    const storagePath = `${CATALOG_FOLDER}/${name}`;
    const { data: stored, error: downloadError } = await admin.storage.from(BUCKET).download(storagePath);
    if (downloadError || !stored) throw new Error(`${manual.title} could not be read from shared storage.`);

    const bytes = new Uint8Array(await stored.arrayBuffer());
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
    });
  }

  return { documents, warnings };
}
