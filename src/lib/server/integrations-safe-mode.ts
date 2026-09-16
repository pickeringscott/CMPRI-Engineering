export type SafeModeBlockedResult = {
  ok: true;
  safeMode: true;
  blocked: true;
  blockedAction: string;
  message: string;
};

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
