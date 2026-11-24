"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AskCmpriMicrophoneState, AskCmpriMicrophoneStatus } from "./useAskCmpriVoice";

export interface AskCmpriLiveVoiceOptions {
  onTranscript: (text: string, delegationId?: string) => void;
  onInterruptedTranscript?: (text: string) => void;
  onEnd?: () => void;
  locale?: string;
  enabled?: boolean;
  connect: (sdp: string, signal: AbortSignal) => Promise<{ sdp: string; sessionId?: string;
    history?: { role: "user" | "assistant"; text: string }[] }>;
}

interface VoiceState {
  active: boolean;
  draft: string;
  reply: string;
  status: string;
  typingFallback: boolean;
  microphone: AskCmpriMicrophoneStatus;
}

const MESSAGES = {
  en: {
    checking: "Checking microphone…", ready: "Microphone ready",
    permission: "Microphone permission needed — click to allow",
    blocked: "Microphone access is blocked in your browser", missing: "No microphone detected",
    unsupported: "Live voice is unavailable in this browser",
    starting: "Connecting live voice…", listening: "Listening. Say “goodbye” to end the call.",
    connected: "Connected to Ask CMPRI. I'm listening.",
    ended: "Voice call ended.", failed: "Live voice could not connect. Type your question to continue.",
    disconnected: "The voice connection ended. Start a new call or type your question.",
    playback: "Audio playback is blocked. Start the call again or type your question.",
  },
  es: {
    checking: "Comprobando el micrófono…", ready: "Micrófono listo",
    permission: "Se necesita permiso para el micrófono. Selecciona el botón para permitirlo.",
    blocked: "Tu navegador bloqueó el acceso al micrófono", missing: "No se detectó ningún micrófono",
    unsupported: "La conversación de voz no está disponible en este navegador",
    starting: "Conectando la conversación de voz…", listening: "Escuchando. Di «adiós» para finalizar la llamada.",
    connected: "Conectado a Ask CMPRI. Te escucho.",
    ended: "Llamada de voz finalizada.", failed: "No se pudo conectar la voz. Escribe tu pregunta para continuar.",
    disconnected: "Se perdió la conexión de voz. Inicia otra llamada o escribe tu pregunta.",
    playback: "La reproducción de audio está bloqueada. Inicia otra llamada o escribe tu pregunta.",
  },
};

function languageFor(locale?: string) { return /^es(?:-|$)/i.test(locale || "") ? "es" : "en"; }
function initialState(locale?: string): VoiceState {
  return { active: false, draft: "", reply: "", status: "", typingFallback: false,
    microphone: { state: "checking", text: MESSAGES[languageFor(locale)].checking } };
}
function endsCall(value: string) {
  return /^(?:(?:ok(?:ay)?|thanks|thank you|gracias)[, ]+)?(?:good[\s-]*bye|adi[oó]s|hasta luego)[.!?,;\s]*$/i.test(value.trim().replace(/^[¡¿]+/, ""));
}

type LiveConnection = {
  controller: AbortController;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  audio: HTMLAudioElement;
  stream?: MediaStream;
  ready: boolean;
  calls: Map<string, { complete: boolean }>;
  responding: boolean;
  responseId?: string;
  needsResponse: boolean;
  speaking: boolean;
  history?: { role: "user" | "assistant"; text: string }[];
  inputItemId?: string;
  handledInputItems: Set<string>;
  eventIds: Set<string>;
  connectedEventId?: string;
  connectedResponseId?: string;
  connectedCancelEventId?: string;
  connectedInterrupted?: boolean;
  connectedDone?: boolean;
  setupTimer?: number;
};

/** The media track stays open during replies; Realtime handles speech turns and interruptions. */
export function createAskCmpriLiveVoiceController(options: AskCmpriLiveVoiceOptions, publish: (state: VoiceState) => void) {
  const text = MESSAGES[languageFor(options.locale)];
  const media = navigator.mediaDevices;
  const supported = typeof window.RTCPeerConnection === "function" && typeof media?.getUserMedia === "function" && window.isSecureContext !== false;
  const events = new AbortController();
  let state = initialState(options.locale);
  let current: LiveConnection | undefined;
  let disposed = false;
  let permission: PermissionStatus | undefined;
  let probe: Promise<AskCmpriMicrophoneStatus> | undefined;

  function update(next: Partial<VoiceState>) {
    state = { ...state, ...next };
    if (!disposed) publish(state);
  }
  function setMicrophone(value: AskCmpriMicrophoneState) {
    const microphone = { state: value, text: text[value] };
    update({ microphone });
    return microphone;
  }
  function permissionChanged() {
    if (permission?.state === "denied" && state.active) fail(text.blocked);
    void refreshMicrophone();
  }
  function refreshMicrophone(): Promise<AskCmpriMicrophoneStatus> {
    if (!supported) return Promise.resolve(setMicrophone("unsupported"));
    if (probe) return probe;
    probe = (async () => {
      try {
        const next = await navigator.permissions?.query({ name: "microphone" });
        if (!disposed && next !== permission) {
          permission?.removeEventListener("change", permissionChanged);
          permission = next;
          permission?.addEventListener("change", permissionChanged, { signal: events.signal });
        }
      } catch { /* A click can still request microphone permission. */ }
      const policyDocument = document as Document & {
        permissionsPolicy?: { allowsFeature: (name: string) => boolean };
        featurePolicy?: { allowsFeature: (name: string) => boolean };
      };
      const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy;
      if (permission?.state === "denied" || policy?.allowsFeature("microphone") === false) return setMicrophone("blocked");
      try {
        const devices = await media.enumerateDevices();
        if ((devices.length || permission?.state === "granted") && devices.every(device => device.kind !== "audioinput")) return setMicrophone("missing");
      } catch { /* Device labels can remain private before permission. */ }
      return setMicrophone(permission?.state === "granted" || current?.stream ? "ready" : "permission");
    })().finally(() => { probe = undefined; });
    return probe;
  }

  function send(connection: LiveConnection, event: Record<string, unknown>) {
    if (current !== connection || !connection.ready || connection.channel.readyState !== "open") return false;
    try { connection.channel.send(JSON.stringify({ event_id: crypto.randomUUID(), ...event })); return true; }
    catch { fail(text.disconnected); return false; }
  }
  function announceConnection(connection: LiveConnection) {
    if (current !== connection || !connection.ready || connection.channel.readyState !== "open" || connection.connectedEventId) return;
    const eventId = crypto.randomUUID();
    connection.connectedEventId = eventId;
    // A separate, empty-context response cannot read prior records or invoke
    // Ask tools. Session updates and duplicate open events must not repeat it.
    send(connection, { event_id: eventId, type: "response.create", response: {
      conversation: "none", input: [], output_modalities: ["audio"],
      tools: [], tool_choice: "none", max_output_tokens: 256,
      metadata: { cmpri: "connected" },
      instructions: `Say exactly this brief connection confirmation and nothing else: ${text.connected}`,
    } });
  }
  function interruptAnnouncement(connection: LiveConnection) {
    connection.connectedInterrupted = true;
    if (!connection.connectedResponseId || connection.connectedCancelEventId || connection.connectedDone) return;
    const eventId = crypto.randomUUID();
    connection.connectedCancelEventId = eventId;
    // Cancel only the announcement, never the caller's VAD response. WebRTC
    // clears unheard output when speech starts; keep the input track open.
    send(connection, { event_id: eventId, type: "response.cancel", response_id: connection.connectedResponseId });
  }
  function release(connection: LiveConnection) {
    connection.controller.abort();
    window.clearTimeout(connection.setupTimer);
    for (const track of connection.stream?.getTracks() || []) track.stop();
    connection.audio.pause();
    connection.audio.srcObject = null;
    connection.peer.ontrack = null;
    connection.peer.onconnectionstatechange = null;
    connection.channel.onopen = connection.channel.onmessage = connection.channel.onerror = connection.channel.onclose = null;
    connection.channel.close();
    connection.peer.close();
  }
  function disconnect() {
    const connection = current;
    if (!connection) return;
    current = undefined;
    release(connection);
  }
  function stop() {
    if (!state.active && !current) return;
    const remainder = state.draft.trim();
    disconnect();
    update({ active: false, draft: "", status: text.ended, typingFallback: false });
    if (!disposed) {
      if (remainder && !endsCall(remainder)) options.onInterruptedTranscript?.(remainder);
      options.onEnd?.();
    }
  }
  function fail(reason: string) {
    stop();
    update({ active: false, status: reason, typingFallback: true });
  }

  function continueResponse(connection: LiveConnection) {
    if (!connection.needsResponse || connection.responding || connection.speaking) return;
    if (send(connection, { type: "response.create" })) {
      connection.needsResponse = false;
      connection.responding = true;
    }
  }
  function functionCall(connection: LiveConnection, item: Record<string, unknown>) {
    if (current !== connection || !state.active) return;
    if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string"
      || connection.calls.has(item.call_id)) return;
    if (item.name === "end_call") { stop(); return; }
    if (item.name !== "ask_cmpri") return;
    let args: { question?: unknown };
    try { args = JSON.parse(item.arguments); } catch { return; }
    if (!args || typeof args.question !== "string" || !args.question.trim()) return;
    // Keep call IDs for the entire session so a replay cannot repeat an action.
    if (connection.calls.size >= 1024) { fail(text.disconnected); return; }
    connection.calls.set(item.call_id, { complete: false });
    if (connection.inputItemId) connection.handledInputItems.add(connection.inputItemId);
    update({ draft: "", reply: "" });
    if (endsCall(args.question)) { stop(); return; }
    options.onTranscript(args.question, item.call_id);
  }
  function receive(connection: LiveConnection, raw: unknown) {
    if (current !== connection || typeof raw !== "string" || raw.length > 1_000_000) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== "object" || typeof event.type !== "string") return;
    if (typeof event.event_id === "string") {
      if (connection.eventIds.has(event.event_id)) return;
      connection.eventIds.add(event.event_id);
      if (connection.eventIds.size > 4000) connection.eventIds.delete(connection.eventIds.values().next().value!);
    }
    const notice = event.response as { id?: string; metadata?: { cmpri?: string } } | undefined;
    if (connection.connectedResponseId && event.response_id === connection.connectedResponseId) return;
    if (notice?.metadata?.cmpri === "connected" || notice?.id && notice.id === connection.connectedResponseId) {
      if (event.type === "response.created") {
        connection.connectedResponseId = notice.id;
        if (connection.connectedInterrupted) interruptAnnouncement(connection);
      }
      if (event.type === "response.done") connection.connectedDone = true;
      // Even unexpected tool output in this announcement is never executable.
      return;
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      const first = !connection.ready;
      connection.ready = true;
      window.clearTimeout(connection.setupTimer);
      if (first) {
        for (const item of connection.history || []) {
          send(connection, { type: "conversation.item.create", item: { type: "message", role: item.role,
            content: [{ type: item.role === "user" ? "input_text" : "output_text", text: item.text }] } });
        }
        connection.history = undefined;
      }
      update({ status: text.listening });
      announceConnection(connection);
    } else if (event.type === "input_audio_buffer.speech_started") {
      connection.speaking = true;
      connection.inputItemId = typeof event.item_id === "string" ? event.item_id : undefined;
      interruptAnnouncement(connection);
      // WebRTC cancels/truncates unheard model audio. Never mute or discard the caller.
      update({ draft: "", reply: "" });
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      connection.speaking = false;
      // VAD will start the next model response; pending results are already in its context.
    } else if (event.type === "conversation.item.input_audio_transcription.delta" && typeof event.delta === "string") {
      if (typeof event.item_id === "string" && connection.handledInputItems.has(event.item_id)) return;
      update({ draft: (state.draft + event.delta).slice(-4000) });
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.transcript === "string") {
      if (typeof event.item_id === "string" && connection.handledInputItems.has(event.item_id)) return;
      update({ draft: event.transcript });
      if (endsCall(event.transcript)) stop();
    } else if (event.type === "response.output_audio_transcript.delta" && typeof event.delta === "string") {
      update({ reply: (state.reply + event.delta).slice(-3000) });
    } else if (event.type === "response.created") {
      connection.responding = true;
      const response = event.response as { id?: unknown } | undefined;
      if (typeof response?.id === "string") connection.responseId = response.id;
      connection.needsResponse = false;
    } else if (event.type === "response.done") {
      const response = event.response as { id?: string; status?: string; output?: Record<string, unknown>[] } | undefined;
      const finished = !connection.responseId || !response?.id || connection.responseId === response.id;
      if (finished) { connection.responding = false; connection.responseId = undefined; }
      if (response?.status === "completed") {
        for (const item of response.output || []) if (item.type === "function_call") functionCall(connection, item);
      }
      if (finished && response?.status === "failed") { fail(text.disconnected); return; }
      continueResponse(connection);
    } else if (event.type === "error") {
      const error = event.error as { code?: unknown; event_id?: unknown } | undefined;
      if (connection.connectedEventId && error?.event_id === connection.connectedEventId) return;
      if (connection.connectedCancelEventId && error?.event_id === connection.connectedCancelEventId) return;
      // A VAD response can start while the browser is returning a tool result.
      // Keep that result queued instead of hanging up on the overlap.
      if (error?.code === "conversation_already_has_active_response") {
        connection.responding = true;
        connection.needsResponse = true;
        return;
      }
      fail(text.disconnected);
    }
  }

  async function connect() {
    if (disposed || current) return;
    if (!supported) { fail(setMicrophone("unsupported").text); return; }
    let connection: LiveConnection | undefined;
    try {
      const peer = new window.RTCPeerConnection();
      const channel = peer.createDataChannel("oai-events");
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      connection = { peer, channel, audio, controller: new AbortController(), ready: false, calls: new Map(),
        responding: false, needsResponse: false, speaking: false, eventIds: new Set(), handledInputItems: new Set() };
      current = connection;
      const active = connection;
      connection.setupTimer = window.setTimeout(() => { if (current === active && !active.ready) fail(text.failed); }, 30_000);
      channel.onopen = () => announceConnection(active);
      channel.onmessage = event => receive(active, event.data);
      channel.onerror = () => { if (current === connection) fail(text.disconnected); };
      channel.onclose = () => { if (current === connection) fail(text.disconnected); };
      peer.onconnectionstatechange = () => {
        if (current === connection && ["failed", "closed", "disconnected"].includes(peer.connectionState)) fail(text.disconnected);
      };
      peer.ontrack = event => {
        if (current !== connection) return;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        void audio.play().catch(() => { if (current === connection) fail(text.playback); });
      };
      const stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (current !== connection || disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      connection.stream = stream;
      setMicrophone("ready");
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      if (current !== connection) return;
      await peer.setLocalDescription(offer);
      if (current !== connection) return;
      const sdp = peer.localDescription?.sdp || offer.sdp;
      if (!sdp) throw new Error(text.failed);
      const answer = await options.connect(sdp, connection.controller.signal);
      if (current !== connection || disposed) return;
      connection.history = answer.history;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      if (disposed || (connection && current !== connection) || !state.active) return;
      const name = error instanceof Error ? error.name : "";
      if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) fail(setMicrophone("blocked").text);
      else if (["NotFoundError", "DevicesNotFoundError"].includes(name)) fail(setMicrophone("missing").text);
      else fail(error instanceof Error && error.message ? error.message : text.failed);
    }
  }
  function start() {
    if (disposed || state.active) return;
    update({ active: true, draft: "", reply: "", status: text.starting, typingFallback: false });
    void connect();
  }
  function newTopic() {
    if (!state.active) return;
    disconnect();
    update({ draft: "", reply: "", status: text.starting, typingFallback: false });
    void connect();
  }
  function speak(answer: string, delegationId?: string) {
    const connection = current;
    if (!connection || !state.active || !answer.trim() || !delegationId) return;
    const call = connection.calls.get(delegationId);
    if (!call || call.complete) return;
    if (!send(connection, { type: "conversation.item.create", item: {
      type: "function_call_output", call_id: delegationId, output: JSON.stringify({ result: answer }),
    } })) return;
    call.complete = true;
    connection.needsResponse = true;
    continueResponse(connection);
  }

  function endFromText(value: string) {
    if (!state.active || !endsCall(value)) return false;
    stop(); return true;
  }
  media?.addEventListener?.("devicechange", () => { void refreshMicrophone(); }, { signal: events.signal });
  window.addEventListener("pagehide", stop, { signal: events.signal });
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || !state.active) return;
    event.preventDefault(); stop();
  }, { signal: events.signal });
  function dispose() {
    const wasActive = state.active;
    disposed = true;
    events.abort();
    stop();
    if (wasActive) options.onEnd?.();
  }
  return { start, stop, newTopic, speak, endFromText, refreshMicrophone, dispose };
}

export function useAskCmpriLiveVoice(options: AskCmpriLiveVoiceOptions) {
  const { locale, enabled = true } = options;
  const callbacks = useRef(options);
  const controller = useRef<ReturnType<typeof createAskCmpriLiveVoiceController> | null>(null);
  const [state, setState] = useState(() => initialState(locale));
  useEffect(() => { callbacks.current = options; }, [options]);
  useEffect(() => {
    if (!enabled) return;
    const instance = createAskCmpriLiveVoiceController({
      locale,
      onTranscript: (text, id) => callbacks.current.onTranscript(text, id),
      onInterruptedTranscript: text => callbacks.current.onInterruptedTranscript?.(text),
      onEnd: () => callbacks.current.onEnd?.(),
      connect: (sdp, signal) => callbacks.current.connect(sdp, signal),
    }, setState);
    controller.current = instance;
    queueMicrotask(() => {
      if (controller.current !== instance) return;
      setState(initialState(locale));
      void instance.refreshMicrophone();
    });
    return () => { controller.current = null; instance.dispose(); };
  }, [enabled, locale]);
  return {
    ...(enabled ? state : initialState(locale)),
    start: useCallback(() => controller.current?.start(), []),
    stop: useCallback(() => controller.current?.stop(), []),
    newTopic: useCallback(() => controller.current?.newTopic(), []),
    speak: useCallback((text: string, id?: string) => controller.current?.speak(text, id), []),
    endFromText: useCallback((text: string) => controller.current?.endFromText(text) ?? false, []),
    refreshMicrophone: useCallback(() => controller.current?.refreshMicrophone(), []),
  };
}
