import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import { loadTs } from "./helpers/load-ts.mjs";

const actor = "0c72b5c1-6019-497a-95c9-d456698aacd7", hotel = "68254b1d-98b1-4ad1-8f17-42540cc44e6b";
const id = "2e98b477-9af0-4660-b4ba-0436874ccfb2";
const request = () => new Request("https://cmpri.test/api/ask-cmpri/files", { headers: { Authorization: "Bearer native-user" } });
const files = loadTs("src/lib/ask-cmpri/files.ts"), media = loadTs("src/lib/staff-note-media.ts");
function fixture(content = "The complete original CSV\n".repeat(1000), name = "original.csv", type = "text/csv") {
  const objects = new Map(), calls = [];
  const state = { actor, hotel, now: Date.now(), denied: false, mcp: false, publicBucket: false };
  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(content);
  const descriptor = { id, name, type, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const storage = {
    list: async prefix => { calls.push({ action: "list", path: prefix }); return { data: [], error: null }; },
    createSignedUploadUrl: async (path, options) => { assert.equal(options.upsert, false); calls.push({ action: "sign", path }); return { data: { signedUrl: "https://storage.example/upload" }, error: null }; },
    info: async path => { calls.push({ action: "info", path }); const stored = objects.get(path); return stored ? { data: { size: stored.bytes.length, contentType: stored.type, createdAt: new Date(state.now).toISOString() } } : { error: { status: 404 } }; },
    download: async path => { calls.push({ action: "download", path }); const stored = objects.get(path); return stored ? { data: new Blob([stored.bytes], { type: stored.type }) } : { error: { status: 404 } }; },
    remove: async paths => { paths.forEach(path => { calls.push({ action: "remove", path }); objects.delete(path); }); return { error: null }; },
  };
  const auth = () => ({ ok: true, mcp: state.mcp, principal: { identity: { id: state.actor }, hotelId: state.hotel }, admin: { storage: {
    getBucket: async () => ({ data: { public: state.publicBucket, file_size_limit: files.ASK_FILE_LIMIT } }),
    from: bucket => { assert.equal(bucket, media.STAFF_FILE_BUCKET); return storage; },
  } } });
  const staging = loadTs("src/lib/server/ask-cmpri-file-staging.ts", {
    "server-only": {}, "@/lib/ask-cmpri/files": files, "@/lib/staff-note-media": media,
    "@/lib/server/auth": { requireUserAttempt: async incoming => { assert.equal(incoming.headers.get("authorization"), "Bearer native-user"); return state.denied ? { ok: false } : auth(); } },
  }, { File, Request, Date: class extends Date { static now() { return state.now; } }, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-signing-key" } } });
  const stage = async () => {
    await staging.prepareAskFile(request(), descriptor);
    objects.set(calls.find(call => call.action === "sign").path, { bytes, type });
    return (await staging.finalizeAskFile(request(), descriptor)).file;
  };
  return { staging, objects, calls, state, descriptor, bytes, stage, auth };
}

test("original staging binds real bytes and canonical metadata to actor/property without module writes", async () => {
  const f = fixture(); const signed = await f.stage();
  assert.match(signed.token, /^ask-file\./); assert.equal(signed.sha256, f.descriptor.sha256);
  const canonical = f.staging.describeAskStagedFile(f.auth(), signed.token);
  assert.equal(canonical.name, "original.csv"); assert.equal(canonical.size, f.bytes.length);
  const original = await f.staging.readAskStagedFile(request(), signed.token);
  assert.equal(original.file.name, f.descriptor.name); assert.deepEqual(new Uint8Array(await original.file.arrayBuffer()), f.bytes);
  assert.ok(f.calls.every(call => call.path.startsWith(`ask-files/v1/${hotel}/${actor}`)));
});

test("tampered metadata, wrong actor/property, expiry and changed stored bytes cannot be consumed", async () => {
  const f = fixture(); const signed = await f.stage();
  const before = f.calls.length;
  f.state.actor = id;
  await assert.rejects(f.staging.readAskStagedFile(request(), signed.token), /another CMPRI account/);
  assert.equal(f.calls.length, before);
  f.state.actor = actor; f.state.hotel = id;
  assert.throws(() => f.staging.describeAskStagedFile(f.auth(), signed.token), /another CMPRI account/);
  f.state.hotel = hotel;
  const token = signed.token.split("."); const payload = JSON.parse(Buffer.from(token[1], "base64url").toString()); payload.descriptor.name = "invented.pdf"; token[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.throws(() => f.staging.describeAskStagedFile(f.auth(), token.join(".")), /reference changed/);
  f.objects.values().next().value.bytes = new Uint8Array(f.bytes.length).fill(65);
  await assert.rejects(f.staging.readAskStagedFile(request(), signed.token), /differ from/);
  f.state.now += 24 * 60 * 60 * 1000 + 1;
  assert.throws(() => f.staging.describeAskStagedFile(f.auth(), signed.token), /expired/);
});

test("finalization refuses incomplete/changed originals and removal remains owner scoped", async () => {
  const f = fixture();
  await assert.rejects(f.staging.finalizeAskFile(request(), f.descriptor), /could not be verified/);
  const signed = await f.stage();
  f.state.actor = id;
  await assert.rejects(f.staging.removeAskFile(request(), { token: signed.token }), /another CMPRI account/);
  assert.equal(f.objects.size, 1);
  f.state.actor = actor; await f.staging.removeAskFile(request(), { token: signed.token }); assert.equal(f.objects.size, 0);
  f.state.publicBucket = true;
  await assert.rejects(f.staging.prepareAskFile(request(), f.descriptor), /Private original-file storage/);
  f.state.denied = true;
  await assert.rejects(f.staging.prepareAskFile(request(), f.descriptor), /Sign in/);
});

test("original-file transport follows the main Ask sign-in policy and rejects MCP credentials before storage access", async () => {
  const f = fixture(); const signed = await f.stage();
  const before = f.calls.length; f.state.mcp = true;
  await assert.rejects(f.staging.prepareAskFile(request(), f.descriptor), /Sign in/);
  await assert.rejects(f.staging.finalizeAskFile(request(), f.descriptor), /Sign in/);
  await assert.rejects(f.staging.readAskStagedFile(request(), signed.token), /Sign in/);
  await assert.rejects(f.staging.removeAskFile(request(), { token: signed.token }), /Sign in/);
  assert.throws(() => f.staging.describeAskStagedFile(f.auth(), signed.token), /Sign in/);
  assert.equal(f.calls.length, before); assert.equal(f.objects.size, 1);
});

function inspector(f, pdfResult, inspectPdf) {
  return loadTs("src/lib/server/ask-cmpri-file-inspection.ts", {
    "server-only": {}, "adm-zip": { default: AdmZip }, "@xmldom/xmldom": { DOMParser },
    "@/lib/ask-cmpri/files": files, "./ask-cmpri-file-staging": f.staging,
    "@/lib/manual-pdf-knowledge": { inspectManualPdf: inspectPdf || (async () => pdfResult) },
  }, { TextDecoder, Uint8Array });
}

test("source inspection keeps complete text and PDF page/OCR coverage, rather than preview-length content", async () => {
  const f = fixture(); const signed = await f.stage();
  const inspected = await inspector(f).inspectAskStagedFile(request(), signed.token);
  assert.equal(inspected.text, new TextDecoder().decode(f.bytes)); assert.ok(inspected.text.length > 8500); assert.equal(inspected.complete, true);
  const p = fixture("%PDF-fixture", "manual.pdf", "application/pdf"), pdfFile = await p.stage();
  const pdf = await inspector(p, { text: "Page one source", total_pages: 2, pages: [{ page: 1, text: "Page one source" }, { page: 2, needs_ocr: true, text: "" }], warnings: [] }).inspectAskStagedFile(request(), pdfFile.token);
  assert.equal(pdf.complete, false); assert.deepEqual(Array.from(pdf.needsOcr), [2]); assert.equal(pdf.pages.length, 2);
});

test("authorized native originals share the full JSON/PDF reader without accessing staging or accepting changed bytes", async () => {
  const contents = { rows: Array.from({ length: 900 }, (_, index) => ({ id: index, note: "Actual original source row " + index })), last: "Complete source tail" };
  const original = fixture(JSON.stringify(contents), "saved-report.json", "application/json");
  const pdfOriginal = fixture("%PDF-actual-native-original", "saved-manual.pdf", "application/pdf");
  const pdfCalls = [];
  const pdfSource = { text: "Page one\nPage two\nLast original page", total_pages: 3,
    pages: [{ page: 1, text: "Page one" }, { page: 2, text: "Page two" }, { page: 3, text: "Last original page" }], warnings: [] };
  const reader = inspector({ staging: { readAskStagedFile: () => assert.fail("Native-source inspection must not download or authorize through staging") } }, undefined,
    async (bytes, options) => { pdfCalls.push({ bytes, options }); return pdfSource; });
  const json = await reader.inspectAskOriginalFile(original);
  assert.equal(json.kind, "text"); assert.equal(json.complete, true);
  assert.equal(json.text, JSON.stringify(contents)); assert.equal(json.data.rows.length, 900); assert.equal(json.data.last, contents.last);
  assert.equal(json.sha256, original.descriptor.sha256); assert.deepEqual(json.file, original.descriptor);
  const pdf = await reader.inspectAskOriginalFile(pdfOriginal);
  assert.equal(pdf.complete, true); assert.equal(pdf.totalPages, 3); assert.equal(pdf.pages[2].text, "Last original page");
  assert.equal(pdfCalls[0].bytes, pdfOriginal.bytes); assert.deepEqual(JSON.parse(JSON.stringify(pdfCalls[0].options)), { includeEmptyPages: true });
  await assert.rejects(reader.inspectAskOriginalFile({ ...pdfOriginal, bytes: new Uint8Array(pdfOriginal.bytes.length).fill(65) }), /differ from the source SHA/);
  await assert.rejects(reader.inspectAskOriginalFile({ ...pdfOriginal, descriptor: { ...pdfOriginal.descriptor, size: pdfOriginal.bytes.length + 1 } }), /file size/);
  await assert.rejects(reader.inspectAskOriginalFile({ ...pdfOriginal, descriptor: { ...pdfOriginal.descriptor, size: files.ASK_FILE_LIMIT + 1 } }), /processing limit/);
  assert.equal(pdfCalls.length, 1, "Unverified bytes never reach a document parser");
});

test("the staged inspection wrapper reauthorizes and verifies its original before parsing", async () => {
  const f = fixture("%PDF-private-source", "private.pdf", "application/pdf"), signed = await f.stage();
  const reader = inspector(f, undefined, () => assert.fail("Unauthorized or altered originals must not be parsed"));
  f.state.denied = true;
  await assert.rejects(reader.inspectAskStagedFile(request(), signed.token), /Sign in/);
  f.state.denied = false;
  f.objects.values().next().value.bytes = new Uint8Array(f.bytes.length).fill(65);
  await assert.rejects(reader.inspectAskStagedFile(request(), signed.token), /differ from/);
});

test("XLSX inspection reads every worksheet, rich strings, cached values and formulas without evaluation", async () => {
  const zip = new AdmZip();
  const add = (name, value) => zip.addFile(name, Buffer.from(value));
  add("xl/workbook.xml", '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Original &amp; First" r:id="r1"/><sheet name="Second" state="hidden" r:id="r2"/></sheets></workbook>');
  add("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>');
  add("xl/sharedStrings.xml", '<sst><si><r><t>Source </t></r><r><t>&lt;value&gt;</t></r></si></sst>');
  add("xl/worksheets/sheet1.xml", '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B3)</f><v>12</v></c></row></sheetData></worksheet>');
  add("xl/worksheets/sheet2.xml", '<worksheet><sheetData><row r="9"><c r="C9" t="inlineStr"><is><t>Hidden source</t></is></c></row></sheetData></worksheet>');
  const f = fixture(new Uint8Array(zip.toBuffer()), "source.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const file = await f.stage(); const inspected = await inspector(f).inspectAskStagedFile(request(), file.token);
  assert.equal(inspected.complete, true); assert.equal(inspected.dateSystem, "1904"); assert.equal(inspected.sheets.length, 2);
  assert.equal(inspected.sheets[0].rows[0].cells[0].value, "Source <value>");
  assert.equal(inspected.sheets[0].rows[0].cells[1].formula, "SUM(B2:B3)"); assert.equal(inspected.sheets[0].rows[0].cells[1].cachedValue, 12);
  assert.equal(inspected.sheets[1].state, "hidden"); assert.equal(inspected.sheets[1].rows[0].cells[0].cell, "C9");
  const nativeOriginal = await inspector({ staging: { readAskStagedFile: () => assert.fail("Already-authorized originals do not use staging") } }).inspectAskOriginalFile(f);
  assert.deepEqual(JSON.parse(JSON.stringify(nativeOriginal)), JSON.parse(JSON.stringify(inspected)), "Native and selected originals retain the same complete workbook cells");
});
