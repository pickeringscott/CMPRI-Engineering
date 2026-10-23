import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { requireUserAttempt } from "@/lib/server/auth";
import { canReviewEmployment } from "@/lib/employment-access";
import { validateEmployment } from "@/lib/employment-validation.mjs";

const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin !== request.nextUrl.origin) return NextResponse.json({ error: "Invalid origin." }, { status: 403, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "JSON required." }, { status: 415, headers });
  // Bound the stream, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "Questionnaire required." }, { status: 400, headers });
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 20000) { await reader.cancel(); return NextResponse.json({ error: "Questionnaire too large." }, { status: 413, headers }); } chunks.push(value); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return NextResponse.json({ error: "Invalid questionnaire." }, { status: 400, headers }); }
  const validation = validateEmployment(body);
  if (!validation.ok || !validation.value || body.website) return NextResponse.json({ error: "Check the required fields." }, { status: 400, headers });
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Submission temporarily unavailable." }, { status: 503, headers });
  const { error } = await admin.rpc("submit_employment_application", { p_answers: validation.value });
  if (error) return NextResponse.json({ error: "Submission unavailable. Please try again later." }, { status: error.code === "P0001" ? 429 : 503, headers });
  return NextResponse.json({ ok: true }, { status: 201, headers });
}

export async function GET(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp || !canReviewEmployment(auth.principal.identity)) return NextResponse.json({ error: "Private work-account access required." }, { status: 403, headers });
  const id = request.nextUrl.searchParams.get("id");
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid application." }, { status: 400, headers });
  const query = auth.admin.from("employment_applications").select(id ? "id,created_at,answers" : "id,created_at,answers->>name,answers->>email");
  const { data, error } = id ? await query.eq("id", id).maybeSingle() : await query.order("created_at", { ascending: false }).limit(200);
  if (error) return NextResponse.json({ error: "Applications unavailable." }, { status: 503, headers });
  return NextResponse.json(id ? { application: data } : { applications: data }, { headers });
}

