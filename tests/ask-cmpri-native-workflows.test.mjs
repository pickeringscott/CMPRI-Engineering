import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const pool = loadTs("src/lib/pool-log.ts", {}, { Date });
const roomOperations = loadTs("src/lib/room-operations.ts");
const driveAdapter = loadTs("src/lib/server/drive-room-report-import.ts");
const facility = "f1130fe7-8569-443e-8e1c-03cd6e875eee";
const request = body => new NextRequest("https://cmpri.test/api/ask-cmpri", { method: "POST", headers: { Authorization: "Bearer native-user-session", "Content-Type": "application/json" }, body: JSON.stringify(body) });
function fixture() {
  const calls = [];
  const state = { denied: false, readbackDenied: false, validationError: false, files: [{ name: "In-house.csv", text: "original guest source" }], privateResult: false,
    roomRows: [{ room: "101", room_status: "OOO" }, { room: "201", room_status: "Out of Order" }, { room: "303", room_status: "Occupied", move_from: "304", move_to: "303" }] };
  const resultId = "8337c6db-a46f-48c4-9987-16fb13b9981e";
  const record = async (kind, incoming) => {
    assert.equal(incoming.headers.get("authorization"), "Bearer native-user-session");
    const body = incoming.method === "GET" ? null : await incoming.json();
    calls.push({ kind, method: incoming.method, url: incoming.url, body });
    return body;
  };
  const privateBytes = () => Buffer.from(JSON.stringify({ files: state.files }));
  const workflows = loadTs("src/lib/server/ask-cmpri-native-workflows.ts", {
    "server-only": {}, "next/server": { NextRequest }, "@/lib/pool-log": pool,
    "@/lib/room-operations": roomOperations,
    "@/lib/server/drive-room-report-import": driveAdapter, "@/lib/server/import-upload": { IMPORT_UPLOAD_BUCKET: "fixture-imports" },
    "@/lib/server/auth": { requireUser: async () => ({ principal: { hotelId: "property-fixture", identity: { id: "actor-fixture" } }, admin: { storage: { from: bucket => {
      assert.equal(bucket, "fixture-imports"); return { download: async path => { assert.equal(path, `property-fixture/actor-fixture/results/${resultId}-0.json`); return { data: new Blob([JSON.stringify(privateBytes().toString("base64"))]), error: null }; } };
    } } } }) },
    "@/app/api/room-operations/route": {
      POST: async incoming => { const body = await record("rooms", incoming); return state.validationError ? Response.json({ error: "Incomplete source" }, { status: 422 }) : Response.json({ ok: true, validated: body.validate_only === true, date: "2026-01-01", ...(body.validate_only === true ? { rows: state.roomRows } : { import_id: resultId, count: state.roomRows.length }) }); },
      GET: async incoming => { await record("rooms-read", incoming); return state.readbackDenied ? Response.json({ error: "Readback unavailable" }, { status: 503 }) : Response.json({ date: "2026-01-01", source_date: "2026-01-01", rows: state.roomRows }); },
    },
    "@/app/api/room-operations/guest-reports/route": { POST: async incoming => { const body = await record("reports", incoming); return state.validationError ? Response.json({ error: "Incomplete source" }, { status: 422 }) : Response.json({ ok: true, previousId: "saved-before", date: "2026-01-01", ...(body.validateOnly === false ? { import_id: resultId } : {}), imported: body.validateOnly === false, rows: state.roomRows }); } },
    "@/app/api/room-operations/guest-reports/drive/route": { GET: async incoming => {
      await record("drive", incoming);
      if (state.denied) return Response.json({ error: "Native role denied" }, { status: 403 });
      return state.privateResult ? Response.json({ importResult: { id: resultId, count: 1, hashes: [createHash("sha256").update(privateBytes()).digest("hex")], urls: ["https://never-fetch.invalid/private"] } }) : Response.json({ files: state.files });
    } },
    "@/app/api/pool-log/route": {
      GET: async incoming => { await record("pool-read", incoming); return state.denied ? Response.json({ error: "Native role denied" }, { status: 403 }) : Response.json({ facilities: [{ id: facility, pool_name: "Indoor Pool" }], can_edit_saved: true }); },
      POST: async incoming => { const body = await record("pool-save", incoming); return Response.json({ body }); },
    },
  }, { Response, Headers, URL, Request, Buffer, Error, fetch: () => { throw Error("No live requests are permitted in workflow tests"); } });
  return { workflows, calls, state };
}

test("preview wrappers force validation even when model body requests a write", async () => {
  const f = fixture();
  assert.equal((await f.workflows.validateNativeRoomOperations(request({ csv: "source", validate_only: false }))).status, 200);
  assert.equal((await f.workflows.validateNativeGuestReports(request({ files: f.state.files, validateOnly: false }))).status, 200);
  assert.equal(f.calls[0].body.validate_only, true); assert.equal(f.calls[1].body.validateOnly, true);
});

test("Drive preview cannot commit and same-source confirmation rejects changed files", async () => {
  const f = fixture();
  const preview = await (await f.workflows.nativeDriveRoomReports(request({ validate_only: false }), false)).json();
  assert.equal(preview.validate_only, true); assert.equal(f.calls.find(call => call.kind === "reports").body.validateOnly, true);
  f.state.files = [{ name: "In-house.csv", text: "changed source" }];
  const result = await f.workflows.nativeDriveRoomReports(request({ previousId: preview.previousId, source_digest: preview.source_digest }), true);
  assert.equal(result.status, 409);
  assert.equal(f.calls.filter(call => call.kind === "reports").length, 1);
});

test("Drive commit reuses native validation and original bearer with exact preview tokens", async () => {
  const f = fixture(); f.state.privateResult = true;
  const preview = await (await f.workflows.nativeDriveRoomReports(request({}), false)).json();
  assert.match(preview.source_digest, /^[a-f0-9]{64}$/);
  const result = await f.workflows.nativeDriveRoomReports(request({ previousId: preview.previousId, source_digest: preview.source_digest }), true);
  assert.equal(result.status, 200); assert.equal((await result.json()).imported, true);
  const last = f.calls.filter(call => call.kind === "reports").at(-1);
  assert.equal(last.body.validateOnly, false); assert.equal(last.body.previousId, "saved-before");
  assert.deepEqual(last.body.files, f.state.files);
});

test("native role denials stop Drive and pool workflows before any save", async () => {
  const f = fixture(); f.state.denied = true;
  assert.equal((await f.workflows.nativeDriveRoomReports(request({}), false)).status, 403);
  assert.equal((await f.workflows.saveNativePoolLog(request({ date: "2026-01-01", pool: "Indoor Pool" }))).status, 403);
  assert.ok(!f.calls.some(call => ["reports", "pool-save"].includes(call.kind)));
});

test("pool saves reuse established aliases, exact active facility and test-entry normalization", async () => {
  const f = fixture();
  const result = await f.workflows.saveNativePoolLog(request({ date: "2026-01-01", pool: "Indoor Pool", ph_am: 7.4, sanitizer_band_am: "3-6", test_entry: true, remarks: "User supplied remark" }));
  assert.equal(result.status, 200);
  const body = (await result.json()).body;
  assert.equal(body.log_date, "2026-01-01"); assert.equal(body.pool_facility_id, facility);
  assert.equal(body.remarks, "User supplied remark\nTest entry"); assert.equal(body.ph_am, 7.4);
  assert.equal(body.test_entry, undefined); assert.equal(body.date, undefined); assert.equal(body.pool, undefined);
  const unknown = await f.workflows.saveNativePoolLog(request({ date: "2026-01-01", pool: "Invented Pool" }));
  assert.equal(unknown.status, 400); assert.equal(f.calls.filter(call => call.kind === "pool-save").length, 1);
});

test("successful legacy import deterministically reports every OOO room and move after native readback", async () => {
  const f = fixture();
  const result = await (await f.workflows.saveNativeRoomOperations(request({ csv: "original source" }))).json();
  assert.match(result.message, /101 \(OOO\)/); assert.match(result.message, /201 \(Out of Order\)/); assert.match(result.message, /304 → 303/);
  assert.equal(result.room_operations_report.refreshed, true);
  assert.deepEqual(result.room_operations_report.out_of_order_rooms.map(row => row.room), ["101", "201"]);
  assert.deepEqual(f.calls.map(call => call.kind), ["rooms", "rooms-read"]);
});

test("failed previews and validation-only import calls never run commit readback", async () => {
  const f = fixture(); f.state.validationError = true;
  assert.equal((await f.workflows.validateNativeRoomOperations(request({ csv: "incomplete", validate_only: false }))).status, 422);
  assert.equal((await f.workflows.validateNativeGuestReports(request({ files: [], validateOnly: false }))).status, 422);
  assert.ok(f.calls.every(call => call.body.validate_only === true || call.body.validateOnly === true));
  f.state.validationError = false;
  const result = await (await f.workflows.saveNativeRoomOperations(request({ csv: "source", validate_only: true }))).json();
  assert.equal(result.validation_only, true); assert.match(result.message, /No accepted room report was replaced/);
  assert.ok(!f.calls.some(call => call.kind === "rooms-read"));
});

test("readback failure preserves successful save and never fabricates absent OOO rooms or moves", async () => {
  const f = fixture(); f.state.readbackDenied = true;
  const legacy = await (await f.workflows.saveNativeRoomOperations(request({ csv: "source" }))).json();
  assert.equal(legacy.ok, true); assert.equal(legacy.room_operations_report.available, false);
  assert.doesNotMatch(legacy.message, /Out of order: none|Room moves: none/);
  const guests = await (await f.workflows.saveNativeGuestReports(request({ files: f.state.files, validateOnly: false, previousId: "saved-before" }))).json();
  assert.equal(guests.room_operations_report.source, "save_response"); assert.equal(guests.room_operations_report.refreshed, false);
  assert.match(guests.message, /101 \(OOO\)/); assert.match(guests.message, /201 \(Out of Order\)/); assert.match(guests.message, /304 → 303/);
  assert.match(guests.warnings.join(" "), /Import saved, but refreshed readback is unavailable/);
});
