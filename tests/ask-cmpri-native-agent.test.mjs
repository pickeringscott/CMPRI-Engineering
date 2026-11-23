import assert from "node:assert/strict";
import test from "node:test";
import * as zod from "zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import { loadTs } from "./helpers/load-ts.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const loyalty = loadTs("src/lib/loyalty-tier.ts");
const nativeQuery = loadTs("src/lib/ask-cmpri/native-query.ts", { "@/lib/loyalty-tier": loyalty }, { Error });
const nativeContext = loadTs("src/lib/ask-cmpri/native-context.ts");
const selectedFileTypes = loadTs("src/lib/ask-cmpri/files.ts");
const selectedFileMedia = loadTs("src/lib/staff-note-media.ts");
const originalModelMedia = loadTs("src/lib/server/ask-cmpri-model-media.ts", { "server-only": {} });
const actor = "00000000-0000-4000-8000-000000000001";
const hotel = "00000000-0000-4000-8000-000000000002";
const ticketId = "00000000-0000-4000-8000-000000000003";
const principal = { identity: { id: actor, email: "fixture@example.invalid" }, hotelId: hotel, profile: { id: actor, role: "system_admin", full_name: "Fixture Engineer", active: true } };
class NativeRequest extends Request { get nextUrl() { return new URL(this.url); } }
const request = body => new NativeRequest("https://fixture.invalid/api/ask-cmpri", {
  method: "POST", headers: { Authorization: "Bearer fixture-user-session", "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});
const answer = (summary, itemIds = [], format = "default") => ({ title: "CMPRI fixture result", summary, itemIds, format });

// The shared loader assumes TSX; this server module has a generic arrow and is .ts.
function loadAgent(dependencies, globals) {
  const fileName = "src/lib/server/ask-cmpri-native-agent.ts", exports = {};
  const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, { exports, Buffer, console, ...globals, require(name) {
    if (name in dependencies) return dependencies[name];
    throw Error(`Unmocked agent import: ${name}`);
  } });
  return exports;
}

function operation(key, path, run, { method = "GET", domain = key.split(".")[0], parameters = [], query = [], bodyKind = method === "GET" ? "none" : "json" } = {}) {
  return { key, path, run, method, domain, writes: method !== "GET", pathParams: parameters, queryParams: query,
    description: `${domain} fixture operation`, bodyKind, responseKind: "json", inputContract: "Use this fixture operation's current native fields." };
}

function fixture({ operations, script, pmRead, originalFiles = {}, fileInspection, modelMedia = originalModelMedia, key = "fixture-provider-key", vendorDocuments = {}, vendorSearch = () => { throw Error("Unexpected vendor search"); } }) {
  const calls = [], storageWrites = [], stored = new Map();
  const catalog = { ASK_NATIVE_OPERATIONS: operations, askNativeOperation: key => operations.find(operation => operation.key === key) };
  const native = loadTs("src/lib/server/ask-cmpri-native.ts", {
    "server-only": {}, "next/server": { NextRequest: NativeRequest }, zod,
    "@/lib/server/manual-preview": { manualPreviewReadOnly: () => false },
    "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "fixture-bucket" },
    "./ask-cmpri-native-catalog": catalog,
    "./ask-cmpri-file-staging": originalFiles.staging,
  }, { URL, Headers, FormData, Error, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-signing-secret" } } });
  const auth = { ok: true, mcp: false, principal, admin: { storage: { from(bucket) {
    assert.equal(bucket, "fixture-bucket");
    return {
      async download(path) { return stored.has(path) ? { data: new Blob([stored.get(path)]), error: null } : { data: null, error: { statusCode: "404", message: "Not found" } }; },
      async upload(path, content, options) {
        storageWrites.push({ path, content, options });
        if (stored.has(path) && !options.upsert) return { data: null, error: { statusCode: "409", message: "Already exists" } };
        stored.set(path, content); return { data: { path }, error: null };
      },
    };
  } } } };
  const agent = loadAgent({
    "server-only": {}, "node:crypto": { createHash }, zod,
    "@ai-sdk/google": { createGoogleGenerativeAI: options => { assert.equal(options.apiKey, key); return model => ({ model }); } },
    ai: {
      tool: options => options, Output: { object: options => options },
      isStepCount: value => ({ steps: value }), hasToolCall: value => ({ tool: value }),
      ToolLoopAgent: class {
        constructor(options) { this.options = options; }
        async generate(input) {
          const call = async (name, data) => {
            const tool = this.options.tools[name];
            assert.ok(tool, `Unknown tool ${name}`);
            const parsed = tool.inputSchema.parse(data);
            const result = await tool.execute(parsed);
            const modelOutput = tool.toModelOutput ? await tool.toModelOutput({ toolCallId: "fixture-call-" + calls.length, input: parsed, output: result }) : undefined;
            calls.push({ name, input: parsed, result, modelOutput });
            return result;
          };
          const output = await script({ call, prompt: JSON.parse(input.prompt), auth, native });
          return { output: this.options.output.schema.parse(output) };
        }
      },
    },
    "@/lib/ask-cmpri/native-query": nativeQuery,
    "@/lib/ask-cmpri/native-context": nativeContext,
    "./ask-cmpri-native-catalog": catalog,
    "./ask-cmpri-native": native,
    "./ask-cmpri-pm": { readAskPm: pmRead || (() => { throw Error("Unexpected PM read"); }) },
    "./ask-cmpri-gemini": { askGeminiKey: () => key, publicAskQuery: () => null, searchPublicAsk: () => { throw Error("Unexpected public search"); } },
    "./ask-cmpri-public-document": { askPublicDocumentUrl: value => new URL(value) },
    "./ask-cmpri-public-search": { searchAskVendorDocuments: vendorSearch },
    "./ask-cmpri-vendor-document": vendorDocuments,
    "./ask-cmpri-file-staging": originalFiles.staging,
    "./ask-cmpri-file-inspection": fileInspection,
    "./ask-cmpri-model-media": modelMedia,
  }, { Date, Intl, Error, AbortSignal, process: { env: {} } });
  const run = (question, previous, files) => agent.runNativeAsk({ request: request({ question }), auth, question, previous, files, language: "en", chief: true, signal: new AbortController().signal });
  return { native, auth, run, calls, storageWrites };
}

/** Real signed originals; only the storage/auth edges are fixtures. */
function selectedOriginals() {
  const objects = new Map(), calls = [];
  const state = { actor, hotel, now: Date.now(), mcp: false, denied: false };
  const storage = {
    info: async path => { calls.push({ action: "info", path }); const value = objects.get(path); return value ? { data: { size: value.bytes.length, contentType: value.type } } : { error: { status: 404 } }; },
    download: async path => { calls.push({ action: "download", path }); const value = objects.get(path); return value ? { data: new Blob([value.bytes], { type: value.type }) } : { error: { status: 404 } }; },
  };
  const current = () => ({ ok: true, mcp: state.mcp, principal: { ...principal, identity: { ...principal.identity, id: state.actor }, hotelId: state.hotel }, admin: { storage: { from: bucket => { assert.equal(bucket, selectedFileMedia.STAFF_FILE_BUCKET); return storage; } } } });
  const staging = loadTs("src/lib/server/ask-cmpri-file-staging.ts", {
    "server-only": {}, "@/lib/ask-cmpri/files": selectedFileTypes, "@/lib/staff-note-media": selectedFileMedia,
    "@/lib/server/auth": { requireUserAttempt: async incoming => { assert.equal(incoming.headers.get("authorization"), "Bearer fixture-user-session"); return state.denied ? { ok: false } : current(); } },
  }, { File, Request, Uint8Array, Date: class extends Date { static now() { return state.now; } }, Error, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "selected-original-signing-key" } } });
  const stage = async ({ id = "00000000-0000-4000-8000-000000000004", name = "Room 101 original.png", type = "image/png", bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 65, 255, 0]) } = {}) => {
    const descriptor = { id, name, type, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const path = `ask-files/v1/${state.hotel}/${state.actor}/${id}-${descriptor.sha256}`;
    objects.set(path, { bytes, type });
    return { file: (await staging.finalizeAskFile(request(), descriptor)).file, descriptor, bytes, path };
  };
  return { staging, stage, state, objects, calls };
}

test("native tools discover, read, count Bonvoy tiers, and join guest rooms to exact work-order links", async () => {
  const tiers = ["Base", "Silver", "Gold", "Platinum", "Titanium", "Ambassador"];
  const roomRows = Array.from({ length: 612 }, (_, index) => ({ room: String(index + 101), guest_name: `Guest ${index}`, loyalty_tier: tiers[index % 6], incoming_loyalty_tier: tiers[(index + 3) % 6] }));
  const orders = [
    { id: "ticket-gold", display_id: "WO#1001", room: "Room 103", issue: "Sink leaks", status: "Open" },
    { id: "ticket-closed", display_id: "WO#1002", room: "103", issue: "Old issue", status: "Closed" },
    { id: "ticket-ambassador", display_id: "WO#1003", room: "106", issue: "Heat not working", status: "In Progress" },
    { id: "ticket-base", display_id: "WO#1004", room: "101", issue: "Reading lamp", status: "Open" },
  ];
  const forwarded = [];
  const read = body => async native => { forwarded.push({ method: native.method, authorization: native.headers.get("authorization") }); return Response.json(body); };
  let aggregate;
  const f = fixture({ operations: [
    operation("room_operations.read", "/api/room-operations", read({ rows: roomRows, coverage: "complete fixture" })),
    operation("work_orders.list", "/api/work-orders", read({ work_orders: orders, count: orders.length })),
  ], script: async ({ call }) => {
    const catalog = await call("discoverOperations", { query: "room" });
    assert.ok(catalog.operations.some(operation => operation.key === "room_operations.read"));
    const contract = await call("describeOperation", { operation: "room_operations.read" });
    assert.equal(contract.method, "GET");
    assert.equal(contract.writes, false);
    const rooms = await call("readCmpri", { operation: contract.key });
    assert.equal(rooms.shape.rows.count, 612);
    aggregate = await call("querySnapshot", { snapshotId: rooms.snapshotId, path: "rows",
      filters: [{ path: "loyalty_tier", operator: "tierAtLeast", valueJson: '"Gold"' }],
      sort: [{ path: "loyalty_tier", direction: "desc", type: "bonvoy" }], groupBy: "loyalty_tier", aggregate: "count", limit: 2 });
    assert.equal(aggregate.matchedCount, 408);
    assert.equal(aggregate.aggregate, 408);
    assert.equal(aggregate.returnedCount, 2);
    const tickets = await call("readCmpri", { operation: "work_orders.list" });
    const joined = await call("joinSnapshots", { leftSnapshot: rooms.snapshotId, leftPath: "rows", leftKey: "room", rightSnapshot: tickets.snapshotId, rightPath: "work_orders", rightKey: "room" });
    assert.equal(joined.count, 4);
    const selected = await call("querySnapshot", { snapshotId: joined.snapshotId, filters: [
      { path: "left.loyalty_tier", operator: "tierAtLeast", valueJson: '"Gold"' },
      { path: "right.status", operator: "ne", valueJson: '"Closed"' },
    ], sort: [{ path: "left.room", direction: "asc" }] });
    assert.equal(selected.matchedCount, 2);
    assert.deepEqual(plain(selected.rows.map(row => row.right.id)), ["ticket-gold", "ticket-ambassador"]);
    return answer("Two qualifying rooms have active work orders.", selected.itemIds, "table");
  } });
  const result = await f.run("Show Gold or higher Bonvoy guests with active work orders, with ticket links.");
  assert.equal(result.items.length, 2);
  assert.equal(result.table.rows.length, 2);
  assert.deepEqual(forwarded, Array.from({ length: 2 }, () => ({ method: "GET", authorization: "Bearer fixture-user-session" })));
  assert.equal(aggregate.groups.reduce((sum, group) => sum + group.count, 0), 408);
  for (const [index, id] of ["ticket-gold", "ticket-ambassador"].entries()) {
    const item = result.items[index];
    const references = [item.record, ...(item.links || [])].filter(Boolean);
    assert.ok(references.some(reference => reference.kind === "order" && reference.id === id), "Joined evidence must retain the exact ticket link");
    const resultCell = result.table.rows[index].cells.Result;
    const tableReferences = [resultCell.record, ...(resultCell.links || [])].filter(Boolean);
    assert.ok(tableReferences.some(reference => reference.kind === "order" && reference.id === id), "Table rendering must retain joined ticket links");
  }
  assert.deepEqual(plain(result.context.native.reads.map(read => read.operation)), ["room_operations.read", "work_orders.list"]);
});

test("direct native ticket queries retain exact source links without serializing session credentials", async () => {
  const f = fixture({ operations: [operation("work_orders.list", "/api/work-orders", async () => Response.json({
    work_orders: [{ id: ticketId, display_id: "WO#1001", issue: "Sink leaks", room: "103" }], access_token: "never-show-this-token",
  }))], script: async ({ call }) => {
    const read = await call("readCmpri", { operation: "work_orders.list" });
    assert.equal(read.shape.access_token, undefined);
    const result = await call("querySnapshot", { snapshotId: read.snapshotId, path: "work_orders" });
    return answer("The source ticket is available.", result.itemIds, "table");
  } });
  const result = await f.run("Show that work order with its source link.");
  assert.equal(result.items[0].record.kind, "order");
  assert.equal(result.items[0].record.id, ticketId);
  assert.equal(result.table.rows[0].cells.Result.record.id, ticketId);
  assert.doesNotMatch(JSON.stringify(result), /never-show-this-token|fixture-user-session/);
});

test("snapshot IDs are request-local and invalid snapshots cannot export or join unobserved data", async () => {
  let staleId;
  const operations = [operation("room_operations.read", "/api/room-operations", async () => Response.json({ rows: [{ room: "101" }] }))];
  const first = fixture({ operations, script: async ({ call }) => {
    const read = await call("readCmpri", { operation: "room_operations.read" }); staleId = read.snapshotId;
    return answer("One room read.");
  } });
  await first.run("Read room operations.");
  const second = fixture({ operations, script: async ({ call }) => {
    const missing = await call("querySnapshot", { snapshotId: staleId, path: "rows" });
    assert.match(missing.error, /Read the authorized CMPRI data first/);
    const exported = await call("exportSnapshot", { snapshotId: "invented", format: "csv" });
    assert.match(exported.error, /Snapshot identifiers apply only to this request/);
    const joined = await call("joinSnapshots", { leftSnapshot: "invented", leftPath: "rows", leftKey: "room", rightSnapshot: "unread", rightPath: "rows", rightKey: "room" });
    assert.match(joined.error, /Read the authorized CMPRI data first/);
    return answer("The data must be read in this request first.");
  } });
  const result = await second.run("Export that stale snapshot.");
  assert.equal(result.items.length, 0);
  assert.equal(result.downloads, undefined);
});

test("CSV export neutralizes formula-like headers and values while JSON preserves authorized data", async () => {
  const rows = [
    { "=formula-header": "=1+1", note: " +cmd", other: "\t@SUM(A1)", quote: 'Guest said "hello"' },
    { "=formula-header": "-2+3", note: "Normal text", other: "@command", quote: "Line one\nLine two" },
  ];
  const f = fixture({ operations: [operation("notes.list", "/api/notes", async () => Response.json({ rows }))], script: async ({ call }) => {
    const read = await call("readCmpri", { operation: "notes.list" });
    const csv = await call("exportSnapshot", { snapshotId: read.snapshotId, path: "rows", format: "csv", name: "../../Guest results.csv" });
    assert.equal(csv.created, true);
    await call("exportSnapshot", { snapshotId: read.snapshotId, path: "rows", format: "json", name: "Guest results" });
    return answer("The requested files are ready.");
  } });
  const result = await f.run("Export the notes as CSV and JSON.");
  assert.equal(result.downloads.length, 2);
  const csv = result.downloads.find(file => file.mimeType.startsWith("text/csv"));
  assert.doesNotMatch(csv.name, /[\\/]/);
  for (const expected of ['"\'=formula-header"', '"\'=1+1"', '"\' +cmd"', '"\'\t@SUM(A1)"', '"\'-2+3"', '"\'@command"', '"Guest said ""hello"""']) assert.ok(csv.content.includes(expected), expected);
  const json = result.downloads.find(file => file.mimeType === "application/json");
  assert.deepEqual(JSON.parse(json.content), rows);
  assert.equal(f.storageWrites.length, 0, "Exports do not write into native CMPRI data");
});

test("native read denial and application-level errors never become successful read snapshots", async () => {
  const f = fixture({ operations: [
    operation("users.list", "/api/users", async () => Response.json({ error: "Fixture denied" }, { status: 403 })),
    operation("catalog.read", "/api/engineering/catalog", async () => Response.json({ success: false, error: "Fixture catalog unavailable" })),
  ], script: async ({ call }) => {
    const denied = await call("readCmpri", { operation: "users.list" });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    assert.equal(denied.snapshotId, undefined);
    const failed = await call("readCmpri", { operation: "catalog.read" });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 422);
    assert.equal(failed.snapshotId, undefined);
    // The host must retain known failures even if a provider's final wording is wrong.
    return answer("Everything completed successfully.");
  } });
  const result = await f.run("Read users and inventory.");
  assert.equal(result.items.length, 0);
  assert.match(result.summary, /role does not permit|catalog unavailable/);
  assert.doesNotMatch(result.summary, /Everything completed successfully/);
});

test("native actions do not mutate before confirmation and replay cannot apply the same change twice", async () => {
  let mutations = 0;
  const operations = [
    operation("work_orders.read", "/api/work-orders/[id]", async () => Response.json({ id: ticketId, display_id: "WO#1001", issue: "Sink leaks", priority: "Medium", revision: 7 }), { parameters: ["id"] }),
    operation("work_orders.update", "/api/work-orders/[id]", async native => {
      assert.equal(native.method, "PATCH");
      assert.equal(native.headers.get("authorization"), "Bearer fixture-user-session");
      assert.deepEqual(await native.json(), { priority: "Urgent", expected_revision: 7 });
      mutations++; return Response.json({ success: true, work_order: { id: ticketId, priority: "Urgent", revision: 8 } });
    }, { method: "PATCH", parameters: ["id"] }),
  ];
  const change = { operation: "work_orders.update", parameters: [{ name: "id", value: ticketId }], bodyJson: JSON.stringify({ priority: "Urgent", expected_revision: 7 }) };
  const f = fixture({ operations, script: async ({ call }) => {
    const missingRules = await call("proposeChange", { label: "Set WO#1001 to Urgent", requests: [change] });
    assert.match(missingRules.error, /contract and workflow rules/);
    assert.equal(mutations, 0);
    await call("describeOperation", { operation: "work_orders.update" });
    await call("readCmpri", { operation: "work_orders.read", parameters: change.parameters });
    const blocked = await call("readCmpri", change);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(mutations, 0);
    const proposed = await call("proposeChange", { label: "Set WO#1001 to Urgent", requests: [change] });
    assert.equal(proposed.requiresConfirmation, true);
    assert.equal(proposed.performed, false);
    assert.equal(mutations, 0);
    return answer("The model must not claim this write happened.");
  } });
  const result = await f.run("Set WO#1001 priority to Urgent.");
  assert.equal(mutations, 0);
  assert.equal(f.storageWrites.length, 0);
  assert.ok(result.proposal.token.startsWith("native."));
  assert.equal(result.title, "Review proposed change");
  assert.equal(result.summary, "Set WO#1001 to Urgent");
  const confirmed = await f.native.confirmAskNativeChange(request({ confirmationToken: result.proposal.token }), f.auth, result.proposal.token);
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.result.summary, /1 change completed/);
  assert.equal(mutations, 1);
  const repeated = await f.native.confirmAskNativeChange(request({ confirmationToken: result.proposal.token }), f.auth, result.proposal.token);
  assert.equal(repeated.status, 200);
  assert.equal(mutations, 1);
});

test("selected-file handles canonicalize metadata and confirm exact original multipart bytes and JSON source references", async () => {
  const originals = selectedOriginals(), photo = await originals.stage();
  const csv = await originals.stage({ id: "00000000-0000-4000-8000-000000000005", name: "Actual In House.csv", type: "text/csv", bytes: new TextEncoder().encode("Room,Guest\n101,Original source") });
  const writes = [];
  const operations = [
    operation("work_order_attachments.add", "/api/work-orders/[id]/attachments", async incoming => {
      assert.equal(incoming.headers.get("authorization"), "Bearer fixture-user-session");
      assert.equal(incoming.headers.get("x-upload-id"), photo.file.id);
      assert.match(incoming.headers.get("content-type"), /^multipart\/form-data; boundary=/);
      assert.equal(incoming.headers.get("cookie"), null); assert.equal(incoming.headers.get("apikey"), null);
      const form = await incoming.formData(), original = form.get("photo");
      assert.equal(original.name, photo.file.name); assert.equal(original.type, photo.file.type);
      assert.deepEqual(new Uint8Array(await original.arrayBuffer()), photo.bytes);
      writes.push({ kind: "photo", uploadId: incoming.headers.get("x-upload-id") });
      return Response.json({ success: true });
    }, { method: "POST", bodyKind: "multipart", parameters: ["id"] }),
    operation("room_operations.files_import", "/api/ask-cmpri/native-files/guest-import", async incoming => {
      const body = await incoming.json(); assert.deepEqual(body, { fileTokens: [csv.file.token], previousId: null });
      const original = await originals.staging.readAskStagedFile(incoming, body.fileTokens[0]);
      assert.deepEqual(original.bytes, csv.bytes); writes.push({ kind: "csv" }); return Response.json({ success: true });
    }, { method: "POST" }),
  ];
  const f = fixture({ operations, originalFiles: originals, script: async ({ call, prompt }) => {
    assert.deepEqual(prompt.files, [photo, csv].map(({ file }) => ({ fileId: "file:" + file.id, name: file.name, type: file.type, size: file.size, sha256: file.sha256 })));
    assert.doesNotMatch(JSON.stringify(prompt), /ask-file\./);
    await call("describeOperation", { operation: "work_order_attachments.add" });
    await call("describeOperation", { operation: "room_operations.files_import" });
    const prepared = await call("proposeChange", { label: "Attach the selected photo and import the reviewed guest report", requests: [
      { operation: "work_order_attachments.add", parameters: [{ name: "id", value: ticketId }], files: [{ name: "photo", fileId: "file:" + photo.file.id }] },
      { operation: "room_operations.files_import", bodyJson: JSON.stringify({ fileTokens: [{ $askFile: "file:" + csv.file.id }], previousId: null }) },
    ] });
    assert.equal(prepared.performed, false); assert.equal(prepared.requiresConfirmation, true); assert.equal(writes.length, 0);
    return answer("Prepared the exact selected originals for review.");
  } });
  const result = await f.run("Attach the selected original to WO#1001 and import the reviewed guest report.", undefined, [
    { id: photo.file.id, name: "Untrusted client label", file: { ...photo.file, id: ticketId, name: "forged.bin", type: "application/x-forged", size: 1, sha256: "0".repeat(64) } },
    { id: csv.file.id, name: csv.file.name, file: csv.file },
  ]);
  assert.equal(writes.length, 0); assert.equal(f.storageWrites.length, 0);
  const review = JSON.parse(result.proposal.to);
  assert.match(review[0].files.photo, /Room 101 original\.png/); assert.match(review[1].values.fileTokens[0], /Actual In House\.csv/);
  assert.doesNotMatch(result.proposal.to, /ask-file\.|forged\.bin|application\/x-forged/);
  assert.ok(result.proposal.to.includes(photo.file.sha256));
  const signed = f.native.verifyAskNativeChange(result.proposal.token, f.auth.principal);
  assert.equal(signed.requests[0].files.photo, photo.file.token); assert.equal(signed.requests[1].body.fileTokens[0], csv.file.token);
  const confirmed = await f.native.confirmAskNativeChange(request(), f.auth, result.proposal.token);
  assert.equal(confirmed.status, 200); assert.equal(writes.length, 2);
  assert.equal((await f.native.confirmAskNativeChange(request(), f.auth, result.proposal.token)).status, 200); assert.equal(writes.length, 2);
  const retry = f.native.beginAskNativeChange(f.auth.principal, [signed.requests[0]], "en", "Same original photo retry");
  assert.equal((await f.native.confirmAskNativeChange(request(), f.auth, retry.token)).status, 200);
  assert.equal(writes[2].uploadId, writes[0].uploadId, "A new proposal for the identical original must retain the native upload id");
});

test("follow-up turns retain reverified signed originals without exposing tokens to the model", async () => {
  const originals = selectedOriginals(), source = await originals.stage();
  let phase = 0;
  const f = fixture({ originalFiles: originals, operations: [operation("work_order_attachments.add", "/api/work-orders/[id]/attachments", () => assert.fail("A proposal must not write"), { method: "POST", bodyKind: "multipart", parameters: ["id"] })], script: async ({ call, prompt }) => {
    assert.equal(prompt.files.length, 1); assert.equal(prompt.files[0].name, source.file.name);
    assert.doesNotMatch(JSON.stringify(prompt), /ask-file\./);
    if (phase++ === 0) return answer("The selected original is retained for this conversation.");
    assert.equal(prompt.previous.native.files, undefined);
    await call("describeOperation", { operation: "work_order_attachments.add" });
    const proposed = await call("proposeChange", { label: "Attach that same original", requests: [{ operation: "work_order_attachments.add", parameters: [{ name: "id", value: ticketId }], files: [{ name: "photo", fileId: prompt.files[0].fileId }] }] });
    assert.equal(proposed.performed, false); return answer("Review the original photo attachment.");
  } });
  const first = await f.run("Keep this original for the next request.", undefined, [{ id: source.file.id, name: source.file.name, file: source.file }]);
  assert.deepEqual(plain(first.context.native.files), [plain(source.file)]);
  const reads = originals.calls.length;
  const second = await f.run("Now attach that same file to WO#1001.", first.context);
  assert.equal(f.native.verifyAskNativeChange(second.proposal.token, f.auth.principal).requests[0].files.photo, source.file.token);
  assert.equal(originals.calls.length, reads, "Discovery reverifies signed metadata without downloading original bytes");
  assert.deepEqual(plain(second.context.native.files), [plain(source.file)]);
});

test("json-or-multipart native handlers receive JSON without files and original multipart when files are present", async () => {
  const originals = selectedOriginals(), source = await originals.stage();
  const received = [];
  const op = operation("assets.native-upload", "/api/assets/documentation", async incoming => {
    if (incoming.headers.get("content-type").startsWith("application/json")) received.push(await incoming.json());
    else {
      const form = await incoming.formData(), file = form.get("file");
      assert.equal(form.get("asset_id"), ticketId); assert.equal(form.get("reviewed"), "true");
      assert.equal(file.name, source.file.name); assert.deepEqual(new Uint8Array(await file.arrayBuffer()), source.bytes);
      received.push({ multipart: true });
    }
    return Response.json({ success: true });
  }, { method: "POST", bodyKind: "json-or-multipart" });
  const f = fixture({ operations: [op], originalFiles: originals, script: () => answer("Unused model fixture") });
  assert.equal((await f.native.runAskNativeRequest(request(), { operation: op.key, body: { asset_id: ticketId, reviewed: true } }, true)).ok, true);
  assert.equal((await f.native.runAskNativeRequest(request(), { operation: op.key, body: { asset_id: ticketId, reviewed: true }, files: { file: source.file.token } }, true)).ok, true);
  assert.deepEqual(received, [{ asset_id: ticketId, reviewed: true }, { multipart: true }]);
  const before = originals.calls.length;
  const conflict = await f.native.runAskNativeRequest(request(), { operation: op.key, body: { file: "invented source" }, files: { file: source.file.token } }, true);
  assert.equal(conflict.ok, false); assert.equal(conflict.status, 400); assert.equal(received.length, 2); assert.equal(originals.calls.length, before);
});

test("forged, expired and cross-account original references cannot become file handles or native writes", async () => {
  const originals = selectedOriginals(), source = await originals.stage();
  const tampered = source.file.token.split(".");
  const payload = JSON.parse(Buffer.from(tampered[1], "base64url").toString()); payload.descriptor.name = "invented.pdf";
  tampered[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const forged = { ...source.file, token: tampered.join(".") };
  originals.state.actor = ticketId; const foreignActor = await originals.stage(); originals.state.actor = actor;
  originals.state.hotel = ticketId; const foreignHotel = await originals.stage(); originals.state.hotel = hotel;
  const unavailable = [forged, foreignActor.file, foreignHotel.file, source.file];
  const initialTime = originals.state.now;
  let mutations = 0;
  const op = operation("work_order_attachments.add", "/api/work-orders/[id]/attachments", () => { mutations++; return Response.json({ success: true }); }, { method: "POST", bodyKind: "multipart", parameters: ["id"] });
  const f = fixture({ operations: [op], originalFiles: originals, script: async ({ call, prompt }) => {
    assert.deepEqual(prompt.files, []);
    await call("describeOperation", { operation: op.key });
    const rejected = await call("proposeChange", { label: "Invalid source must not be attached", requests: [{ operation: op.key, parameters: [{ name: "id", value: ticketId }], files: [{ name: "photo", fileId: "file:" + source.file.id }] }] });
    assert.match(rejected.error, /original file/); return answer("Select the original again.");
  } });
  const before = originals.calls.length;
  for (const file of unavailable) {
    originals.state.now = initialTime + (file === source.file ? 24 * 60 * 60 * 1000 + 1 : 0);
    const response = await f.run("Attach the original.", undefined, [{ id: file.id, name: file.name, file }]);
    assert.equal(response.proposal, undefined);
    // Even a valid confirmation envelope cannot bypass the original's own proof.
    const proposal = f.native.beginAskNativeChange(f.auth.principal, [{ operation: op.key, parameters: { id: ticketId }, files: { photo: file.token } }], "en", "Rejected original reference");
    const result = await f.native.confirmAskNativeChange(request(), f.auth, proposal.token);
    assert.notEqual(result.status, 200);
  }
  assert.equal(mutations, 0); assert.equal(originals.calls.length, before);
});

test("selected source markers reject unselected handles and metadata smuggling before proposal signing", async () => {
  const originals = selectedOriginals(), source = await originals.stage();
  const f = fixture({ originalFiles: originals, operations: [operation("room_operations.files_import", "/api/ask-cmpri/native-files/guest-import", () => assert.fail("Rejected source must not write"), { method: "POST" })], script: async ({ call }) => {
    await call("describeOperation", { operation: "room_operations.files_import" });
    for (const marker of [{ $askFile: "file:unselected" }, { $askFile: "file:" + source.file.id, token: source.file.token }, { $askFile: 42 }]) {
      const rejected = await call("proposeChange", { label: "Rejected source", requests: [{ operation: "room_operations.files_import", bodyJson: JSON.stringify({ fileTokens: [marker], previousId: null }) }] });
      assert.match(rejected.error, /original.file reference|original file/);
    }
    return answer("Use the exact selected original.");
  } });
  const result = await f.run("Import the selected original.", undefined, [{ id: source.file.id, name: source.file.name, file: source.file }]);
  assert.equal(result.proposal, undefined); assert.equal(f.storageWrites.length, 0);
});

test("selected image inspection supplies authorized original bytes only in model media, with permission and provider failures explicit", async () => {
  const originals = selectedOriginals();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=", "base64");
  const source = await originals.stage({ name: "Actual Daily Ops image.png", bytes });
  const selected = [{ id: source.file.id, name: source.file.name, file: source.file }];
  let phase = "read";
  const f = fixture({ operations: [], originalFiles: originals, script: async ({ call, prompt }) => {
    const read = await call("inspectFile", { fileId: prompt.files[0].fileId });
    if (phase === "denied") { assert.match(read.error, /Sign in/); return answer("The original could not be read with the current session."); }
    assert.equal(read.complete, false);
    const summary = await call("querySnapshot", { snapshotId: read.snapshotId, path: "originalMedia" });
    assert.equal(summary.rows[0].status, "ready"); assert.equal(summary.rows[0].sha256, source.file.sha256);
    assert.ok(!JSON.stringify(summary).includes(bytes.toString("base64")));
    if (phase === "provider-error") throw Error("Fixture provider rejected the image request with status 413");
    return answer("The exact source was provided for visual review; unreadable details remain unknown.");
  } });
  const before = originals.calls.length;
  const response = await f.run("Read the selected Daily Ops image.", undefined, selected);
  assert.equal(originals.calls.filter(call => call.action === "download").length, 2, "Finalize and consumption each read the actual scoped original");
  assert.ok(originals.calls.length > before);
  const inspected = f.calls.find(call => call.name === "inspectFile");
  const part = inspected.modelOutput.value.find(part => part.type === "file");
  assert.equal(part.mediaType, "image/png"); assert.equal(part.filename, source.file.name); assert.deepEqual(Buffer.from(part.data.data, "base64"), bytes);
  assert.ok(!JSON.stringify(inspected.result).includes(bytes.toString("base64"))); assert.ok(!JSON.stringify(response).includes(bytes.toString("base64")));
  assert.equal(response.downloads, undefined); assert.equal(response.proposal, undefined);
  phase = "denied"; originals.state.denied = true; const callsBeforeDenial = originals.calls.length;
  const denied = await f.run("Read that same image again.", response.context);
  assert.equal(originals.calls.length, callsBeforeDenial); assert.equal(f.calls.at(-1).modelOutput.value.some(part => part.type === "file"), false);
  assert.equal(denied.proposal, undefined); assert.match(denied.summary, /Sign in/);
  phase = "provider-error"; originals.state.denied = false;
  const incomplete = await f.run("Read that same image again.", response.context);
  assert.match(incomplete.summary, /stopped before the full request was completed/); assert.equal(incomplete.proposal, undefined);
  assert.ok(!JSON.stringify(incomplete).includes(bytes.toString("base64")));
});

test("authorized native radar image reads attach exact visual media and report shared-budget exhaustion honestly", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=", "base64");
  let denied = false, nativeReads = 0;
  const op = operation("weather.map", "/api/weather-preview/map", incoming => {
    nativeReads++; assert.equal(incoming.headers.get("authorization"), "Bearer fixture-user-session");
    if (denied) return Response.json({ error: "Native weather access denied" }, { status: 403 });
    return new Response(bytes, { headers: { "Content-Type": "image/png", "Content-Disposition": 'attachment; filename="Actual NOAA radar.png"' } });
  });
  const f = fixture({ operations: [op], modelMedia: { ...originalModelMedia, ASK_MODEL_MEDIA_BYTES: bytes.length }, script: async ({ call }) => {
    const first = await call("readCmpri", { operation: op.key });
    assert.equal(first.originalMedia.status, "ready"); assert.equal(first.originalMedia.complete, false);
    const snapshot = await call("querySnapshot", { snapshotId: first.snapshotId });
    assert.ok(!JSON.stringify(snapshot).includes(bytes.toString("base64")));
    const second = await call("readCmpri", { operation: op.key });
    assert.equal(second.originalMedia.status, "too_large"); assert.equal(second.originalMedia.complete, false); assert.match(second.originalMedia.message, /remaining inline media budget/);
    denied = true; const blocked = await call("readCmpri", { operation: op.key });
    assert.equal(blocked.ok, false); assert.equal(blocked.status, 403);
    return answer("One original radar image was provided. The next image exceeded this answer's media budget, and the later read was denied.");
  } });
  const result = await f.run("Inspect the native radar images.");
  assert.equal(nativeReads, 3);
  const reads = f.calls.filter(call => call.name === "readCmpri");
  const part = reads[0].modelOutput.value.find(part => part.type === "file");
  assert.equal(part.filename, "Actual NOAA radar.png"); assert.deepEqual(Buffer.from(part.data.data, "base64"), bytes);
  assert.equal(reads[1].modelOutput.value.some(part => part.type === "file"), false); assert.equal(reads[2].modelOutput.value.some(part => part.type === "file"), false);
  assert.ok(!JSON.stringify(result.context).includes(bytes.toString("base64"))); assert.ok(!JSON.stringify(result.items).includes(bytes.toString("base64")));
  assert.equal(result.downloads.length, 2); assert.equal(result.downloads[0].content, bytes.toString("base64"));
  assert.match(result.summary, /media budget/); assert.match(result.summary, /role does not permit/);
});

test("saved native JSON, workbook and PDF downloads are inspected explicitly through the full original reader", async () => {
  const jsonSource = { rows: Array.from({ length: 900 }, (_, index) => ({ id: index, note: "Original saved note " + index })), tail: "FINAL-SAVED-SOURCE" };
  const zip = new AdmZip();
  zip.addFile("xl/workbook.xml", Buffer.from('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Actual saved sheet" r:id="r1"/></sheets></workbook>'));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile("xl/worksheets/sheet1.xml", Buffer.from('<worksheet><sheetData><row r="45"><c r="D45" t="inlineStr"><is><t>Last saved worksheet value</t></is></c><c r="E45"><f>SUM(E1:E44)</f><v>72</v></c></row></sheetData></worksheet>'));
  const sources = {
    json: { name: "Saved staff data.json", type: "application/json", bytes: Buffer.from(JSON.stringify(jsonSource)) },
    xlsx: { name: "Saved staff workbook.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: zip.toBuffer() },
    pdf: { name: "Saved staff manual.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-exact-authorized-native-original") },
  };
  const inspections = [], nativeCalls = [], pdfCalls = [];
  const reader = loadTs("src/lib/server/ask-cmpri-file-inspection.ts", {
    "server-only": {}, "adm-zip": { default: AdmZip }, "@xmldom/xmldom": { DOMParser },
    "@/lib/ask-cmpri/files": selectedFileTypes,
    "./ask-cmpri-file-staging": { readAskStagedFile: () => assert.fail("Saved native sources must not be reinterpreted as selected upload tokens") },
    "@/lib/manual-pdf-knowledge": { inspectManualPdf: async (bytes, options) => {
      pdfCalls.push({ bytes, options });
      assert.deepEqual(Buffer.from(bytes), sources.pdf.bytes); assert.deepEqual(plain(options), { includeEmptyPages: true });
      return { text: "First saved page\nFinal saved page", total_pages: 3,
        pages: [{ page: 1, text: "First saved page" }, { page: 2, text: "", needs_ocr: true }, { page: 3, text: "Final saved page" }], warnings: [] };
    } },
  }, { TextDecoder, Uint8Array });
  const op = operation("staff_notes.attachment_read", "/api/staff-notes/attachments/read", incoming => {
    assert.equal(incoming.headers.get("authorization"), "Bearer fixture-user-session");
    const selected = incoming.nextUrl.searchParams.get("id"), source = sources[selected];
    assert.ok(source); nativeCalls.push(selected);
    return new Response(source.bytes, { headers: { "Content-Type": source.type, "Content-Disposition": `attachment; filename="${source.name}"`, "X-CMPRI-Export-Source": "Original authorized Staff Note attachment" } });
  }, { query: ["id"] });
  const f = fixture({ operations: [op], fileInspection: { ...reader, inspectAskOriginalFile: async original => {
    inspections.push(original); return reader.inspectAskOriginalFile(original);
  } }, script: async ({ call }) => {
    for (const [key, source] of Object.entries(sources)) {
      const before = inspections.length;
      const read = await call("readCmpri", { operation: op.key, query: [{ name: "id", value: key }] });
      assert.equal(inspections.length, before, "A requested download alone must not automatically parse its contents");
      assert.equal(read.files[0].name, source.name); assert.match(read.files[0].fileId, /^native-file:/);
      assert.ok(!JSON.stringify(read).includes(source.bytes.toString("base64")));
      const inspected = await call("inspectNativeFile", { fileId: read.files[0].fileId });
      assert.equal(inspections.length, before + 1);
      assert.deepEqual(Buffer.from(inspections.at(-1).bytes), source.bytes);
      assert.equal(inspections.at(-1).descriptor.name, source.name);
      assert.equal(inspections.at(-1).descriptor.sha256, createHash("sha256").update(source.bytes).digest("hex"));
      assert.equal(inspected.sourceScope, "Original authorized Staff Note attachment");
      if (key === "json") {
        assert.equal(inspected.complete, true);
        const rows = await call("querySnapshot", { snapshotId: inspected.snapshotId, path: "data.rows", aggregate: "count", offset: 899, limit: 1 });
        assert.equal(rows.aggregate, 900); assert.equal(rows.rows[0].note, "Original saved note 899");
        const text = await call("querySnapshot", { snapshotId: inspected.snapshotId, path: "textChunks", limit: 50 });
        assert.equal(text.rows.map(row => row.text).join(""), JSON.stringify(jsonSource));
      } else if (key === "xlsx") {
        assert.equal(inspected.complete, true);
        const cells = await call("querySnapshot", { snapshotId: inspected.snapshotId, path: "sheets.0.rows.0.cells" });
        assert.equal(cells.rows[0].cell, "D45"); assert.equal(cells.rows[0].value, "Last saved worksheet value");
        assert.equal(cells.rows[1].formula, "SUM(E1:E44)"); assert.equal(cells.rows[1].cachedValue, 72);
      } else {
        assert.equal(inspected.complete, false, "OCR gaps must never be described as complete source coverage");
        const coverage = await call("querySnapshot", { snapshotId: inspected.snapshotId, fields: ["totalPages", "needsOcr"] });
        assert.equal(coverage.rows[0].totalPages, 3); assert.deepEqual(plain(coverage.rows[0].needsOcr), [2]);
        const pages = await call("querySnapshot", { snapshotId: inspected.snapshotId, path: "pages" });
        assert.equal(pages.rows.length, 3); assert.equal(pages.rows[2].text, "Final saved page");
      }
    }
    return answer("Read the saved JSON and workbook completely. The saved PDF still requires OCR on page 2.");
  } });
  const result = await f.run("Read my saved Staff Note's original JSON, workbook and PDF attachments.");
  assert.deepEqual(nativeCalls, ["json", "xlsx", "pdf"]); assert.equal(pdfCalls.length, 1); assert.equal(result.proposal, undefined);
  assert.equal(result.downloads.length, 3);
  for (const source of Object.values(sources)) {
    const download = result.downloads.find(file => file.name === source.name);
    assert.deepEqual(Buffer.from(download.content, "base64"), source.bytes);
    assert.ok(!JSON.stringify(result.context).includes(source.bytes.toString("base64")));
    for (const call of f.calls) assert.ok(!(JSON.stringify(call.modelOutput) || "").includes(source.bytes.toString("base64")), "Original binary bytes never enter text tool output");
  }
});

test("native file inspection rejects invented and prior-request handles and never parses a denied source", async () => {
  const bytes = Buffer.from("Authorized saved text");
  let phase = "first", firstHandle, nativeReads = 0, inspected = 0;
  const op = operation("staff_notes.attachment_read", "/api/staff-notes/attachments/read", incoming => {
    assert.equal(incoming.headers.get("authorization"), "Bearer fixture-user-session"); nativeReads++;
    if (phase === "denied") return Response.json({ error: "Native attachment access denied" }, { status: 403 });
    return new Response(bytes, { headers: { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="saved.txt"' } });
  });
  const f = fixture({ operations: [op], fileInspection: { inspectAskOriginalFile: async original => {
    inspected++; return { kind: "text", complete: true, text: Buffer.from(original.bytes).toString() };
  } }, script: async ({ call }) => {
    if (phase === "first") {
      const invented = await call("inspectNativeFile", { fileId: "native-file:invented" });
      assert.match(invented.error, /authorized CMPRI record first/); assert.equal(inspected, 0); assert.equal(nativeReads, 0);
      const read = await call("readCmpri", { operation: op.key }); firstHandle = read.files[0].fileId;
      const result = await call("inspectNativeFile", { fileId: firstHandle }); assert.equal(result.complete, true);
    } else {
      const stale = await call("inspectNativeFile", { fileId: firstHandle });
      assert.match(stale.error, /authorized CMPRI record first/); assert.equal(inspected, 1);
      const read = await call("readCmpri", { operation: op.key });
      assert.equal(read.ok, false); assert.equal(read.status, 403); assert.equal(read.files, undefined);
      const denied = await call("inspectNativeFile", { fileId: firstHandle });
      assert.match(denied.error, /authorized CMPRI record first/); assert.equal(inspected, 1);
    }
    return answer("Source access is limited to files read in this authorized request.");
  } });
  const first = await f.run("Inspect the saved Staff Note text attachment.");
  assert.equal(inspected, 1); assert.equal(nativeReads, 1);
  phase = "denied";
  const denied = await f.run("Read that same saved source again.", first.context);
  assert.equal(inspected, 1); assert.equal(nativeReads, 2);
  assert.equal(denied.downloads, undefined); assert.equal(denied.proposal, undefined); assert.match(denied.summary, /role does not permit/);
});

test("the exact reported PM year-end question bypasses Gemini and returns the deterministic PM helper result", async () => {
  let keyChecks = 0, plannerCalls = 0;
  const pmCalls = [];
  const summary = "Fixture PM plan: 39 calendar days, 29 Monday–Friday weekdays, 3 room PMs per weekday.";
  const handler = loadTs("src/app/api/ask-cmpri/route.ts", {
    "next/server": { NextResponse: { json: Response.json } }, zod,
    "@/lib/server/roles": { profileIsChiefEngineer: () => true, profileIsEstablishedHoursChief: () => false },
    "@/lib/server/auth": { requireUserAttempt: async () => ({ ok: true, mcp: false, principal }) },
    "@/lib/work-order-attribution": {},
    "@/lib/server/ask-cmpri-data": { askContextSchema: zod.z.object({}).passthrough() },
    "@/lib/server/ask-cmpri-gemini": { askGeminiKey: () => { keyChecks++; return null; }, planAsk: () => { plannerCalls++; throw Error("PM must not call Gemini"); } },
    "@/lib/server/ask-cmpri-actions": { askPhotoSchema: zod.z.object({}) },
    "@/lib/server/ask-cmpri-pm": { readAskPm: async (auth, input) => {
      assert.equal(auth.principal.identity.id, actor); pmCalls.push(input);
      return { summary, items: [{ id: "pm:fixture", title: "PM plan", source: "CMPRI · Preventive Maintenance", sourceType: "internal" }] };
    } },
  }, { TextDecoder, AbortSignal, Error, process: { env: { SUPABASE_SERVICE_ROLE_KEY: "fixture-signing-secret" } } });
  const question = "How many PMs do I need to do per day to get them done by the end of the year?";
  const response = await handler.POST(request({ question }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.summary, summary);
  assert.equal(result.items[0].record.kind, "module");
  assert.equal(result.items[0].record.id, "/engineering/preventive-maintenance");
  assert.deepEqual(result.context.sources, ["preventiveMaintenance"]);
  assert.ok(result.context.contextProof);
  assert.deepEqual(plain(pmCalls), [{ question, rooms: [] }]);
  const readOnlyVariant = "How many PMs per day must I complete for Room 101 by the end of the year?";
  const variant = await handler.POST(request({ question: readOnlyVariant }));
  assert.equal(variant.status, 200, "The verb complete in a how-many question is not a request to modify PM records");
  assert.equal((await variant.json()).summary, summary);
  assert.deepEqual(plain(pmCalls[1]), { question: readOnlyVariant, rooms: ["101"] });
  assert.equal(keyChecks, 0);
  assert.equal(plannerCalls, 0);
});

test("vendor search, original download, and later verification retain source choices and the same document", async () => {
  const assetId = "00000000-0000-4000-8000-000000000004";
  const asset = { id: assetId, name: "Installed washer", manufacturer: "FixtureCo", model_number: "W-100", model_family: null, serial_number: "PRIVATE-SERIAL", location_id: "PRIVATE-ROOM" };
  const sourceUrl = "https://vendor.com/service/W-100.pdf";
  const descriptor = { id: "original-file", name: "W-100.pdf", sha256: "a".repeat(64), size: 321, kind: "asset-documentation" };
  const original = { kind: "pdf", token: "original-reference-token", descriptor, asset, sourceUrl,
    identityMatch: true, review: { complete: true, intended: "reference", serial: { status: "unrestricted" } },
    source: { text: "PAGE 1\nFixtureCo W-100 Service Manual", pages: [{ page: 1, text: "FixtureCo W-100" }], totalPages: 1, warnings: [] } };
  let phase = 0, acquisitions = 0, reviewCalls = 0, writes = 0;
  const f = fixture({
    operations: [operation("manuals.vendor_import", "/api/assets/documentation", async () => { writes++; return Response.json({ success: true }); }, { method: "POST" })],
    vendorSearch: async identity => {
      assert.deepEqual(plain(identity), { manufacturer: "FixtureCo", model: "W-100" });
      assert.doesNotMatch(JSON.stringify(identity), /PRIVATE/);
      return [{ id: "vendor-choice", title: "W-100 service manual", href: sourceUrl, source: "Web · vendor.com", sourceType: "web" }];
    },
    vendorDocuments: {
      loadAskVendorAsset: async () => ({ asset }),
      prepareAskVendorDocument: async (_request, input) => {
        acquisitions++; assert.equal(input.url, sourceUrl); assert.equal(input.assetId, assetId); return original;
      },
      reviewAskVendorDocument: async (_request, token, intended) => {
        reviewCalls++; assert.equal(token, original.token); assert.equal(intended, "verify");
        return { ...original, token: "same-original-verified-intent", text: original.source.text, review: { ...original.review, intended } };
      },
    },
    script: async ({ call, prompt }) => {
      if (phase === 0) {
        await call("findAssetDocument", { assetId });
        return answer("A vendor source is available.");
      }
      if (phase === 1) {
        assert.equal(prompt.previous.native.publicSources[0].title, "W-100 service manual");
        const read = await call("readVendorDocument", { assetId, url: prompt.previous.native.publicSources[0].url });
        assert.equal(read.identityMatch, true); return answer("The original can be downloaded; no asset has changed.");
      }
      const retained = prompt.previous.native.documents[0];
      const reviewed = await call("readVendorDocument", { assetId, documentToken: retained.token, intended: "verify" });
      await call("describeOperation", { operation: "manuals.vendor_import" });
      const proposed = await call("proposeChange", { label: "Attach and verify W-100.pdf for the installed washer", requests: [{ operation: "manuals.vendor_import", bodyJson: JSON.stringify({ documentToken: reviewed.documentToken, verify: true }) }] });
      assert.equal(proposed.performed, false); return answer("Review the requested native change.");
    },
  });
  const first = await f.run("Find the vendor document for the selected asset.");
  phase = 1;
  const second = await f.run("Read the first PDF and make it available for download.", first.context);
  assert.equal(second.downloads[0].downloadToken, original.token);
  assert.equal(second.context.native.documents[0].token, original.token);
  phase = 2;
  const third = await f.run("Now upload and verify that same document.", second.context);
  assert.equal(acquisitions, 1, "A later review must reuse the original without another vendor fetch");
  assert.equal(reviewCalls, 1);
  assert.equal(writes, 0);
  assert.match(third.proposal.to, /W-100.pdf/);
  assert.match(third.proposal.to, /vendor.com/);
  assert.doesNotMatch(third.proposal.to, /original-reference-token|same-original-verified-intent/);
  const signed = f.native.verifyAskNativeChange(third.proposal.token, f.auth.principal);
  assert.equal(signed.requests[0].body.documentToken, "same-original-verified-intent");
  assert.equal(third.context.native.documents[0].token, "same-original-verified-intent");
});

test("a guessed vendor URL cannot fetch a document", async () => {
  const f = fixture({ operations: [], vendorDocuments: { prepareAskVendorDocument: () => assert.fail("Unobserved source must never be fetched") },
    script: async ({ call }) => {
      const found = await call("readVendorDocument", { assetId: "00000000-0000-4000-8000-000000000004", url: "https://vendor.com/invented.pdf" });
      assert.match(found.error, /actual vendor search\/page link/);
      return answer("The source needs to be found first.");
    } });
  const result = await f.run("Find the equipment manual.");
  assert.equal(result.downloads, undefined);
  assert.equal(result.proposal, undefined);
});
