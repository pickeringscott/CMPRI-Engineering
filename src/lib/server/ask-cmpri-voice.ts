import "server-only";
import type { AskOpenAIVoice } from "@/lib/ask-cmpri/voices";

export const DEFAULT_ASK_REALTIME_MODEL = "gpt-realtime-2.1";

export function askCmpriVoiceSession(voice: AskOpenAIVoice, language: "en" | "es") {
  return {
    type: "realtime",
    model: process.env.CMPRI_OPENAI_REALTIME_MODEL?.trim() || DEFAULT_ASK_REALTIME_MODEL,
    output_modalities: ["audio"],
    instructions: [
      "You are the spoken interface for Ask CMPRI at Residence Inn Champaign.",
      "Have a natural, concise conversation. Listen to corrections and follow-up requests. Do not repeat generic acknowledgments or narrate internal work.",
      language === "es" ? "Begin in Spanish; follow the user's requested language." : "Begin in English; follow the user's requested language.",
      "For EVERY CMPRI lookup, current fact, record, workflow, task, or action, call ask_cmpri. This includes all modules, rooms, weather, airport information, and follow-ups to earlier CMPRI requests.",
      "Send the user's complete current request as a self-contained question of at most 1000 characters. Preserve room numbers, identifiers, exact note text, dates, and corrections. Never invent missing details.",
      "The existing Ask CMPRI backend owns data access, role permissions, business rules, and required confirmations. A voice request or tool call does not bypass any of them.",
      "Use only the returned backend result for CMPRI facts and action status. Never claim a change was saved, sent, completed, cancelled, or approved unless that result confirms it.",
      "If the backend requires a confirmation or a choice, explain that actual request, wait for the user's reply, and pass the reply to ask_cmpri. Do not approve or complete the backend action yourself.",
      "If a tool fails, report the failure briefly. Do not fabricate a result, silently retry a change, or turn an error into a success.",
      "Start the tool call without a checking announcement. When its result arrives, give the useful answer briefly and continue listening.",
      "You may handle greetings and ordinary conversational clarifications directly. When the user explicitly says goodbye, hang up, end the call, or an equivalent instruction, call end_call. Do not end the call because of silence, a simple thank-you, or a quoted goodbye.",
      "Ending voice does not prove that any pending backend action was cancelled.",
    ].join("\n"),
    audio: {
      input: {
        transcription: { model: "gpt-4o-mini-transcribe", language },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice },
    },
    tools: [
      {
        type: "function",
        name: "ask_cmpri",
        description: "Send a complete CMPRI question, action request, correction, or reply to a pending backend confirmation to the existing authenticated Ask CMPRI backend. It enforces the signed-in user's permissions.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", minLength: 1, maxLength: 1000, description: "The user's complete current request, preserving exact identifiers and requested text." },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "end_call",
        description: "End this voice connection only when the user explicitly asks to hang up or says goodbye. This does not cancel backend actions.",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ],
    tool_choice: "auto",
  };
}
