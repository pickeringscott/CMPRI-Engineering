// Gemini's prebuilt voices: https://ai.google.dev/gemini-api/docs/speech-generation#voices
export const ASK_GEMINI_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe",
  "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux",
  "Iapetus", "Kore", "Laomedeia", "Leda", "Orus", "Pulcherrima", "Puck",
  "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat", "Umbriel",
  "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;

export type AskGeminiVoice = typeof ASK_GEMINI_VOICES[number];
export const DEFAULT_ASK_GEMINI_VOICE: AskGeminiVoice = "Kore";

export function askGeminiVoice(value: unknown): AskGeminiVoice {
  return typeof value === "string" && ASK_GEMINI_VOICES.includes(value as AskGeminiVoice)
    ? value as AskGeminiVoice : DEFAULT_ASK_GEMINI_VOICE;
}

// Native Realtime voices; Gemini names belong only to the legacy speech endpoint.
// https://developers.openai.com/api/docs/guides/realtime-conversations#voice-options
export const ASK_OPENAI_VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse",
] as const;

export type AskOpenAIVoice = typeof ASK_OPENAI_VOICES[number];
export const DEFAULT_ASK_OPENAI_VOICE: AskOpenAIVoice = "marin";

// Perceived sound, not a provider-declared identity. Alloy is neutral/balanced;
// presentation can vary with speech instructions. First-hand listening sources:
// https://woodstitch.com/text-to-speech/voices/openai--marin (also cedar/coral)
// https://vocalingo.featurebase.app/en/help/articles/8601932-standard-voices-vs-openai-voices
// https://community.openai.com/t/feedback-on-voice-models-customization/1272619
const OPENAI_VOICE_SOUND = {
  alloy: "neutral", ash: "male", ballad: "male", cedar: "male", coral: "female",
  echo: "male", marin: "female", sage: "female", shimmer: "female", verse: "male",
} as const satisfies Record<AskOpenAIVoice, "male" | "female" | "neutral">;

export function askOpenAIVoiceLabel(voice: AskOpenAIVoice, language = "en"): string {
  const labels = /^es(?:-|$)/i.test(language)
    ? { male: "Masculina", female: "Femenina", neutral: "Neutra" }
    : { male: "Male", female: "Female", neutral: "Neutral" };
  return `${voice} · ${labels[OPENAI_VOICE_SOUND[voice]]}`;
}

export function askOpenAIVoice(value: unknown): AskOpenAIVoice {
  return typeof value === "string" && ASK_OPENAI_VOICES.includes(value as AskOpenAIVoice)
    ? value as AskOpenAIVoice : DEFAULT_ASK_OPENAI_VOICE;
}
