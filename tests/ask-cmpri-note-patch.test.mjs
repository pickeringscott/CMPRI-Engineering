import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import * as notes from "../src/lib/general-notes.ts";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const id = "054c81e0-d00f-4cf4-b826-3b0c6aab4793", changeId = "3a2ca836-8533-45d6-92be-49adb09bbe3e";
const actor = "024e76a5-16fa-4df9-8b7b-0a4adf17366d", hotel = "89ce5858-d822-4902-8170-07b7d1a9bcfa";
const original = () => ({ title: "Saved sketch", text: "Check @Sam before closing.", fontSize: 16, titleAutomatic: false,
  strokes: [{ id: "original-ink", color: "#000000", size: 4, points: Array.from({ length: 18000 }, (_, index) => ({ x: index % 800, y: index % 1100, p: 0.5 })) }],
  mentions: [{ id: actor, kind: "person", label: "Sam", start: 6, end: 10 }], textStyles: [{ start: 0, end: 5, fontSize: 18 }] });

function fixture() {
  const calls = [], state = { signed: true, denyPut: false, race: false, owner: actor, property: hotel,
    document: original(), revision: 7 };
  const native = loadTs("src/app/api/notes/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/general-notes": notes,
    "@/lib/server/auth": { requireUser: async incoming => {
      calls.push({ kind: "auth", method: incoming.method, bearer: incoming.headers.get("authorization"), property: incoming.headers.get("x-cmpri-property") });
      assert.equal(incoming.headers.get("authorization"), "Bearer current-account");
      if (!state.signed || state.denyPut && incoming.method === "PUT") return null;
      if (state.race && incoming.method === "PUT") state.revision++;
      return { principal: { identity: { id: actor }, hotelId: hotel }, admin: {
        from(table) {
          assert.equal(table, "cmpri_general_notes");
          const filters = {};
          const query = { select() { return query; }, eq(key, value) { filters[key] = value; return query; }, async maybeSingle() {
            calls.push({ kind: "read", filters });
            return { data: filters.hotel_id === state.property && filters.user_id === state.owner && filters.id === id
              ? { id, document: state.document, revision: state.revision, updated_at: "2026-11-23T10:00:00Z" } : null, error: null };
          } };
          return query;
        },
        async rpc(name, parameters) {
          calls.push({ kind: "write", name, parameters });
          assert.equal(name, "cmpri_save_general_note");
          assert.equal(parameters.p_actor, actor); assert.equal(parameters.p_hotel, hotel);
          if (parameters.p_expected !== state.revision) return { error: { code: "40001" } };
          state.document = structuredClone(parameters.p_document); state.revision++;
          return { data: { id, document: state.document, revision: state.revision, updated_at: "2026-11-23T10:01:00Z" }, error: null };
        },
      } };
    } },
  }, { TextDecoder });
  const adapter = loadTs("src/lib/server/ask-cmpri-note-patch.ts", {
    "server-only": {}, "next/server": { NextRequest, NextResponse: Response },
    zod: { z },
    "@/app/api/notes/route": {
      GET: native.GET,
      PUT: async incoming => { calls.push({ kind: "put", body: await incoming.clone().json() }); return native.PUT(incoming); },
    },
  }, { Headers, URL });
  return { calls, state, async patch(change, headers = {}) {
    return adapter.patchAskPersonalNote(new NextRequest("https://cmpri.test/api/notes", { method: "PATCH",
      headers: { Authorization: "Bearer current-account", "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ id, changeId, expectedRevision: 7, ...change }) }));
  } };
}
test("a small confirmed patch preserves a native document larger than Ask's token limit, including exact original ink and ranges", async () => {
  const f = fixture(), before = structuredClone(f.state.document);
  assert.ok(Buffer.byteLength(JSON.stringify(before)) > 320000);
  assert.ok(notes.validNoteDocument(before));
  const response = await f.patch({ patch: { title: "Requested new title" }, appendText: "\nExact new line." });
  assert.equal(response.status, 200);
  assert.equal(f.state.document.title, "Requested new title");
  assert.equal(f.state.document.text, before.text + "\nExact new line.");
  for (const key of ["strokes", "mentions", "textStyles", "fontSize", "titleAutomatic"]) assert.deepEqual(f.state.document[key], before[key], key);
  const put = f.calls.find(call => call.kind === "put").body;
  assert.deepEqual(Object.keys(put).sort(), ["changeId", "document", "expectedRevision", "id"]);
  assert.equal(put.expectedRevision, 7); assert.equal(put.changeId, changeId);
  assert.deepEqual(f.calls.filter(call => call.kind === "auth").map(call => call.method), ["GET", "PUT"]);
  assert.equal(f.state.revision, 8);
});

test("native owner, property and current authorization gates are never bypassed", async () => {
  for (const configure of [f => { f.state.signed = false; }, f => { f.state.owner = "other-owner"; }, f => { f.state.property = "other-property"; }]) {
    const f = fixture(); configure(f);
    const response = await f.patch({ appendText: "\nRequested line" });
    assert.ok([401, 404].includes(response.status));
    assert.equal(f.calls.some(call => call.kind === "put" || call.kind === "write"), false);
  }
  const spoofed = fixture();
  assert.equal((await spoofed.patch({ appendText: "\nRequested line" }, { "x-cmpri-property": "another-property" })).status, 401);
  assert.equal(spoofed.calls.some(call => call.kind === "read" || call.kind === "put"), false);
  const revoked = fixture(); revoked.state.denyPut = true;
  assert.equal((await revoked.patch({ appendText: "\nRequested line" })).status, 401);
  assert.equal(revoked.calls.some(call => call.kind === "write"), false);
});

test("stale expected revisions reject before PUT and a concurrent native revision change cannot overwrite the note", async () => {
  const stale = fixture(); stale.state.revision = 8;
  assert.equal((await stale.patch({ appendText: "\nRequested line" })).status, 409);
  assert.equal(stale.calls.some(call => call.kind === "put" || call.kind === "write"), false);
  const raced = fixture(), before = structuredClone(raced.state.document); raced.state.race = true;
  assert.equal((await raced.patch({ appendText: "\nRequested line" })).status, 409);
  assert.deepEqual(raced.state.document, before);
  assert.equal(raced.calls.find(call => call.kind === "write").parameters.p_expected, 7);
});

test("only explicit patch fields are accepted; native full-document validation protects preserved mention and formatting ranges", async () => {
  for (const body of [{ patch: {} }, { patch: { owner: "victim" } }, { actor: "victim", appendText: "line" },
    { document: null }, { patch: { text: "replacement" }, appendText: "extra" }, { expectedRevision: null, appendText: "line" }]) {
    const f = fixture();
    assert.equal((await f.patch(body)).status, 400);
    assert.equal(f.calls.length, 0);
  }
  for (const patch of [{ fontSize: 9 }, { text: "short" }]) {
    const f = fixture(), before = structuredClone(f.state.document);
    assert.equal((await f.patch({ patch })).status, 400);
    assert.equal(f.calls.some(call => call.kind === "write"), false);
    assert.deepEqual(f.state.document, before);
  }
  const explicit = fixture(), originalText = explicit.state.document.text;
  assert.equal((await explicit.patch({ patch: { strokes: [], fontSize: 20 } })).status, 200);
  assert.deepEqual(explicit.state.document.strokes, []);
  assert.equal(explicit.state.document.fontSize, 20);
  assert.equal(explicit.state.document.text, originalText);
});
