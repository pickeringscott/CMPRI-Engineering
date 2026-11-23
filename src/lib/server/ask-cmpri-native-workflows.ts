import "server-only";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { prepareMcpPoolLogInput } from "@/lib/pool-log";
import { summarizeRoomOperations } from "@/lib/room-operations";
import { requireUser } from "@/lib/server/auth";
import { runDriveRoomReportImport } from "@/lib/server/drive-room-report-import";
import { IMPORT_UPLOAD_BUCKET } from "@/lib/server/import-upload";

const HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
type JsonObject = Record<string, unknown>;
type NativeResult = { status: number; body: JsonObject | null };
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const error = (message: string, status = 400) => Response.json({ error: message }, { status, headers: HEADERS });

/** Paths are literals supplied by these wrappers, never by the model. */
function requestFor(original: NextRequest, pathname: string, method: "GET" | "POST", body?: JsonObject): NextRequest {
  const headers = new Headers({ Authorization: original.headers.get("authorization") || "" });
  const property = original.headers.get("x-cmpri-property");
  if (property) headers.set("x-cmpri-property", property);
  if (method === "POST") headers.set("Content-Type", "application/json");
  return new NextRequest(new URL(pathname, original.url), {
    method, headers, signal: original.signal,
    ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
  });
}

/** Preserve native large-file transport without following supplied signed URLs. */
async function importResult(original: NextRequest, response: Response): Promise<NativeResult> {
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok || !object(parsed) || !object(parsed.importResult)) return { status: response.status, body: object(parsed) ? parsed : null };
  const descriptor = parsed.importResult;
  if (typeof descriptor.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(descriptor.id)
    || !Number.isSafeInteger(descriptor.count) || Number(descriptor.count) < 1 || Number(descriptor.count) > 64
    || !Array.isArray(descriptor.hashes) || descriptor.hashes.length !== descriptor.count
    || descriptor.hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    return { status: 502, body: { error: "The native import review descriptor is invalid." } };
  }
  const auth = await requireUser(original);
  if (!auth) return { status: 401, body: { error: "Sign in is required." } };
  const chunks: Buffer[] = [];
  for (let index = 0; index < Number(descriptor.count); index++) {
    const path = `${auth.principal.hotelId}/${auth.principal.identity.id}/results/${descriptor.id}-${index}.json`;
    const downloaded = await auth.admin.storage.from(IMPORT_UPLOAD_BUCKET).download(path);
    if (downloaded.error || !downloaded.data) return { status: 502, body: { error: "The complete native import review could not be read." } };
    const encoded: unknown = JSON.parse(await downloaded.data.text());
    if (typeof encoded !== "string") return { status: 502, body: { error: "The native import review chunk is invalid." } };
    const chunk = Buffer.from(encoded, "base64");
    if (chunk.length > 16 * 1024 * 1024 || createHash("sha256").update(chunk).digest("hex") !== descriptor.hashes[index]) {
      return { status: 502, body: { error: "The native import review is incomplete or changed." } };
    }
    chunks.push(chunk);
  }
  const complete: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return { status: response.status, body: object(complete) ? complete : null };
}

/** PO/history/file adapters use the same full private result transport as Daily Ops. */
export async function hydrateNativeImportResponse(request: NextRequest, response: Response): Promise<Response> {
  const result = await importResult(request, response);
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}

/** Deterministic reporting required by the existing Daily Ops AI workflow. */
async function roomImportOutcome(original: NextRequest, response: Response, validationOnly = false): Promise<Response> {
  const result = await importResult(original, response);
  const body = result.body;
  if (result.status < 200 || result.status >= 300 || !body) return Response.json(body, { status: result.status, headers: HEADERS });
  if (validationOnly) return Response.json({ ...body, validation_only: true, message: "Daily Room Operations validated only. No accepted room report was replaced." }, { status: result.status, headers: HEADERS });
  if (typeof body.import_id !== "string" || typeof body.date !== "string") return Response.json(body, { status: result.status, headers: HEADERS });

  const route = await import("@/app/api/room-operations/route");
  let readError = "The saved import's refreshed room view could not be verified.";
  let view: JsonObject | null = null;
  try {
    let refreshed = await route.GET(requestFor(original, `/api/room-operations?date=${encodeURIComponent(body.date)}`, "GET"));
    // Older accepted source reports can be carried into today's retained view.
    if (refreshed.status === 400) refreshed = await route.GET(requestFor(original, "/api/room-operations", "GET"));
    const payload: unknown = await refreshed.json().catch(() => null);
    if (refreshed.ok && object(payload) && payload.source_date === body.date && Array.isArray(payload.rows)) view = payload;
    else if (object(payload) && typeof payload.error === "string") readError = payload.error;
  } catch { /* A completed native save remains completed when readback fails. */ }
  const source = view ? "native_view" : "save_response";
  const rawRows = view?.rows ?? body.rows;
  const warnings = Array.isArray(body.warnings) ? [...body.warnings] : typeof body.warnings === "string" ? [body.warnings] : [];
  if (!view) warnings.push(`Import saved, but refreshed readback is unavailable: ${readError}`);
  if (!Array.isArray(rawRows) || rawRows.some(row => !object(row) || !["string", "number"].includes(typeof row.room))) {
    return Response.json({ ...body, warnings, room_operations_report: { available: false, refreshed: false, date: body.date },
      message: `Daily room operations were saved for ${body.date}. The complete room list could not be read back, so out-of-order rooms and moves are not confirmed. Open Daily Room Operations and refresh.` }, { status: result.status, headers: HEADERS });
  }
  const rows: Array<JsonObject & { room: string }> = rawRows.map(row => ({ ...(row as JsonObject), room: String((row as JsonObject).room) }));
  const { outOfOrderRooms } = summarizeRoomOperations(rows, body.date);
  const moves = rows.flatMap(row => {
    const from = typeof row.move_from === "string" ? row.move_from : "";
    const to = typeof row.move_to === "string" ? row.move_to : "";
    return from || to ? [{ room: row.room, move_from: from, move_to: to }] : [];
  });
  const message = [
    typeof body.message === "string" ? body.message : `Daily room operations saved for ${body.date}.`,
    view ? "The native room view was read back." : "The following details are from the complete native save response; refreshed readback was unavailable.",
    outOfOrderRooms.length ? `Out of order: ${outOfOrderRooms.map(row => `${row.room} (${row.status})`).join(", ")}.` : "Out of order: none.",
    moves.length ? `Room moves: ${moves.map(move => `${move.move_from || "source room unreported"} → ${move.move_to || "destination room unreported"}`).join(", ")}.` : "Room moves: none.",
  ].join(" ");
  return Response.json({ ...body, ...(warnings.length ? { warnings } : {}), message,
    room_operations_report: { available: true, refreshed: Boolean(view), source, date: body.date, source_date: view?.source_date ?? body.date,
      out_of_order_rooms: outOfOrderRooms, moves } }, { status: result.status, headers: HEADERS });
}

export async function saveNativeRoomOperations(request: NextRequest): Promise<Response> {
  const input: unknown = await request.clone().json().catch(() => null);
  const route = await import("@/app/api/room-operations/route");
  return roomImportOutcome(request, await route.POST(request), object(input) && input.validate_only === true);
}

export async function saveNativeGuestReports(request: NextRequest): Promise<Response> {
  const input: unknown = await request.clone().json().catch(() => null);
  const route = await import("@/app/api/room-operations/guest-reports/route");
  return roomImportOutcome(request, await route.POST(request), object(input) && input.validateOnly === true);
}

export async function importNativeDriveButton(request: NextRequest): Promise<Response> {
  const route = await import("@/app/api/room-operations/guest-reports/drive/route");
  return roomImportOutcome(request, await route.POST(request));
}

/** A model-provided false can never turn either preview into a commit. */
export async function validateNativeRoomOperations(request: NextRequest): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  if (!object(body)) return error("A JSON room-report object is required.");
  const route = await import("@/app/api/room-operations/route");
  return route.POST(requestFor(request, "/api/room-operations", "POST", { ...body, validate_only: true }));
}

export async function validateNativeGuestReports(request: NextRequest): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  if (!object(body)) return error("A JSON guest-report object is required.");
  const route = await import("@/app/api/room-operations/guest-reports/route");
  const result = await importResult(request, await route.POST(requestFor(request, "/api/room-operations/guest-reports", "POST", { ...body, validateOnly: true })));
  return Response.json(result.body, { status: result.status, headers: HEADERS });
}

/** Same existing preview/digest/concurrency adapter as the external AI workflow. */
export async function nativeDriveRoomReports(request: NextRequest, commit: boolean): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  if (!object(body)) return error("A JSON Drive-import object is required.");
  const drive = await import("@/app/api/room-operations/guest-reports/drive/route");
  const reports = await import("@/app/api/room-operations/guest-reports/route");
  try {
    const result = await runDriveRoomReportImport({ ...body, source: "drive", validate_only: !commit },
      async () => importResult(request, await drive.GET(requestFor(request, "/api/room-operations/guest-reports/drive", "GET"))),
      async input => importResult(request, await reports.POST(requestFor(request, "/api/room-operations/guest-reports", "POST", input))));
    const response = Response.json(result.body, { status: result.status, headers: HEADERS });
    return commit ? roomImportOutcome(request, response) : response;
  } catch {
    return error("The complete native Drive report review could not be verified. Nothing is confirmed as saved; reload the current report before retrying.", 502);
  }
}

/** Reuse established AI aliases/test-entry behavior; native POST owns validation. */
export async function saveNativePoolLog(request: NextRequest): Promise<Response> {
  const input: unknown = await request.json().catch(() => null);
  if (!object(input)) return error("A JSON pool-log object is required.");
  const date = input.log_date ?? input.date;
  if (typeof date !== "string") return error("Use the pool-log date from the current read.");
  const route = await import("@/app/api/pool-log/route");
  const read = await route.GET(requestFor(request, `/api/pool-log?date=${encodeURIComponent(date)}`, "GET"));
  if (!read.ok) return read;
  const snapshot: unknown = await read.json().catch(() => null);
  if (!object(snapshot) || !Array.isArray(snapshot.facilities)) return error("Active native pool facilities could not be verified. Nothing was saved.", 502);
  try {
    const body = prepareMcpPoolLogInput(input, snapshot.facilities);
    return route.POST(requestFor(request, "/api/pool-log", "POST", body));
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "The pool-log input is invalid.");
  }
}
