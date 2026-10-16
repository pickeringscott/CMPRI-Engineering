import "server-only";
import { configuredEmailProvider } from "../integrations/email-provider";
import { isIntegrationsSafeMode } from "./integrations-safe-mode";

// Observations only: never normalize credentials or infer their validity/type.
function credentialShape(value: string | undefined) {
  const text = value ?? "";
  const trimmed = text.trim();
  let jsonWrapped = false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    jsonWrapped = typeof parsed === "string" || (parsed !== null && typeof parsed === "object");
  } catch { /* Not JSON; do not return parser errors or input. */ }
  return {
    quoteWrapped: trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))),
    jsonWrapped,
    hasEdgeWhitespace: text !== trimmed,
    hasInternalWhitespace: /\s/u.test(trimmed),
    hasControlCharacters: /[\u0000-\u001f\u007f-\u009f]/u.test(text),
    hasLiteralEscapedNewline: /\\[nr]/u.test(text),
  };
}

// Read on every request, in the runtime that would execute the mailbox scan.
// Only the explicitly public OAuth client identifier may be returned, after format validation.
// Never return client secrets, tokens, or arbitrary environment entries.
export function emailDiagnostics() {
  let provider: "gmail" | "microsoft365" | "unset" | "invalid";
  try {
    provider = configuredEmailProvider() ?? "unset";
  } catch {
    provider = "invalid";
  }
  const identity = (value: string | undefined, pattern: RegExp) =>
    value && pattern.test(value) ? value : null;
  const clientSecret = process.env.CMPRI_GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.CMPRI_GMAIL_REFRESH_TOKEN;
  // Local dry run only. This does not attest to a request sent to Google.
  const form = new URLSearchParams({
    client_id: process.env.CMPRI_GMAIL_CLIENT_ID ?? "",
    client_secret: clientSecret ?? "",
    grant_type: "refresh_token",
    refresh_token: refreshToken ?? "",
  });
  const decoded = new URLSearchParams(form.toString());
  const matches = (key: string, value: string | undefined) =>
    typeof value === "string" && decoded.getAll(key).length === 1 && decoded.get(key) === value;
  return {
    gmail_credential_shape: {
      client_secret: credentialShape(clientSecret),
      refresh_token: credentialShape(refreshToken),
      dryRunClientSecretSerializationMatchesRuntime: matches("client_secret", clientSecret),
      dryRunRefreshTokenSerializationMatchesRuntime: matches("refresh_token", refreshToken),
    },
    deployment: {
      id: identity(process.env.VERCEL_DEPLOYMENT_ID, /^dpl_[a-zA-Z0-9]+$/),
      url: identity(process.env.VERCEL_URL, /^[a-zA-Z0-9-]+\.vercel\.app$/),
      commit: identity(process.env.VERCEL_GIT_COMMIT_SHA, /^[a-fA-F0-9]{40}$/),
      environment: identity(process.env.VERCEL_ENV, /^(production|preview|development)$/),
    },
    provider,
    gmail_public_client_id: identity(process.env.CMPRI_GMAIL_CLIENT_ID, /^[0-9]{6,30}-[a-z0-9]{10,100}\.apps\.googleusercontent\.com$/),
    configuration_present: {
      CMPRI_EMAIL_PROVIDER: Boolean(process.env.CMPRI_EMAIL_PROVIDER),
      CMPRI_GMAIL_CLIENT_ID: Boolean(process.env.CMPRI_GMAIL_CLIENT_ID),
      CMPRI_GMAIL_CLIENT_SECRET: Boolean(process.env.CMPRI_GMAIL_CLIENT_SECRET),
      CMPRI_GMAIL_REFRESH_TOKEN: Boolean(process.env.CMPRI_GMAIL_REFRESH_TOKEN),
      CMPRI_GMAIL_ADDRESS: Boolean(process.env.CMPRI_GMAIL_ADDRESS),
      CMPRI_MS_TENANT_ID: Boolean(process.env.CMPRI_MS_TENANT_ID),
      CMPRI_MS_CLIENT_ID: Boolean(process.env.CMPRI_MS_CLIENT_ID),
      CMPRI_MS_CLIENT_SECRET: Boolean(process.env.CMPRI_MS_CLIENT_SECRET),
      CMPRI_MS_MAILBOX: Boolean(process.env.CMPRI_MS_MAILBOX),
    },
    safe_mode: isIntegrationsSafeMode(),
  };
}
