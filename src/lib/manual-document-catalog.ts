import { manualTextContainsExactIdentity } from "@/lib/manual-document-match";

export type ManualEquipmentIdentity = {
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
};

export type CatalogManual = {
  title: string;
  document_type: string | null;
  manufacturer: string | null;
  equipment: string | null;
  model_pattern: string | null;
  active: boolean;
  ingestion_status: string;
};

function normalized(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") : "";
}

function catalogFamilyMatchesEquipment(equipment: ManualEquipmentIdentity, manual: CatalogManual) {
  const assetFamily = normalized(equipment.model_family);
  const assetModel = normalized(equipment.model_number);
  const modelPattern = normalized(manual.model_pattern);
  const catalogEquipment = normalized(manual.equipment);

  if (modelPattern && (assetFamily === modelPattern || assetModel === modelPattern || assetModel.startsWith(modelPattern))) {
    return true;
  }
  return Boolean(assetFamily && catalogEquipment && assetFamily === catalogEquipment);
}

export function catalogManualModelFamily(equipment: ManualEquipmentIdentity, manual: CatalogManual) {
  if (manual.model_pattern?.trim()) return manual.model_pattern.trim().replace(/\s+/g, " ");
  // The reviewed Symmons parts diagram prints "Temptrol® Genuine Replacement
  // Parts". "Shower Valve" is the catalog's equipment description, not part of
  // the manufacturer's family name. Keep this alias manufacturer-specific;
  // do not weaken the exact asset-to-catalog or PDF identity checks generally.
  if (normalized(manual.manufacturer) === "symmons" &&
      normalized(manual.equipment) === "temptrol shower valve" &&
      normalized(equipment.model_family) === "temptrol shower valve") return "Temptrol";
  return normalized(equipment.model_family) && normalized(equipment.model_family) === normalized(manual.equipment)
    ? equipment.model_family?.trim().replace(/\s+/g, " ") || null
    : null;
}

export function catalogManualMatchesEquipment(equipment: ManualEquipmentIdentity, manual: CatalogManual) {
  const manufacturerMatches = normalized(equipment.manufacturer) !== "" &&
    normalized(equipment.manufacturer) === normalized(manual.manufacturer);
  return Boolean(
    manual.active === true &&
    manual.ingestion_status === "complete" &&
    manufacturerMatches &&
    catalogFamilyMatchesEquipment(equipment, manual),
  );
}

export function catalogManualPdfMatchesEquipment(
  text: string,
  equipment: ManualEquipmentIdentity,
  manual: CatalogManual,
) {
  if (!catalogManualMatchesEquipment(equipment, manual)) return false;
  return manualTextContainsExactIdentity(text, catalogManualModelFamily(equipment, manual)) ||
    manualTextContainsExactIdentity(text, equipment.model_number);
}
