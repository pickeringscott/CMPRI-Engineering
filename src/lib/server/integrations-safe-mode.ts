export type SafeModeBlockedResult = {
  ok: true;
  safeMode: true;
  blocked: true;
  blockedAction: string;
  message: string;
};

export class IntegrationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationConfigurationError";
  }
}

export function requireIntegrationConfig(
  integration: string,
  urlValue: string | undefined,
  apiKeyValue: string | undefined,
  urlVariable: string,
  keyVariable: string,
) {
  const url = urlValue?.trim();
  const apiKey = apiKeyValue?.trim();
  const missing = [!url && urlVariable, !apiKey && keyVariable].filter(Boolean);
  if (missing.length) {
    throw new IntegrationConfigurationError(`${integration} integration is missing deployment settings: ${missing.join(", ")}.`);
  }
  return { url: url as string, apiKey: apiKey as string };
}

export function integrationErrorStatus(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "IntegrationConfigurationError"
    ? 503
    : 502;
}

export function isIntegrationsSafeMode() {
  return String(process.env.CMPRI_INTEGRATIONS_SAFE_MODE ?? "true").trim().toLowerCase() !== "false";
}

export function safeModeBlocked(integration: "Room Ranker" | "Corporate PM", action: string): SafeModeBlockedResult {
  return {
    ok: true,
    safeMode: true,
    blocked: true,
    blockedAction: action,
    message: `Safe mode is on: this ${action} was NOT sent to ${integration}.`,
  };
}
