import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ASK_OPENAI_VOICES, DEFAULT_ASK_OPENAI_VOICE } from "@/lib/ask-cmpri/voices";
import { requireUserAttempt } from "@/lib/server/auth";
import { askCmpriVoiceSession } from "@/lib/server/ask-cmpri-voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const headers = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const inputSchema = z.object({
  sdp: z.string().min(1).max(65_536).refine(value => /^v=0\r?\n/.test(value) && /(?:^|\r?\n)m=audio /.test(value)),
  voice: z.enum(ASK_OPENAI_VOICES).default(DEFAULT_ASK_OPENAI_VOICE),
  language: z.enum(["en", "es"]).default("en"),
  // The browser seeds these as conversation messages after session.created,
  // never as privileged instructions in the server's session configuration.
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(2000),
  }).strict()).max(12).optional(),
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
      if (bytes > 196_608) { await reader.cancel(); return null; }
      raw += decoder.decode(value, { stream: true });
    }
    return JSON.parse(raw + decoder.decode()) as unknown;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

function callId(location: string | null) {
  if (!location) return undefined;
  try {
    const url = new URL(location, "https://api.openai.com");
    if (url.origin !== "https://api.openai.com") return undefined;
    return /^\/v1\/realtime\/calls\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAttempt(request);
  if (!auth.ok || auth.mcp) {
    return NextResponse.json({ error: "Sign in to use Ask CMPRI." }, { status: 401, headers });
  }
  const input = inputSchema.safeParse(await inputBody(request));
  if (!input.success) {
    return NextResponse.json({ error: "Send a valid voice connection and a supported OpenAI voice." }, { status: 400, headers });
  }
  const { sdp, voice, language } = input.data;
  const es = language === "es";
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: es ? "La voz de OpenAI no está configurada en este entorno." : "OpenAI voice is not configured for this environment." }, { status: 503, headers });
  }

  try {
    // User-started WebRTC negotiation only. No model/key is accepted from the client.
    // https://developers.openai.com/api/docs/guides/voice-webrtc?api=realtime
    const form = new FormData();
    form.set("sdp", sdp);
    form.set("session", JSON.stringify(askCmpriVoiceSession(voice, language)));
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(22_000)]),
      headers: {
        Authorization: "Bearer " + apiKey,
        "OpenAI-Safety-Identifier": createHash("sha256").update(auth.principal.identity.id).digest("hex"),
      },
      body: form,
    });
    if (!response.ok) throw new Error("Voice connection unavailable");
    const answer = await response.text();
    if (answer.length > 65_536 || !/^v=0\r?\n/.test(answer) || !/(?:^|\r?\n)m=audio /.test(answer)) {
      throw new Error("Invalid voice connection");
    }
    return NextResponse.json({ sdp: answer, sessionId: callId(response.headers.get("Location")) }, { headers });
  } catch {
    return NextResponse.json({ error: es ? "No se pudo conectar la voz de OpenAI. Puedes seguir usando el chat." : "OpenAI voice could not connect. You can keep using chat." }, { status: 502, headers });
  }
}
