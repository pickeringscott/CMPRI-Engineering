import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const id = "f6bf48a4-15f3-45d3-9049-eb4d1e20b228", actor = "490074f3-c149-4663-814c-c6188a7a8404", hotel = "a275a891-1dc2-40a3-89c2-208127d508fd";
const importUploads = loadTs("src/lib/server/import-upload.ts");
const parser = loadTs("src/lib/work-order-import-table.ts");
const request = body => new NextRequest("https://cmpri.test/api/ask-cmpri/native-files", { method: "POST", headers: { Authorization: "Bearer native-session", "Content-Type": "application/json" }, body: JSON.stringify(body) });
function fixture(name = "original.csv", content = "Original unshortened source\n".repeat(500)) {
  const bytes = new TextEncoder().encode(content), sha256 = createHash("sha256").update(bytes).digest("hex");
  const descriptor = { id, name, type: name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".json") ? "application/json" : "text/csv", size: bytes.length, sha256 };
  const calls = [], stored = new Map(), state = { denied: false, noteFails: false, posted: false };
  const storage = bucket => ({
    upload: async (path, data, options) => { assert.equal(options.upsert, false); calls.push({ action: "copy", bucket, path }); if (stored.has(bucket + path)) return { error: { status: 409 } }; stored.set(bucket + path, { bytes: new Uint8Array(data), type: options.contentType }); return { error: null }; },
    info: async path => { const file = stored.get(bucket + path); return file ? { data: { size: file.bytes.length, contentType: file.type } } : { error: { status: 404 } }; },
    download: async path => { const file = stored.get(bucket + path); return file ? { data: new Blob([file.bytes], { type: file.type }) } : { error: { status: 404 } }; },
  });
  const original = { descriptor, bytes, file: new File([bytes], name, { type: descriptor.type }), auth: { principal: { identity: { id: actor }, hotelId: hotel }, admin: { storage: { from: storage } } } };
  const asset = { id, hotel_id: hotel, name: "Current equipment", manufacturer: "Source Maker", model_number: "MODEL-42", model_family: "", serial_number: "125", updated_at: "2026-11-23T10:00:00Z" };
  const record = async (action, incoming) => {
    assert.equal(incoming.headers.get("authorization"), "Bearer native-session");
    const body = await incoming.json(); calls.push({ action, body }); return body;
  };
  const files = loadTs("src/lib/server/ask-cmpri-native-files.ts", {
    "server-only": {}, "next/server": { NextRequest }, "./ask-cmpri-file-staging": { readAskStagedFile: async (_request, token) => { assert.equal(token, "actual-original-token"); return original; } },
    "./import-upload": importUploads, "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "staff-note-files" },
    "@/lib/work-order-import-table": parser,
    "./ask-cmpri-native-workflows": {
      hydrateNativeImportResponse: async (_request, response) => Response.json({ ...await response.json(), hydrated_complete_result: true }, { status: response.status }),
      validateNativeGuestReports: async incoming => { const body = await record("guest-preview", incoming); assert.equal(body.validateOnly, true); return Response.json({ previousId: id, rows: [{ room: "101" }] }); },
      saveNativeGuestReports: async incoming => { const body = await record("guest-commit", incoming); assert.equal(body.validateOnly, false); return Response.json({ ok: true, message: "Out of order:101. Room moves:102→103." }); },
    },
    "@/app/api/import-uploads/route": { POST: async incoming => { await record("native-prepare", incoming); return state.denied ? Response.json({ error: "Native role denied" }, { status: 403 }) : Response.json({ signedUrl: "https://native-storage.example/upload" }); } },
    "@/app/api/engineering/po-pdf-review/route": { POST: async incoming => { const body = await record("po-review", incoming); return Response.json({ actual_upload: body.upload }); } },
    "@/app/api/engineering/purchasing-history/route": { POST: async incoming => { const body = await record("history", incoming); return Response.json({ action: body.action, digest: "d".repeat(64) }); } },
    "@/app/api/work-orders/import/route": { POST: async incoming => { const body = await record("work-orders", incoming); return state.denied ? Response.json({ error: "Native role denied" }, { status: 403 }) : Response.json({ imported: body.validate_only ? 0 : body.rows.length, validate_only: body.validate_only, rows: body.rows }); } },
    "@/app/api/staff-notes/uploads/route": {
      POST: async incoming => { const body = await record("staff-prepare", incoming); return state.posted ? Response.json({ error: "Upload ID is already in use." }, { status: 409 }) : Response.json({ id: body.id, path: `${hotel}/${actor}/${body.id}`, token: "private-upload-credential" }); },
      PUT: async incoming => { const body = await record("staff-finalize", incoming); return Response.json({ id: body.id, ready: true }); },
    },
    "@/app/api/staff-notes/route": { POST: async incoming => { await record("staff-post", incoming); if (state.noteFails) return Response.json({ error: "Native post unconfirmed" }, { status: 503 }); state.posted = true; return Response.json({ id }); } },
    "./ask-cmpri-vendor-document": { loadAskVendorAsset: async (_request, assetId) => { assert.equal(assetId, id); if (state.denied) throw Error("Native equipment access denied"); return { auth: original.auth, asset }; }, askVendorSerialReview: () => ({ status: "unrestricted" }) },
    "@/lib/manual-pdf-knowledge": { inspectManualPdf: async data => { assert.deepEqual(data, bytes); return { text: "Source Maker MODEL-42\nActual original source", total_pages: 4, pages: [1, 2, 3, 4].map(page => ({ page, text: `Source page ${page}` })), warnings: [] }; }, manualPdfMatchesEquipment: (text, asset) => text.includes(asset.manufacturer) && text.includes(asset.model_number) },
    "@/lib/manual-applicability": { serialRangeStatus: () => "unrestricted" },
    "./ask-cmpri-vendor-workflow": { importAskReviewedDocument: async (incoming, readEvidence) => { const body = await incoming.clone().json(); const evidence = await readEvidence(incoming, body.documentToken); return Response.json({ sourceLabel: evidence.sourceLabel, intended: evidence.review.intended, complete: evidence.review.complete, identityMatch: evidence.identityMatch, sha256: evidence.sha256, assetId: evidence.asset.id }); } },
    "@/app/api/assets/documentation/route": { POST: async incoming => { assert.equal(incoming.headers.get("authorization"), "Bearer native-session"); const form = await incoming.formData(); calls.push({ action: "stored-review", actionValue: form.get("import_action") }); if (state.denied) return Response.json({ error: "Native role denied" }, { status: 403 }); return Response.json({ file: { object_id: id, storage_path: `${hotel}/${id}/original.pdf`, size: bytes.length }, sha256, asset_identity: { asset_id: id }, updated_at: asset.updated_at, suggestions: { preview_pages: 3 } }); } },
  }, { Request, Response, Headers, File, FormData, URL, Uint8Array, TextDecoder, Error });
  return { files, calls, state, original, stored, descriptor };
}

test("selected PO source copies exact bytes through native authorization and hydrates full private review", async () => {
  const f = fixture("original.pdf", "%PDF-actual original bytes");
  const response = await f.files.reviewAskPoFile(request({ fileToken: "actual-original-token" }));
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.hydrated_complete_result, true);
  const copy = f.calls.find(call => call.action === "copy"); assert.equal(copy.bucket, "import-upload-staging");
  assert.equal(copy.path, `${hotel}/${actor}/po-pdf/${id}-${f.descriptor.sha256}.pdf`);
  assert.equal(result.actual_upload.sha256, f.descriptor.sha256); assert.deepEqual(f.stored.get(copy.bucket + copy.path).bytes, f.original.bytes);
  const denied = fixture("original.pdf", "%PDF-real source"); denied.state.denied = true;
  assert.equal((await denied.files.reviewAskPoFile(request({ fileToken: "actual-original-token" }))).status, 403);
  assert.ok(!denied.calls.some(call => call.action === "copy" || call.action === "po-review"));
});

test("history and Daily Ops preview operations cannot be flipped into commits", async () => {
  const history = fixture("source.json", '{"sources":[],"records":[]}');
  let response = await history.files.importAskPurchasingFile(request({ fileToken: "actual-original-token", action: "import", reviewed: true }), false);
  assert.equal(response.status, 400); assert.equal(history.calls.length, 0);
  response = await history.files.importAskPurchasingFile(request({ fileToken: "actual-original-token" }), false);
  assert.equal(response.status, 200); assert.equal(history.calls.find(call => call.action === "history").body.action, "review");
  assert.equal((await history.files.importAskPurchasingFile(request({ fileToken: "actual-original-token" }), true)).status, 400);
  assert.equal((await history.files.importAskPurchasingFile(request({ fileToken: "actual-original-token", digest: "d".repeat(64) }), true)).status, 200);
  const guest = fixture("In House.csv");
  assert.equal((await guest.files.importAskGuestFiles(request({ fileTokens: ["actual-original-token"], validateOnly: false }), false)).status, 400);
  assert.equal((await guest.files.importAskGuestFiles(request({ fileTokens: ["actual-original-token"] }), false)).status, 200);
  assert.equal((await guest.files.importAskGuestFiles(request({ fileTokens: ["actual-original-token"] }), true)).status, 400);
  const commit = await guest.files.importAskGuestFiles(request({ fileTokens: ["actual-original-token"], previousId: id }), true);
  assert.equal(commit.status, 200); assert.match((await commit.json()).message, /101.*102→103/);
});

test("original work-order files use the native shared parser, exact source digest and complete batching", async () => {
  const source = "Source ID,Room,Issue,Notes\n" + Array.from({ length: 201 }, (_, n) => `source-${n},${100 + n},Repair ${n},Source note ${n}`).join("\n");
  const f = fixture("issues.csv", source);
  const preview = await f.files.importAskWorkOrderFile(request({ fileToken: "actual-original-token", source: "Spreadsheet" }), false);
  const data = await preview.json(); assert.equal(data.total_source_rows, 201); assert.equal(data.rows.length, 200); assert.equal(data.next_offset, 200); assert.equal(data.imported, 0);
  assert.equal(data.rows[0].external_id, "source-0"); assert.equal(data.rows[0].notes, "Source note 0");
  assert.equal((await f.files.importAskWorkOrderFile(request({ fileToken: "actual-original-token", source: "Spreadsheet", sourceSha256: "0".repeat(64) }), true)).status, 400);
  const last = await f.files.importAskWorkOrderFile(request({ fileToken: "actual-original-token", source: "Spreadsheet", sourceSha256: data.sourceSha256, offset: 200 }), true);
  const saved = await last.json(); assert.equal(saved.imported, 1); assert.equal(saved.next_offset, null); assert.equal(saved.rows[0].external_id, "source-200");
  f.state.denied = true;
  assert.equal((await f.files.importAskWorkOrderFile(request({ fileToken: "actual-original-token", source: "Spreadsheet" }), false)).status, 403);
});

test("work-order source reviews resolve native physical IDs without rewriting original evidence", async () => {
  const f = fixture("issues.csv", "Source ID,Room,Issue,Notes\nsource-1,101,Original issue,Original note\nsource-2,102,Second issue,Second note");
  const body = { fileToken: "actual-original-token", source: "Spreadsheet", reviewedRows: [{ sourceRow: 2, location_id: id, asset_id: null, reviewed_keep_separate: { candidate_ids: [actor], reason: "This is a separately observed repair." } }] };
  const response = await f.files.importAskWorkOrderFile(request(body), false);
  const data = await response.json(); assert.equal(response.status, 200);
  assert.equal(data.source_rows[1].sourceRow, 2); assert.equal(data.source_rows[1].location_id, id); assert.equal(data.source_rows[1].asset_id, null);
  assert.equal(data.rows[1].issue, "Second issue"); assert.equal(data.rows[1].notes, "Second note"); assert.equal(data.rows[1].external_id, "source-2");
  assert.deepEqual(data.rows[1].reviewed_keep_separate, body.reviewedRows[0].reviewed_keep_separate);
  assert.equal(data.rows[0].location_id, undefined);
  const calls = f.calls.length;
  for (const reviewedRows of [[{ sourceRow: 3, location_id: id }], [{ sourceRow: 1 }, { sourceRow: 1 }], [{ sourceRow: 1, issue: "Rewritten" }], [{ sourceRow: 1, history_actor_user_id: actor }]]) {
    assert.equal((await f.files.importAskWorkOrderFile(request({ ...body, reviewedRows }), false)).status, 400);
  }
  assert.equal(f.calls.length, calls);
});

test("Staff Notes uses exact original attachments and stable native request recovery", async () => {
  const f = fixture("source.txt", "Private original evidence");
  const body = { fileTokens: ["actual-original-token"], requestId: id, body: "User requested this staff note." };
  const result = await f.files.postAskStaffFiles(request(body)); assert.equal(result.status, 200);
  const note = f.calls.find(call => call.action === "staff-post").body;
  assert.equal(note.fileTokens, undefined); assert.equal(note.requestId, id); assert.equal(note.uploadIds.length, 1);
  const saved = f.stored.get(`staff-note-files${hotel}/${actor}/${note.uploadIds[0]}`); assert.deepEqual(saved.bytes, f.original.bytes);
  const copies = f.calls.filter(call => call.action === "copy").length;
  assert.equal((await f.files.postAskStaffFiles(request(body))).status, 200);
  assert.equal(f.calls.filter(call => call.action === "copy").length, copies);
  const failed = fixture("source.txt", "Original evidence"); failed.state.noteFails = true;
  const failure = await failed.files.postAskStaffFiles(request(body)); assert.equal(failure.status, 503);
  assert.match((await failure.json()).error, /attachments were prepared.*same requestId/);
});

test("local equipment PDFs use the same reviewed native workflow with actual current asset and full source", async () => {
  const f = fixture("manual.pdf", "%PDF-original fixture");
  const verified = await f.files.importAskAssetFile(request({ fileToken: "actual-original-token", assetId: id, verify: true }));
  const data = await verified.json(); assert.equal(verified.status, 200); assert.equal(data.sourceLabel, "selected original PDF");
  assert.equal(data.assetId, id); assert.equal(data.intended, "verify"); assert.equal(data.complete, true); assert.equal(data.identityMatch, true); assert.equal(data.sha256, f.descriptor.sha256);
  const reference = await (await f.files.importAskAssetFile(request({ fileToken: "actual-original-token", assetId: id }))).json(); assert.equal(reference.intended, "reference");
  f.state.denied = true;
  assert.notEqual((await f.files.importAskAssetFile(request({ fileToken: "actual-original-token", assetId: id, verify: true }))).status, 200);
});

test("stored-PDF questions read the full original under native review without any association write", async () => {
  const f = fixture("manual.pdf", "%PDF-original fixture");
  f.stored.set(`asset-documentation${hotel}/${id}/original.pdf`, { bytes: f.original.bytes, type: "application/pdf" });
  const response = await f.files.inspectAskStoredPdf(request({ assetId: id, objectId: id }));
  const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.source.pages.length, 4); assert.equal(data.source.complete, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].actionValue, "review"); assert.match(data.message, /No association or asset verification was changed/);
  f.stored.values().next().value.bytes = new Uint8Array(f.original.bytes.length).fill(65);
  assert.equal((await f.files.inspectAskStoredPdf(request({ assetId: id, objectId: id }))).status, 409);
});
