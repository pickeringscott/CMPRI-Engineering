import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";

const DOCUMENTATION_BUCKET = "asset-documentation";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function attachmentPrefix(workOrderId: string) {
  return `${HOTEL_ID}/work-orders/${workOrderId}`;
}

async function authorizedWorkOrder(request: NextRequest, id: string) {
  const auth = await requireUser(request);
  if (!auth) return null;
  const { data: workOrder, error } = await auth.admin
    .from("work_orders")
    .select("id, created_by, technician_name")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (error || !workOrder) return null;
  if (!canAccessWorkOrderByAssignment(auth.principal.profile.role, auth.principal.profile.full_name, workOrder)) return null;
  const isCreator = String(workOrder.created_by || "") === String(auth.principal.identity.id);
  const canAccess = isCreator || allows(auth.principal, "view_dashboard") || allows(auth.principal, "edit_tickets") || allows(auth.principal, "review_tickets");
  return canAccess ? { auth, workOrder } : null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await authorizedWorkOrder(request, id);
  if (!context) return NextResponse.json({ error: "Work-order attachment access is required." }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("photo");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ error: "Only image files can be attached." }, { status: 400 });
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: "Images must be smaller than 10 MB." }, { status: 400 });

  const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const storagePath = `${attachmentPrefix(id)}/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await context.auth.admin.storage
    .from(DOCUMENTATION_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) return NextResponse.json({ error: "The work-order image could not be stored." }, { status: 503 });

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const context = await authorizedWorkOrder(request, id);
  if (!context) return NextResponse.json({ error: "Work-order attachment access is required." }, { status: 403 });

  const { data: files, error: listError } = await context.auth.admin.storage
    .from(DOCUMENTATION_BUCKET)
    .list(attachmentPrefix(id), { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  if (listError) return NextResponse.json({ error: "Work-order images could not be loaded." }, { status: 503 });

  const images = [];
  for (const file of files || []) {
    if (!file.name || !/^image\//i.test(String(file.metadata?.mimetype || ""))) continue;
    const path = `${attachmentPrefix(id)}/${file.name}`;
    const { data: signed } = await context.auth.admin.storage
      .from(DOCUMENTATION_BUCKET)
      .createSignedUrl(path, 60 * 60);
    if (signed?.signedUrl) images.push({ id: file.name, name: file.name, url: signed.signedUrl });
  }

  return NextResponse.json({ images }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
