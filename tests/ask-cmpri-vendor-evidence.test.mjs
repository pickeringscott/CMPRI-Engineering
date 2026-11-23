import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const actor = "f1130fe7-8569-443e-8e1c-03cd6e875eee";
const hotel = "9d6f0c5b-6975-4730-bad5-e8bfcf802c62";
const assetId = "8337c6db-a46f-48c4-9987-16fb13b9981e";
const otherActor = "9d37501d-8dc4-46fb-87ef-0e686c8706ed";
const otherHotel = "9d37501d-8dc4-46fb-87ef-0e686c8706ee";
const original = Buffer.from("%PDF-1.7\nFixtureCo W-100 original service manual\n%%EOF");
const plain = value => JSON.parse(JSON.stringify(value));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const applicability = loadTs("src/lib/manual-applicability.ts");
const pdfKnowledge = loadTs("src/lib/manual-pdf-knowledge.ts", {
  "@/lib/manual-document-match": loadTs("src/lib/manual-document-match.ts"),
});

function fixture() {
  const calls = [], objects = new Map();
  const state = {
    now: 1_795_435_200_000, denied: "", signedIn: true,
    asset: { id: assetId, hotel_id: hotel, active: true, asset_type: "Washer", name: "Laundry washer",
      manufacturer: "FixtureCo", model_number: "W-100", model_family: null, serial_number: "1500",
      updated_at: "2026-11-20T00:00:00.000Z", documentation_verified_at: null, documentation_revision_id: null, pdf_import_links: [] },
    source: { text: "FixtureCo W-100 service manual. Serial numbers 1000 through 2000.", total_pages: 2,
      pages: [{ page: 1, text: "FixtureCo W-100", needs_ocr: false }, { page: 2, text: "Service information", needs_ocr: false }], warnings: [] },
    publicResult: { kind: "pdf", bytes: original, fileName: "Fixture-W-100.pdf", url: "https://vendor.example.invalid/W-100.pdf" },
  };
  class Clock extends Date { static now() { return state.now; } }
  class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
  const storage = {
    async list(prefix) { calls.push({ kind: "storage.list", prefix }); return { data: [], error: null }; },
    async createSignedUploadUrl(path, options) { calls.push({ kind: "storage.prepare", path, options }); return { data: { signedUrl: "https://private.invalid/signed-upload-secret" }, error: null }; },
    async upload(path, bytes, options) {
      calls.push({ kind: "storage.upload", path, bytes: Buffer.from(bytes), options });
      if (objects.has(path)) return { error: { message: "Already exists" } };
      objects.set(path, Buffer.from(bytes));
      return { data: { path }, error: null };
    },
    async info(path) {
      calls.push({ kind: "storage.info", path });
      return objects.has(path) ? { data: { size: objects.get(path).length, contentType: "application/pdf", createdAt: new Date(state.now).toISOString() }, error: null }
        : { data: null, error: { message: "Not found" } };
    },
    async download(path) { calls.push({ kind: "storage.download", path }); return { data: objects.has(path) ? new Blob([objects.get(path)]) : null, error: null }; },
    async createSignedUrl(path, expires) {
      calls.push({ kind: "storage.sign", path, expires });
      assert.ok(objects.has(path), "download signing must address the original staged PDF");
      return { data: { signedUrl: `https://storage.example.invalid/storage/v1/object/sign/private/${path}?token=fixture` }, error: null };
    },
  };
  const principal = { identity: { id: actor }, hotelId: hotel, profile: { id: actor, role: "Chief Engineer" } };
  const admin = {
    from(table) {
      assert.equal(table, "assets");
      const filters = [];
      return {
        select(columns) { calls.push({ kind: "asset.select", columns }); return this; },
        eq(name, value) { filters.push([name, value]); return this; },
        async maybeSingle() {
          assert.deepEqual(filters, [["id", assetId], ["hotel_id", hotel]], "supplemental asset reads must retain property and asset filters");
          return { data: plain(state.asset), error: null };
        },
        insert() { assert.fail("staging must never create or update an asset"); },
        update() { assert.fail("staging must never create or update an asset"); },
        delete() { assert.fail("staging must never delete an asset"); },
      };
    },
    storage: {
      from(bucket) { assert.equal(bucket, "import-upload-staging"); return storage; },
      async getBucket(bucket) { assert.equal(bucket, "import-upload-staging"); return { data: { public: false, file_size_limit: 104857600 }, error: null }; },
    },
  };
  const auth = { ok: true, mcp: false, admin, principal };
  const imports = loadTs("src/lib/server/import-upload.ts", {}, { Date: Clock });
  const bridge = loadTs("src/lib/server/ask-cmpri-vendor-document.ts", {
    "server-only": {}, zod, "next/server": { NextRequest },
    "@/lib/server/auth": { requireUserAttempt: async () => {
      calls.push({ kind: "auth" });
      return state.signedIn ? auth : { ok: false, response: Response.json({ error: "Sign in" }, { status: 401 }) };
    } },
    "@/lib/manual-applicability": applicability,
    "@/lib/manual-pdf-knowledge": {
      manualPdfMatchesEquipment: pdfKnowledge.manualPdfMatchesEquipment,
      inspectManualPdf: async (bytes, options) => {
        calls.push({ kind: "inspect", bytes: Buffer.from(bytes), options });
        assert.equal(options.includeEmptyPages, true, "identity review must cover every PDF page");
        return plain(state.source);
      },
    },
    "@/lib/server/import-upload": imports,
    "./ask-cmpri-public-document": { fetchAskPublicDocument: async (url, signal) => {
      calls.push({ kind: "public.read", url }); signal.throwIfAborted(); return state.publicResult;
    } },
    "@/app/api/assets/route": { GET: async request => {
      calls.push({ kind: "native.assets", request });
      return Response.json({ assets: state.denied === "missing" ? [] : [{ id: assetId }] }, { status: state.denied === "assets" ? 403 : 200 });
    } },
    "@/app/api/assets/documentation/route": { GET: async request => {
      calls.push({ kind: "native.documents", request });
      return Response.json({ documents: [] }, { status: state.denied === "documents" ? 403 : 200 });
    } },
  }, { Date: Clock, Error, URL, Request, Response, AbortController,
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-server-signing-secret" } },
    fetch: () => { throw new Error("Vendor evidence tests must not make live requests"); },
  });
  const request = () => new NextRequest("https://cmpri.test/api/ask-cmpri", { method: "POST",
    headers: { authorization: "Bearer current-user-session", apikey: "must-not-forward", cookie: "private-session-cookie" } });
  const prepare = (intended = "verify") => bridge.prepareAskVendorDocument(request(), { assetId, url: state.publicResult.url, intended }, new AbortController().signal);
  return { bridge, calls, state, objects, auth, request, prepare };
}

test("vendor staging preserves the original bytes privately and does not change the asset", async () => {
  const h = fixture(), before = plain(h.state.asset);
  const staged = await h.prepare();
  assert.equal(staged.kind, "pdf");
  assert.equal(staged.identityMatch, true);
  assert.equal(staged.review.complete, true);
  assert.deepEqual(plain(h.state.asset), before);
  assert.equal(h.objects.size, 1);
  const uploaded = h.calls.find(call => call.kind === "storage.upload");
  assert.deepEqual(uploaded.bytes, original);
  assert.equal(uploaded.options.upsert, false);
  assert.equal(uploaded.options.contentType, "application/pdf");
  assert.equal(staged.descriptor.sha256, digest(original));
  assert.equal(staged.descriptor.size, original.length);
  assert.match(uploaded.path, new RegExp(`^${hotel}/${actor}/asset-documentation/`));
  assert.doesNotMatch(JSON.stringify(staged), /signed-upload-secret|fixture-server-signing-secret/);
  for (const call of h.calls.filter(call => call.kind.startsWith("native."))) {
    assert.equal(call.request.method, "GET");
    assert.deepEqual([...call.request.headers], [["authorization", "Bearer current-user-session"]]);
  }
});

test("vendor evidence tokens bind actor, property, physical asset, descriptor hash, and expiry", async () => {
  const h = fixture(), staged = await h.prepare();
  const token = h.bridge.verifyAskVendorDocumentToken(staged.token, h.auth);
  assert.equal(token.actor, actor); assert.equal(token.hotel, hotel); assert.equal(token.assetId, assetId);
  assert.equal(token.descriptor.sha256, digest(original));
  assert.equal(token.expires, h.state.now + 24 * 60 * 60_000);
  assert.throws(() => h.bridge.verifyAskVendorDocumentToken(staged.token, { ...h.auth, principal: { ...h.auth.principal, identity: { id: otherActor } } }), /another CMPRI account/);
  assert.throws(() => h.bridge.verifyAskVendorDocumentToken(staged.token, { ...h.auth, principal: { ...h.auth.principal, hotelId: otherHotel } }), /another CMPRI account/);
  const encoded = staged.token.slice("vendor-document.".length).split(".");
  for (const change of [value => { value.assetId = otherActor; }, value => { value.assetIdentity = "0".repeat(64); },
    value => { value.descriptor.sha256 = "0".repeat(64); }, value => { value.descriptor.name = "Other.pdf"; }]) {
    const altered = plain(token); change(altered);
    const tampered = "vendor-document." + Buffer.from(JSON.stringify(altered)).toString("base64url") + "." + encoded[1];
    assert.throws(() => h.bridge.verifyAskVendorDocumentToken(tampered, h.auth), /reference changed/);
  }
  h.state.now = token.expires;
  assert.throws(() => h.bridge.verifyAskVendorDocumentToken(staged.token, h.auth), /expired/);
});

test("download and import evidence reread the same original descriptor, bytes, and current native permissions", async () => {
  const h = fixture(), staged = await h.prepare();
  h.calls.length = 0;
  const imported = await h.bridge.readAskVendorEvidence(h.request(), staged.token);
  const downloaded = await h.bridge.askVendorDocumentDownload(h.request(), staged.token);
  assert.deepEqual(plain(imported.descriptor), plain(staged.descriptor));
  assert.deepEqual(Buffer.from(imported.bytes), original);
  assert.equal(downloaded.name, staged.descriptor.name);
  assert.equal(downloaded.sha256, staged.descriptor.sha256);
  assert.equal(downloaded.size, staged.descriptor.size);
  assert.equal(downloaded.mimeType, "application/pdf");
  const readPaths = h.calls.filter(call => call.kind === "storage.download").map(call => call.path);
  assert.equal(readPaths.length, 2); assert.equal(readPaths[0], readPaths[1]);
  assert.equal(h.calls.find(call => call.kind === "storage.sign").path, readPaths[0]);
  assert.equal(h.calls.filter(call => call.kind === "native.assets").length, 2);
  assert.equal(h.calls.filter(call => call.kind === "native.documents").length, 2);
  assert.equal(h.calls.filter(call => call.kind === "public.read").length, 0, "download/import cannot refetch a changed vendor original");
});

test("changed physical identity or staged bytes cannot be reused as verified evidence", async () => {
  for (const field of ["manufacturer", "model_number", "serial_number", "asset_type"]) {
    const h = fixture(), staged = await h.prepare();
    h.calls.length = 0; h.state.asset[field] += " changed";
    await assert.rejects(h.bridge.readAskVendorEvidence(h.request(), staged.token), /identity changed/);
    assert.equal(h.calls.some(call => call.kind.startsWith("storage.")), false);
  }
  const h = fixture(), staged = await h.prepare();
  const [path] = h.objects.keys();
  const different = Buffer.from(original); different[10] ^= 1; h.objects.set(path, different);
  await assert.rejects(h.bridge.readAskVendorEvidence(h.request(), staged.token), /differs from the selected original/);
  assert.equal(h.calls.some(call => call.kind === "storage.sign"), false);
});

test("OCR gaps, missing pages, warnings, and unresolved serial restrictions cannot verify equipment", async () => {
  const cases = [
    h => { h.state.source.pages[1].needs_ocr = true; },
    h => { h.state.source.total_pages = 3; },
    h => { h.state.source.warnings = ["A page could not be read"]; },
    h => { h.state.source.text = ""; },
    h => { h.state.source.text = "FixtureCo W-100. Serial numbers 2000 through 3000."; },
    h => { h.state.asset.serial_number = "A1500"; },
    h => { h.state.source.text = "FixtureCo W-100. Serial numbers 2000 through 1000."; },
    h => { h.state.source.text = "FixtureCo W-100. Serial numbers 1000 and later."; },
    h => { h.state.source.text = "FixtureCo W-100. Serial numbers A100-A200."; },
    h => { h.state.source.text = "FixtureCo W-100. S/N range 2000-3000."; },
  ];
  const wronglyVerified = [];
  for (const change of cases) {
    const h = fixture(); change(h);
    const staged = await h.prepare();
    const reread = await h.bridge.readAskVendorEvidence(h.request(), staged.token);
    if (staged.identityMatch || reread.identityMatch) wronglyVerified.push(h.state.source.text);
  }
  assert.deepEqual(wronglyVerified, [], "unresolved, out-of-range, or unreadable evidence cannot verify equipment");
});

test("native authorization failures stop supplemental asset, vendor, and private storage reads", async () => {
  for (const denied of ["assets", "documents", "missing", "signed-out"]) {
    const h = fixture();
    h.state.denied = denied; h.state.signedIn = denied !== "signed-out";
    await assert.rejects(h.prepare(), /role cannot read|not available|Sign in/);
    assert.equal(h.calls.some(call => call.kind === "asset.select" || call.kind === "public.read" || call.kind.startsWith("storage.")), false, denied);
  }
  const h = fixture(), staged = await h.prepare();
  h.calls.length = 0; h.state.denied = "documents";
  await assert.rejects(h.bridge.askVendorDocumentDownload(h.request(), staged.token), /role cannot read/);
  assert.equal(h.calls.some(call => call.kind === "asset.select" || call.kind.startsWith("storage.")), false, "an earlier token cannot bypass current native denial");
});

test("an explicit later verification review retains the same original bytes and original expiry", async () => {
  const h = fixture(), staged = await h.prepare("reference");
  const before = h.bridge.verifyAskVendorDocumentToken(staged.token, h.auth);
  h.state.now += 10_000;
  const reviewed = await h.bridge.reviewAskVendorDocument(h.request(), staged.token, "verify");
  const after = h.bridge.verifyAskVendorDocumentToken(reviewed.token, h.auth);
  assert.notEqual(reviewed.token, staged.token);
  assert.equal(before.intended, "reference");
  assert.equal(after.intended, "verify");
  assert.equal(after.expires, before.expires);
  assert.equal(after.assetIdentity, before.assetIdentity);
  assert.deepEqual(plain(after.descriptor), plain(before.descriptor));
  assert.deepEqual(Buffer.from(reviewed.bytes), original);
  assert.equal(h.calls.filter(call => call.kind === "public.read").length, 1);
  assert.equal(h.calls.filter(call => call.kind === "storage.upload").length, 1);
  assert.equal(h.objects.size, 1);
});
