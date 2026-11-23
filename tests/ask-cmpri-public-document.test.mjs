import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { loadTs } from "./helpers/load-ts.mjs";

function fixture(responses = [], addresses = [{ address: "93.184.216.34", family: 4 }]) {
  const calls = [], lookups = [];
  const reader = loadTs("src/lib/server/ask-cmpri-public-document.ts", {
    "server-only": {},
    "node:dns/promises": { lookup: async (host, options) => { lookups.push({ host, options }); return typeof addresses === "function" ? addresses(host) : addresses; } },
    "node:https": { request: (url, options, ready) => {
      calls.push({ url: url.href, options });
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = error => req.emit("error", error);
      req.end = () => queueMicrotask(() => {
        const next = responses.shift();
        assert.ok(next, "No live HTTP calls are allowed");
        const response = new EventEmitter();
        response.statusCode = next.status || 200;
        response.headers = { "content-type": "application/pdf", ...next.headers };
        response.destroy = () => { response.destroyed = true; };
        ready(response);
        if (!response.destroyed) {
          response.emit("data", Buffer.from(next.body || "%PDF-1.7\nfixture"));
          response.emit("end");
        }
      });
      return req;
    } },
  }, { URL, AbortSignal, Error, queueMicrotask });
  return { reader, calls, lookups, read: url => reader.fetchAskPublicDocument(url, new AbortController().signal) };
}

test("vendor transport rejects local/reserved addresses and credential-bearing URLs", () => {
  const { reader } = fixture();
  for (const ip of ["0.1.2.3", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "2001:0db8::1", "2002:a00:1::1", "3fff::1"]) assert.equal(reader.isAskPublicAddress(ip), false, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(reader.isAskPublicAddress(ip), true, ip);
  for (const url of ["http://vendor.com/a.pdf", "https://localhost/a.pdf", "https://127.0.0.1/a.pdf", "https://user:password@vendor.com/a.pdf", "https://vendor.com:8443/a.pdf", "https://vendor.com/a.pdf?access_token=private", "https://internal.local/a.pdf"]) assert.throws(() => reader.askPublicDocumentUrl(url), /public HTTPS/);
});

test("PDF bytes are fetched with DNS pinned and no CMPRI credentials", async () => {
  const h = fixture([{ body: "%PDF-1.7\nexact original", headers: { "content-disposition": "attachment; filename=manual.pdf" } }]);
  const found = await h.read("https://vendor.com/manual.pdf");
  assert.equal(found.kind, "pdf");
  assert.equal(found.bytes.toString(), "%PDF-1.7\nexact original");
  assert.equal(found.fileName, "manual.pdf");
  assert.equal(h.calls[0].options.agent, false);
  assert.equal(h.calls[0].options.headers.Authorization, undefined);
  assert.equal(h.calls[0].options.headers.Cookie, undefined);
  let pinned;
  h.calls[0].options.lookup("vendor.com", {}, (error, address, family) => { assert.equal(error, null); pinned = { address, family }; });
  assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
});

test("every redirect is checked before a request and private DNS cannot receive bytes", async () => {
  const local = fixture([{ status: 302, headers: { location: "https://127.0.0.1/private" } }]);
  await assert.rejects(local.read("https://vendor.com/manual"), /public HTTPS/);
  assert.equal(local.calls.length, 1);
  const dns = fixture([{ status: 302, headers: { location: "https://cdn.vendor.com/manual.pdf" } }], host => [{ address: host === "vendor.com" ? "93.184.216.34" : "10.0.0.8", family: 4 }]);
  await assert.rejects(dns.read("https://vendor.com/manual"), /public document server/);
  assert.equal(dns.calls.length, 1);
});

test("HTML only supplies observed public document links and never a fake PDF", async () => {
  const h = fixture([{ headers: { "content-type": "text/html" }, body: '<a href="/files/model.pdf">Service manual</a><a href="http://vendor.com/old.pdf">Old</a><a href="https://127.0.0.1/private.pdf">Private</a><a href="/downloads?id=1&amp;type=manual">Document</a>' }]);
  const found = await h.read("https://vendor.com/support");
  assert.equal(found.kind, "page");
  assert.deepEqual(JSON.parse(JSON.stringify(found.links)), [{ url: "https://vendor.com/files/model.pdf", label: "Service manual" }, { url: "https://vendor.com/downloads?id=1&type=manual", label: "Document" }]);
  assert.equal(found.bytes, undefined);
});

test("oversized and non-PDF responses cannot be retained as document originals", async () => {
  const big = fixture([{ headers: { "content-length": String(104857601) } }]);
  await assert.rejects(big.read("https://vendor.com/manual.pdf"), /file limit/);
  const invalid = fixture([{ body: "This is not a PDF" }]);
  await assert.rejects(invalid.read("https://vendor.com/manual.pdf"), /did not return/);
});
