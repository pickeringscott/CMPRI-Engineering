import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { PM_TEMPLATES } from "@/lib/pm/catalog";
import { validatePmSource } from "@/lib/pm/source-evidence";
import { requireUser } from "@/lib/server/auth";
import { profileHasRole } from "@/lib/server/roles";
import { projectRecordedPmForms } from "@/lib/server/pm-recorded-forms";

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  const result = await auth.admin.from("cmpri_pm_source_evidence").select("source_id, source_name, page_count, pages, confirmed_by_name, confirmed_at").eq("hotel_id", HOTEL_ID).order("confirmed_at", { ascending: false }).limit(100);
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 503 });
  return NextResponse.json({ sources: (result.data || []).map(source => ({ ...source, pages: projectRecordedPmForms(source.source_id, source.pages) })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!profileHasRole(auth.principal.profile, "system_admin") && !profileHasRole(auth.principal.profile, "engineer")) return NextResponse.json({ error: "Only a PM reviewer can import source evidence." }, { status: 403 });
  let input;
  let apply: boolean;
  let expected: string | null;
  try {
    const raw = await request.text();
    if (raw.length > 4_000_000) throw new Error("Source import is too large.");
    const body = JSON.parse(raw);
    if (body.action !== "preview" && body.action !== "apply") throw new Error("Choose preview or apply.");
    input = validatePmSource(body.input, PM_TEMPLATES.map(template => template.id));
    apply = body.action === "apply";
    expected = apply ? body.previewDigest : null;
    if (apply && (typeof expected !== "string" || !/^[a-f0-9]{32}$/.test(expected))) throw new Error("Preview this exact source before confirming.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid source." }, { status: 400 });
  }
  const result = await auth.admin.rpc("cmpri_import_pm_source_evidence", { p_hotel: HOTEL_ID, p_actor: auth.principal.identity.id, p_actor_name: auth.principal.profile.full_name || "CMPRI reviewer", p_input: input, p_digest: createHash("sha256").update(JSON.stringify(input)).digest("hex"), p_apply: apply, p_expected: expected });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: result.error.code === "P0001" ? 409 : 503 });
  return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
