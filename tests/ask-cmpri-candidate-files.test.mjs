import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const id = "c6a862b5-1217-46a9-9f17-2e73cfc2a754";
const origin = "https://native-storage.example.invalid";
const fileName = "Original candidate résumé.pdf";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const request = () => new NextRequest(`https://cmpri.test/api/employment/resume?id=${id}`, { headers: { Authorization: "Bearer current-native-reviewer", Cookie: "unrelated=not-forwarded" } });

function fixture(bytes = Buffer.from("%PDF-1.7\nActual original source"), inspect) {
  const calls = [], inspections = [];
  const location = `${origin}/storage/v1/object/sign/employment-resumes/${id}/${digest(bytes)}.pdf?token=private-storage-token&download=${encodeURIComponent(fileName)}`;
  const state = { native: () => new Response(null, { status: 303, headers: { Location: location } }),
    source: () => new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Length": String(bytes.length) } }) };
  const reader = loadTs("src/lib/server/ask-cmpri-candidate-files.ts", {
    "server-only": {}, "next/server": { NextRequest, NextResponse: Response },
    "@/lib/supabase/config": { SUPABASE_URL: origin },
    "@/lib/manual-pdf-knowledge": { inspectManualPdf: async (value, options) => {
      inspections.push({ bytes: Buffer.from(value), options });
      if (inspect) return inspect(value, options);
      return { text: "PAGE 1\nActual source\nPAGE 4\nFinal qualifications", total_pages: 4,
        pages: [1, 2, 3, 4].map(page => ({ page, text: `Source page ${page}`, needs_ocr: false })), warnings: [] };
    } },
    "@/app/api/employment/resume/route": { GET: async incoming => {
      calls.push({ kind: "native", incoming });
      assert.equal(incoming.headers.get("authorization"), "Bearer current-native-reviewer");
      assert.equal(incoming.headers.get("cookie"), null);
      assert.equal(incoming.nextUrl.searchParams.get("id"), id);
      return state.native();
    } },
  }, { URL, Response, Uint8Array, fetch: async (url, options) => {
    calls.push({ kind: "storage", url: String(url), options });
    return state.source();
  } });
  return { ...reader, state, calls, inspections, bytes, location, read: () => reader.readAskCandidateResume(request()) };
}

test("candidate native denials remain authoritative before any storage fetch or PDF inspection", async () => {
  for (const status of [401, 403, 404]) {
    const f = fixture(), denied = Response.json({ error: "Native department access denied." }, { status });
    f.state.native = () => denied;
    assert.equal(await f.read(), denied);
    assert.deepEqual(f.calls.map(call => call.kind), ["native"]);
    assert.equal(f.inspections.length, 0);
  }
});

test("private candidate redirect retrieves exact bytes without forwarding CMPRI credentials and preserves complete text", async () => {
  const f = fixture();
  const response = await f.read(), body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(f.calls.map(call => call.kind), ["native", "storage"]);
  const transfer = f.calls[1];
  assert.equal(transfer.url, f.location);
  assert.deepEqual(Object.keys(transfer.options.headers), ["Accept"]);
  assert.equal(transfer.options.credentials, "omit");
  assert.equal(transfer.options.referrerPolicy, "no-referrer");
  assert.equal(transfer.options.redirect, "error");
  assert.deepEqual(f.inspections[0].bytes, f.bytes);
  assert.equal(f.inspections[0].options.includeEmptyPages, true);
  assert.equal(body.applicationId, id);
  assert.equal(body.file.name, fileName);
  assert.equal(body.file.size, f.bytes.length);
  assert.equal(body.file.sha256, digest(f.bytes));
  assert.equal(body.inspection.pages.length, 4);
  assert.match(body.inspection.text, /Final qualifications/);
  assert.equal(body.inspection.complete, true);
  assert.deepEqual(Buffer.from(body.originalDownload.content, "base64"), f.bytes);
  assert.equal(body.originalDownload.name, fileName);
  assert.equal(body.originalDownload.id, body.file.id);
  assert.equal(JSON.stringify(body).includes("private-storage-token"), false);
});

test("legacy inline resumes keep their original filename, bytes and incomplete/OCR coverage", async () => {
  const f = fixture(undefined, async () => ({ text: "PAGE 1\nReadable text", total_pages: 4,
    pages: [{ page: 1, text: "Readable text", needs_ocr: false }, { page: 2, text: "", needs_ocr: true }], warnings: ["Reader stopped before every page."] }));
  f.state.native = () => new Response(f.bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(fileName)}` } });
  const body = await (await f.read()).json();
  assert.deepEqual(f.calls.map(call => call.kind), ["native"]);
  assert.equal(body.file.name, fileName);
  assert.equal(body.inspection.complete, false);
  assert.deepEqual(body.inspection.needsOcr, [2]);
  assert.deepEqual(body.inspection.warnings, ["Reader stopped before every page."]);
  assert.equal(body.inspection.totalPages, 4);
  assert.deepEqual(Buffer.from(body.originalDownload.content, "base64"), f.bytes);
});

test("candidate redirects cannot leave the exact configured private bucket and application", async () => {
  for (const change of [
    url => { url.hostname = "external.example.invalid"; },
    url => { url.protocol = "http:"; },
    url => { url.username = "credential"; },
    url => { url.pathname = url.pathname.replace("employment-resumes", "other-private-bucket"); },
    url => { url.pathname = url.pathname.replace(id, "another-application"); },
    url => { url.pathname = url.pathname.replace(/[^/]+$/, "nested%2Fsource.pdf"); },
    url => { url.searchParams.delete("token"); },
  ]) {
    const f = fixture(), url = new URL(f.location); change(url);
    f.state.native = () => new Response(null, { status: 303, headers: { Location: url.href } });
    assert.equal((await f.read()).status, 503);
    assert.deepEqual(f.calls.map(call => call.kind), ["native"]);
  }
  const redirected = fixture();
  redirected.state.source = () => new Response(null, { status: 303, headers: { Location: "https://other.example.invalid/source.pdf" } });
  assert.equal((await redirected.read()).status, 503);
  assert.equal(redirected.calls.filter(call => call.kind === "storage").length, 1);
  assert.equal(redirected.inspections.length, 0);
});

test("invalid, altered, size-mismatched and oversized PDF responses never yield downloads or inspected evidence", async () => {
  for (const source of [
    () => new Response("not a PDF", { headers: { "Content-Type": "application/pdf" } }),
    () => new Response("%PDF-replaced-original", { headers: { "Content-Type": "application/pdf" } }),
    () => new Response("%PDF-valid", { headers: { "Content-Type": "text/html" } }),
    () => new Response("%PDF-valid", { headers: { "Content-Type": "application/pdf", "Content-Length": "104857601" } }),
    () => new Response("%PDF-valid", { headers: { "Content-Type": "application/pdf", "Content-Length": "1234" } }),
    () => {
      const part = new Uint8Array(1024 * 1024); let count = 0;
      return new Response(new ReadableStream({ pull(controller) { if (++count <= 101) controller.enqueue(part); else controller.close(); } }), { headers: { "Content-Type": "application/pdf" } });
    },
  ]) {
    const f = fixture(); f.state.source = source;
    const response = await f.read(), body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.originalDownload, undefined);
    assert.equal(f.inspections.length, 0);
  }
});

test("the existing full PDF reader sees every page of the exact candidate original", async () => {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= 4; page++) document.addPage().drawText(`Candidate resume source page ${page}. Actual qualifications include maintaining pumps, preventive maintenance and documented repair history.`, { x: 25, y: 700, size: 10, font });
  const bytes = Buffer.from(await document.save());
  const { inspectManualPdf } = await import("../src/lib/manual-pdf-knowledge.ts");
  const f = fixture(bytes, inspectManualPdf);
  const response = await f.read(), result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.inspection.totalPages, 4);
  assert.equal(result.inspection.pages.length, 4);
  assert.match(result.inspection.text, /source page 4/);
  assert.deepEqual(Buffer.from(result.originalDownload.content, "base64"), bytes);
  assert.equal(result.file.sha256, digest(bytes));
});
