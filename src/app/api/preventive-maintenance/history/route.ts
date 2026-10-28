import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { PM_ROOM_NUMBERS } from "@/lib/pm/catalog";
import { validateRoomHistory } from "@/lib/pm/history";
import { requireUser } from "@/lib/server/auth";
import { profileHasRole } from "@/lib/server/roles";

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!profileHasRole(auth.principal.profile, "system_admin") && !profileHasRole(auth.principal.profile, "engineer")) {
    return NextResponse.json({ error: "Only a PM reviewer can import historical completions." }, { status: 403 });
  }
  let input;
  let apply: boolean;
  let expectedDigest: string | null;
  try {
    const raw = await request.text();
    if (raw.length > 2_000_000) throw new Error("Import is too large.");
    const body = JSON.parse(raw);
    if (body.action !== "preview" && body.action !== "apply") throw new Error("Choose preview or apply.");
    input = validateRoomHistory(body.input, PM_ROOM_NUMBERS);
    apply = body.action === "apply";
    expectedDigest = apply ? body.previewDigest : null;
    if (apply && (typeof expectedDigest !== "string" || !/^[a-f0-9]{32}$/.test(expectedDigest))) throw new Error("Preview this exact import before confirming.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid import." }, { status: 400 });
  }
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const result = await auth.admin.rpc("cmpri_import_room_pm_history", {
    p_hotel: HOTEL_ID, p_actor: auth.principal.identity.id,
    p_actor_name: auth.principal.profile.full_name || "CMPRI reviewer",
    p_input: input, p_digest: digest, p_apply: apply, p_expected: expectedDigest,
  });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: result.error.code === "P0001" ? 409 : 503 });
  return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
