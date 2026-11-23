import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { loadTs } from "./helpers/load-ts.mjs";

class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const id = "d914b67a-d4a4-4c9d-aae4-633aa89013ce", changeId = "3e769108-4233-430a-97f5-087a320f076d";
const notepad = loadTs("src/lib/notepad.ts");

function fixture() {
  const saved = [];
  const current = { id, revision: 7, authorId: "creator", authorName: "Creator", createdAt: "2026-11-23T12:00:00Z", updatedAt: "2026-11-23T13:00:00Z",
    title: "Shared project", audience: { all: false, roles: ["engineer", "technician"], people: [] },
    content: '<div class="note-check" data-item-id="task"><input type="checkbox"><span class="task-label">Original</span></div>',
    priority: "High", fontSize: 14, fontFamily: "Comic Sans MS", titleFontFamily: "Georgia",
    ink: [{ id: "saved-ink", color: "black", size: 2, points: [{ x: 1, y: 2, p: .5 }] }],
    itemThreads: { task: [{ id: "reply", authorId: "coworker", at: "2026-11-23T12:30:00Z", text: "Keep this reply", replies: [] }] },
    attachments: [{ id: "already-saved", kind: "file", name: "Original.pdf", type: "application/pdf", size: 80, url: "https://private.example/token" }] };
  const state = { notes: [current], denied: null };
  const adapter = loadTs("src/lib/server/ask-cmpri-notepad-patch.ts", {
    "server-only": {}, "next/server": { NextRequest, NextResponse: Response }, zod: { z }, "@/lib/notepad": notepad,
    "@/app/api/notepad/route": {
      GET: async request => {
        assert.equal(request.nextUrl.pathname, "/api/notepad");
        assert.equal(request.headers.get("authorization"), "Bearer current-actor");
        assert.equal(request.headers.get("x-cmpri-property"), "current-property");
        return state.denied || Response.json({ notes: state.notes });
      },
      PUT: async request => { assert.equal(request.nextUrl.pathname, "/api/notepad"); saved.push(await request.json()); return Response.json({ ok: true }); },
    },
  }, { URL, Headers });
  const patch = body => adapter.patchAskNotepad(new NextRequest("https://cmpri.test/api/ask-cmpri/notepad-patch", {
    method: "PATCH", headers: { authorization: "Bearer current-actor", "x-cmpri-property": "current-property" }, body: JSON.stringify({ id, changeId, expectedRevision: 7, ...body }),
  }));
  return { current, state, saved, patch };
}

test("Ask Notepad edits preserve existing sharing, title font, ink, replies and attachments", async () => {
  const f = fixture();
  assert.equal((await f.patch({ patch: { title: "Renamed" } })).status, 200);
  assert.deepEqual(f.saved[0], { id, changeId, expectedRevision: 7, document: { ...JSON.parse(JSON.stringify(notepad.notepadDocument(f.current))), title: "Renamed" } });
  assert.equal(f.saved[0].document.attachments[0].url, undefined, "signed read URLs must never be persisted");
  assert.equal(f.saved[0].document.authorId, undefined, "native attribution is not a mutable document field");
});

test("Ask appends escaped text with a stable item ID without replacing an existing shared checklist", async () => {
  const f = fixture();
  assert.equal((await f.patch({ appendText: 'New <task> & "detail"\nNext line' })).status, 200);
  assert.equal(f.saved[0].document.content, f.current.content + `<p data-item-id="append-${changeId}">New &lt;task&gt; &amp; &quot;detail&quot;<br>Next line</p>`);
  assert.deepEqual(f.saved[0].document.itemThreads, f.current.itemThreads);
  assert.equal((await f.patch({ patch: { content: "replacement" }, appendText: "ambiguous" })).status, 400);
  assert.equal(f.saved.length, 1);
});

test("Ask Notepad patch denies stale, hidden or unauthenticated documents before any mutation", async () => {
  const stale = fixture(); assert.equal((await stale.patch({ expectedRevision: 6, patch: { title: "Changed" } })).status, 409); assert.equal(stale.saved.length, 0);
  const hidden = fixture(); hidden.state.notes = [];
  assert.equal((await hidden.patch({ patch: { title: "Changed" } })).status, 404); assert.equal(hidden.saved.length, 0);
  const denied = fixture(); denied.state.denied = Response.json({ error: "Current account denied" }, { status: 403 });
  assert.equal((await denied.patch({ patch: { title: "Changed" } })).status, 403); assert.equal(denied.saved.length, 0);
  const legacy = fixture(); legacy.current.revision = 0; legacy.current.legacyVersion = "general:8";
  assert.equal((await legacy.patch({ expectedRevision: 0, expectedLegacyVersion: "general:7", patch: { title: "Stale migration" } })).status, 409);
  assert.equal((await legacy.patch({ expectedRevision: 0, expectedLegacyVersion: "general:8", patch: { title: "Migrated" } })).status, 200);
  assert.equal(legacy.saved[0].expectedRevision, 0);
  assert.equal(legacy.saved[0].expectedLegacyVersion, "general:8");
});

test("Ask discovers the unified Notepad operations instead of retired storage mutations", () => {
  const catalog = loadTs("src/lib/server/ask-cmpri-native-catalog.ts", { "server-only": {}, "@/lib/ai/cmpri-operation-guidance": loadTs("src/lib/ai/cmpri-operation-guidance.ts") });
  for (const key of ["notepad.read", "notepad.save", "notepad.patch", "notepad.order", "notepad.attachment_read", "notepad.save_files"]) assert.ok(catalog.askNativeOperation(key), key);
  for (const key of ["personal_notes.read", "personal_notes.save", "notes.patch", "staff_notes.read", "staff_notes.post", "staff_notes.post_files"]) assert.equal(catalog.askNativeOperation(key), undefined, key);
});
