import { withStoredPdfStatus } from "./stored-pdf-status";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractManualPdfText, manualPdfSha256 } from "@/lib/manual-pdf-knowledge";
import { validateStoredPdf, type StoredPdf } from "@/lib/stored-pdf-link";

export async function inspectStoredPdf(admin: SupabaseClient, objectId: string, expectedHash: string | null = null) {
  const { data: available, error: listError } = await admin.rpc("cmpri_import_stored_pdfs");
  if (listError) throw new Error("Stored PDF selection is unavailable. The importer database update may not be installed.");
  const selected = (available as StoredPdf[] || []).find(item => item.object_id === objectId);
  const file = selected ? (await withStoredPdfStatus(admin, [selected]))[0] : undefined;
  if (!file) throw new Error("The selected PDF is missing or is outside CMPRI equipment documentation.");
  const { data, error } = await admin.storage.from("asset-documentation").download(file.storage_path);
  if (error || !data) throw new Error("The selected original PDF could not be opened. No association was saved.");
  const bytes = new Uint8Array(await data.arrayBuffer());
  const sha256 = manualPdfSha256(bytes);
  validateStoredPdf(bytes, file, expectedHash, sha256);
  let text: string;
  try { text = await extractManualPdfText(bytes, {previewPages:3}); }
  catch { throw new Error("The stored PDF could not be read by the existing importer. No association was saved."); }
  const { data: signed, error: signError } = await admin.storage.from("asset-documentation").createSignedUrl(file.storage_path, 900);
  if (signError || !signed?.signedUrl) throw new Error("The selected PDF could not be opened for review. No association was saved.");
  return { file, sha256, text, url: signed.signedUrl };
}
