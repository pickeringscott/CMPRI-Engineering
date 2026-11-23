import assert from "node:assert/strict";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { loadTs } from "./helpers/load-ts.mjs";

const scope = "hotel:actor:Chief Engineer";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const calls = [], state = { scope, badPrepare: false, badFinalize: false, signedUrl: "https://storage.example.invalid/storage/v1/object/upload/sign/private/original?token=private-upload", now: Date.now() };
  let uploadGate;
  const uploadStarted = deferred();
  class Clock extends Date { static now() { return state.now; } }
  const { createAskOriginalFileStore } = loadTs("src/components/ask-cmpri/original-file-upload.ts", {}, {
    AbortController, AbortSignal, URL, crypto: webcrypto, Date: Clock,
    fetch: async (url, options) => {
      calls.push({ url, ...options, json: typeof options.body === "string" ? JSON.parse(options.body) : undefined });
      if (url === state.signedUrl) { uploadStarted.resolve(); if (uploadGate) await uploadGate.promise; return new Response(null, { status: 200 }); }
      assert.equal(url, "/api/ask-cmpri/files");
      const descriptor = JSON.parse(options.body);
      if (options.method === "POST") return Response.json({ descriptor: state.badPrepare ? { ...descriptor, sha256: "0".repeat(64) } : descriptor,
        signedUrl: state.signedUrl, contentType: descriptor.type });
      if (options.method === "PUT") return Response.json({ file: { ...descriptor, ...(state.badFinalize ? { size: descriptor.size + 1 } : {}),
        token: "signed-private-ref:" + descriptor.id, expiresAt: state.now + 86400000 } });
      assert.equal(options.method, "DELETE");
      return Response.json({ removed: true });
    },
  });
  const store = createAskOriginalFileStore();
  const authorize = async signal => { signal.throwIfAborted(); return { scope: state.scope, headers: { Authorization: "Bearer original-actor" } }; };
  return { store, calls, state, uploadStarted,
    holdUpload() { uploadGate = deferred(); return () => uploadGate.resolve(); },
    stage(file, signal = new AbortController().signal) { return store.stage(file, scope, authorize, signal); },
  };
}

test("only an explicitly staged original is uploaded with its real digest; storage never receives the CMPRI bearer", async () => {
  const h = fixture();
  const selected = new File([new Uint8Array([0, 1, 2, 255])], "Selected.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const unselected = new File(["private folder file"], "Not-selected.txt");
  assert.equal(h.calls.length, 0);
  const ref = await h.stage(selected);
  const [prepared, uploaded, finalized] = h.calls;
  assert.equal(prepared.json.name, selected.name);
  assert.equal(prepared.json.size, selected.size);
  assert.equal(prepared.json.sha256, createHash("sha256").update(Buffer.from(await selected.arrayBuffer())).digest("hex"));
  assert.equal(uploaded.body, selected);
  assert.equal(uploaded.credentials, "omit"); assert.equal(uploaded.redirect, "error");
  assert.equal(uploaded.referrerPolicy, "no-referrer");
  assert.equal(uploaded.headers.Authorization, undefined);
  assert.equal(uploaded.headers["x-upsert"], "false");
  assert.equal(prepared.headers.Authorization, "Bearer original-actor");
  assert.deepEqual(finalized.json, prepared.json);
  assert.equal(ref.sha256, prepared.json.sha256);
  assert.equal(h.calls.some(call => call.json?.name === unselected.name), false);
  assert.equal(await h.stage(selected), ref, "the same conversation reuses the finalized immutable original");
  assert.equal(h.calls.length, 3);
  await h.store.remove(selected);
  assert.deepEqual(h.calls.at(-1).json, { token: ref.token });
});

test("cancelled or unmounted uploads ignore late completion, never finalize, and revoke only the original scope", async () => {
  const h = fixture(), release = h.holdUpload();
  const controller = new AbortController();
  const pending = h.stage(new File(["private bytes"], "Original.pdf", { type: "application/pdf" }), controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await h.uploadStarted.promise;
  controller.abort(); await h.store.clear(); release(); await rejected;
  assert.equal(h.calls.filter(call => call.url === "/api/ask-cmpri/files" && call.method === "PUT").length, 0);
  const deletions = h.calls.filter(call => call.method === "DELETE");
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].headers.Authorization, "Bearer original-actor");
  assert.equal(deletions[0].json.descriptor.sha256, h.calls[0].json.sha256);
});

test("normal close or a new search retains finalized originals for saved History; account clearing can revoke them", async () => {
  const h = fixture();
  const ref = await h.stage(new File(["retained source"], "Original.pdf", { type: "application/pdf" }));
  await h.store.clear();
  assert.equal(h.calls.some(call => call.method === "DELETE"), false, "normal close must not invalidate the signed reference saved in History");
  assert.ok(ref.expiresAt > h.state.now);
  const other = fixture();
  const scoped = await other.stage(new File(["private source"], "Scoped.pdf", { type: "application/pdf" }));
  await other.store.clear({ revokeFinalized: true });
  assert.deepEqual(other.calls.at(-1).json, { token: scoped.token });
});

test("an account switch during upload cannot finalize or hand original bytes to the next account", async () => {
  const h = fixture(), release = h.holdUpload();
  const pending = h.stage(new File(["private"], "Original.txt"));
  const rejected = assert.rejects(pending, /account changed/);
  await h.uploadStarted.promise; h.state.scope = "another-hotel:another-user:Manager"; release(); await rejected;
  assert.equal(h.calls.some(call => call.url === "/api/ask-cmpri/files" && call.method === "PUT"), false);
  assert.equal(h.calls.at(-1).method, "DELETE");
  assert.equal(h.calls.at(-1).headers.Authorization, "Bearer original-actor");
});

test("changed descriptors and unsafe upload URLs cannot produce usable original references", async () => {
  for (const change of [h => { h.state.badPrepare = true; }, h => { h.state.badFinalize = true; },
    h => { h.state.signedUrl = "https://external.example.invalid/upload?token=unexpected"; }]) {
    const h = fixture(); change(h);
    await assert.rejects(h.stage(new File(["original"], "Original.bin")), /prepared|verified|address/);
    assert.equal(h.calls.at(-1).method, "DELETE");
  }
});

test("expired originals are restaged, while invalid size and account reject before transfer", async () => {
  const h = fixture(), file = new File(["original"], "Original.csv", { type: "text/csv" });
  const first = await h.stage(file); h.state.now = first.expiresAt;
  const second = await h.stage(file);
  assert.notEqual(second.id, first.id);
  assert.equal(h.calls.filter(call => call.method === "DELETE").length, 1);
  const invalid = fixture();
  await assert.rejects(invalid.stage(new File([], "Empty.csv")), /nonempty/);
  invalid.state.scope = "other-account";
  await assert.rejects(invalid.stage(file), /account changed/);
  assert.equal(invalid.calls.length, 0);
});
