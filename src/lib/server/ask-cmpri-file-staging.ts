import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ASK_FILE_LIMIT, type AskFileDescriptor, type AskStagedFile } from "@/lib/ask-cmpri/files";
import { STAFF_FILE_BUCKET, staffFileInput } from "@/lib/staff-note-media";
import { requireUserAttempt, type AuthAttempt } from "@/lib/server/auth";

type Authorized = Extract<AuthAttempt, { ok: true }>;
type Token = { version: 1; actor: string; hotel: string; expiresAt: number; descriptor: AskFileDescriptor };
const TTL = 24 * 60 * 60 * 1000;
const PREFIX = "ask-file.";
const SIGNING_CONTEXT = "cmpri-ask-original-file:v1:";
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function askFileDescriptor(input: unknown): AskFileDescriptor {
  if (!isObject(input) || Object.keys(input).some(key => !["id", "name", "type", "size", "sha256"].includes(key))) throw Error("Choose a valid original file.");
  const file = staffFileInput({ id: input.id, name: input.name, type: input.type, size: input.size });
  if (!file || /[\\/]/.test(file.name) || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) throw Error("Choose a nonempty original up to 100 MB with its actual SHA-256.");
  return { ...file, id: file.id.toLowerCase(), sha256: input.sha256 };
}

function filePath(auth: Authorized, descriptor: AskFileDescriptor) {
  return `ask-files/v1/${auth.principal.hotelId}/${auth.principal.identity.id}/${descriptor.id}-${descriptor.sha256}`;
}

async function authorize(request: NextRequest): Promise<Authorized> {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp) throw Error("Sign in to CMPRI before using an original file.");
  request.signal.throwIfAborted();
  return auth;
}

function signature(payload: string) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw Error("Private Ask file review is not configured.");
  return createHmac("sha256", key).update(SIGNING_CONTEXT).update(payload).digest();
}

function verifyToken(token: string, auth: Authorized, expired = false): Token {
  if (auth.mcp) throw Error("Sign in to CMPRI before using an original file.");
  if (typeof token !== "string" || !token.startsWith(PREFIX) || token.length > 10000) throw Error("Select the original file again.");
  const [payload, signed, extra] = token.slice(PREFIX.length).split(".");
  if (!payload || !signed || extra !== undefined) throw Error("The original file reference is invalid.");
  const provided = Buffer.from(signed, "base64url"), expected = signature(payload);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw Error("The original file reference changed.");
  const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!isObject(parsed) || parsed.version !== 1 || parsed.actor !== auth.principal.identity.id || parsed.hotel !== auth.principal.hotelId
    || !Number.isSafeInteger(parsed.expiresAt) || !expired && Number(parsed.expiresAt) <= Date.now()) throw Error("The original file reference expired or belongs to another CMPRI account.");
  return { version: 1, actor: String(parsed.actor), hotel: String(parsed.hotel), expiresAt: Number(parsed.expiresAt), descriptor: askFileDescriptor(parsed.descriptor) };
}

/** Cheap signed metadata check for discovery; consuming bytes still reauthenticates and rehashes. */
export function describeAskStagedFile(auth: Authorized, token: string): AskStagedFile {
  const evidence = verifyToken(token, auth);
  return { ...evidence.descriptor, expiresAt: evidence.expiresAt, token };
}

/** Only this account's expired Ask staging is eligible; saved module files are untouched. */
async function cleanExpired(auth: Authorized) {
  const prefix = `ask-files/v1/${auth.principal.hotelId}/${auth.principal.identity.id}`;
  const storage = auth.admin.storage.from(STAFF_FILE_BUCKET);
  const listed = await storage.list(prefix, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  if (listed.error) return;
  const paths = (listed.data || []).filter(item => item.id && item.created_at && Date.parse(item.created_at) < Date.now() - TTL
    && /^[a-f0-9-]{36}-[a-f0-9]{64}$/.test(item.name)).map(item => `${prefix}/${item.name}`);
  if (paths.length) await storage.remove(paths);
}

export async function prepareAskFile(request: NextRequest, input: unknown) {
  const descriptor = askFileDescriptor(input), auth = await authorize(request);
  const bucket = await auth.admin.storage.getBucket(STAFF_FILE_BUCKET);
  if (bucket.error || !bucket.data || bucket.data.public || !Number.isFinite(Number(bucket.data.file_size_limit)) || Number(bucket.data.file_size_limit) < ASK_FILE_LIMIT) throw Error("Private original-file storage is unavailable.");
  await cleanExpired(auth);
  const signed = await auth.admin.storage.from(STAFF_FILE_BUCKET).createSignedUploadUrl(filePath(auth, descriptor), { upsert: false });
  if (signed.error || !signed.data?.signedUrl) throw Error("The original file upload could not be prepared.");
  request.signal.throwIfAborted();
  return { descriptor, signedUrl: signed.data.signedUrl, contentType: descriptor.type };
}

async function originalBytes(request: NextRequest, auth: Authorized, descriptor: AskFileDescriptor) {
  const storage = auth.admin.storage.from(STAFF_FILE_BUCKET), path = filePath(auth, descriptor);
  const info = await storage.info(path);
  if (info.error || !info.data || info.data.size !== descriptor.size || info.data.contentType !== descriptor.type) throw Error("The stored original's size or media type could not be verified.");
  if (info.data.createdAt && Date.parse(info.data.createdAt) < Date.now() - TTL) throw Error("This original file expired. Select it again.");
  request.signal.throwIfAborted();
  const downloaded = await storage.download(path);
  if (downloaded.error || !downloaded.data || downloaded.data.size !== descriptor.size) throw Error("The original file upload is incomplete.");
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  request.signal.throwIfAborted();
  if (bytes.length !== descriptor.size || createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw Error("The uploaded bytes differ from the selected original file.");
  return bytes;
}

export async function finalizeAskFile(request: NextRequest, input: unknown): Promise<{ file: AskStagedFile }> {
  const descriptor = askFileDescriptor(input), auth = await authorize(request);
  await originalBytes(request, auth, descriptor);
  const expiresAt = Date.now() + TTL;
  const value: Token = { version: 1, actor: auth.principal.identity.id, hotel: auth.principal.hotelId, expiresAt, descriptor };
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return { file: { ...descriptor, expiresAt, token: PREFIX + payload + "." + signature(payload).toString("base64url") } };
}

/** Current account authorization and exact original bytes are rechecked for every use. */
export async function readAskStagedFile(request: NextRequest, token: string) {
  const auth = await authorize(request), evidence = verifyToken(token, auth);
  const bytes = await originalBytes(request, auth, evidence.descriptor);
  return { auth, descriptor: evidence.descriptor, bytes,
    file: new File([new Uint8Array(bytes)], evidence.descriptor.name, { type: evidence.descriptor.type }) };
}

export async function removeAskFile(request: NextRequest, input: unknown) {
  const auth = await authorize(request);
  if (!isObject(input) || Object.keys(input).length !== 1 || !("token" in input || "descriptor" in input)) throw Error("Choose the original file reference to remove.");
  const descriptor = typeof input.token === "string" ? verifyToken(input.token, auth, true).descriptor : askFileDescriptor(input.descriptor);
  const removed = await auth.admin.storage.from(STAFF_FILE_BUCKET).remove([filePath(auth, descriptor)]);
  if (removed.error) throw Error("The temporary original could not be removed yet.");
  return { ok: true };
}
