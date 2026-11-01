/** Existing, importer-verified Mitti batch; other spreadsheet batches are unrelated. */
const MITTI_BATCH_ID = /^CMPRI-final-20260915-IMP-\d{4}\|CUR-\d{3}(?:-[AB])?(?:\|[^|\r\n]+)?$/;

export type WorkOrderImportProvenance = {
  import_source?: string | null;
  import_external_id?: string | null;
};

export function workOrderImportLabel(order: WorkOrderImportProvenance): string | null {
  // Reserved for explicit provenance written by the PM creation flow.
  // Never infer PM origin from an issue title or maintenance notes.
  if (order.import_source === "PM Log") return "PM Log";
  if (order.import_source === "Spreadsheet"
    && typeof order.import_external_id === "string"
    && MITTI_BATCH_ID.test(order.import_external_id)) {
    return "Imported from Mitti";
  }
  return null;
}

export function workOrderSourceTitle(order: WorkOrderImportProvenance): string | undefined {
  const label = workOrderImportLabel(order);
  if (label === "PM Log") return "Created from the PM log";
  if (label === "Imported from Mitti") return "Imported from SafetyCulture / Mitti via the approved September 15, 2026 workbook";
  return undefined;
}
