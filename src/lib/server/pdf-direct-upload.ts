import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredPdf } from "@/lib/stored-pdf-link";
import { MAX_PDF_UPLOAD_BYTES } from "@/lib/pdf-direct-upload";

const BUCKET = "asset-documentation";

/** Called only after the existing capability, role, hotel and asset-lock checks. */
export async function prepareDirectPdf(admin: SupabaseClient, hotelId: string, assetId: string, form: FormData, complete: boolean) {
  const hash = String(form.get("sha256") || "");
  const size = Number(form.get("file_size"));
  const name = String(form.get("file_name") || "");
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || size < 1 || size > MAX_PDF_UPLOAD_BYTES || !name || name.length > 255) throw new Error("Choose a nonempty PDF of at most 50 MiB.");
  const prefix = `${hotelId}/${assetId}/${hash}-`;
  const baseName = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 136) || "document";
  const safeName = baseName.endsWith(".pdf") ? baseName : `${baseName}.pdf`;
  const { data: files, error } = await admin.rpc("cmpri_import_stored_pdfs");
  if (error) throw new Error("Stored PDF selection is unavailable. Retry before uploading.");
  // Content-addressed paths make retries (including renamed files) reuse the original.
  const existing = (files as StoredPdf[] || []).find(file => file.storage_path.startsWith(prefix));
  if (complete) {
    if (!existing) throw new Error("The upload is not yet available. Retry the same file; an existing original will be reused.");
    if (existing.size !== size) throw new Error("The stored PDF size differs from the original. No association was saved.");
    return { object_id: existing.object_id, sha256: hash };
  }
  if (existing) return { already_uploaded: true };
  // Never create or broaden bucket access from this flow. Enforce the intended
  // ingress limit in storage too, before issuing a file-specific upload token.
  const { data: bucket, error: bucketError } = await admin.storage.getBucket(BUCKET);
  if (bucketError || !bucket || bucket.public || !bucket.file_size_limit || Number(bucket.file_size_limit) > MAX_PDF_UPLOAD_BYTES) throw new Error("Private PDF storage with the 50 MiB limit is unavailable.");
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUploadUrl(`${prefix}${safeName}`, { upsert: false });
  if (signError || !signed?.signedUrl) throw new Error("Private upload authorization failed. Retry the same file; an existing original will be reused.");
  return { signed_url: signed.signedUrl, already_uploaded: false };
}
