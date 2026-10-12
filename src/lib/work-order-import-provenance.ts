/** Existing, importer-verified Mitti batch; other spreadsheet batches are unrelated. */
const MITTI_BATCH_ID = /^CMPRI-final-20260915-IMP-\d{4}\|CUR-\d{3}(?:-[AB])?(?:\|[^|\r\n]+)?$/;

export type WorkOrderImportProvenance = {
  import_source?: string | null;
  import_external_id?: string | null;
};

export function workOrderImportLabel(order: WorkOrderImportProvenance): string | null {
  if (order.import_source === "Spreadsheet"
    && typeof order.import_external_id === "string"
    && MITTI_BATCH_ID.test(order.import_external_id)) {
    return "Imported from Mitti";
  }
  return null;
}
