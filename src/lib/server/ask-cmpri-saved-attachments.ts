import "server-only";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { SUPABASE_URL } from "@/lib/supabase/config";
import { STAFF_FILE_BUCKET, STAFF_FILE_LIMIT } from "@/lib/staff-note-media";
import { isUuid } from "@/lib/uuid";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const LIMIT = STAFF_FILE_LIMIT;
type SavedFile = { id: string; name: string; type: string; url: string; size?: number };
class SavedAttachmentError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

function reply(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: HEADERS });
}

function selectedQuery(request: NextRequest, names: string[]) {
  const entries = [...request.nextUrl.searchParams];
  if (entries.length !== names.length || names.some(name => request.nextUrl.searchParams.getAll(name).length !== 1)
    || entries.some(([name]) => !names.includes(name))) return null;
  return Object.fromEntries(entries);
}

function nativeRequest(request: NextRequest, path: string) {
  const authorization = request.headers.get("authorization");
  return new NextRequest(new URL(path, request.url), { headers: authorization ? { authorization } : {}, signal: request.signal });
}

function safeKey(value: string) {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/%\x00-\x1f\x7f]/.test(value);
}

function savedFile(value: unknown, needsSize = false): SavedFile {
  if (!value || typeof value !== "object") throw new SavedAttachmentError("The saved attachment details are unavailable.");
  const file = value as Record<string, unknown>;
  if (typeof file.id !== "string" || typeof file.name !== "string" || !file.name.trim() || file.name.length > 255
    || /[\x00-\x1f\x7f]/.test(file.name) || typeof file.type !== "string" || !/^[-\w.+]+\/[-\w.+]+$/.test(file.type)
    || typeof file.url !== "string" || file.url.length > 16000) throw new SavedAttachmentError("The saved attachment details are unavailable.");
  const size = file.size;
  if (needsSize && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > LIMIT)) {
    throw new SavedAttachmentError("The saved attachment has an invalid size or exceeds its native 100 MB limit.", typeof size === "number" && size > LIMIT ? 413 : 503);
  }
  return { id: file.id, name: file.name, type: file.type.toLowerCase(), url: file.url, ...(needsSize ? { size: size as number } : {}) };
}

/** Only a URL returned by the authorized native record may identify this fixed object. */
function privateObject(file: SavedFile, objectPath: string, bucket: string) {
  const configured = new URL(SUPABASE_URL), url = new URL(file.url);
  const expected = `/storage/v1/object/sign/${bucket}/${objectPath}`;
  if (configured.protocol !== "https:" || url.protocol !== "https:" || url.origin !== configured.origin
    || url.username || url.password || url.hash || decodeURIComponent(url.pathname) !== expected
    || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")
    || url.searchParams.getAll("download").length > 1 || [...url.searchParams.keys()].some(key => !["token", "download"].includes(key))) {
    throw new SavedAttachmentError("The native attachment source could not be verified.");
  }
  return url;
}

async function originalResponse(request: NextRequest, file: SavedFile, bucket: string, objectPath: string, source: string) {
  const url = privateObject(file, objectPath, bucket);
  request.signal.throwIfAborted();
  const response = await fetch(url, { headers: { Accept: file.type, "Accept-Encoding": "identity" },
    credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: request.signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SavedAttachmentError(response.status === 404 ? "The saved attachment original is no longer available." : "The saved attachment original could not be loaded.", response.status === 404 ? 404 : 503);
  }
  if (response.status !== 200 || response.headers.has("content-range")) {
    await response.body?.cancel();
    throw new SavedAttachmentError("The saved attachment source did not return the complete original.", 409);
  }
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (mime !== file.type || encoding && encoding !== "identity") {
    await response.body?.cancel();
    throw new SavedAttachmentError("The saved attachment's original type or transfer could not be verified.", 409);
  }
  const rawSize = response.headers.get("content-length"), declared = rawSize === null ? undefined : Number(rawSize);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 || declared > LIMIT || file.size !== undefined && declared !== file.size)) {
    await response.body?.cancel();
    throw new SavedAttachmentError("The saved attachment size does not match its original or exceeds the native 100 MB limit.", declared > LIMIT ? 413 : 409);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SavedAttachmentError("The saved attachment original is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) throw new SavedAttachmentError("The saved attachment exceeds the native 100 MB limit.", 413);
      chunks.push(value);
    }
    request.signal.throwIfAborted();
    if (!size || declared !== undefined && size !== declared || file.size !== undefined && size !== file.size) {
      throw new SavedAttachmentError("The saved attachment bytes do not match the original size.", 409);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, size), sha256 = createHash("sha256").update(bytes).digest("hex");
  const fallback = file.name.replace(/[^\x20-\x7e]|["\\;]/g, "_");
  const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  return new NextResponse(new Uint8Array(bytes), { headers: { ...HEADERS,
    "Content-Type": file.type, "Content-Length": String(size),
    "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodedName}`,
    "X-CMPRI-Source-SHA256": sha256, "X-CMPRI-Export-Source": source,
  } });
}

function failure(request: NextRequest, error: unknown) {
  if (request.signal.aborted) throw error;
  return reply(error instanceof SavedAttachmentError ? error.message : "The saved attachment original could not be verified. Open its native record to retry.", error instanceof SavedAttachmentError ? error.status : 503);
}

/** The same ticket attachment GET decides access before any storage request. */
export async function readAskWorkOrderAttachment(request: NextRequest, workOrderId: string): Promise<Response> {
  const query = selectedQuery(request, ["attachmentId"]);
  if (!isUuid(workOrderId) || !query || !safeKey(query.attachmentId)) return reply("Choose an exact work order and its saved attachment ID.", 400);
  const { GET } = await import("@/app/api/work-orders/[id]/attachments/route");
  const native = await GET(nativeRequest(request, `/api/work-orders/${workOrderId}/attachments`), { params: Promise.resolve({ id: workOrderId }) });
  if (!native) return reply("The native attachment list is unavailable.", 503);
  if (!native.ok) return native;
  try {
    const body = await native.json();
    if (!Array.isArray(body.images)) throw new SavedAttachmentError("The native attachment list is unavailable.");
    const matches = body.images.filter((file: { id?: unknown }) => file?.id === query.attachmentId);
    if (matches.length !== 1) return reply("That saved attachment is not available on this work order.", 404);
    const file = savedFile(matches[0]);
    if (!/^(image|video)\//.test(file.type)) throw new SavedAttachmentError("The native work-order media type could not be verified.");
    return await originalResponse(request, file, "asset-documentation", `${HOTEL_ID}/work-orders/${workOrderId}/${file.id}`, "Saved original from the selected work-order attachment.");
  } catch (error) { return failure(request, error); }
}

/** Read only attachments of the exact freshly authorized Staff Note, not its parent or another note. */
export async function readAskStaffNoteAttachment(request: NextRequest): Promise<Response> {
  const query = selectedQuery(request, ["noteId", "attachmentId"]);
  if (!query || !isUuid(query.noteId) || !isUuid(query.attachmentId)) return reply("Choose an exact Staff Note and its saved attachment ID.", 400);
  const { GET } = await import("@/app/api/staff-notes/route");
  const native = await GET(nativeRequest(request, `/api/staff-notes?note=${query.noteId}`));
  if (!native) return reply("The native Staff Note is unavailable.", 503);
  if (!native.ok) return native;
  try {
    const body = await native.json();
    if (!Array.isArray(body.notes) || !isUuid(body.hotelId)) throw new SavedAttachmentError("The native Staff Note details are unavailable.");
    const notes = body.notes.filter((note: { id?: unknown }) => note?.id === query.noteId);
    if (notes.length !== 1 || !isUuid(notes[0].author_user_id) || !Array.isArray(notes[0].attachments)) return reply("That Staff Note is not available.", 404);
    const matches = notes[0].attachments.filter((file: { id?: unknown }) => file?.id === query.attachmentId);
    if (matches.length !== 1) return reply("That saved attachment is not available on this Staff Note.", 404);
    const file = savedFile(matches[0], true);
    return await originalResponse(request, file, STAFF_FILE_BUCKET, `${body.hotelId}/${notes[0].author_user_id}/${file.id}`, "Saved original from the selected Staff Note attachment.");
  } catch (error) { return failure(request, error); }
}

/** Resolve current Notepad sharing and file membership before signing its original. */
export async function readAskNotepadAttachment(request: NextRequest): Promise<Response> {
  const query = selectedQuery(request, ["noteId", "attachmentId"]);
  if (!query || !isUuid(query.noteId) || !isUuid(query.attachmentId)) return reply("Choose an exact Notepad note and its saved attachment ID.", 400);
  const { requireUser } = await import("@/lib/server/auth");
  const auth = await requireUser(request);
  if (!auth) return reply("Sign in is required.", 401);
  try {
    const { resolveNotepadAttachment } = await import("@/lib/server/notepad-store");
    const resolved = await resolveNotepadAttachment(auth.admin, auth.principal.hotelId, auth.principal.identity.id, query.noteId, query.attachmentId);
    if (!resolved) return reply("That saved attachment is not available on this Notepad note.", 404);
    const signed = await auth.admin.storage.from(resolved.bucket).createSignedUrl(resolved.path, 60);
    if (signed.error || !signed.data?.signedUrl) throw new SavedAttachmentError("The native attachment original could not be opened.");
    const file = savedFile({ ...resolved, url: signed.data.signedUrl }, true);
    return await originalResponse(request, file, resolved.bucket, resolved.path, "Saved original from the selected Notepad attachment.");
  } catch (error) { return failure(request, error); }
}
