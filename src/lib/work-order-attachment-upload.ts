export type WorkOrderAttachmentUploadResult =
  | { ok: true }
  | { ok: false; message: string; canReplace: boolean };

export async function uploadWorkOrderAttachment(
  workOrderId: string,
  photo: File,
  accessToken: string,
  uploadId: string,
): Promise<WorkOrderAttachmentUploadResult> {
  try {
    const form = new FormData();
    form.append("photo", photo);
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "X-Upload-Id": uploadId },
      body: form,
    });
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;

    if (!response.ok) {
      return {
        ok: false,
        message: typeof payload?.error === "string"
          ? payload.error
          : "The photo upload failed. Restore the connection and retry.",
        canReplace: response.status === 400 || response.status === 413,
      };
    }

    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "The photo upload could not be confirmed. Check the connection and retry.",
      canReplace: false,
    };
  }
}
