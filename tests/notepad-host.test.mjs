import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import * as jsx from "react/jsx-runtime";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";
import * as syncModule from "../src/lib/notepad-sync.ts";
import * as closeModule from "../src/lib/ui/notepad-close.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/notepad", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await tick(); await tick(); await tick(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const noteId = "0e93a492-735c-4117-94c1-1550cec4f4f5";
const note = userId => ({ id: noteId, authorId: userId, title: `${userId}'s note`, audience: { all: false, roles: [], people: [] }, content: '<p data-item-id="task">Saved</p>',
  priority: "Normal", fontSize: 16, fontFamily: "Comic Sans MS", titleFontFamily: "Arial", ink: [], itemThreads: {}, attachments: [],
  createdAt: "2026-11-23T20:00:00Z", updatedAt: "2026-11-23T20:00:00Z", revision: 1 });
const bootstrap = userId => ({ hotelId: "property", userId, people: [{ id: userId, name: userId, roles: ["engineer"], active: true, taggable: true }], roles: [], notes: [note(userId)], order: [noteId], legacyAliases: {} });

async function fixture({ holdInitial = false, count = 1 } = {}) {
  window.localStorage.clear();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), authCallbacks = [], outgoing = [], requests = [];
  const firstGet = deferred();
  const state = { userId: "account-A", writeGate: null, writeStatus: 200, readStatus: 200, uploadGate: null, savedNote: null };
  let readCount = 0;
  const client = { auth: { onAuthStateChange: callback => { authCallbacks.push(callback); return { data: { subscription: { unsubscribe() {} } } }; } },
    channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; }, removeChannel: async () => {},
    storage: { from: () => ({ uploadToSignedUrl: async () => { if (state.uploadGate) await state.uploadGate.promise; return { error: null }; } }) },
  };
  const Component = loadTs("src/components/Notepad.tsx", {
    react: React, "react/jsx-runtime": jsx, "./notepad/notepad-host.css": {},
    "@/lib/supabase/client": { createClient: () => client, getValidSession: async () => state.userId ? { access_token: `session:${state.userId}`, user: { id: state.userId } } : null },
    "@/lib/general-notes-session": { isNotesSessionRestart: async () => false }, "@/lib/giphy": {}, "@/lib/staff-note-media": { STAFF_FILE_BUCKET: "staff-note-files", staffFileInput: value => value },
    "@/lib/notepad-sync": syncModule, "@/lib/ui/notepad-close": closeModule,
    "@/lib/notepad-device-drafts": { recoverNotepadDeviceDrafts: async (_data, restored) => restored },
  }, { window, document, localStorage: window.localStorage, crypto, URL, Headers, AbortController, Error, File,
    getComputedStyle: dom.window.getComputedStyle, MutationObserver: dom.window.MutationObserver, queueMicrotask,
    fetch: async (path, options) => {
      assert.ok(["/api/notepad", "/api/notepad/uploads"].includes(path));
      const userId = options.headers.Authorization.replace("Bearer session:", "");
      const method = options.method || "GET";
      requests.push({ path, method, userId, body: options.body && JSON.parse(options.body) });
      if (path === "/api/notepad/uploads") {
        const body = JSON.parse(options.body);
        return Response.json(method === "POST" ? { id: body.id, path: `property/${userId}/notepad/${body.id}`, token: "signed-file-token" } : { id: body.id, ready: true, url: "https://storage.example/verified-file" });
      }
      if (method === "GET") {
        const result = bootstrap(userId), index = ++readCount;
        if (state.savedNote?.authorId === userId) result.notes = [state.savedNote];
        if (holdInitial && index === 1) await firstGet.promise;
        return state.readStatus === 200 ? Response.json(result) : Response.json({ error: "Current account access denied" }, { status: state.readStatus });
      }
      if (method === "PUT") {
        if (state.writeGate) await state.writeGate.promise;
        if (state.writeStatus !== 200) return Response.json({ error: "This note changed elsewhere" }, { status: state.writeStatus });
        state.savedNote = { ...note(userId), ...JSON.parse(options.body).document, revision: 2 };
        return Response.json({ note: state.savedNote, revision: 2 });
      }
      return Response.json({ order: JSON.parse(options.body).order });
    },
  }).default;
  await act(async () => { root.render(React.createElement(React.Fragment, {}, ...Array.from({ length: count }, (_, key) => React.createElement(Component, { key })))); await settle(); });
  const frames = [...container.querySelectorAll("iframe")];
  for (const [index, frame] of frames.entries()) frame.contentWindow.postMessage = (data, origin) => outgoing.push({ index, data, origin });
  const send = async (type, payload = {}, index = 0, extra = {}) => act(async () => {
    const frame = frames[index], token = new URL(frame.src).searchParams.get("bridge");
    const initialized = outgoing.filter(message => message.index === index && message.data.type === "initialize").at(-1)?.data.payload;
    window.dispatchEvent(new dom.window.MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow,
      data: { channel: "cmpri-notepad", token, scope: initialized ? `${initialized.hotelId}:${initialized.userId}` : null, type, payload, ...extra } }));
    await settle();
  });
  for (const index of frames.keys()) await send("ready", {}, index);
  return { container, frames, outgoing, requests, state, send,
    async releaseInitial() { await act(async () => { firstGet.resolve(); await settle(); }); },
    async account(userId, notify = true) { await act(async () => { state.userId = userId; if (notify) for (const callback of authCallbacks) callback("SIGNED_IN", { user: { id: userId } }); await settle(); }); },
    async close() { await act(async () => { root.unmount(); await settle(); }); container.remove(); },
  };
}

for (const notify of [true, false]) test(`a changed account cannot receive the prior bootstrap (${notify ? "auth event" : "post-response recheck"})`, async () => {
  const f = await fixture({ holdInitial: true });
  try {
    await f.account("account-B", notify);
    await f.releaseInitial();
    const initializations = f.outgoing.filter(message => message.data.type === "initialize");
    assert.ok(initializations.length, "the current account should initialize");
    assert.deepEqual(initializations.map(message => message.data.payload.userId), ["account-B"]);
    assert.ok(initializations.every(message => message.data.payload.notes.every(item => item.authorId === "account-B")));
  } finally { await f.close(); }
});

test("a delayed iframe message from the prior account cannot write or request under the new account", async () => {
  const f = await fixture();
  try {
    await f.account("account-B");
    assert.equal(f.outgoing.filter(message => message.data.type === "initialize").at(-1).data.payload.userId, "account-B");
    const before = f.requests.length;
    const stale = { scope: "property:account-A" };
    await f.send("save", { id: noteId, sequence: 1, baseRevision: 1, document: { ...note("account-A"), title: "Old account draft" } }, 0, stale);
    await f.send("order", { order: [noteId] }, 0, stale);
    await f.send("request", { id: "old-attachment", noteId }, 0, { ...stale, action: "attachment", requestId: "old-request" });
    await f.send("save", { id: noteId, sequence: 2, baseRevision: 1, document: note("account-A") }, 0, { scope: undefined });
    await f.send("flush");
    assert.equal(f.requests.length, before, "stale and unscoped messages must not queue data or issue account requests");
    assert.equal(f.outgoing.some(message => message.data.type === "result" && message.data.payload.requestId === "old-request"), false);
    assert.doesNotMatch(window.localStorage.getItem("cmpri:notepad:outbox:v1:property:account-B") || "", /Old account draft/);
    await f.send("save", { id: noteId, sequence: 1, baseRevision: 1, document: { ...note("account-B"), title: "Current account draft" } });
    await f.send("flush");
    assert.equal(f.state.savedNote.authorId, "account-B");
    assert.equal(f.state.savedNote.title, "Current account draft");
  } finally { await f.close(); }
});

test("a targeted close flushes only its editor and waits for its matching acknowledgement and write", async () => {
  const f = await fixture({ count: 2 });
  try {
    const hosts = f.container.querySelectorAll(".cmpri-notepad-host"), ready = [];
    assert.equal(document.dispatchEvent(new dom.window.Event("cmpri-modal-cancel-request", { cancelable: true })), true, "a retained Ask editor cannot block another modal's close");
    let immediate;
    await act(async () => { immediate = closeModule.requestNotepadClose(hosts[0], () => ready.push("first")); await settle(); });
    assert.equal(immediate, false);
    const flushes = f.outgoing.filter(message => message.data.type === "flush");
    assert.equal(flushes.length, 1); assert.equal(flushes[0].index, 0);
    const requestId = flushes[0].data.payload.requestId;
    await f.send("flushed", { requestId: "another-close" });
    await f.send("flushed", { requestId }, 1);
    assert.deepEqual(ready, []);
    f.state.writeGate = deferred();
    await f.send("save", { id: noteId, sequence: 1, baseRevision: 1, document: { ...note("account-A"), title: "Final pen/text input" } });
    await f.send("flushed", { requestId });
    assert.deepEqual(ready, [], "closing must wait for the final input's save");
    assert.equal(f.requests.filter(request => request.method === "PUT").length, 1);
    await act(async () => { f.state.writeGate.resolve(); await settle(); });
    assert.deepEqual(ready, ["first"]);
    await f.send("flushed", { requestId });
    assert.deepEqual(ready, ["first"], "a duplicate acknowledgement cannot close another surface");
  } finally { await f.close(); }
});

test("save conflicts keep the requested surface open and revocation clears displayed account data", async () => {
  const f = await fixture();
  try {
    f.state.writeStatus = 409;
    await f.send("save", { id: noteId, sequence: 1, baseRevision: 1, document: { ...note("account-A"), title: "Protected draft" } });
    let closed = false;
    await act(async () => { closeModule.requestNotepadClose(f.container, () => { closed = true; }); await settle(); });
    const requestId = f.outgoing.find(message => message.data.type === "flush").data.payload.requestId;
    await f.send("flushed", { requestId });
    assert.equal(closed, false);
    assert.match(f.container.textContent, /changed elsewhere/);
    f.state.readStatus = 403;
    await f.send("refresh");
    assert.equal(f.outgoing.at(-1).data.type, "clear");
    assert.match(f.container.textContent, /Current account access denied/);
    assert.match(window.localStorage.getItem("cmpri:notepad:outbox:v1:property:account-A"), /Protected draft/);
  } finally { await f.close(); }
});

test("closing during an upload waits for the returned attachment and its final note save", async () => {
  const f = await fixture();
  try {
    f.state.uploadGate = deferred();
    const attachmentId = "9780b356-e489-4538-96d6-acdf6bb2d739";
    await f.send("request", { id: attachmentId, noteId, file: new File(["image bytes"], "pump.png", { type: "image/png" }) }, 0,
      { action: "upload", requestId: "upload-request" });
    let closed = 0;
    await act(async () => { closeModule.requestNotepadClose(f.container, () => { closed++; }); await settle(); });
    const firstFlush = f.outgoing.find(message => message.data.type === "flush").data.payload.requestId;
    await f.send("flushed", { requestId: firstFlush });
    assert.equal(closed, 0, "a completed input flush cannot close while original bytes are uploading");
    await act(async () => { f.state.uploadGate.resolve(); await settle(); });
    const attachment = f.outgoing.find(message => message.data.type === "result" && message.data.payload.requestId === "upload-request").data.payload.result;
    assert.equal(attachment.id, attachmentId);
    const lastFlush = f.outgoing.filter(message => message.data.type === "flush").at(-1).data.payload.requestId;
    assert.notEqual(lastFlush, firstFlush, "the attachment must be collected in a new input flush");
    await f.send("flushed", { requestId: firstFlush });
    assert.equal(closed, 0, "the first flush acknowledgement cannot close after upload completion");
    f.state.writeGate = deferred();
    await f.send("save", { id: noteId, sequence: 1, baseRevision: 1, document: { ...note("account-A"), attachments: [attachment] } });
    await f.send("flushed", { requestId: lastFlush });
    assert.equal(closed, 0, "the attachment association must reach the server before close");
    await act(async () => { f.state.writeGate.resolve(); await settle(); });
    assert.equal(closed, 1);
    assert.equal(f.state.savedNote.attachments[0].id, attachmentId);
  } finally { await f.close(); }
});

for (const writeStatus of [200, 409]) test(`opening an attachment waits for its note save (${writeStatus === 200 ? "saved" : "conflict"})`, async () => {
  const f = await fixture();
  try {
    f.state.writeGate = deferred(); f.state.writeStatus = writeStatus;
    const attachment = { id: "9780b356-e489-4538-96d6-acdf6bb2d739", kind: "file", name: "pump.png", type: "image/png", size: 11 };
    await f.send("save", { id: noteId, sequence: 1, baseRevision: 1, document: { ...note("account-A"), attachments: [attachment] } });
    const readsBefore = f.requests.filter(request => request.path === "/api/notepad" && request.method === "GET").length;
    await f.send("request", { id: attachment.id, noteId }, 0, { action: "attachment", requestId: "open-request" });
    assert.equal(f.requests.filter(request => request.path === "/api/notepad" && request.method === "GET").length, readsBefore);
    assert.equal(f.outgoing.some(message => message.data.type === "result" && message.data.payload.requestId === "open-request"), false);
    await act(async () => { f.state.writeGate.resolve(); await settle(); });
    const result = f.outgoing.find(message => message.data.type === "result" && message.data.payload.requestId === "open-request").data.payload;
    if (writeStatus === 200) {
      assert.equal(result.result.id, attachment.id);
      assert.equal(f.requests.filter(request => request.path === "/api/notepad" && request.method === "GET").length, readsBefore + 1);
    } else {
      assert.match(result.error, /cannot open until the note is saved/);
      assert.equal(f.requests.filter(request => request.path === "/api/notepad" && request.method === "GET").length, readsBefore);
    }
  } finally { await f.close(); }
});
