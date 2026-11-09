import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/server/auth";

/** Retained for older clients; report images are no longer sent for extraction. */
export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "edit_tickets");
  if (!auth) {
    return NextResponse.json({ error: "Engineering ticket-edit permission is required." }, { status: 403 });
  }
  return NextResponse.json(
    { error: "Report image extraction is disabled. Import the original CSV report instead." },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
