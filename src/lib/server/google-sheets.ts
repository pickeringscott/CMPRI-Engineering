import "server-only";
import { createHash, createSign } from "node:crypto";
import { IntegrationConfigurationError } from "@/lib/server/integrations-safe-mode";

type GoogleServiceAccount = { client_email?: unknown; private_key?: unknown };

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
let cachedToken: { accessToken: string; expiresAt: number; keyFingerprint: string } | null = null;

function serviceAccount() {
  const serviceAccountJson = process.env.CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON?.trim();
  if (!serviceAccountJson) {
    throw new IntegrationConfigurationError("Google Sheets is missing the server deployment setting CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON.");
  }

  let credentials: GoogleServiceAccount;
  try {
    credentials = JSON.parse(serviceAccountJson) as GoogleServiceAccount;
  } catch {
    throw new Error("CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON must contain a valid Google service-account JSON object.");
  }
  if (typeof credentials.client_email !== "string" || !credentials.client_email.trim()
    || typeof credentials.private_key !== "string" || !credentials.private_key.trim()) {
    throw new Error("CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON must include client_email and private_key.");
  }
  const privateKey = credentials.private_key.replace(/\\n/g, "\n");
  return {
    clientEmail: credentials.client_email.trim(),
    privateKey,
    keyFingerprint: createHash("sha256").update(`${credentials.client_email}:${privateKey}`).digest("hex"),
  };
}

function encodeBase64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

async function googleAccessToken() {
  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.keyFingerprint === account.keyFingerprint && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const claims = {
    iss: account.clientEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsignedToken = `${encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encodeBase64Url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256")
    .update(unsignedToken)
    .sign(account.privateKey, "base64url");
  const assertion = `${unsignedToken}.${signature}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown };
  if (!response.ok || typeof result.access_token !== "string" || !result.access_token) {
    throw new Error(`Google service-account authentication failed (${response.status}). Check the configured service-account credentials and enabled Google Sheets API.`);
  }
  const expiresIn = typeof result.expires_in === "number" && Number.isFinite(result.expires_in) ? result.expires_in : 3600;
  cachedToken = { accessToken: result.access_token, expiresAt: now + expiresIn, keyFingerprint: account.keyFingerprint };
  return result.access_token;
}

export async function googleSheetsRequest<T>(
  spreadsheetId: string,
  path: string,
  init: RequestInit = {},
  integration = "Google Sheets",
): Promise<T> {
  const accessToken = await googleAccessToken();
  const response = await fetch(`${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(`Google Sheets denied ${integration} access. Share the private spreadsheet with the configured service-account email as an Editor and ensure the Google Sheets API is enabled.`);
    }
    if (response.status === 404) {
      throw new Error(`Google Sheets could not find the configured ${integration} spreadsheet or tab.`);
    }
    throw new Error(`Google Sheets request for ${integration} failed (${response.status}).`);
  }
  return await response.json() as T;
}
