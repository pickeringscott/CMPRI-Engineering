/** Local Weather-preview sound only. No notification permissions or remote delivery. */
export type WeatherWarningSoundResult = "played" | "duplicate" | "blocked" | "unavailable" | "canceled";
const SOURCE = "/previews/weather/warning-siren.mp3";
let context: AudioContext | null = null;
let decoded: AudioBuffer | null = null;
let loading: Promise<AudioBuffer | null> | null = null;
let generation = 0;
let playing: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
const played = new Set<string>();
const pending = new Set<string>();

function audioContext() {
  if (context && context.state !== "closed") return context;
  if (typeof window === "undefined") return null;
  const Constructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return null;
  try { context = new Constructor(); return context; } catch { return null; }
}
function load(ctx: AudioContext) {
  if (decoded) return Promise.resolve(decoded);
  if (loading) return loading;
  loading = (async () => {
    try {
      const response = await fetch(SOURCE, { credentials: "same-origin", cache: "force-cache" });
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) return null;
      decoded = await ctx.decodeAudioData(bytes); return decoded;
    } catch { return null; }
    finally { loading = null; }
  })();
  return loading;
}

// Call directly from the genuine Weather launcher/retry click. Creation and
// resume happen synchronously before any fetch/decode await can lose activation.
export function armWeatherWarningSound(): Promise<boolean> {
  const ctx = audioContext();
  if (!ctx) return Promise.resolve(false);
  let resumed: Promise<void>;
  try { resumed = ctx.state === "running" ? Promise.resolve() : ctx.resume(); }
  catch { return Promise.resolve(false); }
  const buffer = load(ctx);
  return Promise.all([resumed, buffer]).then(([, value]) => ctx.state === "running" && Boolean(value)).catch(() => false);
}

export function stopWeatherWarningSound(): void {
  generation++;
  const current = playing; playing = null;
  if (!current || !context) return;
  if (context.state !== "running") {
    try { current.source.stop(); current.source.disconnect(); current.gain.disconnect(); } catch { /* Already ended. */ }
    return;
  }
  const now = context.currentTime;
  try {
    current.gain.gain.cancelScheduledValues(now);
    current.gain.gain.setValueAtTime(current.gain.gain.value, now);
    current.gain.gain.linearRampToValueAtTime(0, now + .12);
    current.source.stop(now + .14);
  } catch { try { current.source.stop(); } catch { /* Already ended. */ } }
}

export async function playWeatherWarningSound(key: string): Promise<WeatherWarningSoundResult> {
  if (!key || key.length > 2400) return "unavailable";
  if (played.has(key) || pending.has(key)) return "duplicate";
  const ctx = audioContext();
  if (!ctx) return "unavailable";
  if (ctx.state !== "running") return "blocked";
  stopWeatherWarningSound();
  const ticket = generation;
  pending.add(key);
  try {
    const buffer = await load(ctx);
    if (ticket !== generation) return "canceled";
    if (!buffer) return "unavailable";
    if (ctx.state !== "running") return "blocked";
    const source = ctx.createBufferSource(), gain = ctx.createGain();
    source.buffer = buffer; gain.gain.value = 1;
    source.connect(gain); gain.connect(ctx.destination);
    const current = { source, gain }; playing = current;
    source.onended = () => { source.disconnect(); gain.disconnect(); if (playing === current) playing = null; };
    source.start(); played.add(key);
    while (played.size > 1000) played.delete(played.values().next().value!);
    return "played";
  } catch { return "unavailable"; }
  finally { pending.delete(key); }
}
