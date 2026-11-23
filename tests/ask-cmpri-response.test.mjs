import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const threshold = 4 * 1024 * 1024;
const chunkLimit = 64 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(webGlobals = true) {
  const metrics = { normalJson: 0, streams: 0, pulls: 0, encodes: 0, cancelled: 0 };
  class ObservedStream extends ReadableStream {
    constructor(source, strategy) {
      metrics.streams++;
      super({
        pull(controller) { metrics.pulls++; return source.pull(controller); },
        cancel(reason) { metrics.cancelled++; return source.cancel(reason); },
      }, strategy);
    }
  }
  class ObservedEncoder extends TextEncoder {
    encodeInto(source, destination) { metrics.encodes++; return super.encodeInto(source, destination); }
  }
  const helper = loadTs("src/lib/server/ask-cmpri-response.ts", {
    "server-only": {}, "next/server": { NextResponse: { json: (body, init) => {
      metrics.normalJson++; return Response.json(body, init);
    } } },
  }, webGlobals ? { Response, ReadableStream: ObservedStream, TextEncoder: ObservedEncoder, Uint8Array } : {});
  return { ...helper, metrics };
}

test("small Ask responses retain normal NextResponse JSON, status and custom headers without extra Web globals", async () => {
  const f = fixture(false), headers = { "Cache-Control": "public, max-age=3600", "Content-Length": "999", "X-CMPRI-Test": "preserved" };
  const value = { title: "Resultado", summary: "Habitación 203 · Δ 🛠", context: { language: "es" }, optional: undefined };
  const response = f.askJsonResponse(value, { status: 202, statusText: "Accepted", headers });
  assert.equal(response.status, 202); assert.equal(response.statusText, "Accepted");
  assert.equal(response.headers.get("x-cmpri-test"), "preserved");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(headers["Cache-Control"], "public, max-age=3600", "caller header objects are unchanged");
  assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(value)));
  assert.equal(f.metrics.normalJson, 1); assert.equal(f.metrics.streams, 0);
});

test("an Ask download larger than 4.5 MB streams and a normal Response.json consumer recovers the exact original hash", async () => {
  const f = fixture(), original = Buffer.alloc(3_600_001, Buffer.from([0, 1, 254, 255, 92, 34, 17]));
  const body = { title: "Saved original", summary: "Original file retained.", downloads: [{ id: "native-original", name: "Original Δ.bin",
    mimeType: "application/octet-stream", content: original.toString("base64"), encoding: "base64" }],
  context: { sources: ["cmpri"], native: { summary: "Original file retained.", reads: [] } } };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 4_500_000);
  const response = f.askJsonResponse(body, { status: 200, headers: { "Content-Length": "1", "X-Result": "original" } });
  assert.equal(f.metrics.normalJson, 0); assert.equal(f.metrics.streams, 1);
  assert.equal(response.headers.get("content-length"), null); assert.equal(response.headers.get("x-result"), "original");
  const parsed = await response.json(), received = Buffer.from(parsed.downloads[0].content, "base64");
  assert.equal(received.length, original.length); assert.equal(hash(received), hash(original));
  assert.deepEqual(parsed, body); assert.ok(f.metrics.pulls > 1);
});

test("UTF-8 byte size chooses streaming and every bounded chunk is independently valid across a surrogate-pair boundary", async () => {
  const f = fixture();
  const prefixBytes = Buffer.byteLength('{"text":"');
  const text = "a".repeat(chunkLimit - 1 - prefixBytes) + "🛠漢é\u2028🙂".repeat(400_000);
  const serialized = JSON.stringify({ text });
  assert.ok(serialized.length < threshold, "UTF-16 string length alone would incorrectly choose the buffered path");
  assert.ok(Buffer.byteLength(serialized) > 4_500_000);
  const response = f.askJsonResponse({ text });
  assert.equal(f.metrics.streams, 1); assert.equal(f.metrics.encodes, 0, "no chunks are encoded before a consumer reads");
  const reader = response.body.getReader(), parts = [], sizes = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    assert.ok(value.byteLength > 0 && value.byteLength <= chunkLimit);
    parts.push(new TextDecoder("utf-8", { fatal: true }).decode(value)); sizes.push(value.byteLength);
  }
  assert.equal(sizes[0], chunkLimit - 1, "the four-byte symbol is kept out of the one-byte space at the first boundary");
  assert.ok(parts[1].startsWith("🛠"));
  assert.equal(parts.join(""), serialized); assert.equal(JSON.parse(parts.join("")).text, text);
  assert.equal(f.metrics.encodes, sizes.length); assert.ok(sizes.length > 1);
});

test("stream backpressure is bounded and cancellation stops all further chunk production", async () => {
  const f = fixture(), response = f.askJsonResponse({ text: "x".repeat(threshold + chunkLimit) });
  await Promise.resolve();
  assert.equal(f.metrics.pulls, 0); assert.equal(f.metrics.encodes, 0);
  const reader = response.body.getReader(), first = await reader.read();
  assert.equal(first.done, false); assert.equal(first.value.byteLength, chunkLimit);
  await Promise.resolve();
  assert.equal(f.metrics.encodes, 1, "the stream does not pre-encode the remaining result");
  await reader.cancel("caller closed Ask");
  const after = { pulls: f.metrics.pulls, encodes: f.metrics.encodes };
  assert.equal(f.metrics.cancelled, 1);
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
  await Promise.resolve();
  assert.deepEqual({ pulls: f.metrics.pulls, encodes: f.metrics.encodes }, after);
});

test("the exact 4 MiB boundary stays normal JSON and the next byte streams without changing serialization", async () => {
  const overhead = JSON.stringify({ text: "" }).length;
  for (const extra of [0, 1]) {
    const f = fixture(), body = { text: "x".repeat(threshold - overhead + extra) };
    const response = f.askJsonResponse(body);
    assert.equal(f.metrics.normalJson, extra === 0 ? 1 : 0); assert.equal(f.metrics.streams, extra);
    assert.deepEqual(await response.json(), body);
  }
});

test("size checking and transport observe caller serialization once and reject non-JSON bodies before producing a response", async () => {
  for (const length of [10, threshold + 1]) {
    const f = fixture(); let calls = 0;
    const response = f.askJsonResponse({ toJSON() { calls++; return { text: "x".repeat(length), calls }; } });
    const result = await response.json(); assert.equal(calls, 1); assert.equal(result.calls, 1); assert.equal(result.text.length, length);
  }
  const f = fixture(), circular = {}; circular.self = circular;
  assert.throws(() => f.askJsonResponse(undefined), /JSON serializable/);
  assert.throws(() => f.askJsonResponse(circular), /circular/i);
  assert.equal(f.metrics.streams, 0); assert.equal(f.metrics.normalJson, 0);
});
