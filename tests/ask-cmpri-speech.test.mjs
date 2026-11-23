import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

const voices = loadTs("src/lib/ask-cmpri/voices.ts");
const wav = Buffer.alloc(46);
wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(2, 40);

function speechFixture() {
  const calls = [];
  const settings = { auth: { ok: true, mcp: false }, key: "fixture-server-key", status: 200, audio: wav.toString("base64") };
  class NextResponse extends Response { static json = Response.json; }
  const route = loadTs("src/app/api/ask-cmpri/speech/route.ts", {
    "next/server": { NextResponse }, zod: { z }, "@/lib/ask-cmpri/voices": voices,
    "@/lib/server/ask-cmpri-gemini": { askGeminiKey: () => settings.key },
    "@/lib/server/auth": { requireUserAttempt: async () => settings.auth },
  }, {
    AbortSignal, TextDecoder, process: { env: {} },
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return Response.json(settings.status === 200
        ? { steps: [{ type: "model_output", content: [{ type: "audio", data: settings.audio }] }] }
        : { error: "Do not expose fixture-server-key" }, { status: settings.status });
    },
  });
  return { settings, calls, send: body => route.POST(new Request("https://cmpri.test/api/ask-cmpri/speech", { method: "POST", body: JSON.stringify(body) })) };
}

test("speech authenticates before generation and rejects non-Gemini voices", async () => {
  const h = speechFixture();
  h.settings.auth = { ok: false };
  assert.equal((await h.send({ text: "Reply", voice: "Kore" })).status, 401);
  h.settings.auth = { ok: true, mcp: true };
  assert.equal((await h.send({ text: "Reply", voice: "Kore" })).status, 401);
  h.settings.auth = { ok: true, mcp: false };
  assert.equal((await h.send({ text: "Reply", voice: "Browser voice" })).status, 400);
  assert.equal((await h.send({ text: "x".repeat(5001), voice: "Kore" })).status, 400);
  assert.equal(h.calls.length, 0);
});

test("selected Gemini voice generates private WAV audio from the exact reply", async () => {
  const h = speechFixture();
  const response = await h.send({ text: "Quedan cuatro PMs.", voice: "Aoede", language: "es" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(h.calls[0].options.headers["x-goog-api-key"], "fixture-server-key");
  assert.equal(h.calls[0].body.model, "gemini-3.8-flash-lite-tts");
  assert.equal(h.calls[0].body.store, false);
  assert.equal(h.calls[0].body.input[0].content[0].text, "Quedan cuatro PMs.");
  assert.deepEqual(h.calls[0].body.generation_config.speech_config, [{ voice: "Aoede" }]);
});

test("speech failures and malformed audio remain explicit without exposing upstream data", async () => {
  const h = speechFixture();
  h.settings.key = null;
  assert.equal((await h.send({ text: "Reply", voice: "Kore" })).status, 503);
  assert.equal(h.calls.length, 0);
  h.settings.key = "fixture-server-key";
  h.settings.status = 403;
  let response = await h.send({ text: "Reply", voice: "Kore" });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /fixture-server-key/);
  h.settings.status = 200;
  h.settings.audio = Buffer.from("not audio").toString("base64");
  response = await h.send({ text: "Reply", voice: "Kore" });
  assert.equal(response.status, 502);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const flush = () => new Promise(resolve => setImmediate(resolve));

async function voiceFixture() {
  const requests = [];
  const sources = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  class AudioContext {
    state = "running";
    destination = {};
    async resume() {}
    async close() { this.state = "closed"; }
    async decodeAudioData() { return { duration: 1 }; }
    createBufferSource() {
      const source = { started: false, stopped: false, disconnected: false, connect() {}, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    }
  }
  dom.window.AudioContext = AudioContext;
  dom.window.SpeechRecognition = class {
    start() { this.onstart?.(); }
    abort() {}
  };
  const microphone = {
    language: "en-US",
    permissions: { query: async () => ({ state: "granted", addEventListener() {}, removeEventListener() {} }) },
    mediaDevices: { enumerateDevices: async () => [{ kind: "audioinput" }], addEventListener() {} },
  };
  const { useAskCmpriVoice } = loadTs("src/components/ask-cmpri/useAskCmpriVoice.ts", { react: React }, {
    window, document, navigator: microphone, AbortController: dom.window.AbortController, queueMicrotask, performance,
  });
  let current;
  function Harness() {
    current = useAskCmpriVoice({ locale: "en-US", onTranscript() {}, synthesizeSpeech: (text, signal) => new Promise((resolve, reject) => requests.push({ text, signal, resolve, reject })) });
    return null;
  }
  await act(async () => { root.render(React.createElement(Harness)); await flush(); });
  return {
    get voice() { return current; }, requests, sources,
    async run(action) { await act(async () => { action(current); await flush(); await flush(); }); },
    async close() { await act(async () => { root.unmount(); await flush(); }); container.remove(); },
  };
}

test("Gemini speech is click initiated and stopped requests cannot play late audio", async () => {
  const h = await voiceFixture();
  try {
    assert.equal(h.requests.length, 0);
    await h.run(voice => voice.speak("Before a call"));
    assert.equal(h.requests.length, 0);
    await h.run(voice => voice.start());
    assert.equal(h.requests.length, 0, "starting the microphone does not prefetch speech");
    await h.run(voice => voice.speak("Authorized reply"));
    assert.equal(h.requests.length, 1);
    await h.run(voice => voice.stop());
    assert.equal(h.requests[0].signal.aborted, true);
    await h.run(() => h.requests[0].resolve(wav.buffer));
    assert.equal(h.sources.length, 0, "a late response cannot create an audio source after stop");
  } finally { await h.close(); }
});

test("Gemini WAV playback stops and never substitutes a browser voice", async () => {
  const h = await voiceFixture();
  try {
    await h.run(voice => voice.start());
    await h.run(voice => voice.speak("Read this reply"));
    await h.run(() => h.requests[0].resolve(wav.buffer));
    assert.equal(h.sources[0].started, true);
    await h.run(voice => voice.stop());
    assert.equal(h.sources[0].stopped, true);
    assert.equal(h.sources[0].disconnected, true);
  } finally { await h.close(); }
});
