import { NextRequest, NextResponse } from "next/server";
import { requireUserAttempt } from "@/lib/server/auth";
import { askVendorDocumentDownload } from "@/lib/server/ask-cmpri-vendor-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok) return NextResponse.json({ error: "Sign in to download this document." }, { status: 401, headers });
  try {
    const text = await request.text();
    if (text.length > 18000) throw new Error("This document reference is invalid.");
    const body = JSON.parse(text);
    if (typeof body?.token !== "string") throw new Error("Choose the original document from this Ask response.");
    return NextResponse.json(await askVendorDocumentDownload(request, body.token), { headers });
  } catch {
    return NextResponse.json({ error: "This document download is unavailable or expired. Read the original again in Ask CMPRI." }, { status: 409, headers });
  }
}
