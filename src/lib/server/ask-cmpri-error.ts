import "server-only";
import { randomUUID } from "node:crypto";
import { APICallError, RetryError } from "ai";
import type { AskLanguage } from "@/lib/ask-cmpri/types";

export type AskFailurePhase = "native-load" | "native-generate" | "native-response" | "legacy";
type Category = "ai_request_rejected" | "ai_configuration" | "ai_quota" | "ai_connection" | "timeout" | "cancelled" | "ai_response_invalid" | "unexpected";
type Classification = { category: Category; errorName: string; providerStatus?: number; providerReason?: string };

const safeNames = new Set([
  "AI_APICallError", "AI_RetryError", "AI_LoadAPIKeyError", "AI_LoadSettingError", "AI_NoSuchModelError",
  "AI_UnsupportedFunctionalityError", "AI_UnsupportedModelVersionError", "AI_InvalidArgumentError",
  "AI_InvalidPromptError", "AI_InvalidResponseDataError", "AI_TypeValidationError", "AI_JSONParseError",
  "AI_NoOutputGeneratedError", "AI_NoObjectGeneratedError", "AI_NoContentGeneratedError", "AI_EmptyResponseBodyError",
  "AbortError", "TimeoutError", "Error", "TypeError", "ReferenceError", "SyntaxError",
]);
const credentialReasons = new Set([
  "API_KEY_INVALID", "API_KEY_EXPIRED", "API_KEY_SERVICE_BLOCKED", "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_ANDROID_APP_BLOCKED", "API_KEY_IOS_APP_BLOCKED",
  "SERVICE_DISABLED", "BILLING_DISABLED", "CONSUMER_INVALID", "UNAUTHENTICATED", "PERMISSION_DENIED",
]);
const quotaReasons = new Set(["RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED", "RESOURCE_EXHAUSTED"]);
const safeReasons = new Set([...credentialReasons, ...quotaReasons, "INVALID_ARGUMENT", "FAILED_PRECONDITION",
  "OUT_OF_RANGE", "NOT_FOUND", "DEADLINE_EXCEEDED", "UNAVAILABLE", "INTERNAL", "UNKNOWN"]);
const timeoutCodes = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const connectionCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);

function property(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
function allowed(value: unknown, choices: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && choices.has(value) ? value : undefined;
}

/** Read only fixed diagnostic fields. Never stringify the error or its provider payload. */
export function classifyAskFailure(error: unknown): Classification {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 4 && !chain.includes(current); depth++) {
    chain.push(current);
    current = RetryError.isInstance(current) ? property(current, "lastError") : property(current, "cause");
  }
  const api = chain.find(value => APICallError.isInstance(value));
  const errorName = allowed(property(api || error, "name"), safeNames) || "UnknownError";
  const rawStatus = property(api, "statusCode");
  const providerStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const providerError = property(property(api, "data"), "error");
  const details = property(providerError, "details");
  const detailedReason = Array.isArray(details) ? details.slice(0, 10).flatMap(detail =>
    property(detail, "@type") === "type.googleapis.com/google.rpc.ErrorInfo"
      ? allowed(property(detail, "reason"), safeReasons) || [] : [])[0] : undefined;
  const providerReason = detailedReason || allowed(property(providerError, "status"), safeReasons);
  const diagnostics = { errorName, ...(providerStatus !== undefined ? { providerStatus } : {}), ...(providerReason ? { providerReason } : {}) };
  const names = chain.map(value => allowed(property(value, "name"), safeNames));
  const codes = chain.map(value => property(value, "code"));
  let category: Category = "unexpected";
  if (names.includes("TimeoutError") || codes.some(code => allowed(code, timeoutCodes))
    || providerStatus === 408 || providerStatus === 504 || providerReason === "DEADLINE_EXCEEDED") category = "timeout";
  else if (names.includes("AbortError")) category = "cancelled";
  else if (providerStatus === 429 || providerReason && quotaReasons.has(providerReason)) category = "ai_quota";
  else if (providerStatus === 401 || providerStatus === 403 || providerStatus === 404 || providerReason && credentialReasons.has(providerReason)
    || names.some(name => ["AI_LoadAPIKeyError", "AI_LoadSettingError", "AI_NoSuchModelError"].includes(name || ""))) category = "ai_configuration";
  else if (providerStatus === 400 || providerStatus === 422
    || names.some(name => ["AI_UnsupportedFunctionalityError", "AI_UnsupportedModelVersionError", "AI_InvalidArgumentError", "AI_InvalidPromptError"].includes(name || ""))) category = "ai_request_rejected";
  else if (names.some(name => ["AI_InvalidResponseDataError", "AI_TypeValidationError", "AI_JSONParseError", "AI_NoOutputGeneratedError",
    "AI_NoObjectGeneratedError", "AI_NoContentGeneratedError", "AI_EmptyResponseBodyError"].includes(name || ""))
    || api && providerStatus !== undefined && providerStatus < 400) category = "ai_response_invalid";
  else if (api || codes.some(code => allowed(code, connectionCodes))) category = "ai_connection";
  return { category, ...diagnostics };
}

const messages: Record<Category, { status: number; en: string; es: string }> = {
  ai_request_rejected: { status: 502, en: "Ask CMPRI’s AI request could not be processed.", es: "Ask CMPRI no pudo procesar la solicitud de IA." },
  ai_configuration: { status: 503, en: "Ask CMPRI’s AI service configuration needs attention.", es: "La configuración del servicio de IA de Ask CMPRI necesita revisión." },
  ai_quota: { status: 429, en: "Ask CMPRI’s AI service is at its usage limit. Try again later.", es: "El servicio de IA de Ask CMPRI alcanzó su límite de uso. Inténtalo más tarde." },
  ai_connection: { status: 503, en: "Ask CMPRI’s AI service is unavailable. Try again shortly.", es: "El servicio de IA de Ask CMPRI no está disponible. Inténtalo dentro de unos momentos." },
  timeout: { status: 504, en: "Ask CMPRI took too long to respond. Try again.", es: "Ask CMPRI tardó demasiado en responder. Inténtalo de nuevo." },
  cancelled: { status: 499, en: "The Ask CMPRI request was cancelled.", es: "Se canceló la solicitud de Ask CMPRI." },
  ai_response_invalid: { status: 502, en: "Ask CMPRI received an unreadable AI response. Try again.", es: "Ask CMPRI recibió una respuesta de IA que no pudo procesar. Inténtalo de nuevo." },
  unexpected: { status: 500, en: "Ask CMPRI could not complete the request.", es: "Ask CMPRI no pudo completar la solicitud." },
};

export function reportAskFailure(error: unknown, options: { language: AskLanguage; phase: AskFailurePhase }) {
  const failure = classifyAskFailure(error);
  const requestId = randomUUID();
  const phase = ["native-load", "native-generate", "native-response", "legacy"].includes(options.phase) ? options.phase : "unknown";
  // Provider errors contain prompts, URLs, headers and full response bodies.
  // Only this newly constructed allowlisted object may reach application logs.
  console.error("ask_cmpri_failure", { requestId, phase, ...failure });
  const message = messages[failure.category];
  const language = options.language === "es" ? "es" : "en";
  return { status: message.status, headers: { "X-CMPRI-Request-ID": requestId },
    body: { error: `${message[language]} ${language === "es" ? "Referencia" : "Reference"}: ${requestId}.`, code: failure.category, requestId } };
}
