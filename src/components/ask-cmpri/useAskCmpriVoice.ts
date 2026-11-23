"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AskCmpriMicrophoneState = "checking" | "ready" | "permission" | "blocked" | "missing" | "unsupported";

export interface AskCmpriMicrophoneStatus {
  state: AskCmpriMicrophoneState;
  text: string;
}

export interface AskCmpriVoiceOptions {
  onTranscript: (text: string) => void;
  onEnd?: () => void;
  locale?: string;
  enabled?: boolean;
}

interface VoiceState {
  active: boolean;
  draft: string;
  status: string;
  typingFallback: boolean;
  microphone: AskCmpriMicrophoneStatus;
}

interface RecognitionResult {
  isFinal: boolean;
  0?: { transcript: string };
}

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface BrowserRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}

type RecognitionConstructor = new () => BrowserRecognition;

type VoiceListener = (state: VoiceState) => void;

const MICROPHONE_TEXT = {
  en: {
    checking: "Checking microphone…",
    ready: "Microphone ready",
    permission: "Microphone permission needed — click to allow",
    blocked: "Microphone access is blocked in your browser",
    missing: "No microphone detected",
    unsupported: "Voice input is unavailable in this browser",
  },
  es: {
    checking: "Comprobando el micrófono…",
    ready: "Micrófono listo",
    permission: "Se necesita permiso para el micrófono. Selecciona el botón para permitirlo.",
    blocked: "Tu navegador bloqueó el acceso al micrófono",
    missing: "No se detectó ningún micrófono",
    unsupported: "La entrada de voz no está disponible en este navegador",
  },
} satisfies Record<string, Record<AskCmpriMicrophoneState, string>>;

const VOICE_TEXT = {
  en: {
    listen: "Listening. Say “goodbye” to end the call.",
    type: "Type your question to continue.",
    starting: "Starting browser dictation…",
    permission: "Requesting microphone access…",
    microphoneError: "Microphone access could not start.",
    recognitionError: "Browser dictation could not start.",
    recognitionEnded: "Browser dictation ended before detecting speech.",
    ended: "Voice call ended.",
    topic: "New voice topic.",
  },
  es: {
    listen: "Escuchando. Di «adiós» para finalizar la llamada.",
    type: "Escribe tu pregunta para continuar.",
    starting: "Iniciando el dictado del navegador…",
    permission: "Solicitando acceso al micrófono…",
    microphoneError: "No se pudo acceder al micrófono.",
    recognitionError: "No se pudo iniciar el dictado del navegador.",
    recognitionEnded: "El dictado del navegador terminó antes de detectar voz.",
    ended: "Llamada de voz finalizada.",
    topic: "Nuevo tema de voz.",
  },
};

const TURN_PAUSE_MS = 520;
const RESTART_PAUSE_MS = 180;

function languageFor(locale?: string) {
  return /^es(?:-|$)/i.test(locale ?? "") ? "es" : "en";
}

function initialState(locale?: string): VoiceState {
  return {
    active: false,
    draft: "",
    status: "",
    typingFallback: false,
    microphone: { state: "checking", text: MICROPHONE_TEXT[languageFor(locale)].checking },
  };
}

function endsCall(text: string) {
  const words = text.trim().replace(/^[¡¿]+|[.!?,;]+$/g, "");
  return /^(?:(?:ok(?:ay)?|thanks|thank you|gracias)[, ]+)?(?:good[\s-]*bye|adi[oó]s|hasta luego)$/i.test(words);
}

function punctuate(text: string) {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function createVoiceController({ onTranscript, onEnd, locale }: AskCmpriVoiceOptions, publish: VoiceListener) {
  const speechWindow = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  const media = navigator.mediaDevices;
  const supported = Recognition && window.isSecureContext !== false ? Recognition : null;
  const speechLocale = locale || navigator.language || "en-US";
  const language = languageFor(speechLocale);
  const text = VOICE_TEXT[language];
  const events = new AbortController();
  let state = initialState(speechLocale);
  let disposed = false;
  let generation = 0;
  let permission: PermissionStatus | undefined;
  let micFinding: AskCmpriMicrophoneState | undefined;
  let micProbe: Promise<AskCmpriMicrophoneStatus> | null = null;
  let micRequest: Promise<boolean> | null = null;
  let run: { recognition: BrowserRecognition; started: number; processed: Set<number> } | null = null;
  let restartTimer: number | undefined;
  let turnTimer: number | undefined;
  let finalSegments: string[] = [];
  let shortRuns = 0;
  let spokenUtterance: SpeechSynthesisUtterance | null = null;

  function update(next: Partial<VoiceState>) {
    state = { ...state, ...next };
    if (!disposed) publish(state);
  }

  function setMicrophone(value: AskCmpriMicrophoneState) {
    const microphone = { state: value, text: MICROPHONE_TEXT[language][value] };
    update({ microphone });
    return microphone;
  }

  function permissionChanged() {
    if (permission?.state !== "granted") micFinding = undefined;
    void refreshMicrophone();
  }

  function refreshMicrophone() {
    if (!supported) return Promise.resolve(setMicrophone("unsupported"));
    if (micProbe) return micProbe;
    micProbe = (async () => {
      try {
        const newPermission = await navigator.permissions?.query({ name: "microphone" });
        if (newPermission !== permission && !disposed) {
          permission?.removeEventListener("change", permissionChanged);
          permission = newPermission;
          permission?.addEventListener("change", permissionChanged, { signal: events.signal });
        }
      } catch {
        // Some browsers only report microphone permission after a user gesture.
      }
      const documentWithPolicy = document as Document & {
        permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
        featurePolicy?: { allowsFeature: (feature: string) => boolean };
      };
      const policy = documentWithPolicy.permissionsPolicy ?? documentWithPolicy.featurePolicy;
      if (permission?.state === "denied" || policy?.allowsFeature("microphone") === false) return setMicrophone("blocked");
      try {
        const devices = await media?.enumerateDevices();
        if ((devices?.length || permission?.state === "granted") && devices?.every((device) => device.kind !== "audioinput")) {
          return setMicrophone("missing");
        }
      } catch {
        // A direct gesture can still request an audio input.
      }
      if (permission?.state === "granted") return setMicrophone("ready");
      return setMicrophone(micFinding ?? "permission");
    })().finally(() => { micProbe = null; });
    return micProbe;
  }

  function requestMicrophone() {
    if (micRequest) return micRequest;
    micRequest = (async () => {
      try {
        const stream = await media.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        micFinding = "ready";
        setMicrophone(micFinding);
        return true;
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "NotFoundError" || name === "DevicesNotFoundError") micFinding = "missing";
        if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(name)) micFinding = "blocked";
        if (micFinding) setMicrophone(micFinding);
        return false;
      }
    })().finally(() => { micRequest = null; });
    return micRequest;
  }

  function clearTurn() {
    window.clearTimeout(turnTimer);
    turnTimer = undefined;
    finalSegments = [];
    if (state.draft) update({ draft: "" });
  }

  function submitTurn() {
    const transcript = finalSegments.join(" ").trim();
    clearTurn();
    if (state.active && transcript) onTranscript(transcript);
  }

  function closeRecognition() {
    window.clearTimeout(restartTimer);
    restartTimer = undefined;
    if (!run) return;
    const { recognition } = run;
    run = null;
    recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // The browser may already have ended this recognition session.
    }
  }

  function fallback(reason: string) {
    closeRecognition();
    clearTurn();
    update({ typingFallback: true, status: `${punctuate(reason)} ${text.type}` });
  }

  function scheduleRecognition() {
    if (!state.active || state.typingFallback || spokenUtterance) return;
    window.clearTimeout(restartTimer);
    restartTimer = window.setTimeout(launchRecognition, RESTART_PAUSE_MS);
  }

  function launchRecognition() {
    restartTimer = undefined;
    if (!state.active || state.typingFallback || run || micRequest || spokenUtterance || !supported) return;
    try {
      const recognition = new supported();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = speechLocale;
      const current = { recognition, started: Date.now(), processed: new Set<number>() };
      run = current;

      recognition.onstart = () => {
        if (run !== current) return;
        micFinding = "ready";
        setMicrophone(micFinding);
        update({ status: text.listen });
      };
      recognition.onresult = (event) => {
        if (run !== current) return;
        const interim: string[] = [];
        let receivedFinal = false;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const segment = result[0]?.transcript.trim();
          if (!segment) continue;
          if (!result.isFinal) {
            interim.push(segment);
            continue;
          }
          if (current.processed.has(index)) continue;
          current.processed.add(index);
          if (endsCall(segment)) {
            submitTurn();
            stop();
            return;
          }
          receivedFinal = true;
          finalSegments.push(segment);
        }
        update({ draft: [...finalSegments, ...interim].join(" ") });
        if (receivedFinal || (turnTimer !== undefined && interim.length)) {
          window.clearTimeout(turnTimer);
          turnTimer = window.setTimeout(submitTurn, TURN_PAUSE_MS);
        }
      };
      recognition.onerror = ({ error }) => {
        if (run !== current || error === "no-speech" || error === "aborted") return;
        const problem = error === "audio-capture" ? "missing" :
          ["not-allowed", "service-not-allowed"].includes(error) ? "blocked" : undefined;
        if (problem) {
          micFinding = problem;
          setMicrophone(problem);
        }
        fallback(problem ? state.microphone.text : text.recognitionError);
      };
      recognition.onend = () => {
        if (run !== current) return;
        run = null;
        submitTurn();
        if (!state.active || spokenUtterance) return;
        shortRuns = Date.now() - current.started < 1000 && !current.processed.size ? shortRuns + 1 : 0;
        if (shortRuns >= 3) fallback(text.recognitionEnded);
        else scheduleRecognition();
      };
      recognition.start();
    } catch {
      fallback(text.recognitionError);
    }
  }

  function start() {
    if (disposed || state.active) return;
    const started = ++generation;
    shortRuns = 0;
    update({ active: true, status: text.starting, typingFallback: false });
    if (!supported) {
      fallback(setMicrophone("unsupported").text);
      return;
    }
    const canRequest = typeof media?.getUserMedia === "function";
    const blocked = state.microphone.state === "blocked" && (permission?.state === "denied" || !canRequest);
    if (blocked || state.microphone.state === "missing") {
      fallback(state.microphone.text);
      return;
    }
    if (state.microphone.state !== "ready" && canRequest) {
      update({ status: text.permission });
      void requestMicrophone().then((granted) => {
        if (!state.active || generation !== started || disposed) return;
        if (!granted) {
          const knownFailure = state.microphone.state === "blocked" || state.microphone.state === "missing";
          fallback(knownFailure ? state.microphone.text : text.microphoneError);
          return;
        }
        update({ status: text.starting });
        launchRecognition();
      });
    } else {
      launchRecognition();
    }
  }

  function cancelSpeech() {
    if (!spokenUtterance) return;
    spokenUtterance.onend = spokenUtterance.onerror = null;
    spokenUtterance = null;
    speechWindow.speechSynthesis.cancel();
  }

  function stop() {
    if (!state.active) return;
    generation += 1;
    closeRecognition();
    cancelSpeech();
    clearTurn();
    update({ active: false, status: text.ended, typingFallback: false });
    if (!disposed) onEnd?.();
  }

  function newTopic() {
    if (!state.active) return;
    clearTurn();
    cancelSpeech();
    closeRecognition();
    shortRuns = 0;
    update({ status: `${text.topic} ${state.typingFallback ? text.type : text.listen}` });
    scheduleRecognition();
  }

  function endFromText(transcript: string) {
    if (!state.active || !endsCall(transcript)) return false;
    stop();
    return true;
  }

  function speak(answer: string) {
    if (!state.active || !answer.trim() || !speechWindow.speechSynthesis || typeof SpeechSynthesisUtterance !== "function") return;
    cancelSpeech();
    closeRecognition();
    clearTurn();
    const utterance = new SpeechSynthesisUtterance(answer);
    utterance.lang = speechLocale;
    spokenUtterance = utterance;
    const resume = () => {
      if (spokenUtterance !== utterance) return;
      spokenUtterance = null;
      scheduleRecognition();
    };
    utterance.onend = utterance.onerror = resume;
    try {
      speechWindow.speechSynthesis.speak(utterance);
    } catch {
      resume();
    }
  }

  media?.addEventListener?.("devicechange", () => {
    if (micFinding === "missing") micFinding = undefined;
    void refreshMicrophone();
  }, { signal: events.signal });
  window.addEventListener("pagehide", stop, { signal: events.signal });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !state.active) return;
    event.preventDefault();
    stop();
  }, { signal: events.signal });

  function dispose() {
    disposed = true;
    events.abort();
    stop();
  }

  return { start, stop, newTopic, endFromText, speak, refreshMicrophone, dispose };
}

export function useAskCmpriVoice(options: AskCmpriVoiceOptions) {
  const { locale, enabled = true } = options;
  const callbacks = useRef(options);
  const controller = useRef<ReturnType<typeof createVoiceController> | null>(null);
  const [state, setState] = useState(() => initialState(locale));

  useEffect(() => { callbacks.current = options; }, [options]);
  useEffect(() => {
    if (!enabled) return;
    const current = createVoiceController({
      locale,
      onTranscript: (text) => callbacks.current.onTranscript(text),
      onEnd: () => callbacks.current.onEnd?.(),
    }, setState);
    controller.current = current;
    // The first status probe runs after the mounted controls can report its result.
    queueMicrotask(() => {
      if (controller.current !== current) return;
      setState(initialState(locale));
      void current.refreshMicrophone();
    });
    return () => {
      controller.current = null;
      current.dispose();
    };
  }, [enabled, locale]);

  return {
    ...(enabled ? state : initialState(locale)),
    start: useCallback(() => controller.current?.start(), []),
    stop: useCallback(() => controller.current?.stop(), []),
    newTopic: useCallback(() => controller.current?.newTopic(), []),
    endFromText: useCallback((text: string) => controller.current?.endFromText(text) ?? false, []),
    speak: useCallback((text: string) => controller.current?.speak(text), []),
    refreshMicrophone: useCallback(() => controller.current?.refreshMicrophone(), []),
  };
}
