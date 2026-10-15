import "server-only";
import { configuredEmailProvider } from "../integrations/email-provider";
import { isIntegrationsSafeMode } from "./integrations-safe-mode";

// Read on every request, in the runtime that would execute the mailbox scan.
// Never return arbitrary environment entries or credential-derived metadata.
export function emailDiagnostics() {
  let provider: "gmail" | "microsoft365" | "unset" | "invalid";
  try {
    provider = configuredEmailProvider() ?? "unset";
  } catch {
    provider = "invalid";
  }
  const identity = (value: string | undefined, pattern: RegExp) =>
    value && pattern.test(value) ? value : null;
  return {
    deployment: {
      id: identity(process.env.VERCEL_DEPLOYMENT_ID, /^dpl_[a-zA-Z0-9]+$/),
      url: identity(process.env.VERCEL_URL, /^[a-zA-Z0-9-]+\.vercel\.app$/),
      commit: identity(process.env.VERCEL_GIT_COMMIT_SHA, /^[a-fA-F0-9]{40}$/),
      environment: identity(process.env.VERCEL_ENV, /^(production|preview|development)$/),
    },
    provider,
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
