import type { AskContext } from "@/lib/ask-cmpri/types";

const maxTurns = 6;
const maxQuestionLength = 1000;
const hidden = (value: string) => value.length >= 10 ? "[redacted]" : "*".repeat(value.length);

/** Preserve operational values verbatim; credential replacements never lengthen a turn. */
export function redactNativeContextText(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]* )?PRIVATE KEY-----/g, "[redacted]")
    .replace(/\b(Bearer|Basic)(\s+)([^\s"'<>]+)/gi, (_match, scheme: string, spacing: string, credential: string) => scheme + spacing + hidden(credential))
    .replace(/(https?:\/\/)([^/\s@]+:[^/\s@]+)(@)/gi, (_match, scheme: string, credential: string, at: string) => scheme + hidden(credential) + at)
    .replace(/([?&](?:access_token|refresh_token|token|api_key|key|client_secret|password)=)([^&#\s"']+)/gi, (_match, label: string, credential: string) => label + hidden(credential))
    .replace(/((?:password|passwd|pwd|api[ _-]?key|(?:access|refresh|auth|bearer|session)[ _-]?token|client[ _-]?secret)\s+is\s+)([^\r\n,;]+)/gi, (_match, label: string, credential: string) => label + hidden(credential))
    .replace(/((?:["']?)(?:password|passwd|pwd|(?:[a-z]+[ _-]?)?api[ _-]?key|(?:access|refresh|id|auth|bearer|session|reset|invite|verification)[ _-]?token|token|(?:supabase[ _-]?)?(?:service[ _-]?role[ _-]?key|anon[ _-]?key)|(?:client[ _-]?)?secret|private[ _-]?key)(?:["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
      (_match, label: string, credential: string) => label + hidden(credential))
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{30,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]+|cmpri_mcp_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, credential => hidden(credential));
}

/** `previous` must be the context verified for this actor/property by the Ask route. */
export function nativeUserTurns(previous: AskContext | undefined, currentQuestion: string): string[] {
  const prior = previous?.native?.userTurns
    || (previous?.native && previous.question ? [previous.question] : []);
  return [...prior, currentQuestion].filter(turn => typeof turn === "string" && turn.length > 0)
    .slice(-maxTurns).map(turn => redactNativeContextText(turn.slice(0, maxQuestionLength)));
}
