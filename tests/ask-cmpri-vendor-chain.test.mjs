import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const hotel = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const sourceUrl = "https://vendorco.com/manuals/W100.pdf";
const original = Buffer.from("%PDF-1.7\nFixtureCo W100 original service manual\n%%EOF");
const hash = value => createHash("sha256").update(value).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
const applicability = loadTs("src/lib/manual-applicability.ts");
const match = loadTs("src/lib/manual-document-match.ts");
const pdf = loadTs("src/lib/manual-pdf-knowledge.ts", { "@/lib/manual-document-match": match });
const fields = loadTs("src/lib/stored-pdf-link.ts");
const imports = loadTs("src/lib/server/import-upload.ts");
const suggestions = loadTs("src/lib/equipment-pdf-suggestions.ts");

function fixture() {
  class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
  const staged = new Map(), nativeFiles = new Map(), calls = [];
  let revision = 0;
  const state = {
    denyDocuments: false, failNextSave: false, vendorReads: 0,
    principal: { identity: { id: actor }, hotelId: hotel, profile: { role: "chief_engineer" } },
    asset: { id: assetId, hotel_id: hotel, name: "Laundry washer", asset_type: "Washer", active: true,
      manufacturer: "FixtureCo", model_number: "W100", model_family: null, serial_number: "00150",
      updated_at: "2026-11-23T00:00:00.000Z", documentation_verified_at: null, documentation_revision_id: null, pdf_import_links: [] },
    source: { text: "Manufacturer: FixtureCo\nModel: W100\nSerial numbers 00100 through 00199.\nTroubleshooting: Check the drain.",
      total_pages: 1, pages: [{ page: 1, text: "FixtureCo W100 service instructions", needs_ocr: false }], warnings: [] },
  };
  const advance = () => { state.asset.updated_at = new Date(Date.UTC(2026, 10, 23, 0, 0, ++revision)).toISOString(); };
  const snapshot = () => ({ asset_identity: applicability.manualAssetIdentity(state.asset), updated_at: state.asset.updated_at,
    files: [...nativeFiles.values()].map(file => ({ ...file, bytes: undefined })), links: state.asset.pdf_import_links });
  const request = body => new NextRequest("https://cmpri.test/api/ask-cmpri/vendor", {
    method: "POST", headers: { authorization: "Bearer chain-user", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const authHeader = request => assert.equal(request.headers.get("authorization"), "Bearer chain-user");
  const assetsRoute = {
    GET: async request => { authHeader(request); return Response.json({ assets: [{ id: assetId }] }); },
    PATCH: async request => {
      authHeader(request);
      const input = await request.json(); calls.push({ kind: "asset-write", input });
      assert.equal(input.id, assetId); assert.equal(input.expected_updated_at, state.asset.updated_at);
      if (input.begin_documentation_revision) {
        state.asset.documentation_verified_at = null; state.asset.documentation_revision_id = "open"; advance();
        return Response.json({ revision_open: true });
      }
      assert.equal(input.verify_with_documentation, true);
      state.asset.documentation_verified_at = state.asset.updated_at; state.asset.documentation_revision_id = null; advance();
      return Response.json({ verified: true, asset: state.asset });
    },
  };
  const inspected = file => ({ file: { ...file, bytes: undefined }, sha256: hash(file.bytes),
    asset_identity: applicability.manualAssetIdentity(state.asset), updated_at: state.asset.updated_at });
  const docsRoute = {
    GET: async request => {
      authHeader(request);
      if (state.denyDocuments) return Response.json({ error: "Current role cannot read documents" }, { status: 403 });
      return Response.json(request.nextUrl.searchParams.get("mode") === "stored" ? snapshot() : { documents: [] });
    },
    POST: async request => {
      authHeader(request);
      const form = await request.formData(), action = form.get("import_action");
      assert.equal(form.get("asset_id"), assetId);
      if (action === "upload") {
        const file = form.get("file"), bytes = Buffer.from(await file.arrayBuffer());
        assert.deepEqual(bytes, original, "The native upload must use the original retained bytes");
        assert.equal(file.name, "W100-service.pdf");
        calls.push({ kind: "native-upload", bytes });
        const object = { object_id: fileId, storage_path: `${hotel}/${assetId}/original.pdf`, size: bytes.length, bytes, catalog_status: "complete" };
        nativeFiles.set(fileId, object);
        return Response.json(inspected(object));
      }
      const file = nativeFiles.get(form.get("object_id")); assert.ok(file);
      if (action === "review") return Response.json(inspected(file));
      assert.equal(action, "save");
      calls.push({ kind: "association-write" });
      if (state.failNextSave) { state.failNextSave = false; return Response.json({ error: "Revision conflict before association save" }, { status: 409 }); }
      assert.equal(form.get("sha256"), hash(file.bytes));
      assert.equal(form.get("expected_updated_at"), state.asset.updated_at);
      assert.equal(form.get("review_confirmed"), "true");
      const review = fields.reviewPdfFields(JSON.parse(form.get("fields")));
      if (review.applicability === "confirmed_model") review.applicability_review = applicability.validateManualApplicability(state.asset, review.applicability_review);
      const saved = { ...file, bytes: undefined, ...review, sha256: hash(file.bytes) };
      state.asset.pdf_import_links = [saved]; advance();
      return Response.json({ association_verified: true, saved });
    },
  };
  const storage = {
    list: async () => ({ data: [], error: null }),
    createSignedUploadUrl: async () => ({ data: { signedUrl: "https://storage.test/private-upload" }, error: null }),
    upload: async (path, bytes) => { assert.ok(!staged.has(path)); staged.set(path, Buffer.from(bytes)); return { error: null }; },
    info: async path => ({ data: staged.has(path) ? { size: staged.get(path).length, contentType: "application/pdf", createdAt: new Date().toISOString() } : null, error: null }),
    download: async path => ({ data: staged.has(path) ? new Blob([staged.get(path)]) : null, error: null }),
    createSignedUrl: async path => ({ data: { signedUrl: "https://storage.test/private-download/" + path }, error: null }),
  };
  const admin = {
    from: table => {
      assert.equal(table, "assets"); const filters = {};
      return { select() { return this; }, eq(key, value) { filters[key] = value; return this; },
        async maybeSingle() { assert.deepEqual(filters, { id: assetId, hotel_id: state.principal.hotelId }); return { data: plain(state.asset), error: null }; } };
    },
    storage: { from: bucket => { assert.equal(bucket, "import-upload-staging"); return storage; },
      getBucket: async () => ({ data: { public: false, file_size_limit: 104857600 }, error: null }) },
  };
  const globals = { Error, URL, Request, Response, Headers, FormData, File, AbortSignal, Uint8Array,
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: "chain-fixture-signing-key" } } };
  const shared = {
    "server-only": {}, "next/server": { NextRequest },
    "@/lib/manual-applicability": applicability, "@/lib/manual-document-match": match,
    "@/lib/manual-pdf-knowledge": { ...pdf, inspectManualPdf: async () => plain(state.source) },
    "@/app/api/assets/route": assetsRoute, "@/app/api/assets/documentation/route": docsRoute,
  };
  const evidence = loadTs("src/lib/server/ask-cmpri-vendor-document.ts", { ...shared, zod,
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, mcp: false, principal: state.principal, admin }) },
    "@/lib/server/import-upload": imports,
    "./ask-cmpri-public-document": { fetchAskPublicDocument: async () => {
      state.vendorReads++; return { kind: "pdf", bytes: original, fileName: "W100-service.pdf", url: sourceUrl };
    } },
  }, globals);
  const workflow = loadTs("src/lib/server/ask-cmpri-vendor-workflow.ts", { ...shared,
    "@/lib/server/ask-cmpri-vendor-document": evidence,
    "@/lib/equipment-pdf-suggestions": suggestions, "@/lib/stored-pdf-link": fields,
    "@/app/api/maintenance-reference/route": { GET: async request => {
      authHeader(request); calls.push({ kind: "guide-read" });
      assert.equal(request.nextUrl.searchParams.get("assetId"), assetId);
      const registered = state.asset.pdf_import_links[0];
      const source = { registered_file_id: fileId, sha256: registered?.sha256, search_incomplete: false };
      return Response.json({ documentation_status: "verified", manualKnowledge: { sources: [source],
        source_passages: [{ kind: "troubleshooting", source_document_id: fileId, source_sha256: registered?.sha256, page: 1, text: "Check the drain." }] } });
    } },
  }, globals);
  return { state, staged, calls, evidence, request,
    prepare: intended => evidence.prepareAskVendorDocument(request(), { assetId, url: sourceUrl, intended }, new AbortController().signal),
    import: async (token, verify) => {
      const response = await workflow.importAskVendorDocument(request({ documentToken: token, verify }));
      return { status: response.status, ...await response.json() };
    } };
}

test("a real evidence token carries the same original through native upload, reviewed association, verification and guide readback", async () => {
  const f = fixture(), prepared = await f.prepare("verify");
  assert.equal(f.calls.length, 0, "Preview cannot modify the asset");
  const result = await f.import(prepared.token, true);
  assert.equal(result.status, 200); assert.equal(result.association_verified, true); assert.equal(result.verified, true);
  assert.equal(result.sha256, prepared.descriptor.sha256); assert.equal(result.troubleshooting.status, "ready");
  assert.equal(result.troubleshooting.source_file_id, fileId);
  assert.equal(result.troubleshooting.source_sha256, hash(original));
  assert.deepEqual(f.calls.map(call => call.kind), ["native-upload", "association-write", "asset-write", "guide-read"]);
  const link = f.state.asset.pdf_import_links[0];
  assert.deepEqual(plain(link.serial_range), { kind: "numeric", from: "00100", to: "00199" });
  assert.equal(link.applicability_review.asset_id, assetId); assert.equal(link.applicability_review.serial_number, "00150");
  assert.equal(link.notes, sourceUrl);
  const download = await f.evidence.askVendorDocumentDownload(f.request(), prepared.token);
  assert.equal(download.sha256, result.sha256); assert.equal(download.name, "W100-service.pdf");
  assert.equal(f.state.vendorReads, 1, "Neither import nor later download may refetch a changed vendor original");
  assert.equal(f.staged.size, 1);
});

test("reference evidence stays a reference through the actual chain and cannot silently become verified", async () => {
  const f = fixture(), prepared = await f.prepare("reference");
  const rejected = await f.import(prepared.token, true);
  assert.notEqual(rejected.status, 200); assert.match(rejected.error, /reference only/); assert.equal(f.calls.length, 0);
  const result = await f.import(prepared.token, false);
  assert.equal(result.status, 200); assert.equal(result.applicability, "reference"); assert.equal(result.verified, false);
  assert.equal(result.troubleshooting.status, "reference");
  assert.equal(f.calls.some(call => call.kind === "asset-write"), false);
});

test("identity changes, actor replay, current permission loss and altered staged bytes fail before the adapter mutates anything", async () => {
  for (const change of [
    f => { f.state.asset.serial_number = "00151"; },
    f => { f.state.principal = { ...f.state.principal, identity: { id: "00000000-0000-4000-8000-000000000099" } }; },
    f => { f.state.denyDocuments = true; },
    f => { const [path, bytes] = [...f.staged][0]; const altered = Buffer.from(bytes); altered[10] ^= 1; f.staged.set(path, altered); },
  ]) {
    const f = fixture(), prepared = await f.prepare("verify"); change(f);
    const result = await f.import(prepared.token, true);
    assert.ok(result.status >= 400); assert.equal(f.calls.length, 0);
    assert.equal(result.progress.association_saved, false); assert.equal(result.progress.asset_verified, false);
    assert.equal(f.state.vendorReads, 1);
  }
});

test("a new proposal after a failed association reuses the exact original retained by the first attempt", async () => {
  const f = fixture(), prepared = await f.prepare("verify"); f.state.failNextSave = true;
  const failed = await f.import(prepared.token, true);
  assert.equal(failed.status, 409); assert.equal(failed.progress.original_uploaded, true);
  assert.equal(failed.progress.association_saved, false); assert.match(failed.error, /original PDF was uploaded/);
  const recovered = await f.import(prepared.token, true);
  assert.equal(recovered.status, 200); assert.equal(recovered.progress.original_reused, true);
  assert.equal(f.calls.filter(call => call.kind === "native-upload").length, 1);
  assert.equal(f.state.vendorReads, 1); assert.equal(f.staged.size, 1);
  assert.equal(recovered.sha256, prepared.descriptor.sha256);
});
