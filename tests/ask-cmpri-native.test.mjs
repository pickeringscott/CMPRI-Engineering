import assert from "node:assert/strict";
import test from "node:test";
import * as zod from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

const actor = "f1130fe7-8569-443e-8e1c-03cd6e875eee";
const hotel = "9d6f0c5b-6975-4730-bad5-e8bfcf802c62";
const otherActor = "9d37501d-8dc4-46fb-87ef-0e686c8706ed";
const otherHotel = "9d37501d-8dc4-46fb-87ef-0e686c8706ee";
const record = "8337c6db-a46f-48c4-9987-16fb13b9981e";
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const calls = [];
  const markers = new Map();
  const uploads = [];
  const state = { now: 1_795_435_200_000, readOnly: false, failClaim: false, failReceipt: false };
  class Clock extends Date { static now() { return state.now; } }
  class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
  const operations = new Map();
  const define = (key, overrides = {}) => {
    const op = {
      key, path: "/api/work-orders/[id]", pathParams: ["id"], queryParams: ["include"],
      method: "GET", writes: false, bodyKind: "json", domain: "Work orders", description: "Read work order",
      ...overrides,
    };
    const handler = overrides.run || (() => Response.json({ id: record, status: "Open" }));
    op.run = async (request, params) => {
      calls.push({ key, request, params, body: request.body ? await request.clone().text() : undefined });
      return handler(request, params);
    };
    operations.set(key, op);
    return op;
  };
  define("orders.read");
  define("orders.update", { method: "PATCH", writes: true, description: "Update work order", run: () => Response.json({ success: true }) });
  const storage = {
    async download(path) {
      return markers.has(path) ? { data: new Blob([markers.get(path)]), error: null }
        : { data: null, error: { statusCode: "404", message: "Not found" } };
    },
    async upload(path, value, options) {
      uploads.push({ path, value, options });
      if (state.failClaim && path.endsWith("/claim") || state.failReceipt && path.endsWith("/result")) return { error: { statusCode: "503", message: "Storage unavailable" } };
      if (markers.has(path) && !options.upsert) return { error: { statusCode: "409", message: "Already exists" } };
      markers.set(path, String(value));
      return { data: { path }, error: null };
    },
  };
  const principal = { identity: { id: actor }, hotelId: hotel, profile: { id: actor, role: "Chief Engineer" } };
  const auth = { ok: true, mcp: false, principal, admin: { storage: { from(bucket) { assert.equal(bucket, "staff-fixture"); return storage; } } } };
  const bridge = loadTs("src/lib/server/ask-cmpri-native.ts", {
    "server-only": {}, "next/server": { NextRequest }, zod,
    "@/lib/server/manual-preview": { manualPreviewReadOnly: () => state.readOnly },
    "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "staff-fixture" },
    "./ask-cmpri-native-catalog": { askNativeOperation: key => operations.get(key) },
  }, {
    Date: Clock, Error, URL, Headers, FormData, Request, Response,
    process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-signing-secret-never-forwarded" } },
    fetch: () => { throw new Error("Native bridge tests must never make live calls"); },
  });
  const incoming = (authorization = "Bearer current-user-session") => new NextRequest("https://cmpri.test/api/ask-cmpri", {
    method: "POST", headers: {
      ...(authorization ? { authorization } : {}), cookie: "private-cookie", apikey: "do-not-forward", "x-cmpri-role": "do-not-trust",
    },
  });
  const write = (body = { status: "In Progress" }) => ({ operation: "orders.update", parameters: { id: record }, body });
  const propose = (requests = [write()]) => bridge.beginAskNativeChange(principal, requests, "en", "Update CMPRI records");
  return { bridge, calls, operations, markers, uploads, state, define, principal, auth, incoming, write, propose };
}

test("native delegation forwards only the current user's bearer and the catalog method", async () => {
  const h = fixture();
  const result = await h.bridge.runAskNativeRequest(h.incoming(), {
    operation: "orders.read", parameters: { id: record }, query: { include: "notes&role=Admin" },
    method: "DELETE", path: "https://external.invalid/anything", body: { mustNotBeSent: true },
  });
  assert.equal(result.ok, true);
  assert.equal(h.calls.length, 1);
  const delegated = h.calls[0].request;
  assert.equal(delegated.method, "GET");
  assert.deepEqual([...delegated.headers], [["authorization", "Bearer current-user-session"]]);
  assert.equal(delegated.nextUrl.origin, "https://cmpri.test");
  assert.equal(delegated.nextUrl.pathname, `/api/work-orders/${record}`);
  assert.deepEqual([...delegated.nextUrl.searchParams], [["include", "notes&role=Admin"]]);
  assert.equal(h.calls[0].body, undefined);
  assert.doesNotMatch(JSON.stringify([...delegated.headers]), /fixture-signing-secret|do-not-forward|private-cookie/);
});

test("repeated query parameters preserve every target on reads and signed confirmations", async () => {
  const h = fixture();
  const values = ["first-record", "second-record", "value&not_another_parameter=1"];
  await h.bridge.runAskNativeRequest(h.incoming(), { operation: "orders.read", parameters: { id: record }, query: { include: values } });
  assert.deepEqual(h.calls[0].request.nextUrl.searchParams.getAll("include"), values);
  assert.equal(h.calls[0].request.nextUrl.searchParams.has("not_another_parameter"), false);
  const proposal = h.propose([{ ...h.write(), query: { include: values } }]);
  const verified = h.bridge.verifyAskNativeChange(proposal.token, h.principal);
  assert.deepEqual(plain(verified.requests[0].query.include), values);
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 200);
  assert.deepEqual(h.calls[1].request.nextUrl.searchParams.getAll("include"), values);
});

test("the read path cannot run writes including a catalog GET marked as a mutation", async () => {
  const h = fixture();
  h.define("cache.refresh", { path: "/api/cache/refresh", pathParams: [], writes: true });
  assert.equal((await h.bridge.runAskNativeRequest(h.incoming(), h.write())).status, 409);
  assert.equal((await h.bridge.runAskNativeRequest(h.incoming(), { operation: "cache.refresh" })).status, 409);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.bridge.runAskNativeRequest(h.incoming(""), { operation: "orders.read", parameters: { id: record } })).status, 401);
  assert.equal(h.calls.length, 0);
});

test("unknown operations, route parameters and query names cannot escape the catalog", async () => {
  const h = fixture();
  for (const input of [
    { operation: "DELETE /api/users" },
    { operation: "https://external.invalid/" },
    { operation: "orders.read", parameters: { id: ".." } },
    { operation: "orders.read", parameters: { id: "../users" } },
    { operation: "orders.read", parameters: { id: "a\\b" } },
    { operation: "orders.read", parameters: { id: "\u0000" } },
    { operation: "orders.read", parameters: { id: record, ignoredPath: "/api/users" } },
    { operation: "orders.read", parameters: { id: record }, query: { role: "System Admin" } },
  ]) assert.equal((await h.bridge.runAskNativeRequest(h.incoming(), input)).ok, false);
  assert.equal(h.calls.length, 0);
  const safe = h.bridge.askNativeRequestUrl(h.incoming(), h.operations.get("orders.read"), { operation: "orders.read", parameters: { id: "%2F..%2Fusers" } });
  assert.equal(safe.pathname, "/api/work-orders/%252F..%252Fusers");
});

test("native role denials retain their status and cannot be converted to successful data", async () => {
  const h = fixture();
  h.define("orders.denied", { run: () => Response.json({ error: "This role cannot read another user's ticket.", access_token: "never-return" }, { status: 403 }) });
  const result = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "orders.denied", parameters: { id: record } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.match(result.error, /role/);
  assert.equal(result.data.error, "This role cannot read another user's ticket.");
  assert.equal(result.data.access_token, undefined);
});

test("confirmation tokens bind user, hotel, contents and expiry", () => {
  const h = fixture();
  const proposal = h.propose();
  assert.equal(proposal.field, "cmpri");
  assert.ok(h.bridge.verifyAskNativeChange(proposal.token, h.principal));
  assert.equal(h.bridge.verifyAskNativeChange(proposal.token, { ...h.principal, identity: { id: otherActor } }), null);
  assert.equal(h.bridge.verifyAskNativeChange(proposal.token, { ...h.principal, hotelId: otherHotel }), null);
  const [, payload, signature] = proposal.token.split(".");
  const changed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  changed.requests[0].body.status = "Closed";
  const tampered = `native.${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
  assert.equal(h.bridge.verifyAskNativeChange(tampered, h.principal), null);
  assert.equal(h.bridge.verifyAskNativeChange(proposal.token + ".extra", h.principal), null);
  h.state.now += 12 * 60_000;
  assert.equal(h.bridge.verifyAskNativeChange(proposal.token, h.principal), null);
  assert.ok(h.bridge.verifyAskNativeChange(proposal.token, h.principal, true), "expired verified tokens can recover prior receipts");
});

test("expired or wrong-user confirmations cannot reserve a claim or write", async () => {
  const h = fixture();
  const proposal = h.propose();
  const wrong = { ...h.auth, principal: { ...h.principal, identity: { id: otherActor } } };
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), wrong, proposal.token)).status, 409);
  h.state.now += 13 * 60_000;
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 409);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.calls.length, 0);
});

test("concurrent confirmation and retry apply one write and recover a receipt without private record data", async () => {
  const h = fixture();
  const entered = deferred();
  const release = deferred();
  h.define("orders.update", { method: "PATCH", writes: true, run: async () => { entered.resolve(); await release.promise; return Response.json({ success: true, privateNote: "Must not be stored in a replay receipt" }); } });
  const proposal = h.propose();
  const first = h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token);
  await entered.promise;
  const during = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token);
  assert.equal(during.status, 409);
  assert.equal(h.calls.length, 1);
  const cancellation = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token, { cancel: true });
  assert.equal(cancellation.status, 409, "an in-progress write is not falsely reported as cancelled");
  release.resolve();
  assert.equal((await first).status, 200);
  h.state.now += 13 * 60_000;
  const replay = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token, { recover: true });
  assert.equal(replay.status, 200);
  assert.equal(h.calls.length, 1);
  assert.equal(replay.result.items, undefined);
  assert.doesNotMatch(JSON.stringify([...h.markers.values()]), /Must not be stored/);
  assert.ok(h.uploads.every(upload => upload.options.upsert === false));
});

test("a cancellation winning the atomic claim prevents all confirmation writes", async () => {
  const h = fixture();
  const proposal = h.propose();
  const [cancelled, raced] = await Promise.all([
    h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token, { cancel: true }),
    h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token),
  ]);
  assert.equal(cancelled.status, 200);
  assert.match(cancelled.result.title, /cancelled/i);
  assert.match(raced.result.title + " " + raced.result.summary, /cancelled/i);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 409);
  assert.equal(h.calls.length, 0);
});

test("native batches run sequentially and stop after the first rejected native response", async () => {
  const h = fixture();
  h.define("orders.reject", { method: "DELETE", writes: true, run: () => Response.json({ error: "Current role cannot delete this record." }, { status: 403 }) });
  const proposal = h.propose([h.write(), { operation: "orders.reject", parameters: { id: record } }, h.write({ status: "Closed" })]);
  const result = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token);
  assert.equal(result.status, 403);
  assert.match(result.result.summary, /1 of 3/);
  assert.deepEqual(h.calls.map(call => call.key), ["orders.update", "orders.reject"]);
  assert.equal(JSON.parse(h.calls[0].body).status, "In Progress");
  assert.equal(h.calls[0].request.headers.get("authorization"), "Bearer current-user-session");
  await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token);
  assert.equal(h.calls.length, 2, "retry does not repeat successful operations or retry the rejected one");
});

test("confirmed pool readings report required closure, every closure reason, warning and missing daily check", async () => {
  const h = fixture();
  const reasons = ["Sanitizer below the configured threshold", "Main drain visibility was not confirmed"];
  const warnings = ["Flow reading needs review", "Retest before reopening"];
  h.define("pool.save", { path: "/api/pool-log", pathParams: [], method: "POST", writes: true, domain: "Pool log", run: () => Response.json({
    success: true, closure_required: true, closure_reasons: reasons, warnings,
    status: { label: "Closed", reason: "Pool closure condition recorded", daily_checks_missing: ["safety equipment", "drain visibility"] },
  }) });
  const proposal = h.propose([{ operation: "pool.save", body: { fixture: true } }]);
  const outcome = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token);
  assert.equal(outcome.status, 200);
  for (const text of [outcome.result.summary, outcome.result.items[0].text]) {
    assert.match(text, /pool must remain CLOSED/);
    for (const reason of reasons) assert.ok(text.includes(reason), `missing closure reason: ${reason}`);
    for (const warning of warnings) assert.ok(text.includes(warning), `missing warning: ${warning}`);
    assert.match(text, /safety equipment/);
    assert.match(text, /drain visibility/);
  }
});

test("unchanged native records are reported unchanged without claiming a new completed change", async () => {
  const h = fixture();
  h.define("orders.update", { method: "PATCH", writes: true, run: () => Response.json({ unchanged: true, status: "Open", message: "The existing record already matches." }) });
  const outcome = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, h.propose().token);
  assert.equal(outcome.status, 200);
  assert.match(outcome.result.summary, /unchanged/i);
  assert.match(outcome.result.items[0].text, /unchanged/i);
  assert.doesNotMatch(outcome.result.title, /completed/i);
  assert.doesNotMatch(outcome.result.summary, /\b[1-9]\d* changes? completed/i);
});

test("HTTP 202 native operations remain pending in the confirmation status, title and details", async () => {
  const h = fixture();
  h.define("orders.update", { method: "PATCH", writes: true, run: () => Response.json({ status: "queued", message: "Processing started." }, { status: 202 }) });
  const outcome = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, h.propose().token);
  assert.equal(outcome.status, 202);
  assert.match(outcome.result.title, /pending|processing|accepted/i);
  assert.match(outcome.result.summary, /pending/i);
  assert.match(outcome.result.items[0].text, /pending/i);
  assert.doesNotMatch(outcome.result.title + " " + outcome.result.summary + " " + outcome.result.items[0].text, /completed/i);
});

test("native batches stop at pending acceptance and replay cannot start dependent changes", async () => {
  const h = fixture();
  h.define("orders.queue", { method: "PATCH", writes: true, run: () => Response.json({ status: "queued" }, { status: 202 }) });
  const proposal = h.propose([h.write(), { operation: "orders.queue", parameters: { id: record } }, h.write({ status: "Closed" })]);
  const outcome = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token);
  assert.equal(outcome.status, 202);
  assert.match(outcome.result.title, /pending/i);
  assert.match(outcome.result.summary, /1 of 3 changes completed/);
  assert.match(outcome.result.summary, /1 remaining change was not submitted/);
  assert.deepEqual(h.calls.map(call => call.key), ["orders.update", "orders.queue"]);
  const replay = await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token, { recover: true });
  assert.equal(replay.status, 202);
  assert.match(replay.result.summary, /pending/i);
  assert.match(replay.result.summary, /not submitted/);
  assert.equal(h.calls.length, 2);
});

test("storage claim failure, missing receipts and read-only preview never cause a repeated write", async () => {
  const h = fixture();
  let proposal = h.propose();
  h.state.failClaim = true;
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 503);
  assert.equal(h.calls.length, 0);
  h.state.failClaim = false;
  h.state.readOnly = true;
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 403);
  assert.equal(h.calls.length, 0);
  h.state.readOnly = false;
  h.state.failReceipt = true;
  proposal = h.propose();
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 200);
  assert.equal((await h.bridge.confirmAskNativeChange(h.incoming(), h.auth, proposal.token)).status, 409);
  assert.equal(h.calls.length, 1, "a missing receipt cannot unlock the confirmed operation");
});

test("native data and review previews scrub credentials recursively without discarding ordinary CMPRI fields", () => {
  const h = fixture();
  const source = { id: record, issue: "Replace filter", accessToken: "access-secret", refresh_token: "refresh-secret", password_hash: "hash-secret", apiKey: "key-secret",
    nested: [{ notes: "Keep this", authorization: "Bearer hidden", service_role_key: "service-secret", clientSecret: "client-secret", private_key: "pem-secret", token: "generic-secret" }] };
  const redacted = h.bridge.redactAskNativeCredentials(source);
  assert.deepEqual(plain(redacted), { id: record, issue: "Replace filter", nested: [{ notes: "Keep this" }] });
  const proposal = h.propose([h.write(source)]);
  assert.doesNotMatch(proposal.to, /secret|Bearer hidden/);
  assert.match(proposal.to, /Replace filter/);
});

test("native exception messages cannot expose bearer credentials to model context", async () => {
  const h = fixture();
  h.define("orders.error", { run: () => { throw new Error("Upstream request failed with Authorization: Bearer credential-from-provider"); } });
  const result = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "orders.error", parameters: { id: record } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result), /credential-from-provider/);
});

test("native JSON error and message strings cannot leak bearer or URL credentials", async () => {
  const h = fixture();
  h.define("orders.error-json", { run: () => Response.json({
    error: "Provider rejected Authorization: Bearer bearer-private-value",
    message: "Failed https://provider.invalid/resource?access_token=url-private-value&api_key=key-private-value",
    details: { record, authorization: "Bearer nested-private-value" },
  }, { status: 502 }) });
  const result = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "orders.error-json", parameters: { id: record } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.data.details.record, record);
  assert.doesNotMatch(JSON.stringify(result), /bearer-private-value|url-private-value|key-private-value|nested-private-value/);
});

test("the native candidate resume adapter moves original bytes to downloads before model snapshots", async () => {
  const h = fixture();
  const originalDownload = { id: "candidate-original", name: "Candidate original resume.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-original exact resume bytes").toString("base64"), encoding: "base64" };
  h.define("employment.resume", { path: "/api/employment/applications/resume", pathParams: [], queryParams: ["id"], run: () => Response.json({ applicationId: record, source: { text: "Complete source text", pages: [{ page: 1, text: "Source page" }], complete: true }, originalDownload }) });
  const result = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "employment.resume", query: { id: record } });
  assert.equal(result.ok, true); assert.deepEqual(plain(result.downloads), [originalDownload]);
  assert.equal(result.data.source.text, "Complete source text"); assert.equal(result.data.originalDownload, undefined);
  assert.ok(!JSON.stringify(result.data).includes(originalDownload.content), "Original binary content must not be included in model snapshot data");
  h.define("orders.download-shaped-data", { run: () => Response.json({ originalDownload, notes: "Ordinary authorized record data" }) });
  const unrelated = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "orders.download-shaped-data", parameters: { id: record } });
  assert.equal(unrelated.ok, true); assert.equal(unrelated.downloads, undefined, "Only the fixed resume adapter can emit this transport envelope");
  h.define("employment.resume", { path: "/api/employment/applications/resume", pathParams: [], run: () => Response.json({ error: "Native candidate access denied", originalDownload }, { status: 403 }) });
  const denied = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "employment.resume" });
  assert.equal(denied.ok, false); assert.equal(denied.status, 403); assert.equal(denied.downloads, undefined);
});

test("native binary exports retain the handler's source scope alongside the exact download", async () => {
  const h = fixture(), contents = "Period,Task,Recorded state\r\n2026-11-23,Pool check,Pending\r\n";
  const scope = "Saved CMPRI records only; unsaved forms and queued browser changes are excluded.";
  h.define("preventive_maintenance.weekly_csv", { path: "/api/preventive-maintenance/weekly-csv", pathParams: [], queryParams: ["week"], run: () => new Response(contents, { headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": 'attachment; filename="PM-saved-transfer.csv"', "X-CMPRI-Export-Source": scope } }) });
  const result = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "preventive_maintenance.weekly_csv", query: { week: "2026-11-23" } });
  assert.equal(result.ok, true); assert.equal(result.sourceScope, scope); assert.equal(result.data.sourceScope, scope);
  assert.equal(result.downloads[0].name, "PM-saved-transfer.csv"); assert.equal(Buffer.from(result.downloads[0].content, "base64").toString(), contents);
});

test("native attachments preserve JSON source bytes and decoded original filenames", async () => {
  const h = fixture(), content = '{\n  "source": "actual saved attachment", "error": "a document field"\n}\n';
  h.define("staff_notes.attachment_read", { path: "/api/staff-notes/attachment", pathParams: [], run: () => new Response(content, { headers: {
    "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="Original_.json"; filename*=UTF-8\'\'Original%20r%C3%A9sum%C3%A9.json',
  } }) });
  const result = await h.bridge.runAskNativeRequest(h.incoming(), { operation: "staff_notes.attachment_read" });
  assert.equal(result.ok, true, "document content is not a route error envelope");
  assert.equal(result.downloads[0].name, "Original résumé.json");
  assert.equal(Buffer.from(result.downloads[0].content, "base64").toString(), content);
  assert.equal(result.data.source, undefined);
});
