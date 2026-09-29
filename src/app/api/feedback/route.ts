import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { APP_TITLE, BUILD_VERSION, HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";

const FEEDBACK_TYPES = ["Problem", "Bug", "Suggestion"] as const;
const FEEDBACK_STATUSES = ["New", "Reviewed", "Planned", "Resolved"] as const;
type FeedbackStatus = typeof FEEDBACK_STATUSES[number];

async function readBody(request: NextRequest) {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function validRoute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    && value.length <= 500 && !/[\r\n]/.test(value);
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "review_feedback");
  if (!auth) return NextResponse.json({ error: "Feedback review access is required." }, { status: 403 });

  if (request.nextUrl.searchParams.get("mode") === "count") {
    const { count, error } = await auth.admin.from("user_feedback")
      .select("id", { count: "exact", head: true })
      .eq("hotel_id", HOTEL_ID)
      .eq("status", "New");
    if (error) return NextResponse.json({ error: "Feedback count could not be loaded." }, { status: 503 });
    return NextResponse.json({ count: count || 0 }, { headers: { "Cache-Control": "private, no-store" } });
  }

  const { data, error } = await auth.admin.from("user_feedback")
    .select("id, created_at, user_id, user_name, user_role, feedback_type, description, page_route, app_version, status, reviewed_at, resolved_at")
    .eq("hotel_id", HOTEL_ID)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Feedback could not be loaded." }, { status: 503 });
  return NextResponse.json({ feedback: data || [] }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = await requireCapability(request, "submit_feedback");
  if (!auth) return NextResponse.json({ error: "Feedback submission access is required." }, { status: 403 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid feedback report is required." }, { status: 400 });

  const rawFeedbackType = body.feedback_type ?? body.type;
  const feedbackType = typeof rawFeedbackType === "string"
    ? FEEDBACK_TYPES.find((type) => type.toLowerCase() === rawFeedbackType.trim().toLowerCase())
    : undefined;
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!feedbackType) {
    return NextResponse.json({ error: "Choose Problem, Bug, or Suggestion." }, { status: 400 });
  }
  if (!description || description.length > 10000) {
    return NextResponse.json({ error: "Description is required and must be 10,000 characters or fewer." }, { status: 400 });
  }
  if (!validRoute(body.page_route)) return NextResponse.json({ error: "The originating page is invalid." }, { status: 400 });

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Feedback submission is unavailable until server database credentials are configured." }, { status: 503 });
  const { data, error } = await admin.from("user_feedback")
    .insert({
      hotel_id: HOTEL_ID,
      user_id: auth.principal.identity.id,
      user_name: auth.principal.profile.full_name?.trim() || "Name not set",
      user_role: auth.principal.profile.role,
      feedback_type: feedbackType,
      description,
      page_route: body.page_route,
      app_version: `${APP_TITLE} ${BUILD_VERSION}`,
      status: "New",
    })
    .select("id, created_at, status")
    .single();
  if (error || !data) return NextResponse.json({ error: "Feedback could not be submitted." }, { status: 503 });
  return NextResponse.json({ feedback: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireCapability(request, "review_feedback");
  if (!auth) return NextResponse.json({ error: "Feedback review access is required." }, { status: 403 });
  const body = await readBody(request);
  if (!body || typeof body.id !== "string" || !body.id.trim()) {
    return NextResponse.json({ error: "Feedback id is required." }, { status: 400 });
  }
  if (typeof body.status !== "string" || !FEEDBACK_STATUSES.includes(body.status as FeedbackStatus)) {
    return NextResponse.json({ error: "Choose New, Reviewed, Planned, or Resolved." }, { status: 400 });
  }

  const id = body.id.trim();
  const { data: existing, error: lookupError } = await auth.admin.from("user_feedback")
    .select("id, status")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Feedback could not be loaded." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Feedback not found." }, { status: 404 });

  const status = body.status as FeedbackStatus;
  const reviewedAt = status === "New" ? null : existing.status === "New" ? new Date().toISOString() : undefined;
  const update: Record<string, unknown> = {
    status,
    resolved_at: status === "Resolved" ? new Date().toISOString() : null,
  };
  if (reviewedAt !== undefined) update.reviewed_at = reviewedAt;

  const { data, error } = await auth.admin.from("user_feedback")
    .update(update)
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .select("id, created_at, user_id, user_name, user_role, feedback_type, description, page_route, app_version, status, reviewed_at, resolved_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Feedback status could not be updated." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Feedback not found." }, { status: 404 });
  return NextResponse.json({ feedback: data });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireCapability(request, "review_feedback");
  if (!auth) return NextResponse.json({ error: "Feedback review access is required." }, { status: 403 });

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "Feedback id is required." }, { status: 400 });

  const { data, error } = await auth.admin.from("user_feedback")
    .delete()
    .eq("hotel_id", HOTEL_ID)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Feedback could not be deleted." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Feedback not found." }, { status: 404 });
  return NextResponse.json({ ok: true, id: data.id });
}
