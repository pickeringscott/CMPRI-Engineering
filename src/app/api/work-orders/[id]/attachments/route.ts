import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { profileIsChiefEngineer, profileIsEstablishedHoursChief } from "@/lib/server/roles";
import { isUuid } from "@/lib/uuid";

const DOCUMENTATION_BUCKET = "asset-documentation";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MEDIA_SIGNATURE_BYTES = 64;
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

type AttachmentContext = {
  auth: NonNullable<Awaited<ReturnType<typeof requireUser>>>;
  workOrder: { id: string; created_by: string | null; technician_name: string | null; status: string | null };
};

function attachmentPrefix(workOrderId: string) {
  return `${HOTEL_ID}/work-orders/${workOrderId}`;
}

// Reuse the existing exact-ID/email/role legacy Chief mapping without broadening role policy.
function canRemoveSavedPhotos(profile: AttachmentContext["auth"]["principal"]["profile"]) {
  return profileIsChiefEngineer(profile) || profileIsEstablishedHoursChief(profile);
}

function validPhotoName(name: string) {
  const match = /^(?:([0-9a-f-]+)_)?([0-9a-f-]+)\.(jpg|jpeg|png|gif|webp|bmp|heic|heif|mp4|mov|webm)$/.exec(name);
  return Boolean(match && (!match[1] || isUuid(match[1])) && isUuid(match[2]));
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const access = await authorizedWorkOrder(request, id, "write");
  if ("response" in access) return access.response;
  if (!canRemoveSavedPhotos(access.context.auth.principal.profile)) {
    return NextResponse.json({ error: "Only the Chief Engineer can remove saved photos." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const name = body?.photoId;
  if (typeof name !== "string" || !validPhotoName(name)) {
    return NextResponse.json({ error: "A valid saved-photo ID is required." }, { status: 403 });
  }
  const { error } = await access.context.auth.admin.storage.from(DOCUMENTATION_BUCKET)
    .remove([`${attachmentPrefix(id)}/${name}`]);
  if (error) {
    console.error("Work-order photo removal failed:", error.message);
    return NextResponse.json({ error: "The photo could not be removed. Retry after checking the connection." }, { status: 503 });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

function hasImageSignature(contentType: string, bytes: Uint8Array) {
  if (contentType === "video/webm") {
    if (bytes.length < 5 || ![0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)) return false;
    const vint = (offset: number, keepMarker = false) => {
      const first = bytes[offset];
      if (!first) return null;
      let length = 1, mask = 0x80;
      while (!(first & mask) && length <= 8) { length++; mask >>= 1; }
      if (length > (keepMarker ? 4 : 8) || offset + length > bytes.length) return null;
      let value = keepMarker ? first : first & (mask - 1);
      let unknownSize = !keepMarker && value === mask - 1;
      for (let index = 1; index < length; index++) {
        value = value * 256 + bytes[offset + index];
        unknownSize = unknownSize && bytes[offset + index] === 0xff;
      }
      if (!Number.isSafeInteger(value) || unknownSize) return null;
      return { value, length };
    };
    const header = vint(4);
    if (!header || header.value > 4096) return false;
    const end = 4 + header.length + header.value;
    for (let offset = 4 + header.length; offset < Math.min(end, bytes.length);) {
      const id = vint(offset, true);
      if (!id) return false;
      offset += id.length;
      const size = vint(offset);
      if (!size) return false;
      offset += size.length;
      const elementEnd = offset + size.value;
      if (elementEnd > end || elementEnd > bytes.length) return false;
      // This is a bounded signature check: a complete WebM DocType is enough,
      // even when the remaining EBML header extends beyond the sampled bytes.
      if (id.value === 0x4282) return size.value === 4 && String.fromCharCode(...bytes.subarray(offset, elementEnd)) === "webm";
      offset = elementEnd;
    }
    return false;
  }
  if(contentType === "video/mp4" || contentType === "video/quicktime"){
    if(bytes.length<12||String.fromCharCode(...bytes.slice(4,8))!=="ftyp")return false;
    const brand=String.fromCharCode(...bytes.slice(8,12));
    return contentType==="video/quicktime" ? brand==="qt  " : ["isom","iso2","mp41","mp42","avc1","M4V "].includes(brand);
  }
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (contentType === "image/gif") return bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (contentType === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (contentType === "image/bmp") return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
  if (contentType === "image/heic" || contentType === "image/heif") {
    if (bytes.length < 12 || String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return false;
    return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(String.fromCharCode(...bytes.slice(8, 12)));
  }
  return false;
}

async function authorizedWorkOrder(request: NextRequest, id: string, mode: "read" | "write" = "read") {
  const auth = await requireUser(request);
  if (!auth) return { response: NextResponse.json({ error: "Sign in is required." }, { status: 401 }) };
  const { data: workOrder, error } = await auth.admin
    .from("work_orders")
    .select("id, created_by, technician_name, status")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (error) return { response: NextResponse.json({ error: "The work order could not be verified." }, { status: 503 }) };
  if (!workOrder) return { response: NextResponse.json({ error: "Work order not found." }, { status: 404 }) };
  const canRead = allows(auth.principal, 'view_work_orders');
  const canComment = allows(auth.principal, 'add_work_order_notes');
  if (!(mode === 'write' ? canRead && canComment : canRead)) return { response: NextResponse.json({ error: 'Work-order attachment access is required.' }, { status: 403 }) };
  return { context: { auth, workOrder: workOrder as AttachmentContext['workOrder'] } };

}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const uploadId = request.headers.get("x-upload-id");
  if (uploadId && !isUuid(uploadId)) return NextResponse.json({ error: "A valid upload ID is required." }, { status: 400 });
  const access = await authorizedWorkOrder(request, id, "write");
  if ("response" in access) return access.response;
  const { context } = access;

  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "Photos and videos must be 10 MB or smaller." }, { status: 400 });

  const extension = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const contentType = IMAGE_CONTENT_TYPES[extension];
  const declaredType = file.type.toLowerCase();
  if (!contentType || (declaredType && declaredType !== "application/octet-stream" && declaredType !== contentType)) {
    return NextResponse.json({ error: "Only supported JPEG, PNG, GIF, WebP, HEIC/HEIF, BMP, MP4, MOV or WebM media can be attached." }, { status: 400 });
  }
  const signature = new Uint8Array(await file.slice(0, MEDIA_SIGNATURE_BYTES).arrayBuffer());
  if (!hasImageSignature(contentType, signature)) {
    return NextResponse.json({ error: "The selected file is not a valid supported image." }, { status: 400 });
  }

  const storagePath = `${attachmentPrefix(id)}/${context.auth.principal.identity.id}_${uploadId || crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await context.auth.admin.storage
    .from(DOCUMENTATION_BUCKET)
    .upload(storagePath, file, { contentType, upsert: false, metadata: { original_name:file.name, uploaded_by: context.auth.principal.identity.id, uploader_name: context.auth.principal.profile.full_name || "CMPRI User", uploader_role: context.auth.principal.profile.role } });
  if (uploadError) {
    // Older tabs can retry the same small upload, but cannot overwrite saved bytes.
    if (uploadId) {
      const previous = await context.auth.admin.storage.from(DOCUMENTATION_BUCKET).download(storagePath);
      if (previous.data && previous.data.size === file.size) {
        const digest = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))).join(",");
        if (await digest(previous.data) === await digest(file)) return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    console.error("Work-order photo upload failed:", uploadError.message);
    return NextResponse.json({ error: "The work-order image could not be stored." }, { status: 503 });
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

// Only this small JSON handshake crosses the application function. Original bytes
// go to a write-only signed Storage URL, outside the ticket's readable prefix.
class PhotoUploadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function storageMissing(error: unknown) {
  const value = error as { statusCode?: string | number; status?: number; code?: string } | null;
  return value?.code === "NoSuchKey" || String(value?.statusCode ?? value?.status) === "404";
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
  const reply = (body: object, status = 200) => NextResponse.json(body, { status, headers });
  const { id } = await params;
  if (!isUuid(id)) return reply({ error: "A valid work-order ID is required." }, 400);
  const access = await authorizedWorkOrder(request, id, "write");
  if ("response" in access) return access.response;
  const { context } = access;
  try {
    // No caller-controlled storage path, hotel, owner, or destination is accepted.
    const text = await request.text();
    if (text.length > 2048) return reply({ error: "Invalid photo upload request." }, 400);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["action", "uploadId", "name", "type", "size", "sha256"].includes(key))
      || !["prepare", "finalize"].includes(body.action) || !isUuid(body.uploadId)
      || typeof body.name !== "string" || body.name.length > 255
      || typeof body.type !== "string" || typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256)) {
      return reply({ error: "Invalid photo upload request." }, 400);
    }
    if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_IMAGE_BYTES) {
      return reply({ error: "Photos and videos must be 10 MB or smaller." }, 400);
    }
    const extension = (body.name.split(".").pop() || "").toLowerCase();
    const contentType = IMAGE_CONTENT_TYPES[extension];
    if (!contentType || (body.type && body.type !== "application/octet-stream" && body.type.toLowerCase() !== contentType)) {
      return reply({ error: "Only supported JPEG, PNG, GIF, WebP, HEIC/HEIF, BMP, MP4, MOV or WebM media can be attached." }, 400);
    }
    const actor = context.auth.principal.identity.id;
    const storage = context.auth.admin.storage.from(DOCUMENTATION_BUCKET);
    const destination = `${attachmentPrefix(id)}/${actor}_${body.uploadId}.${extension}`;
    const staging = `${HOTEL_ID}/work-order-upload-staging/${id}/${actor}/${body.uploadId}-${body.sha256}.${extension}`;

    async function verifiedImage(path: string) {
      const info = await storage.info(path);
      if (info.error) {
        if (storageMissing(info.error)) return null;
        throw new PhotoUploadError("Photo storage could not be checked. Retry the photo upload.", 503);
      }
      // Reject lying client sizes before downloading; validate the actual object again below.
      if (!info.data || typeof info.data.size !== "number" || info.data.size !== body.size || info.data.size > MAX_IMAGE_BYTES
        || info.data.contentType !== contentType) {
        throw new PhotoUploadError("Stored photo size or type does not match. Choose the original image again.", 400);
      }
      const result = await storage.download(path);
      if (result.error || !result.data) throw new PhotoUploadError("Photo upload is not complete. Retry the photo upload.", 503);
      const file = result.data;
      if (file.size !== body.size || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
        throw new PhotoUploadError("Photos and videos must be 10 MB or smaller and match the selected file.", 400);
      }
      const bytes = await file.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== body.sha256 || !hasImageSignature(contentType, new Uint8Array(bytes).subarray(0, MEDIA_SIGNATURE_BYTES))) {
        throw new PhotoUploadError("The uploaded file is not the selected supported image. Choose the original image again.", 400);
      }
      return file;
    }

    // A lost completion response is safely retried without replacing the saved photo.
    if (await verifiedImage(destination)) return reply({ ok: true, complete: true });
    if (body.action === "prepare") {
      const staged = await storage.info(staging);
      if (staged.data) return reply({ ok: true, finalize: true });
      if (staged.error && !storageMissing(staged.error)) throw new PhotoUploadError("Photo storage could not be checked. Retry the photo upload.", 503);
      const signed = await storage.createSignedUploadUrl(staging, { upsert: false });
      if (signed.error || !signed.data) throw new PhotoUploadError("Photo upload could not be prepared. Retry the photo upload.", 503);
      return reply({ ok: true, signedUrl: signed.data.signedUrl, contentType });
    }

    const image = await verifiedImage(staging);
    if (!image) return reply({ error: "Photo upload is not complete. Retry the photo upload." }, 409);
    // Recheck session, membership and ticket access after transfer/verification.
    const current = await authorizedWorkOrder(request, id, "write");
    if ("response" in current) return current.response;
    if (current.context.auth.principal.identity.id !== actor) return reply({ error: "Sign in again before retrying the photo upload." }, 401);
    // Outbound server-to-Storage transfer is not an incoming Vercel function payload.
    // Store the already verified original bytes, never a second client-controlled object.
    const saved = await storage.upload(destination, image, { contentType, upsert: false, metadata: {
      original_name:body.name, uploaded_by: actor, uploader_name: current.context.auth.principal.profile.full_name || "CMPRI User",
      uploader_role: current.context.auth.principal.profile.role, sha256: body.sha256,
    } });
    if (saved.error && !(await verifiedImage(destination))) {
      throw new PhotoUploadError("The photo could not be saved. Retry the photo upload.", 503);
    }
    // Staging is not a saved ticket photo. Best-effort cleanup never removes destination.
    // A cleanup failure must not turn a successful photo into a duplicate retry.
    await storage.remove([staging]).catch(() => undefined);
    return reply({ ok: true, complete: true });
  } catch (error) {
    if (error instanceof PhotoUploadError) return reply({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return reply({ error: "Invalid photo upload request." }, 400);
    // Storage errors may contain signed URLs/tokens: never log or echo them.
    return reply({ error: "The photo upload could not be confirmed. Retry the photo upload." }, 503);
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const access = await authorizedWorkOrder(request, id);
  if ("response" in access) return access.response;
  const { context } = access;

  const { data: files, error: listError } = await context.auth.admin.storage
    .from(DOCUMENTATION_BUCKET)
    .list(attachmentPrefix(id), { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  if (listError) return NextResponse.json({ error: "Work-order images could not be loaded." }, { status: 503 });

  const images = [];
  for (const file of files || []) {
    if (!file.name || !/^(image|video)\//i.test(String(file.metadata?.mimetype || ""))) continue;
    const path = `${attachmentPrefix(id)}/${file.name}`;
    // List responses expose system metadata; info exposes upload metadata (camel-cased by the SDK).
    const {data: info, error: infoError} = await context.auth.admin.storage.from(DOCUMENTATION_BUCKET).info(path);
    if (infoError) return NextResponse.json({error:"Work-order attachment details could not be loaded."},{status:503});
    const custom: Record<string, unknown> = info?.metadata || {};
    const originalName = custom.originalName ?? custom.original_name;
    const uploaderName = custom.uploaderName ?? custom.uploader_name;
    const uploaderRole = custom.uploaderRole ?? custom.uploader_role;

    const { data: signed, error: signedUrlError } = await context.auth.admin.storage
      .from(DOCUMENTATION_BUCKET)
      .createSignedUrl(path, 60 * 60);
    if (signedUrlError || !signed?.signedUrl) {
      console.error("Work-order photo URL signing failed:", signedUrlError?.message || "No signed URL was returned.");
      return NextResponse.json({ error: "A work-order image could not be opened." }, { status: 503 });
    }
    images.push({
      id: file.name,
      name: typeof originalName === "string" && originalName.trim() ? originalName : file.name,
      type: String(file.metadata?.mimetype || ""),
      uploader_name: typeof uploaderName === "string" ? uploaderName : undefined,
      uploader_role: typeof uploaderRole === "string" ? uploaderRole : undefined,
      url: signed.signedUrl,
      can_remove: validPhotoName(file.name) && canRemoveSavedPhotos(context.auth.principal.profile),
      ...(typeof file.created_at === "string" ? { uploaded_at: file.created_at } : {}),
    });
  }

  return NextResponse.json({ images }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
