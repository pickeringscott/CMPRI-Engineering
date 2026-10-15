export type WorkOrderAttachmentUploadResult =
  | { ok: true }
  | { ok: false; message: string; canReplace: boolean };

export async function uploadWorkOrderAttachment(
  workOrderId: string,
  photo: File,
  accessToken: string,
  uploadId: string,
): Promise<WorkOrderAttachmentUploadResult> {
  const failed = (message: string, canReplace = false): WorkOrderAttachmentUploadResult => ({ ok: false, message, canReplace });
  if (photo.size < 1 || photo.size > 10 * 1024 * 1024) return failed("Images must be 10 MB or smaller.", true);
  try {
    const bytes = await photo.arrayBuffer();
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const descriptor = { uploadId, name: photo.name, type: photo.type, size: photo.size, sha256 };
    const endpoint = `/api/work-orders/${encodeURIComponent(workOrderId)}/attachments`;
    async function handshake(action: "prepare" | "finalize") {
      const response = await fetch(endpoint, {
        method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...descriptor, action }), cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean; complete?: boolean; finalize?: boolean; signedUrl?: string; contentType?: string; error?: string;
      } | null;
      return { response, payload };
    }
    const prepared = await handshake("prepare");
    if (!prepared.response.ok || prepared.payload?.ok !== true) {
      return failed(prepared.payload?.error || "Photo upload could not be prepared. Retry the photo upload.", prepared.response.status === 400);
    }
    if (prepared.payload.complete === true) return { ok: true };
    if (prepared.payload.finalize !== true) {
      if (!prepared.payload.signedUrl || !prepared.payload.contentType) return failed("Photo upload could not be prepared. Retry the photo upload.");
      // Signed capability is only for one private staging object. Never send the
      // CMPRI bearer token, cookies or referrer to Storage or log its response.
      try {
        await fetch(prepared.payload.signedUrl, {
          method: "PUT", body: photo,
          headers: { "Content-Type": prepared.payload.contentType, "x-upsert": "false" },
          credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store",
        });
      } catch {
        // Storage may have accepted the bytes even if its response was lost.
        // Finalization is authoritative; the existing upload ID makes retry safe.
      }
    }
    const finalized = await handshake("finalize");
    if (finalized.response.ok && finalized.payload?.ok === true && finalized.payload.complete === true) return { ok: true };
    return failed(finalized.payload?.error || "The photo upload could not be confirmed. Retry the photo upload.", finalized.response.status === 400 || finalized.response.status === 413);
  } catch {
    return failed("The photo upload could not be confirmed. Check the connection and retry.");
  }
}
