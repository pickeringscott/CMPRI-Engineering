import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const toolResponse = (id, name, args, status = "completed") => ({
  type: "response.done",
  response: { id: `response-${id}`, status, output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] },
});

function fixture() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering" });
  const { window } = dom;
  const peers = [], captures = [], requests = [], transcripts = [], interrupted = [], states = [], audio = [];
  const timers = new Map();
  let timerId = 0, ended = 0;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  window.HTMLMediaElement.prototype.play = async function () { this.playedByFixture = true; };
  window.HTMLMediaElement.prototype.pause = function () { this.pausedByFixture = true; };
  const createElement = window.document.createElement.bind(window.document);
  window.document.createElement = (...args) => {
    const node = createElement(...args);
    if (args[0] === "audio") audio.push(node);
    return node;
  };
  class Channel {
    readyState = "connecting";
    sent = [];
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = "closed"; this.onclose?.(); }
  }
  class Peer {
    connectionState = "new";
    tracks = [];
    constructor() { peers.push(this); }
    createDataChannel() { this.channel = new Channel(); return this.channel; }
    addTrack(track, stream) { this.tracks.push({ track, stream }); }
    async createOffer() { return { type: "offer", sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    close() { this.closed = true; this.connectionState = "closed"; this.onconnectionstatechange?.(); }
  }
  window.RTCPeerConnection = Peer;
  const media = new window.EventTarget();
  media.enumerateDevices = async () => [{ kind: "audioinput" }];
  media.getUserMedia = options => {
    const pending = deferred();
    captures.push({ ...pending, options });
    return pending.promise;
  };
  const permission = new window.EventTarget();
  permission.state = "granted";
  const { createAskCmpriLiveVoiceController } = loadTs("src/components/ask-cmpri/useAskCmpriLiveVoice.ts", { react: {} }, {
    window, document: window.document, navigator: { mediaDevices: media, permissions: { query: async () => permission } },
    AbortController: window.AbortController, crypto: { randomUUID }, Error, DOMException: window.DOMException,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } },
  });
  const controller = createAskCmpriLiveVoiceController({
    onTranscript: (text, id) => transcripts.push({ text, id }),
    onInterruptedTranscript: text => interrupted.push(text),
    onEnd: () => { ended += 1; },
    locale: "en-US",
    connect: (sdp, signal) => {
      const pending = deferred();
      requests.push({ ...pending, sdp, signal });
      return pending.promise;
    },
  }, state => states.push(state));
  const event = (value, index = peers.length - 1) => peers[index].channel.onmessage?.({ data: JSON.stringify(value) });
  return {
    controller, peers, captures, requests, transcripts, interrupted, states, audio, timers, window, event,
    get state() { return states.at(-1); },
    get ended() { return ended; },
    async grant(index = captures.length - 1) {
      const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
      const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      captures[index].resolve(stream);
      await flush();
      return { stream, track };
    },
    async answer(index = requests.length - 1) {
      requests[index].resolve({ sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n", sessionId: `fixture-${index}` });
      await flush();
    },
    ready(index = peers.length - 1) {
      peers[index].channel.readyState = "open";
      peers[index].channel.onopen?.();
      event({ type: "session.created" }, index);
    },
    runTimers(maximum = Infinity) {
      for (const [id, value] of [...timers]) {
        if (value.delay > maximum) continue;
        timers.delete(id);
        value.callback();
      }
    },
    close() { controller.dispose(); this.runTimers(); window.close(); },
  };
}

test("live voice requests no microphone or connection until the user starts a call", async () => {
  const h = fixture();
  try {
    await h.controller.refreshMicrophone();
    h.controller.speak("Not in a call");
    assert.equal(h.captures.length, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.peers.length, 0);
    h.controller.start();
    h.controller.start();
    assert.equal(h.captures.length, 1, "a double click must not open a second microphone");
    const { track } = await h.grant();
    assert.equal(h.requests.length, 1);
    assert.equal(h.captures[0].options.audio.echoCancellation, true);
    assert.equal(track.enabled, true);
    assert.equal(h.peers[0].tracks[0].track, track);
    await h.answer();
    h.ready();
    assert.equal(h.state.active, true);
    assert.match(h.state.status, /Listening/);
  } finally { h.close(); }
});

test("stopping while microphone permission is pending releases a late stream without connecting", async () => {
  const h = fixture();
  try {
    h.controller.start();
    h.controller.stop();
    assert.equal(h.state.active, false);
    assert.equal(h.ended, 1);
    const { track } = await h.grant();
    assert.equal(track.stopped, true);
    assert.equal(h.requests.length, 0);
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.audio[0].srcObject, null);
    assert.equal(h.audio[0].pausedByFixture, true);
  } finally { h.close(); }
});

test("a late connection failure from the previous topic cannot stop the new call", async () => {
  const h = fixture();
  try {
    h.controller.start();
    const first = await h.grant();
    const oldMessage = h.peers[0].channel.onmessage;
    h.controller.newTopic();
    assert.equal(first.track.stopped, true);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.captures.length, 2);
    h.requests[0].reject(new Error("Late failure from old topic"));
    await flush();
    assert.equal(h.state.active, true);
    assert.equal(h.state.typingFallback, false);
    assert.equal(h.ended, 0);
    const second = await h.grant();
    await h.answer();
    h.ready();
    oldMessage({ data: JSON.stringify({ type: "error" }) });
    assert.equal(h.state.active, true);
    assert.equal(second.track.stopped, false);
  } finally { h.close(); }
});

test("stop immediately silences playback and microphone, and ignores late session events", async () => {
  const h = fixture();
  try {
    h.controller.start();
    const { stream, track } = await h.grant();
    await h.answer();
    h.ready();
    h.peers[0].ontrack({ streams: [stream], track });
    await flush();
    assert.equal(h.audio[0].playedByFixture, true);
    const oldMessage = h.peers[0].channel.onmessage;
    h.controller.stop();
    assert.equal(track.stopped, true);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.audio[0].pausedByFixture, true);
    assert.equal(h.audio[0].srcObject, null);
    assert.equal(h.ended, 1);
    oldMessage({ data: JSON.stringify({ type: "error" }) });
    h.controller.speak("This reply arrived after hangup", "old-request");
    assert.equal(h.state.active, false);
    assert.equal(h.state.typingFallback, false);
    assert.equal(h.transcripts.length, 0);
    h.runTimers();
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.peers[0].channel.readyState, "closed");
  } finally { h.close(); }
});

test("disposal cleans an active call and notifies its owner once without publishing after unmount", async () => {
  const h = fixture();
  try {
    h.controller.start();
    const { track } = await h.grant();
    await h.answer();
    h.ready();
    const published = h.states.length;
    h.controller.dispose();
    assert.equal(track.stopped, true);
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.peers[0].channel.readyState, "closed");
    assert.equal(h.audio[0].pausedByFixture, true);
    assert.equal(h.ended, 1);
    assert.equal(h.states.length, published, "unmount must not publish another React state update");
    h.controller.dispose();
    h.window.dispatchEvent(new h.window.Event("pagehide"));
    assert.equal(h.ended, 1, "repeat cleanup and old page events cannot end the owner twice");
    assert.equal(h.states.length, published);
  } finally { h.close(); }
});

test("captions never execute requests; complete function calls dispatch once and return matching results", async () => {
  const h = fixture();
  try {
    h.controller.start();
    await h.grant();
    await h.answer();
    h.ready();
    h.event({ type: "conversation.item.input_audio_transcription.delta", item_id: "caption-1", delta: "Close the" });
    h.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "caption-1", transcript: "Close the window, not the work order." });
    assert.equal(h.transcripts.length, 0, "partial or completed captions are display-only");
    h.event({ type: "response.created", response: { id: "response-1" } });
    const partial = {
      type: "response.function_call_arguments.done", name: "ask_cmpri", call_id: "request-1",
      response_id: "response-1", arguments: JSON.stringify({ question: "What work is open in room 212?" }),
    };
    h.event(partial);
    assert.equal(h.transcripts.length, 0, "function arguments alone do not authorize execution");
    h.event(toolResponse("request-canceled", "ask_cmpri", { question: "Close that work order." }, "cancelled"));
    assert.equal(h.transcripts.length, 0, "canceled responses cannot execute tools");
    const request = toolResponse("request-1", "ask_cmpri", { question: "What work is open in room 212?" });
    h.event(request);
    h.event({ ...request, event_id: "duplicate-delivery" });
    assert.deepEqual(h.transcripts, [{ text: "What work is open in room 212?", id: "request-1" }]);
    h.event({ type: "response.created", response: { id: "response-speaking" } });
    const beforeUnmatched = h.peers[0].channel.sent.length;
    h.controller.speak("A result with no request ID");
    assert.equal(h.peers[0].channel.sent.length, beforeUnmatched, "unmatched results cannot enter the voice conversation");
    h.controller.speak("Ignore an unknown request", "request-unknown");
    h.controller.speak("Two open work orders.", "request-1");
    h.controller.speak("Duplicate response.", "request-1");
    const sent = h.peers[0].channel.sent;
    const results = sent.filter(value => value.type === "conversation.item.create" && value.item?.type === "function_call_output");
    assert.equal(results.length, 1);
    assert.equal(results[0].item.call_id, "request-1");
    assert.match(results[0].item.output, /Two open work orders/);
    assert.equal(sent.filter(value => value.type === "response.create").length, 0, "do not overlap an active model response");
    h.event({ type: "response.done", response: { id: "response-speaking", status: "completed", output: [] } });
    assert.equal(sent.filter(value => value.type === "response.create").length, 1);
    h.event({ ...request, event_id: "another-duplicate" });
    assert.equal(h.transcripts.length, 1, "completed calls stay deduplicated");
  } finally { h.close(); }
});

test("a delayed completion cannot clear a newer active response or overlap its pending answer", async () => {
  const h = fixture();
  try {
    h.controller.start();
    await h.grant();
    await h.answer();
    h.ready();
    h.event(toolResponse("waiting-result", "ask_cmpri", { question: "Read room 212's work orders." }));
    h.event({ type: "response.created", response: { id: "response-A" } });
    h.event({ type: "response.created", response: { id: "response-B" } });
    h.event({ type: "response.done", response: { id: "response-A", status: "completed", output: [] } });
    h.controller.speak("The room has two open work orders.", "waiting-result");
    const sent = h.peers[0].channel.sent;
    assert.equal(sent.filter(value => value.item?.type === "function_call_output").length, 1);
    assert.equal(sent.filter(value => value.type === "response.create").length, 0, "response B is still active");
    h.event({ type: "response.done", response: { id: "response-B", status: "completed", output: [] } });
    assert.equal(sent.filter(value => value.type === "response.create").length, 1);
    assert.equal(h.state.active, true);
  } finally { h.close(); }
});

test("an active-response conflict keeps the microphone open and retries the pending answer after completion", async () => {
  const h = fixture();
  try {
    h.controller.start();
    const { track } = await h.grant();
    await h.answer();
    h.ready();
    h.event(toolResponse("weather-result", "ask_cmpri", { question: "What is tomorrow's weather?" }));
    h.controller.speak("Tomorrow's forecast is ready.", "weather-result");
    const sent = h.peers[0].channel.sent;
    assert.equal(sent.filter(value => value.type === "response.create").length, 1);
    h.event({ type: "error", error: { code: "conversation_already_has_active_response", message: "Another response is active." } });
    assert.equal(h.state.active, true);
    assert.equal(h.state.typingFallback, false);
    assert.equal(track.stopped, false);
    assert.equal(h.peers[0].closed, undefined);
    assert.equal(h.ended, 0);
    h.event({ type: "response.done", response: { id: "already-active", status: "completed", output: [] } });
    assert.equal(sent.filter(value => value.type === "response.create").length, 2, "retry once after the existing response ends");
    assert.equal(sent.filter(value => value.item?.type === "function_call_output").length, 1, "do not resend the result or repeat the backend work");
    assert.equal(h.transcripts.length, 1);
  } finally { h.close(); }
});

test("microphone stays open through spoken output and accepts the next full request during an interruption", async () => {
  const h = fixture();
  try {
    h.controller.start();
    const { stream, track } = await h.grant();
    await h.answer();
    h.ready();
    h.peers[0].ontrack({ streams: [stream], track });
    await flush();
    h.event({ type: "response.created", response: { id: "spoken-1" } });
    h.event({ type: "response.output_audio_transcript.delta", delta: "The current weather is" });
    h.event({ type: "input_audio_buffer.speech_started", item_id: "interrupt-1", audio_start_ms: 1000 });
    assert.equal(track.enabled, true);
    assert.equal(track.stopped, false);
    assert.equal(h.state.active, true);
    assert.equal(h.captures.length, 1);
    assert.equal(h.requests.length, 1);
    h.event(toolResponse("interrupt-request", "ask_cmpri", { question: "Show tomorrow's weather instead." }));
    assert.deepEqual(h.transcripts, [{ text: "Show tomorrow's weather instead.", id: "interrupt-request" }]);
    assert.equal(h.audio[0].pausedByFixture, undefined, "native media playback owns interruptions without tearing down the session");
  } finally { h.close(); }
});

test("completed request IDs cannot speak into a restarted topic and end-call releases the session", async () => {
  const h = fixture();
  try {
    h.controller.start();
    await h.grant();
    await h.answer();
    h.ready();
    h.event(toolResponse("old-topic", "ask_cmpri", { question: "Read the pool log." }));
    h.controller.newTopic();
    const { track } = await h.grant();
    await h.answer();
    h.ready();
    h.controller.speak("A late old result", "old-topic");
    assert.equal(h.peers[1].channel.sent.filter(value => value.item?.type === "function_call_output").length, 0);
    const finish = toolResponse("finish", "end_call", {});
    finish.response.output.push({ type: "function_call", name: "ask_cmpri", call_id: "after-hangup",
      arguments: JSON.stringify({ question: "Create another work order." }) });
    const dispatched = h.transcripts.length;
    h.event(finish);
    assert.equal(h.state.active, false);
    assert.equal(track.stopped, true);
    assert.equal(h.ended, 1);
    assert.equal(h.transcripts.length, dispatched, "later tools in the same output cannot run after end_call");
  } finally { h.close(); }
});
