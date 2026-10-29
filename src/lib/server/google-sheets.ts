import "server-only";
import { createHash, createPrivateKey, createSign } from "node:crypto";
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
  const normalized = unwrapped.replace(/\\n/g, "\n").trim();
  if (/-----BEGIN [A-Z0-9 ]+-----/.test(normalized)) return normalized;

  const base64 = normalized.replace(/\s+/g, "");
  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(base64);
  const isBase64Url = /^[A-Za-z0-9_-]+={0,2}$/.test(base64);
  if (!isBase64 && !isBase64Url) return normalized;

  const standardBase64 = isBase64Url
    ? base64.replace(/-/g, "+").replace(/_/g, "/")
    : base64;
  const paddedBase64 = standardBase64.padEnd(Math.ceil(standardBase64.length / 4) * 4, "=");
  const der = Buffer.from(paddedBase64, "base64");
  if (der.toString("base64").replace(/=+$/, "") !== standardBase64.replace(/=+$/, "")) return normalized;
  for (const type of ["pkcs8", "pkcs1"] as const) {
    try {
      const key = createPrivateKey({ key: der, format: "der", type });
      return key.export({ type: "pkcs8", format: "pem" }).toString();
    } catch {
      // Try the other supported DER private-key container.
    }
  }
  return normalized;
}

function privateKeyDiagnostics(value: string) {
  const base64 = value.replace(/\s+/g, "");
  const alphabet = /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    ? "standard"
    : /^[A-Za-z0-9_-]+={0,2}$/.test(base64)
      ? "URL-safe"
      : "unrecognized";
  if (alphabet === "unrecognized") {
    return "base64 body: unrecognized; DER bytes: unavailable; PKCS#8/PKCS#1: not attempted";
  }

  const standardBase64 = alphabet === "URL-safe"
    ? base64.replace(/-/g, "+").replace(/_/g, "/")
    : base64;
  const paddedBase64 = standardBase64.padEnd(Math.ceil(standardBase64.length / 4) * 4, "=");
  const der = Buffer.from(paddedBase64, "base64");
  const parseCode = (type: "pkcs8" | "pkcs1") => {
    try {
      createPrivateKey({ key: der, format: "der", type });
      return "valid";
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error
        && typeof error.code === "string"
        ? error.code
        : "unavailable";
    }
  };
  return `base64 body: ${alphabet}; DER bytes: ${der.length}; PKCS#8: ${parseCode("pkcs8")}; PKCS#1: ${parseCode("pkcs1")}`;
}

function objectValue(value: unknown): CredentialObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as CredentialObject
    : null;
}

function findCredentialPair(
  value: unknown,
  depth = 0,
): { clientEmail: string; privateKey: string } | null {
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

function isParsablePrivateKey(value: string) {
  try {
    createPrivateKey(value);
    return true;
  } catch {
    return false;
  }
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
  const separateEmails = emailVariables.map((name) => ({ name, value: process.env[name]?.trim() }));
  const separateKeys = keyVariables.map((name) => ({ name, value: process.env[name]?.trim() }));
  const credentialCandidates: Array<{
    clientEmail: string;
    privateKey: string;
    credentialSource: string;
  }> = [];
  for (let index = 0; index < Math.min(separateEmails.length, separateKeys.length); index += 1) {
    const email = separateEmails[index];
    const key = separateKeys[index];
    if (email.value && key.value) {
      credentialCandidates.push({
        clientEmail: email.value,
        privateKey: normalizePrivateKey(key.value),
        credentialSource: key.name,
      });
    }
  }
  if (!credentialValues.length && !credentialCandidates.length) {
    throw new IntegrationConfigurationError("Google Sheets is missing the server deployment setting CMPRI_GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON.");
  }
  let topLevelFields = "";
  for (const candidate of credentialValues) {
    const parsed = parseCredentialJson(candidate.value);
    const object = objectValue(parsed);
    if (!topLevelFields && object) topLevelFields = Object.keys(object).sort().join(", ");
    const credentials = findCredentialPair(parsed);
    if (credentials) {
      credentialCandidates.push({ ...credentials, credentialSource: candidate.name });
    }
  }
  const credentials = credentialCandidates.find(({ privateKey }) => isParsablePrivateKey(privateKey))
    || credentialCandidates[0];
  if (!credentials) {
    const fieldsDescription = topLevelFields ? ` Top-level fields found: ${topLevelFields}.` : "";
    throw new Error(`Google Sheets service-account credentials need client_email and private_key fields (or CMPRI_GOOGLE_SHEETS_CLIENT_EMAIL and CMPRI_GOOGLE_SHEETS_PRIVATE_KEY).${fieldsDescription} Use a Google service-account key, not OAuth client credentials or an API key.`);
  }
  return {
    ...credentials,
    keyFingerprint: createHash("sha256").update(`${credentials.clientEmail}:${credentials.privateKey}`).digest("hex"),
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
  } catch (error) {
    const pemBlock = account.privateKey.match(/-----BEGIN ([A-Z0-9 ]+)-----/)?.[1] || "missing";
    const lineCount = account.privateKey.split(/\r?\n/).length;
    const cryptoCode = typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string"
      ? error.code
      : "unavailable";
    throw new IntegrationConfigurationError(
      `Google Sheets private key could not be parsed (source: ${account.credentialSource || "unknown"}; PEM block: ${pemBlock}; normalized length: ${account.privateKey.length}; PEM lines: ${lineCount}; crypto code: ${cryptoCode}; ${privateKeyDiagnostics(account.privateKey)}). Confirm the selected setting contains a complete service-account private_key PEM.`,
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
    signal: AbortSignal.timeout(25_000),
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
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
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
