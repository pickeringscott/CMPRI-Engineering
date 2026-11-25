import assert from "node:assert/strict";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import React, { act } from "react";
import * as jsx from "react/jsx-runtime";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

test("document download enforces Chief Engineer access before resolving an original", async () => {
  let auth = { ok: false };
  let reads = 0;
  const { POST } = loadTs("src/app/api/ask-cmpri/document-download/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/server/auth": { requireUserAttempt: async () => auth },
    "@/lib/server/roles": loadTs("src/lib/server/roles.ts"),
    "@/lib/server/ask-cmpri-vendor-document": { askVendorDocumentDownload: async () => { reads++; return { name: "example.pdf" }; } },
  });
  const send = () => POST(new Request("https://cmpri.test/api/ask-cmpri/document-download", {
    method: "POST", body: JSON.stringify({ token: "fixture-only" }),
  }));
  assert.equal((await send()).status, 401);
  auth = { ok: true, principal: { profile: { role: "system_admin" } } };
  assert.equal((await send()).status, 403);
  assert.equal(reads, 0);
  auth.principal.profile.role = "chief_engineer";
  assert.equal((await send()).status, 200);
  assert.equal(reads, 1);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const pdf = Buffer.from("%PDF-1.7\nFixture manual\n%%EOF");
const signedUrl = "https://storage.example.invalid/storage/v1/object/sign/private/manual.pdf?token=fixture-signed-storage";
const scope = "hotel:alex:Chief Engineer:view_pm";
const nativeDownload = { id: "vendor-manual", name: "Fixture manual.pdf", mimeType: "application/pdf", downloadToken: "fixture-scoped-token" };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }

async function fixture({ metadata = {}, status = 200, downloads = [nativeDownload] } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const saved = [], requests = [], authCalls = [], digests = [];
  let currentScope = scope, renderedScope = scope, storageGate, closed = false;
  const metadataBody = { url: signedUrl, name: nativeDownload.name, mimeType: "application/pdf", size: pdf.length,
    sha256: createHash("sha256").update(pdf).digest("hex"), ...metadata };
  const { AskCmpriDownloadList } = loadTs("src/components/ask-cmpri/AskCmpriAttachments.tsx", {
    react: React, "react/jsx-runtime": jsx,
    "./AskCmpriAttachments.module.css": { default: {} },
    "./local-file-storage": {
      AskCmpriFolderSaveError: class extends Error {},
      downloadAskCmpriFile: async (owner, name, blob, signal) => {
        signal.throwIfAborted();
        saved.push({ owner, name, blob });
        return "browser";
      },
    },
  }, {
    Blob, File, URL, AbortController, atob,
    crypto: { subtle: { digest: (...args) => { const digest = webcrypto.subtle.digest(...args); digests.push(digest); return digest; } } },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === "/api/ask-cmpri/document-download") return Response.json(metadataBody, { status });
      assert.equal(url, signedUrl, "the client can only retrieve the authenticated signed storage URL");
      if (storageGate) await storageGate.promise;
      // Deliberately return even after abort, to exercise the late-response guard.
      return new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
    },
  });
  const authorize = async (signal, expected) => {
    authCalls.push(expected);
    signal.throwIfAborted();
    return { scope: currentScope, headers: { Authorization: "Bearer current-user-session" } };
  };
  async function render() {
    await act(async () => { root.render(React.createElement(AskCmpriDownloadList, { downloads, scopeKey: renderedScope, authorize })); await settle(); });
  }
  async function finishLocalWork() { await settle(); await Promise.all(digests); await settle(); }
  await render();
  return {
    container, saved, requests, authCalls,
    holdStorage() { storageGate = deferred(); },
    async releaseStorage() { await act(async () => { storageGate.resolve(); await finishLocalWork(); }); },
    async click(index = 0) { await act(async () => { container.querySelectorAll("button")[index].click(); await finishLocalWork(); }); },
    changeAccount(value) { currentScope = value; },
    async changeRenderedScope(value) { renderedScope = value; currentScope = value; await render(); },
    async close() {
      if (closed) return;
      closed = true;
      await act(async () => { root.unmount(); await settle(); });
      container.remove();
    },
  };
}

test("native PDF downloads verify bytes and scope, omit CMPRI credentials from storage, and preserve truthful browser status", async () => {
  const h = await fixture();
  try {
    h.holdStorage();
    await h.click(); await h.click();
    assert.equal(h.requests.length, 2, "a second click cannot start another download while the first is pending");
    const [metadata, storage] = h.requests;
    assert.equal(metadata.options.method, "POST");
    assert.equal(metadata.options.headers.Authorization, "Bearer current-user-session");
    assert.deepEqual(JSON.parse(metadata.options.body), { token: nativeDownload.downloadToken });
    assert.equal(storage.options.credentials, "omit");
    assert.equal(storage.options.referrerPolicy, "no-referrer");
    assert.equal(storage.options.redirect, "error");
    assert.equal(storage.options.headers, undefined, "the CMPRI bearer never reaches storage");
    assert.equal(h.saved.length, 0);
    await h.releaseStorage();
    assert.deepEqual(h.authCalls, [scope, scope]);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].owner, scope);
    assert.equal(h.saved[0].name, nativeDownload.name);
    assert.equal(h.saved[0].blob.type, "application/pdf");
    assert.deepEqual(Buffer.from(await h.saved[0].blob.arrayBuffer()), pdf);
    assert.match(h.container.textContent, /Check your browser’s downloads/);
    assert.doesNotMatch(h.container.textContent, /Saved to/);
  } finally { await h.close(); }
});

test("digest and actual byte-count mismatches never reach device storage", async () => {
  for (const metadata of [{ sha256: "0".repeat(64) }, { size: pdf.length + 1 }, { size: pdf.length - 1 }]) {
    const h = await fixture({ metadata });
    try {
      await h.click();
      assert.equal(h.saved.length, 0);
      assert.match(h.container.textContent, /could not be downloaded/);
    } finally { await h.close(); }
  }
});

test("expired tokens, incorrect metadata, and unsafe URLs cannot start a device download", async () => {
  for (const options of [{ status: 403 }, { metadata: { name: "Different.pdf" } }, { metadata: { size: 104857601 } },
    { metadata: { url: "http://storage.example.invalid/storage/v1/object/sign/private/manual.pdf?token=fixture" } }]) {
    const h = await fixture(options);
    try {
      await h.click();
      assert.equal(h.requests.length, 1, "invalid metadata is rejected before storage retrieval");
      assert.equal(h.saved.length, 0);
    } finally { await h.close(); }
  }
});

test("a switched account is rejected before authorization or after a pending PDF retrieval", async () => {
  const early = await fixture();
  try {
    early.changeAccount("another-hotel:another-user:Manager:view_pm");
    await early.click();
    assert.equal(early.requests.length, 0);
    assert.equal(early.saved.length, 0);
  } finally { await early.close(); }
  const late = await fixture();
  try {
    late.holdStorage(); await late.click();
    late.changeAccount("another-hotel:another-user:Manager:view_pm");
    await late.releaseStorage();
    assert.equal(late.saved.length, 0);
    assert.equal(late.authCalls.length, 2, "the current account is rechecked after byte verification");
  } finally { await late.close(); }
});

test("unmount and scope replacement abort pending PDF retrieval and ignore late responses", async () => {
  for (const replacement of [false, true]) {
    const h = await fixture();
    try {
      h.holdStorage(); await h.click();
      const signal = h.requests[1].options.signal;
      if (replacement) await h.changeRenderedScope("another-hotel:another-user:Manager:view_pm");
      else await h.close();
      assert.equal(signal.aborted, true);
      await h.releaseStorage();
      assert.equal(h.saved.length, 0);
      if (replacement) assert.equal(h.container.querySelector("button").getAttribute("aria-disabled"), "false");
    } finally { await h.close(); }
  }
});

test("existing UTF-8 and base64 result downloads remain local and use the same device storage", async () => {
  const h = await fixture({ downloads: [
    { id: "csv", name: "Results.csv", mimeType: "text/csv", encoding: "utf8", content: "Room,Issue\n212,Fixture" },
    { id: "binary", name: "Result.bin", mimeType: "application/octet-stream", encoding: "base64", content: "AAH/" },
  ] });
  try {
    await h.click(0); await h.click(1);
    assert.equal(h.requests.length, 0); assert.equal(h.authCalls.length, 0);
    assert.equal(await h.saved[0].blob.text(), "Room,Issue\n212,Fixture");
    assert.deepEqual([...new Uint8Array(await h.saved[1].blob.arrayBuffer())], [0, 1, 255]);
  } finally { await h.close(); }
});
