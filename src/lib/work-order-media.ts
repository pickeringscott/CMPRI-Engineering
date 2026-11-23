const mediaTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

export function isSupportedWorkOrderMedia(name: string, type: string) {
  const extension = (name.split(".").pop() || "").toLowerCase();
  const contentType = mediaTypes[extension];
  const declaredType = type.toLowerCase();
  return contentType && (!declaredType || declaredType === "application/octet-stream" || declaredType === contentType)
    ? contentType : undefined;
}

export async function workOrderMediaDigest(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
