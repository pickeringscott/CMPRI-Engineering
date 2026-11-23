import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { loadTs } from "./helpers/load-ts.mjs";

const media = loadTs("src/lib/server/ask-cmpri-model-media.ts", { "server-only": {} });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=", "base64");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(12, 44); bytes.writeInt16LE(-17, 46);
  return bytes;
}
function provider(requests, rejected = false) {
  return createGoogleGenerativeAI({ apiKey: "offline-provider-fixture", baseURL: "https://fixture.invalid/v1beta", fetch: async (url, init) => {
    assert.ok(String(url).startsWith("https://fixture.invalid/")); requests.push(JSON.parse(init.body));
    return rejected ? Response.json({ error: { code: 413, message: "Original media request exceeds the provider limit", status: "INVALID_ARGUMENT" } }, { status: 413 })
      : Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Fixture received the original media." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
  } })("gemini-3.5-flash");
}
const messages = output => [
  { role: "user", content: "Read this explicitly selected original." },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "source-read-1", toolName: "inspectFile", input: { fileId: "file:actual-selected-original" }, providerOptions: { google: { thoughtSignature: "fixture-signature" } } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "source-read-1", toolName: "inspectFile", output }] },
];

test("original image/audio bytes survive the installed AI SDK and Google tool-result conversion unchanged", async () => {
  for (const source of [{ name: "Original report.png", mimeType: "image/png", bytes: png }, { name: "Original observation.wav", mimeType: "audio/wav", bytes: wav() }]) {
    const prepared = media.prepareAskOriginalModelMedia({ ...source, sha256: digest(source.bytes) });
    assert.equal(prepared.summary.status, "ready"); assert.equal(prepared.summary.complete, false);
    assert.equal(prepared.summary.sha256, digest(source.bytes)); assert.equal(prepared.part.filename, source.name);
    const output = media.askOriginalMediaToModelOutput({ snapshotId: "actual-source", complete: false }, prepared);
    const requests = []; const result = await generateText({ model: provider(requests), maxRetries: 0, messages: messages(output) });
    assert.match(result.text, /Fixture received/); assert.equal(requests.length, 1);
    const responses = requests[0].contents.flatMap(content => content.parts).filter(part => part.functionResponse);
    const inline = responses.flatMap(part => part.functionResponse.parts || []).map(part => part.inlineData).filter(Boolean);
    assert.equal(inline.length, 1); assert.equal(inline[0].mimeType, source.mimeType); assert.deepEqual(Buffer.from(inline[0].data, "base64"), source.bytes);
    assert.ok(!output.value[0].text.includes(source.bytes.toString("base64")), "Binary data must be a media part, never a JSON preview string");
    assert.match(output.value[0].text, /not a verified transcript/); assert.equal(prepared.summary.complete, false);
  }
});

test("fake MIME, contradictory filenames, changed hashes and unsupported originals never become model media", () => {
  const cases = [
    [{ name: "fake.png", mimeType: "image/png", bytes: Buffer.from("<html>not an image</html>") }, "invalid"],
    [{ name: "wrong.jpg", mimeType: "image/jpeg", bytes: png }, "invalid"],
    [{ name: "wrong.jpg", mimeType: "image/png", bytes: png }, "invalid"],
    [{ name: "original.png", mimeType: "image/png", bytes: png, sha256: "0".repeat(64) }, "invalid"],
    [{ name: "animation.gif", mimeType: "image/gif", bytes: Buffer.from("GIF89aoriginal") }, "unsupported"],
    [{ name: "source.txt", mimeType: "text/plain", bytes: Buffer.from("Original textual evidence") }, "not_media"],
    [{ name: "empty.png", mimeType: "image/png", bytes: Buffer.alloc(0) }, "invalid"],
  ];
  for (const [source, expected] of cases) {
    const prepared = media.prepareAskOriginalModelMedia(source);
    assert.equal(prepared.summary.status, expected); assert.equal(prepared.part, undefined); assert.equal(prepared.summary.complete, false);
    const output = media.askOriginalMediaToModelOutput({ snapshotId: "source-status" }, prepared);
    assert.equal(output.value.length, 1); assert.equal(output.value[0].type, "text");
  }
});

test("inline size budgets account for the whole run without truncating or recompressing originals", () => {
  const source = { name: "Actual map", mimeType: "image/png", bytes: png };
  const valid = media.prepareAskOriginalModelMedia(source, { remainingBytes: png.length });
  assert.equal(valid.summary.status, "ready"); assert.deepEqual(Buffer.from(valid.part.data.data, "base64"), png);
  const tooLarge = media.prepareAskOriginalModelMedia(source, { remainingBytes: png.length - 1 });
  assert.equal(tooLarge.summary.status, "too_large"); assert.equal(tooLarge.summary.size, png.length); assert.equal(tooLarge.summary.sha256, digest(png));
  assert.equal(tooLarge.part, undefined); assert.equal(tooLarge.summary.complete, false); assert.match(tooLarge.summary.message, /not shortened or recompressed/);
  const second = media.prepareAskOriginalModelMedia(source, { remainingBytes: 0 }); assert.equal(second.summary.status, "too_large");
  const oversized = Buffer.alloc(media.ASK_MODEL_MEDIA_BYTES + 1); png.copy(oversized);
  assert.equal(media.prepareAskOriginalModelMedia({ ...source, bytes: oversized }).summary.status, "too_large");
});

test("provider failure and failed native reads do not become successful image/audio inspection", async () => {
  const prepared = media.prepareAskOriginalModelMedia({ name: "Original.png", mimeType: "image/png", bytes: png });
  const failed = media.askOriginalMediaToModelOutput({ ok: false, error: "Current native access was denied" }, prepared);
  assert.equal(failed.value.length, 1); assert.match(failed.value[0].text, /denied/);
  const requests = [], output = media.askOriginalMediaToModelOutput({ snapshotId: "exact-source" }, prepared);
  await assert.rejects(generateText({ model: provider(requests, true), maxRetries: 0, messages: messages(output) }), /provider limit/);
  assert.equal(requests.length, 1); assert.equal(prepared.summary.complete, false);
  assert.deepEqual(Buffer.from(prepared.part.data.data, "base64"), png);
});

test("common original audio containers use their verified signature and canonical media type", () => {
  const cases = [
    ["source.mp3", "audio/mp3", Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0]), "audio/mpeg"],
    ["tagged.mp3", "audio/mpeg", Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]), "audio/mpeg"],
    ["source.aiff", "audio/aiff", Buffer.from("FORM\0\0\0\u0010AIFFsource"), "audio/aiff"],
    ["source.flac", "audio/flac", Buffer.from("fLaCactual container"), "audio/flac"],
    ["source.ogg", "audio/ogg", Buffer.from("OggSactual container"), "audio/ogg"],
    ["source.aac", "audio/aac", Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0xff, 0xfc]), "audio/aac"],
    ["source.m4a", "audio/m4a", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypM4A source")]), "audio/mp4"],
    ["source.webm", "audio/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), "audio/webm"],
  ];
  for (const [name, mimeType, bytes, canonical] of cases) {
    const prepared = media.prepareAskOriginalModelMedia({ name, mimeType, bytes });
    assert.equal(prepared.summary.status, "ready", name); assert.equal(prepared.summary.kind, "audio"); assert.equal(prepared.part.mediaType, canonical);
    assert.deepEqual(Buffer.from(prepared.part.data.data, "base64"), bytes); assert.equal(prepared.summary.complete, false);
  }
});
