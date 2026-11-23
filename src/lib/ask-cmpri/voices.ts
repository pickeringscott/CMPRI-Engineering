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
