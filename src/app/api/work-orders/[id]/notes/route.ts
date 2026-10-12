import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { isUuid } from "@/lib/uuid";
import { accountRoleDisplayName } from "@/lib/account-display";
import { historyLine } from "@/lib/ticket-note-presentation";

/** Append-only collaboration; never accepts replacement history or ticket fields. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth || !allows(auth.principal, "add_work_order_notes")) {
    return NextResponse.json({ error: "Work-order note permission is required." }, { status: 403 });
  }
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "A valid work-order ID is required." }, { status: 400 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !["notes", "expected_revision"].includes(key))
    || !Array.isArray(body.notes) || body.notes.length < 1 || body.notes.length > 50
    || body.notes.some((note: unknown) => typeof note !== "string" || !note.trim() || note.length > 10000)) {
    return NextResponse.json({ error: "Supply only new notes and the current ticket revision." }, { status: 400 });
  }
  if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1) {
    return NextResponse.json({ error: "Reload this ticket before saving." }, { status: 428 });
  }
  const { data: existing, error: lookupError } = await auth.admin.from("work_orders")
    .select("id, notes, status, revision").eq("hotel_id", HOTEL_ID).eq("id", id).maybeSingle();
  if (lookupError) return NextResponse.json({ error: "Could not read work order." }, { status: 503 });
  if (!existing) return NextResponse.json({ error: "Work order not found." }, { status: 404 });
  if (!["Open", "In Progress"].includes(existing.status)) {
    return NextResponse.json({ error: "Notes may only be added to open work orders." }, { status: 403 });
  }
  if (existing.revision !== body.expected_revision) {
    return NextResponse.json({ error: "This ticket changed. Reload before combining your notes." }, { status: 409 });
  }
  const profile = auth.principal.profile;
  const lines = body.notes.map((text: string, index: number) => historyLine({
    id: "", kind: "note", text: text.trim(), timestamp: new Date(Date.now() + index).toISOString(),
    actor: profile.full_name?.trim() || "CMPRI User", authorRole: accountRoleDisplayName(profile),
  }));
  const notes = String(existing.notes || "") + (existing.notes ? "\n" : "") + lines.join("\n");
  const { data, error } = await auth.admin.from("work_orders").update({
    notes, history_actor_user_id: auth.principal.identity.id,
    history_source: /^Bearer\s+cmpri_mcp_/i.test(request.headers.get("authorization") || "") ? "ChatGPT" : "CMPRI app",
  }).eq("hotel_id", HOTEL_ID).eq("id", id).eq("revision", body.expected_revision)
    .in("status", ["Open", "In Progress"]).select("*").maybeSingle();
  if (error) return NextResponse.json({ error: "The notes could not be saved." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "This ticket changed. Your notes were not saved; reload before retrying." }, { status: 409 });
  return NextResponse.json({ workOrder: data }, { headers: { "Cache-Control": "no-store" } });
}
