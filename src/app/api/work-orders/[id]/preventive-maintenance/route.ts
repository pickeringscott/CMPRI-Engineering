import { NextRequest, NextResponse } from "next/server";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!allows(auth.principal, "edit_tickets")) {
    return NextResponse.json({ error: "Work-order editing permission is required to commit room checks." }, { status: 403 });
  }
  return NextResponse.json(
    { error: "Direct PM spreadsheet edits from work orders are disabled. Submit the PM change from the Preventive Maintenance workspace for reviewer confirmation." },
    { status: 409 },
  );
}
