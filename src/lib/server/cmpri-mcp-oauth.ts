import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { CMPRI_MCP_RESOURCE, CMPRI_MCP_SCOPE, CMPRI_MCP_WRITE_SCOPE, normalizeMcpScope, validMcpScope } from "@/lib/server/cmpri-mcp-oauth-scope";

export { CMPRI_MCP_RESOURCE, CMPRI_MCP_SCOPE, CMPRI_MCP_WRITE_SCOPE, normalizeMcpScope, validMcpScope };
export const MCP_ACCESS_TOKEN_SECONDS = 60 * 60;
export const MCP_REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 30;

export function randomOAuthToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function randomMcpToken() {
  return `cmpri_mcp_${randomOAuthToken()}`;
}

export function randomPersonalMcpLinkToken() {
  return `cmpri_link_${randomOAuthToken(48)}`;
}

export function hashOAuthToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validRedirectUri(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash) return false;
    if (uri.protocol === "https:") return true;
    return uri.protocol === "http:"
      && (uri.hostname === "localhost" || uri.hostname === "127.0.0.1" || uri.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function appendOAuthParameters(redirectUri: string, values: Record<string, string>) {
  const redirect = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value);
  return redirect.toString();
}

export function oauthError(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}
