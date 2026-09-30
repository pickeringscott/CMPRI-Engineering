import "server-only";
import { createHash, createSign } from "node:crypto";
import { IntegrationConfigurationError } from "@/lib/server/integrations-safe-mode";

type CredentialObject = Record<string, unknown>;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
let cachedToken: { accessToken: string; expiresAt: number; keyFingerprint: string } | null = null;

function normalizePrivateKey(value: string) {
  const trimmed = value.trim();
  const unwrapped = (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    ? trimmed.slice(1, -1)
    : trimmed;
  return unwrapped.replace(/\\n/g, "\n").trim();
}

function objectValue(value: unknown): CredentialObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CredentialObject
    : null;
}

function findCredentialPair(value: unknown, depth = 0): { clientEmail: string; privateKey: string } | null {
  if (depth > 5) return null;
  const object = objectValue(value);
  if (!object) return null;

  const clientEmail = object.client_email ?? object.clientEmail;
  const privateKey = object.private_key ?? object.privateKey;
  if (typeof clientEmail === "string" && clientEmail.trim()
    && typeof privateKey === "string" && privateKey.trim()) {
    return { clientEmail: clientEmail.trim(), privateKey: normalizePrivateKey(privateKey) };
  }
  for (const child of Object.values(object)) {
    const match = findCredentialPair(child, depth + 1);
    if (match) return match;
  }
  return null;
}

function parseCredentialJson(value: string): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed;
}

function serviceAccount() {
  const credentialVariables = [
    "CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "GOOGLE_SERVICE_ACCOUNT_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  ] as const;
  const credentialValues = credentialVariables.flatMap((name) => {
    const value = process.env[name]?.trim();
    return value ? [{ name, value }] : [];
  });
  const emailVariables = [
    "CMPRI_GOOGLE_SHEETS_CLIENT_EMAIL",
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "GOOGLE_CLIENT_EMAIL",
  ] as const;
  const keyVariables = [
    "CMPRI_GOOGLE_SHEETS_PRIVATE_KEY",
    "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
    "GOOGLE_PRIVATE_KEY",
  ] as const;
  const separateEmail = emailVariables.map((name) => process.env[name]?.trim()).find(Boolean) || "";
  const separateKey = keyVariables.map((name) => process.env[name]?.trim()).find(Boolean) || "";
  if (!credentialValues.length && (!separateEmail || !separateKey)) {
    throw new IntegrationConfigurationError("Google Sheets is missing the server deployment setting CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON.");
  }

  let credentials: { clientEmail: string; privateKey: string } | null = null;
  let topLevelFields = "";
  for (const candidate of credentialValues) {
    const parsed = parseCredentialJson(candidate.value);
    const object = objectValue(parsed);
    if (!topLevelFields && object) topLevelFields = Object.keys(object).sort().join(", ");
    credentials = findCredentialPair(parsed);
    if (credentials) break;
  }
  const clientEmail = credentials?.clientEmail || separateEmail || "";
  const privateKey = credentials?.privateKey || (separateKey ? normalizePrivateKey(separateKey) : "");
  if (!clientEmail || !privateKey) {
    const fieldsDescription = topLevelFields ? ` Top-level fields found: ${topLevelFields}.` : "";
    throw new Error(`Google Sheets service-account credentials need client_email and private_key fields (or CMPRI_GOOGLE_SHEETS_CLIENT_EMAIL and CMPRI_GOOGLE_SHEETS_PRIVATE_KEY).${fieldsDescription} Use a Google service-account key, not OAuth client credentials or an API key.`);
  }
  return {
    clientEmail,
    privateKey,
    keyFingerprint: createHash("sha256").update(`${clientEmail}:${privateKey}`).digest("hex"),
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
  let signature = "";
  try {
    signature = createSign("RSA-SHA256")
      .update(unsignedToken)
      .sign(account.privateKey, "base64url");
  } catch {
    throw new IntegrationConfigurationError(
      "Google Sheets private key could not be parsed. Confirm CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON contains a valid service-account private_key PEM (BEGIN/END PRIVATE KEY), and preserve newline escapes exactly.",
    );
  }
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
      const serviceAccountEmail = serviceAccount().clientEmail;
      throw new Error(`Google Sheets denied ${integration} access to spreadsheet ${spreadsheetId}. The configured service account is ${serviceAccountEmail}. Confirm this exact account has Editor access to this spreadsheet and that the Google Sheets API is enabled in its Cloud project.`);
    }
    if (response.status === 404) {
      throw new Error(`Google Sheets could not find the configured ${integration} spreadsheet or tab.`);
    }
    throw new Error(`Google Sheets request for ${integration} failed (${response.status}).`);
  }
  return await response.json() as T;
}
