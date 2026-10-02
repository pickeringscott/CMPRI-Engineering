import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { requireUser } from "@/lib/server/auth";
import { integrationErrorStatus } from "@/lib/server/integrations-safe-mode";
import { applyLivePmChanges, livePmWritesEnabled, type LivePmProposedCell } from "@/lib/server/live-pm";
import { profileHasRole } from "@/lib/server/roles";

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validProposalId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function proposedCells(value: unknown): LivePmProposedCell[] | null {
  if (!Array.isArray(value) || value.length > 1200) return null;
  const cells: LivePmProposedCell[] = [];
  for (const item of value) {
    const cell = objectBody(item);
    if (!cell
      || typeof cell.sheet !== "string"
      || !Number.isSafeInteger(cell.row)
      || !Number.isSafeInteger(cell.column)
      || typeof cell.label !== "string"
      || (cell.kind !== "checkbox" && cell.kind !== "completion-date")
      || typeof cell.expectedValue !== "string"
      || typeof cell.proposedValue !== "string") return null;
    cells.push({
      sheet: cell.sheet,
      row: Number(cell.row),
      column: Number(cell.column),
      label: cell.label,
      kind: cell.kind,
      expectedValue: cell.expectedValue,
      proposedValue: cell.proposedValue,
    });
  }
  return cells;
}

function dbError(error: { message?: string; code?: string } | null, fallback: string) {
  return NextResponse.json(
    { error: error?.message || fallback },
    { status: error?.code === "23505" ? 409 : 503 },
  );
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401 });
  if (!profileHasRole(auth.principal.profile, "system_admin")) {
    return NextResponse.json({ error: "Only a System Administrator can review PM proposals." }, { status: 403 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = objectBody(await request.json());
  } catch {
    return NextResponse.json({ error: "A valid PM review action is required." }, { status: 400 });
  }
  if (!body || !validProposalId(body.proposalId)
    || (body.decision !== "approve" && body.decision !== "reject")
    || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    return NextResponse.json({ error: "Choose a valid proposal and review action." }, { status: 400 });
  }
  if (body.reviewNote !== undefined
    && (typeof body.reviewNote !== "string" || body.reviewNote.length > 2000)) {
    return NextResponse.json({ error: "The reviewer note is invalid." }, { status: 400 });
  }
  const reviewNote = typeof body.reviewNote === "string" ? body.reviewNote.trim() : "";
  const proposalResult = await auth.admin.from("cmpri_pm_proposals")
    .select("id, status, proposed_cells, revision")
    .eq("hotel_id", HOTEL_ID)
    .eq("id", body.proposalId)
    .in("status", ["pending", "processing"])
    .maybeSingle();
  if (proposalResult.error) return dbError(proposalResult.error, "The PM proposal could not be loaded.");
  const proposal = proposalResult.data;
  if (!proposal) return NextResponse.json({ error: "This PM proposal is no longer awaiting review." }, { status: 404 });
  if (Number(proposal.revision) !== Number(body.expectedRevision)) {
    return NextResponse.json({ error: "This proposal changed after it was loaded. Refresh the review queue.", conflict: true }, { status: 409 });
  }
  const actor = auth.principal.identity.id;
  const reviewedAt = new Date().toISOString();

  if (body.decision === "reject") {
    if (proposal.status !== "pending") {
      return NextResponse.json({ error: "A proposal already being approved cannot be rejected. Refresh the queue.", conflict: true }, { status: 409 });
    }
    const rejected = await auth.admin.from("cmpri_pm_proposals")
      .update({ status: "rejected", reviewed_by: actor, reviewed_at: reviewedAt, review_note: reviewNote })
      .eq("hotel_id", HOTEL_ID)
      .eq("id", proposal.id)
      .eq("status", "pending")
      .eq("revision", Number(body.expectedRevision))
      .select("id, status, revision")
      .maybeSingle();
    if (rejected.error) return dbError(rejected.error, "The PM proposal could not be rejected.");
    if (!rejected.data) return NextResponse.json({ error: "This proposal changed before it could be rejected.", conflict: true }, { status: 409 });
    return NextResponse.json({ proposal: rejected.data });
  }

  const cells = proposedCells(proposal.proposed_cells);
  if (!cells) return NextResponse.json({ error: "This PM proposal contains invalid workbook changes and cannot be approved." }, { status: 409 });
  if (cells.length && !livePmWritesEnabled()) {
    return NextResponse.json({ error: "Live PM approval writes are disabled until the development review is complete." }, { status: 409 });
  }

  let claimedRevision = Number(proposal.revision);
  if (proposal.status === "pending") {
    const claimed = await auth.admin.from("cmpri_pm_proposals")
      .update({ status: "processing", reviewed_by: actor, reviewed_at: null, review_note: null })
      .eq("hotel_id", HOTEL_ID)
      .eq("id", proposal.id)
      .eq("status", "pending")
      .eq("revision", Number(body.expectedRevision))
      .select("revision")
      .maybeSingle();
    if (claimed.error) return dbError(claimed.error, "The PM proposal could not be reserved for approval.");
    if (!claimed.data) return NextResponse.json({ error: "Another reviewer changed this proposal. Refresh the queue.", conflict: true }, { status: 409 });
    claimedRevision = Number(claimed.data.revision);
  }

  try {
    await applyLivePmChanges(cells);
  } catch (error) {
    const released = await auth.admin.from("cmpri_pm_proposals")
      .update({ status: "pending", reviewed_by: null, reviewed_at: null, review_note: null })
      .eq("hotel_id", HOTEL_ID)
      .eq("id", proposal.id)
      .eq("status", "processing")
      .eq("revision", claimedRevision)
      .select("id")
      .maybeSingle();
    const message = error instanceof Error ? error.message : "Live PM workbook changes could not be applied.";
    if (released.error || !released.data) {
      return NextResponse.json(
        { error: `${message} The proposal could not be returned to the review queue; an administrator must inspect its processing status.` },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: integrationErrorStatus(error) });
  }

  const approved = await auth.admin.from("cmpri_pm_proposals")
    .update({ status: "approved", reviewed_by: actor, reviewed_at: new Date().toISOString(), review_note: reviewNote })
    .eq("hotel_id", HOTEL_ID)
    .eq("id", proposal.id)
    .eq("status", "processing")
    .eq("revision", claimedRevision)
    .select("id, status, revision, reviewed_at")
    .maybeSingle();
  if (approved.error) return dbError(approved.error, "The workbook was updated, but the PM approval status could not be recorded.");
  if (!approved.data) {
    return NextResponse.json(
      { error: "The workbook update was verified, but the proposal approval status could not be recorded. Refresh the review queue before retrying.", conflict: true },
      { status: 409 },
    );
  }
  return NextResponse.json({ proposal: approved.data, written_cells: cells.length });
}
