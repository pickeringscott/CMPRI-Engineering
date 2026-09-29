import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import {
  validMcpScope,
  CMPRI_MCP_RESOURCE,
  MCP_ACCESS_TOKEN_SECONDS,
  MCP_REFRESH_TOKEN_SECONDS,
  hashOAuthToken,
  oauthError,
  pkceChallenge,
  randomMcpToken,
} from "@/lib/server/cmpri-mcp-oauth";

export const dynamic = "force-dynamic";

async function formBody(request: NextRequest) {
  const params = new URLSearchParams(await request.text());
  return Object.fromEntries(params.entries());
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string) {
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: MCP_ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope,
  }, { headers: { "Cache-Control": "no-store", Pragma: "no-cache", "Access-Control-Allow-Origin": "*" } });
}

async function saveTokenPair(admin: NonNullable<ReturnType<typeof createSupabaseAdmin>>, userId: string, clientId: string, familyId: string, resource: string, scope: string) {
  const accessToken = randomMcpToken();
  const refreshToken = randomMcpToken();
  const now = Date.now();
  const { error } = await admin.from("cmpri_mcp_oauth_tokens").insert([
    {
      token_hash: hashOAuthToken(accessToken),
      token_family_id: familyId,
      client_id: clientId,
      user_id: userId,
      resource,
      token_type: "access_token",
      scope,
      expires_at: new Date(now + MCP_ACCESS_TOKEN_SECONDS * 1000).toISOString(),
    },
    {
      token_hash: hashOAuthToken(refreshToken),
      token_family_id: familyId,
      client_id: clientId,
      user_id: userId,
      resource,
      token_type: "refresh_token",
      scope,
      expires_at: new Date(now + MCP_REFRESH_TOKEN_SECONDS * 1000).toISOString(),
    },
  ]);
  if (error) throw new Error("CMPRI could not store the ChatGPT authorization.");
  return tokenResponse(accessToken, refreshToken, scope);
}

export async function POST(request: NextRequest) {
  const body = await formBody(request);
  const admin = createSupabaseAdmin();
  if (!admin) return oauthError("server_error", "CMPRI OAuth storage is unavailable.", 503);

  try {
    if (body.grant_type === "authorization_code") {
      const code = body.code || "";
      const clientId = body.client_id || "";
      const redirectUri = body.redirect_uri || "";
      const resource = body.resource || CMPRI_MCP_RESOURCE;
      const verifier = body.code_verifier || "";
      if (!code || !clientId || !redirectUri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
        return oauthError("invalid_request", "A valid code, redirect URI, client ID, and PKCE verifier are required.");
      }
      const { data: pending, error: readError } = await admin.from("cmpri_mcp_oauth_codes")
        .select("code_hash, client_id, user_id, redirect_uri, resource, code_challenge, scope, expires_at, used_at")
        .eq("code_hash", hashOAuthToken(code))
        .maybeSingle();
      if (readError || !pending || pending.used_at || Date.parse(pending.expires_at) <= Date.now()
        || pending.client_id !== clientId || pending.redirect_uri !== redirectUri
        || !validMcpScope(pending.scope) || pending.resource !== resource
        || pending.code_challenge !== pkceChallenge(verifier)) {
        return oauthError("invalid_grant", "The authorization code is invalid, expired, or already used.");
      }
      const { data: consumed, error: consumeError } = await admin.from("cmpri_mcp_oauth_codes")
        .update({ used_at: new Date().toISOString() })
        .eq("code_hash", pending.code_hash)
        .is("used_at", null)
        .gt("expires_at", new Date().toISOString())
        .select("user_id")
        .maybeSingle();
      if (consumeError || !consumed) return oauthError("invalid_grant", "The authorization code has already been used.");
      return await saveTokenPair(admin, pending.user_id, clientId, crypto.randomUUID(), pending.resource, pending.scope);
    }

    if (body.grant_type === "refresh_token") {
      const refreshToken = body.refresh_token || "";
      const clientId = body.client_id || "";
      const resource = body.resource || CMPRI_MCP_RESOURCE;
      if (!refreshToken || !clientId) return oauthError("invalid_request", "A refresh token and client ID are required.");
      const { data: current, error: lookupError } = await admin.from("cmpri_mcp_oauth_tokens")
        .select("token_hash, token_family_id, user_id, client_id, resource, scope, expires_at, revoked_at")
        .eq("token_hash", hashOAuthToken(refreshToken))
        .eq("token_type", "refresh_token")
        .maybeSingle();
      if (lookupError || !current || current.revoked_at || current.client_id !== clientId
        || !validMcpScope(current.scope) || current.resource !== resource
        || Date.parse(current.expires_at) <= Date.now()) {
        return oauthError("invalid_grant", "The refresh token is invalid, expired, or revoked.");
      }
      const { data: rotated, error: rotateError } = await admin.from("cmpri_mcp_oauth_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", current.token_hash)
        .is("revoked_at", null)
        .gt("expires_at", new Date().toISOString())
        .select("user_id")
        .maybeSingle();
      if (rotateError || !rotated) return oauthError("invalid_grant", "The refresh token was already used.");
      return await saveTokenPair(admin, current.user_id, clientId, current.token_family_id, current.resource, current.scope);
    }
    return oauthError("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported.");
  } catch (error) {
    console.error("CMPRI MCP OAuth token exchange failed:", error instanceof Error ? error.message : String(error));
    return oauthError("server_error", "CMPRI could not complete the token exchange.", 503);
  }
}
