import "server-only";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import type { AuthAttempt } from "@/lib/server/auth";
import { requireUserAttempt } from "@/lib/server/auth";
import { manualAssetIdentity, serialRangeStatus, type NumericSerialRange } from "@/lib/manual-applicability";
import { inspectManualPdf, manualPdfMatchesEquipment } from "@/lib/manual-pdf-knowledge";
import type { ImportUploadDescriptor } from "@/lib/import-upload";
import { IMPORT_UPLOAD_BUCKET, prepareImportUpload, readImportUpload } from "@/lib/server/import-upload";
import { fetchAskPublicDocument } from "./ask-cmpri-public-document";

type Authorized = Extract<AuthAttempt, { ok: true }>;
export type AskVendorAsset = {
  id: string; hotel_id: string; active: boolean; asset_type: string; name: string;
  manufacturer: string | null; model_number: string | null; model_family: string | null; serial_number: string | null;
  updated_at: string; documentation_verified_at: string | null; documentation_revision_id: string | null;
  pdf_import_links: unknown[];
};
export type AskVendorReview = {
  complete: boolean; intended: "verify" | "reference";
  serial: { status: "unrestricted" | "range" | "unresolved"; range?: NumericSerialRange };
};
const descriptorSchema = z.object({ kind: z.literal("asset-documentation"), id: z.string().uuid(), name: z.string().min(1).max(255),
  size: z.number().int().min(1).max(104857600), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const tokenSchema = z.object({ version: z.literal(1), actor: z.string().uuid(), hotel: z.string().uuid(), assetId: z.string().uuid(),
  assetIdentity: z.string().regex(/^[a-f0-9]{64}$/), expires: z.number().int(), sourceUrl: z.string().max(4000),
  descriptor: descriptorSchema, intended: z.enum(["verify", "reference"]) });
type EvidenceToken = z.infer<typeof tokenSchema>;
const tokenPrefix = "vendor-document.";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const identityHash = (asset: AskVendorAsset) => sha(JSON.stringify({ ...manualAssetIdentity(asset), asset_type: asset.asset_type }));
const signingContext = "cmpri-ask-vendor-document:v1:";

function sign(payload: string) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("CMPRI document review is not configured.");
  return createHmac("sha256", key).update(signingContext).update(payload).digest();
}

export function verifyAskVendorDocumentToken(token: string, auth: Authorized): EvidenceToken {
  if (!token.startsWith(tokenPrefix) || token.length > 16000) throw new Error("Read the original vendor document again before continuing.");
  const [payload, signature, extra] = token.slice(tokenPrefix.length).split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("The document review reference is invalid.");
  const actual = Buffer.from(signature, "base64url"), expected = sign(payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("The document review reference changed.");
  const evidence = tokenSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  if (evidence.actor !== auth.principal.identity.id || evidence.hotel !== auth.principal.hotelId || evidence.expires <= Date.now()) {
    throw new Error("This document review is expired or belongs to another CMPRI account.");
  }
  return evidence;
}

/** Native read authorization precedes the property-scoped supplemental identity read. */
export async function loadAskVendorAsset(request: NextRequest, assetId: string): Promise<{ auth: Authorized; asset: AskVendorAsset }> {
  if (!z.string().uuid().safeParse(assetId).success) throw new Error("Choose the actual asset from CMPRI.");
  const auth = await requireUserAttempt(request);
  if (!auth.ok) throw new Error("Sign in to CMPRI before reading equipment documentation.");
  const authorization = request.headers.get("authorization") || "";
  const headers = { authorization };
  const assetsRoute = await import("@/app/api/assets/route");
  const listing = await assetsRoute.GET(new NextRequest(new URL("/api/assets?scope=property&include_documentation=false", request.url), { headers, signal: request.signal }));
  if (!listing.ok) throw new Error("Your current CMPRI role cannot read this equipment.");
  const data = await listing.json();
  if (!Array.isArray(data.assets) || !data.assets.some((asset: { id?: string }) => asset.id === assetId)) throw new Error("The selected asset is not available to this CMPRI account.");
  const docsRoute = await import("@/app/api/assets/documentation/route");
  const documents = await docsRoute.GET(new NextRequest(new URL(`/api/assets/documentation?asset_id=${encodeURIComponent(assetId)}`, request.url), { headers, signal: request.signal }));
  if (!documents.ok) throw new Error("Your current CMPRI role cannot read this asset's documents.");
  const row = await auth.admin.from("assets").select("id,hotel_id,active,asset_type,name,manufacturer,model_number,model_family,serial_number,updated_at,documentation_verified_at,documentation_revision_id,pdf_import_links")
    .eq("id", assetId).eq("hotel_id", auth.principal.hotelId).maybeSingle();
  if (row.error || !row.data) throw new Error("The current asset identity could not be verified.");
  return { auth, asset: row.data as AskVendorAsset };
}

/** Exact printed numeric limits are usable; ambiguous restrictions never become a match. */
export function askVendorSerialReview(text: string): AskVendorReview["serial"] {
  const label = "(?:serial\\s*(?:numbers?|nos?\\.?|#)?|s\\s*/\\s*n)";
  const ranges = [...text.matchAll(new RegExp("\\b" + label + "\\s*(?:(?:range|from)\\s*)?[:#]?\\s*(\\d{1,32})\\s*(?:through|to|[-–—])\\s*(\\d{1,32})\\b", "gi"))];
  const restricted = new RegExp("\\b" + label + "(?:[^\\n.]{0,80}\\b(?:range|from|through|before|after|prior|starting|beginning|above|below|between|prefix|suffix|up to|and later|and earlier)\\b|\\s*[:#]?\\s*[A-Z0-9]*\\d[A-Z0-9]*)|\\b(?:applicable|applies|only|effective)\\b[^\\n.]{0,65}\\b" + label, "i");
  const restriction = restricted.test(text);
  if (!ranges.length) return { status: restriction ? "unresolved" : "unrestricted" };
  const unique = [...new Map(ranges.map(match => [match[1] + ":" + match[2], { kind: "numeric" as const, from: match[1], to: match[2] }])).values()];
  if (unique.length !== 1 || BigInt(unique[0].from) > BigInt(unique[0].to)) return { status: "unresolved" };
  // A second unparsed restriction must not be hidden by one recognized range.
  const remaining = ranges.reduce((value, match) => value.replace(match[0], ""), text);
  if (restricted.test(remaining)) return { status: "unresolved" };
  return { status: "range", range: unique[0] };
}

async function inspect(bytes: Uint8Array, asset: AskVendorAsset, intended: AskVendorReview["intended"]) {
  const source = await inspectManualPdf(bytes, { includeEmptyPages: true });
  const complete = Boolean(source.text.trim()) && source.pages.length === source.total_pages
    && source.warnings.length === 0 && !source.pages.some(page => page.needs_ocr);
  const serial = askVendorSerialReview(source.text);
  const serialMatches = serial.status === "unrestricted" || serial.status === "range" && serialRangeStatus(asset.serial_number, serial.range) === "match";
  return { source, review: { complete, intended, serial } as AskVendorReview,
    identityMatch: complete && manualPdfMatchesEquipment(source.text, asset) && serialMatches };
}

/** Retain the actual fetched original privately; no asset is changed by this preview. */
export async function prepareAskVendorDocument(request: NextRequest, input: { assetId: string; url: string; intended: AskVendorReview["intended"] }, signal: AbortSignal) {
  const { auth, asset } = await loadAskVendorAsset(request, input.assetId);
  const downloaded = await fetchAskPublicDocument(input.url, signal);
  if (downloaded.kind === "page") return downloaded;
  const bytes = new Uint8Array(downloaded.bytes);
  const inspected = await inspect(bytes, asset, input.intended);
  signal.throwIfAborted();
  const descriptor: ImportUploadDescriptor = { kind: "asset-documentation", id: randomUUID(), name: downloaded.fileName, size: bytes.length, sha256: sha(bytes) };
  // Existing private staging checks/retention apply. The unused signed upload URL
  // stays server-side; it is never part of a model prompt or an Ask answer.
  await prepareImportUpload(auth.admin, auth.principal.hotelId, auth.principal.identity.id, descriptor);
  const path = `${auth.principal.hotelId}/${auth.principal.identity.id}/${descriptor.kind}/${descriptor.id}-${descriptor.sha256}.pdf`;
  const saved = await auth.admin.storage.from(IMPORT_UPLOAD_BUCKET).upload(path, bytes, { upsert: false, contentType: "application/pdf" });
  if (saved.error) throw new Error("The downloaded original could not be retained for this account. No asset was changed.");
  const value = tokenSchema.parse({ version: 1, actor: auth.principal.identity.id, hotel: auth.principal.hotelId,
    assetId: asset.id, assetIdentity: identityHash(asset), expires: Date.now() + 24 * 60 * 60_000,
    sourceUrl: downloaded.url, descriptor, intended: input.intended });
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = tokenPrefix + payload + "." + sign(payload).toString("base64url");
  return { kind: "pdf" as const, token, descriptor, asset, sourceUrl: downloaded.url,
    identityMatch: inspected.identityMatch, review: inspected.review,
    source: { text: inspected.source.text, pages: inspected.source.pages, totalPages: inspected.source.total_pages, warnings: inspected.source.warnings } };
}

/** Re-read both permission and exact stored bytes before an import or download. */
export async function readAskVendorEvidence(request: NextRequest, token: string) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok) throw new Error("Sign in before continuing this document review.");
  const evidence = verifyAskVendorDocumentToken(token, auth);
  const current = await loadAskVendorAsset(request, evidence.assetId);
  if (identityHash(current.asset) !== evidence.assetIdentity) throw new Error("The asset's identity changed after this document was read. Review it against the current asset before continuing.");
  const original = await readImportUpload(current.auth.admin, evidence.hotel, evidence.actor, evidence.descriptor, "asset-documentation");
  const inspected = await inspect(original.bytes, current.asset, evidence.intended);
  return { ...current, descriptor: original.descriptor, bytes: original.bytes, text: inspected.source.text,
    sha256: original.descriptor.sha256, sourceUrl: evidence.sourceUrl, fileName: original.descriptor.name,
    identityMatch: inspected.identityMatch, review: inspected.review };
}

/** A later explicit verification request reuses the exact original, never a fresh vendor fetch. */
export async function reviewAskVendorDocument(request: NextRequest, token: string, intended: AskVendorReview["intended"]) {
  const original = await readAskVendorEvidence(request, token);
  const prior = verifyAskVendorDocumentToken(token, original.auth);
  if (prior.intended === intended) return { ...original, token };
  const payload = Buffer.from(JSON.stringify({ ...prior, intended })).toString("base64url");
  return { ...original, review: { ...original.review, intended }, token: tokenPrefix + payload + "." + sign(payload).toString("base64url") };
}

export async function askVendorDocumentDownload(request: NextRequest, token: string) {
  const { auth, descriptor } = await readAskVendorEvidence(request, token);
  const path = `${auth.principal.hotelId}/${auth.principal.identity.id}/${descriptor.kind}/${descriptor.id}-${descriptor.sha256}.pdf`;
  const signed = await auth.admin.storage.from(IMPORT_UPLOAD_BUCKET).createSignedUrl(path, 60);
  if (signed.error || !signed.data?.signedUrl) throw new Error("The original PDF could not be opened for download.");
  return { url: signed.data.signedUrl, name: descriptor.name, size: descriptor.size, sha256: descriptor.sha256, mimeType: "application/pdf" };
}
