import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const hotel = "00000000-0000-4000-8000-000000000001";
const author = "00000000-0000-4000-8000-000000000002";
const ticket = "00000000-0000-4000-8000-000000000003";
const note = "00000000-0000-4000-8000-000000000004";
const fileId = "00000000-0000-4000-8000-000000000005";
const other = "00000000-0000-4000-8000-000000000006";
const origin = "https://native-storage.example.invalid";
const filename = "Daño del equipo Δ.png";
const savedName = `${author}_${fileId}.png`;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXnQAAAAASUVORK5CYII=", "base64");
const makeRequest = path => new NextRequest(`https://cmpri.test${path}`, { headers: {
  authorization: "Bearer native-current-user", cookie: "private-cookie", "x-cmpri-role": "do-not-trust",
} });

function fixture() {
  const calls = [];
  const workUrl = `${origin}/storage/v1/object/sign/asset-documentation/${hotel}/work-orders/${ticket}/${savedName}?token=private-storage-token`;
  const staffUrl = `${origin}/storage/v1/object/sign/staff-note-files/${hotel}/${author}/${fileId}?token=private-storage-token&download=${encodeURIComponent(filename)}`;
  const state = {
    images: [{ id: savedName, name: filename, type: "image/png", url: workUrl }],
    notes: [{ id: note, author_user_id: author, attachments: [{ id: fileId, name: filename, type: "image/png", size: png.length, url: staffUrl }] }],
    parents: [], hotelId: hotel,
    workNative: undefined, staffNative: undefined,
    source: () => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.length) } }),
  };
  const reader = loadTs("src/lib/server/ask-cmpri-saved-attachments.ts", {
    "server-only": {}, "next/server": { NextRequest, NextResponse: Response },
    "@/lib/constants": { HOTEL_ID: hotel }, "@/lib/supabase/config": { SUPABASE_URL: origin },
    "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "staff-note-files", STAFF_FILE_LIMIT: 100 * 1024 * 1024 },
    "@/lib/uuid": loadTs("src/lib/uuid.ts"),
    "@/app/api/work-orders/[id]/attachments/route": { GET: async (incoming, context) => {
      calls.push({ kind: "work-list", incoming, params: await context.params });
      assert.equal(incoming.headers.get("authorization"), "Bearer native-current-user");
      assert.equal(incoming.headers.get("cookie"), null); assert.equal(incoming.headers.get("x-cmpri-role"), null);
      assert.equal(incoming.nextUrl.pathname, `/api/work-orders/${ticket}/attachments`); assert.equal(incoming.nextUrl.search, "");
      assert.deepEqual(JSON.parse(JSON.stringify(await context.params)), { id: ticket });
      return state.workNative ? state.workNative() : Response.json({ images: state.images });
    } },
    "@/app/api/staff-notes/route": { GET: async incoming => {
      calls.push({ kind: "staff-note", incoming });
      assert.equal(incoming.headers.get("authorization"), "Bearer native-current-user");
      assert.equal(incoming.headers.get("cookie"), null); assert.equal(incoming.headers.get("x-cmpri-role"), null);
      assert.equal(incoming.nextUrl.pathname, "/api/staff-notes"); assert.deepEqual([...incoming.nextUrl.searchParams], [["note", note]]);
      return state.staffNative ? state.staffNative() : Response.json({ hotelId: state.hotelId, notes: state.notes, parents: state.parents });
    } },
  }, { URL, Response, Uint8Array, fetch: async (url, options) => {
    calls.push({ kind: "storage", url: String(url), options }); return state.source();
  } });
  const workRequest = query => makeRequest(`/api/work-orders/${ticket}/attachments/original?${query || "attachmentId=" + encodeURIComponent(savedName)}`);
  const staffRequest = query => makeRequest(`/api/staff-notes/attachment?${query || `noteId=${note}&attachmentId=${fileId}`}`);
  return { reader, state, calls, workUrl, staffUrl, workRequest, staffRequest,
    work: query => reader.readAskWorkOrderAttachment(workRequest(query), ticket),
    staff: query => reader.readAskStaffNoteAttachment(staffRequest(query)),
  };
}

test("both saved-attachment readers preserve native denials before any private object fetch", async () => {
  for (const kind of ["work", "staff"]) for (const status of [401, 403, 404, 503]) {
    const f = fixture(), denied = Response.json({ error: "Native record access denied." }, { status });
    f.state[kind === "work" ? "workNative" : "staffNative"] = () => denied;
    assert.equal(await f[kind](), denied);
    assert.deepEqual(f.calls.map(call => call.kind), [kind === "work" ? "work-list" : "staff-note"]);
  }
});

test("catalog reads fetch the exact authorized original bytes with private transport and original filename/type/hash", async () => {
  const f = fixture();
  const catalog = loadTs("src/lib/server/ask-cmpri-native-catalog.ts", {
    "server-only": {}, "@/lib/ai/cmpri-operation-guidance": loadTs("src/lib/ai/cmpri-operation-guidance.ts"),
    "@/lib/server/ask-cmpri-saved-attachments": f.reader,
  });
  for (const [key, incoming, params, expectedUrl] of [
    ["work_order_attachments.read", f.workRequest(), { id: ticket }, f.workUrl],
    ["staff_notes.attachment_read", f.staffRequest(), {}, f.staffUrl],
  ]) {
    const operation = catalog.askNativeOperation(key);
    assert.equal(operation.writes, false); assert.equal(operation.responseKind, "mixed");
    const response = await operation.run(incoming, params);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal(response.headers.get("content-type"), "image/png"); assert.equal(Number(response.headers.get("content-length")), png.length);
    assert.equal(response.headers.get("x-cmpri-source-sha256"), sha256(png));
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    const actualName = decodeURIComponent(response.headers.get("content-disposition").match(/filename\*=UTF-8''(.+)$/)[1]);
    assert.equal(actualName, filename); assert.match(response.headers.get("x-cmpri-export-source"), /Saved original/);
    assert.equal(JSON.stringify([...response.headers]).includes("private-storage-token"), false);
    const fetch = f.calls.at(-1); assert.equal(fetch.kind, "storage"); assert.equal(fetch.url, expectedUrl);
    assert.deepEqual(Object.keys(fetch.options.headers).sort(), ["Accept", "Accept-Encoding"]);
    assert.equal(fetch.options.credentials, "omit"); assert.equal(fetch.options.referrerPolicy, "no-referrer");
    assert.equal(fetch.options.redirect, "error"); assert.equal(fetch.options.cache, "no-store");
  }
  assert.deepEqual(f.calls.map(call => call.kind), ["work-list", "storage", "staff-note", "storage"]);
});

test("unknown attachment IDs, another note's files and caller-supplied paths or URLs never fetch storage", async () => {
  const unknownWork = fixture(); assert.equal((await unknownWork.work("attachmentId=" + other + ".png")).status, 404);
  const unknownStaff = fixture(); assert.equal((await unknownStaff.staff(`noteId=${note}&attachmentId=${other}`)).status, 404);
  const parent = fixture(); parent.state.parents = [{ ...parent.state.notes[0], id: other }]; parent.state.notes[0].attachments = [];
  assert.equal((await parent.staff()).status, 404, "an attachment listed only on the parent is not an attachment of the selected note");
  for (const query of ["attachmentId=../secret.png", "attachmentId=%2Fsecret.png", "attachmentId=%252Fsecret.png", "attachmentId=.", "attachmentId=..", `attachmentId=${savedName}&url=https://attacker.invalid/x`, `attachmentId=${savedName}&attachmentId=${savedName}`]) {
    const f = fixture(); assert.equal((await f.work(query)).status, 400); assert.equal(f.calls.length, 0);
  }
  for (const query of [`noteId=${note}&attachmentId=${fileId}&author=${author}`, `noteId=${note}&attachmentId=${fileId}&url=https://attacker.invalid`, `noteId=${note}&attachmentId=../${fileId}`]) {
    const f = fixture(); assert.equal((await f.staff(query)).status, 400); assert.equal(f.calls.length, 0);
  }
  for (const f of [unknownWork, unknownStaff, parent]) assert.equal(f.calls.some(call => call.kind === "storage"), false);
});

test("native signed URLs must address the exact configured bucket, property, record and saved original", async () => {
  const changes = [
    url => { url.hostname = "other-storage.invalid"; },
    url => { url.protocol = "http:"; },
    url => { url.username = "credential"; },
    url => { url.port = "444"; },
    url => { url.hash = "fragment"; },
    url => { url.pathname = url.pathname.replace(hotel, other); },
    url => { url.pathname = url.pathname.replace("/object/sign/", "/render/image/sign/"); },
    url => { url.pathname += "/nested"; },
    url => { url.searchParams.delete("token"); },
    url => { url.searchParams.append("token", "second-token"); },
    url => { url.searchParams.set("width", "5"); },
  ];
  for (const kind of ["work", "staff"]) for (const change of changes) {
    const f = fixture(), file = kind === "work" ? f.state.images[0] : f.state.notes[0].attachments[0];
    const url = new URL(file.url); change(url); file.url = url.href;
    const response = await f[kind](); assert.equal(response.status, 503);
    assert.equal(f.calls.some(call => call.kind === "storage"), false);
    assert.equal(JSON.stringify(await response.json()).includes("private-storage-token"), false);
  }
  const wrongTicket = fixture(); wrongTicket.state.images[0].url = wrongTicket.workUrl.replace(ticket, other);
  assert.equal((await wrongTicket.work()).status, 503);
  const wrongAuthor = fixture(); wrongAuthor.state.notes[0].attachments[0].url = wrongAuthor.staffUrl.replace(author, other);
  assert.equal((await wrongAuthor.staff()).status, 503);
  const wrongBucket = fixture(); wrongBucket.state.images[0].url = wrongBucket.workUrl.replace("asset-documentation", "staff-note-files");
  assert.equal((await wrongBucket.work()).status, 503);
  for (const f of [wrongTicket, wrongAuthor, wrongBucket]) assert.equal(f.calls.some(call => call.kind === "storage"), false);
});

test("stored media may use a native legacy filename while Staff Notes preserve arbitrary original document bytes", async () => {
  const legacy = fixture(), name = "Legacy saved photo.png";
  legacy.state.images[0].id = name; legacy.state.images[0].url = legacy.workUrl.replace(savedName, encodeURIComponent(name));
  assert.deepEqual(Buffer.from(await (await legacy.work("attachmentId=" + encodeURIComponent(name))).arrayBuffer()), png);
  const f = fixture(), bytes = Buffer.from('{"actual":"saved original", "value":17}\n');
  f.state.notes[0].attachments[0] = { ...f.state.notes[0].attachments[0], name: "Original record.json", type: "application/json", size: bytes.length };
  f.state.source = () => new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length) } });
  const response = await f.staff();
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); assert.equal(response.headers.get("x-cmpri-source-sha256"), sha256(bytes));
});

test("source failures, changed types, empty files and size mismatches never become successful attachment reads", async () => {
  for (const [source, expected] of [
    [() => new Response("Missing", { status: 404 }), 404],
    [() => new Response("Expired private-storage-token", { status: 403 }), 503],
    [() => new Response(null, { status: 303, headers: { Location: "https://other.invalid" } }), 503],
    [() => new Response(png.subarray(0, 8), { status: 206, headers: { "Content-Type": "image/png", "Content-Length": "8", "Content-Range": `bytes 0-7/${png.length}` } }), 409],
    [() => { throw Error("private-storage-token internal transport error"); }, 503],
    [() => new Response(png, { headers: { "Content-Type": "text/html" } }), 409],
    [() => new Response(png, { headers: { "Content-Type": "image/png", "Content-Encoding": "gzip" } }), 409],
    [() => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": "104857601" } }), 413],
    [() => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.length + 1) } }), 409],
    [() => new Response(new Uint8Array(), { headers: { "Content-Type": "image/png" } }), 409],
  ]) {
    const f = fixture(); f.state.source = source;
    const response = await f.work(); assert.equal(response.status, expected);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(JSON.stringify(await response.json()).includes("private-storage-token"), false);
  }
  const changedStaff = fixture(); changedStaff.state.notes[0].attachments[0].size++;
  assert.equal((await changedStaff.staff()).status, 409, "saved Staff Notes size is checked against the actual original");
  const badList = fixture(); badList.state.workNative = () => Response.json({ error: "Native list failed" });
  assert.equal((await badList.work()).status, 503); assert.equal(badList.calls.length, 1);
  const missingList = fixture(); missingList.state.workNative = () => undefined;
  assert.equal((await missingList.work()).status, 503); assert.equal(missingList.calls.length, 1);
});

test("unbounded storage streams are stopped at the native file limit and incomplete source streams fail", async () => {
  const oversized = fixture(); let cancelled = false;
  oversized.state.source = () => {
    const bytes = new Uint8Array(1024 * 1024);
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "image/png" } });
  };
  assert.equal((await oversized.work()).status, 413); assert.equal(cancelled, true);
  const broken = fixture(); broken.state.source = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(png); controller.error(Error("broken private-storage-token stream")); } }), { headers: { "Content-Type": "image/png" } });
  const response = await broken.work(); assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()).includes("private-storage-token"), false);
  const oversizedMetadata = fixture(); oversizedMetadata.state.notes[0].attachments[0].size = 104857601;
  assert.equal((await oversizedMetadata.staff()).status, 413); assert.equal(oversizedMetadata.calls.length, 1, "oversized native metadata stops before storage");
});
