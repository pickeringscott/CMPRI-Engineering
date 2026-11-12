import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability, requireUser } from "@/lib/server/auth";
import { canEditEquipment, canReadEquipment } from "@/lib/server/roles";
import { isUuid } from "@/lib/uuid";

const BUCKET = "asset-documentation";
const MAX_BYTES = 10 * 1024 * 1024;

async function assetExists(auth: NonNullable<Awaited<ReturnType<typeof requireUser>>>, id: string) {
  const { data, error } = await auth.admin.from("assets").select("id").eq("hotel_id", HOTEL_ID).eq("id", id).maybeSingle();
  return { exists: Boolean(data), error };
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth || !canReadEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Equipment access is required." }, { status: 403 });
  const id = request.nextUrl.searchParams.get("asset_id") || "";
  if (!isUuid(id)) return NextResponse.json({ error: "A valid asset is required." }, { status: 400 });
  const asset = await assetExists(auth, id);
  if (asset.error) return NextResponse.json({ error: "Asset could not be verified." }, { status: 503 });
  if (!asset.exists) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  const { data, error } = await auth.admin.storage.from(BUCKET).download(`${HOTEL_ID}/_asset-photos/${id}.webp`);
  if (error) {
    if ("statusCode" in error && String(error.statusCode) === "404") return new NextResponse(null, { status: 404 });
    return NextResponse.json({ error: "Photo could not be loaded." }, { status: 503 });
  }
  if (!data) return new NextResponse(null, { status: 404 });
  return new NextResponse(await data.arrayBuffer(), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function PUT(request: NextRequest) {
  const auth = await requireCapability(request, "manage_assets");
  if (!auth || !canEditEquipment(auth.principal.profile.role)) return NextResponse.json({ error: "Equipment editing permission is required." }, { status: 403 });
  let form: FormData;
  try { form = await request.formData(); } catch { return NextResponse.json({ error: "Choose an image." }, { status: 400 }); }
  const id = String(form.get("asset_id") || "");
  const file = form.get("file");
  if (!isUuid(id) || !(file instanceof File) || file.size < 1 || file.size > MAX_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) return NextResponse.json({ error: "Choose a JPEG, PNG, or WebP image up to 10 MB." }, { status: 400 });
  const asset = await assetExists(auth, id);
  if (asset.error) return NextResponse.json({ error: "Asset could not be verified." }, { status: 503 });
  if (!asset.exists) return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  let image: Buffer;
  try { image = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40000000 }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(); }
  catch { return NextResponse.json({ error: "The image could not be read." }, { status: 400 }); }
  const { error } = await auth.admin.storage.from(BUCKET).upload(`${HOTEL_ID}/_asset-photos/${id}.webp`, image, { contentType: "image/webp", upsert: true });
  if (error) return NextResponse.json({ error: "Photo could not be saved. Please retry." }, { status: 503 });
  return NextResponse.json({ saved: true });
}
