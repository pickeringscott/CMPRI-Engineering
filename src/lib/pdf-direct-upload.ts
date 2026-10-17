/** PDF bytes go straight to private storage; only small forms reach the app. */
export const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function pdfImportResponse(response: Response) {
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { /* Hosting errors can be plain text or HTML. */ }
  if (!response.ok) {
    if (response.status === 413) throw new Error("The upload was rejected as too large. PDFs must be at most 50 MiB. Reload the page and retry the direct upload.");
    throw new Error(typeof result?.error === "string" ? result.error : `PDF request failed (HTTP ${response.status}). Please retry; existing originals are preserved.`);
  }
  if (!result || typeof result !== "object") throw new Error("The PDF service returned an unexpected response. Please retry; existing originals are preserved.");
  return result;
}

export async function uploadPdfDirect(file: File, assetId: string, request: (form: FormData) => Promise<unknown>, signal: AbortSignal, progress: (message: string) => void) {
  if (!file.size || file.size > MAX_PDF_UPLOAD_BYTES) throw new Error("Choose a nonempty PDF of at most 50 MiB.");
  if (await file.slice(0, 5).text() !== "%PDF-") throw new Error("The selected file is not a PDF.");
  progress("Checking the original PDF…");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  signal.throwIfAborted();
  const form = new FormData();
  form.set("asset_id", assetId); form.set("file_name", file.name);
  form.set("file_size", String(file.size)); form.set("sha256", sha256);
  form.set("import_action", "upload_prepare");
  const prepared = await request(form) as { signed_url?: string; already_uploaded?: boolean };
  signal.throwIfAborted();
  if (!prepared.already_uploaded) {
    if (!prepared.signed_url) throw new Error("Private upload authorization is unavailable. Retry the upload.");
    progress("Uploading the original PDF to private storage…");
    const response = await fetch(prepared.signed_url, { method: "PUT", headers: { "Content-Type": "application/pdf", "x-upsert": "false" }, body: file, signal });
    if (!response.ok) {
      // A lost response or a concurrent retry may have stored the same object.
      // Completion independently reads and verifies its bytes; it never trusts this acknowledgement.
      if (![400, 409].includes(response.status)) await pdfImportResponse(response);
    }
  }
  signal.throwIfAborted();
  progress("Verifying the stored original and opening it for review…");
  form.set("import_action", "upload_complete");
  return request(form);
}
