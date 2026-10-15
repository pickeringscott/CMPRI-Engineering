import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { extractManualPdfText, manualPdfSha256, type ManualEquipmentIdentity } from "@/lib/manual-pdf-knowledge";
import { catalogManualMatchesEquipment, catalogManualModelFamily, catalogManualPdfMatchesEquipment, type CatalogManual } from "@/lib/manual-document-catalog";

const BUCKET = "asset-documentation";


type CatalogRow = CatalogManual & {
  id?: string;
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
  selectedModel?: string;
};

export async function loadVerifiedCatalogManuals(
  admin: SupabaseClient,
  equipment: ManualEquipmentIdentity,
): Promise<{ documents: VerifiedCatalogPdf[]; warnings: string[] }> {
  if (!equipment.id) return { documents: [], warnings: [] };
  const { data: asset, error: linkError } = await admin.from("assets").select("pdf_import_links").eq("hotel_id", HOTEL_ID).eq("id", equipment.id).maybeSingle();
  if (linkError || !asset) throw new Error("Asset PDF associations could not be loaded.");
  type Link = { object_id?: string; document_id?: string; document_key?: string; storage_path?: string; title?: string; manufacturer?: string; selected_model?: string; applicability?: string; preferred?: boolean; sha256?: string; legacy_sources?: string[]; };
  const links = (asset.pdf_import_links || []) as Link[];
  const preferred = links.find(l => l.preferred);
  const selected = preferred ? [preferred] : links;
  const ids = selected.map(l => l.document_id).filter((id): id is string => Boolean(id));
  const { data: storedRows, error: catalogError } = ids.length ? await admin.from("maintenance_documents").select("*").eq("hotel_id", HOTEL_ID).in("id", ids).eq("active", true) : { data: [], error: null };
  if (catalogError) throw new Error("Saved document metadata could not be loaded.");
  const rows = (storedRows || []) as CatalogRow[];
  const overrides = new Map<string, Link>();
  const candidates: CatalogRow[] = [];
  const warnings: string[] = [];
  for (const link of selected) {
    const original = rows.find(d => d.id === link.document_id);
    const manualChoice = link.applicability === "confirmed_model" && Boolean(link.selected_model);
    if (manualChoice && link.storage_path) {
      const row = { ...original, document_key: link.document_key || `manual-${link.object_id}`, title: link.title || original?.title || "Selected PDF", storage_path: link.storage_path, source_file_name: link.storage_path.split("/").pop() || null, manufacturer: link.manufacturer || original?.manufacturer || "", document_type: original?.document_type || "User-reviewed PDF", equipment: link.selected_model || "", model_pattern: link.selected_model || "", active: true, ingestion_status: original?.ingestion_status || "complete", troubleshooting_cache_key: original?.troubleshooting_cache_key || null } as CatalogRow;
      overrides.set(row.document_key, link); candidates.push(row);
    } else if (!link.sha256 && original && link.legacy_sources?.includes("legacy_candidate") && catalogManualMatchesEquipment(equipment, original)) {
      candidates.push(original);
    } else if (preferred) warnings.push("The selected guide is a general reference; exact model applicability has not been confirmed.");
  }
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
    const override = overrides.get(manual.document_key);
    if (override?.sha256 && override.sha256 !== sha256) { warnings.push(`${manual.title}: original changed since manual review.`); continue; }
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
    if (!override && (!text || !catalogManualPdfMatchesEquipment(text, equipment, manual))) {
      warnings.push(`${manual.title}: the PDF content did not verify the exact cataloged model family.`);
      continue;
    }

    documents.push({
      documentKey: manual.document_key,
      name,
      documentType: manual.document_type,
      manufacturer: manual.manufacturer || "",
      modelFamily: override?.selected_model || catalogManualModelFamily(equipment, manual),
      storagePath,
      text,
      sha256: manualPdfSha256(bytes),
      knowledgeKey: manual.troubleshooting_cache_key || null,
      knowledge,
      selectedModel: override?.selected_model,
    });
  }

  return { documents, warnings };
}
