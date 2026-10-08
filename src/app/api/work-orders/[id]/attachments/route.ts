import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { roleKey } from "@/lib/server/roles";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";
import { isUuid } from "@/lib/uuid";

const DOCUMENTATION_BUCKET = "asset-documentation";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
};

type AttachmentContext = {
  auth: NonNullable<Awaited<ReturnType<typeof requireUser>>>;
  workOrder: { id: string; created_by: string | null; technician_name: string | null; status: string | null };
};

function attachmentPrefix(workOrderId: string) {
  return `${HOTEL_ID}/work-orders/${workOrderId}`;
}

function hasImageSignature(contentType: string, bytes: Uint8Array) {
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
  const canEditOrReview = allows(auth.principal, "edit_tickets") || allows(auth.principal, "review_tickets");
  if ((roleKey(auth.principal.profile.role) === "technician" || !canEditOrReview)
    && allows(auth.principal, "view_work_orders")
    && !["Open", "In Progress"].includes(String(workOrder.status || ""))) {
    return { response: NextResponse.json({ error: "This role can only view attachments for open work orders." }, { status: 403 }) };
  }
  if (!canAccessWorkOrderByAssignment(auth.principal.profile.role, auth.principal.profile.full_name, workOrder)) {
    return { response: NextResponse.json({ error: "This work order is not assigned to you." }, { status: 403 }) };
  }
  const isCreator = String(workOrder.created_by || "") === String(auth.principal.identity.id);
  const canAccess = isCreator || (mode === "write"
    ? allows(auth.principal, "edit_tickets") || allows(auth.principal, "review_tickets")
    : allows(auth.principal, "view_dashboard") || allows(auth.principal, "view_work_orders") || allows(auth.principal, "edit_tickets") || allows(auth.principal, "review_tickets"));
  return canAccess
    ? { context: { auth, workOrder: workOrder as AttachmentContext["workOrder"] } }
    : { response: NextResponse.json({ error: mode === "write" ? "Work-order attachment edit or review access is required." : "Work-order attachment access is required." }, { status: 403 }) };
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
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "Images must be 10 MB or smaller." }, { status: 400 });

  const extension = (file.name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const contentType = IMAGE_CONTENT_TYPES[extension];
  const declaredType = file.type.toLowerCase();
  if (!contentType || (declaredType && declaredType !== "application/octet-stream" && declaredType !== contentType)) {
    return NextResponse.json({ error: "Only JPEG, PNG, GIF, WebP, HEIC/HEIF, or BMP images can be attached." }, { status: 400 });
  }
  const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!hasImageSignature(contentType, signature)) {
    return NextResponse.json({ error: "The selected file is not a valid supported image." }, { status: 400 });
  }

  const storagePath = `${attachmentPrefix(id)}/${uploadId || crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await context.auth.admin.storage
    .from(DOCUMENTATION_BUCKET)
    .upload(storagePath, file, { contentType, upsert: Boolean(uploadId) });
  if (uploadError) {
    console.error("Work-order photo upload failed:", uploadError.message);
    return NextResponse.json({ error: "The work-order image could not be stored." }, { status: 503 });
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
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
    if (!file.name || !/^image\//i.test(String(file.metadata?.mimetype || ""))) continue;
    const path = `${attachmentPrefix(id)}/${file.name}`;
    const { data: signed, error: signedUrlError } = await context.auth.admin.storage
      .from(DOCUMENTATION_BUCKET)
      .createSignedUrl(path, 60 * 60);
    if (signedUrlError || !signed?.signedUrl) {
      console.error("Work-order photo URL signing failed:", signedUrlError?.message || "No signed URL was returned.");
      return NextResponse.json({ error: "A work-order image could not be opened." }, { status: 503 });
    }
    images.push({ id: file.name, name: file.name, url: signed.signedUrl });
  }

  return NextResponse.json({ images }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
