import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ASK_GEMINI_VOICES } from "@/lib/ask-cmpri/voices";
import { askGeminiKey } from "@/lib/server/ask-cmpri-gemini";
import { requireUserAttempt } from "@/lib/server/auth";
import { isRecognizedChiefEngineer } from "@/lib/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const inputSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  voice: z.enum(ASK_GEMINI_VOICES),
  language: z.enum(["en", "es"]).default("en"),
}).strict();

async function inputBody(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let bytes = 0;
  let raw = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32_000) { await reader.cancel(); return null; }
      raw += decoder.decode(value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode()) as unknown;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp) return NextResponse.json({ error: "Sign in to use Ask CMPRI." }, { status: 401, headers });
  if (!isRecognizedChiefEngineer(auth.principal.profile)) return NextResponse.json({ error: "Ask CMPRI is available only to the Chief Engineer." }, { status: 403, headers });
  const input = inputSchema.safeParse(await inputBody(request));
  if (!input.success) return NextResponse.json({ error: "Send reply text and a supported Gemini voice." }, { status: 400, headers });
  const { text, voice, language } = input.data;
  const es = language === "es";
  const apiKey = askGeminiKey();
  if (!apiKey) return NextResponse.json({ error: es ? "La voz de Gemini no está configurada en este entorno." : "Gemini voice is not configured for this environment." }, { status: 503, headers });

  try {
    // Gemini 3.8 TTS returns a WAV file; this call is made only during a user-started call.
    // https://ai.google.dev/gemini-api/docs/speech-generation#single-speaker
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(22_000)]),
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: process.env.CMPRI_GEMINI_SPEECH_MODEL?.trim() || "gemini-3.8-flash-lite-tts",
        store: false,
        input: [{ type: "user_input", content: [{ type: "text", text }] }],
        response_format: { type: "audio", mime_type: "audio/wav" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });
    if (!response.ok) throw new Error("Gemini speech unavailable");
    const result = await response.json() as { steps?: { type?: string; content?: { type?: string; data?: string }[] }[] };
    const encoded = result.steps?.filter(step => step.type === "model_output")
      .flatMap(step => step.content || []).filter(part => part.type === "audio").at(-1)?.data;
    if (typeof encoded !== "string" || !encoded.length || encoded.length > 22_000_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new Error("Gemini speech missing");
    const audio = Buffer.from(encoded, "base64");
    if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") throw new Error("Gemini speech format unavailable");
    return new NextResponse(new Uint8Array(audio), { headers: { ...headers, "Content-Type": "audio/wav", "Content-Length": String(audio.length) } });
  } catch {
    return NextResponse.json({ error: es ? "No se pudo reproducir la voz de Gemini. La respuesta está disponible como texto." : "Gemini voice could not play this reply. The reply is available as text." }, { status: 502, headers });
  }
}
