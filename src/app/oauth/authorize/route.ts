import { NextRequest } from "next/server";
import { allows } from "@/lib/server/access";
import { requireUser } from "@/lib/server/auth";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { CMPRI_MCP_RESOURCE, CMPRI_MCP_SCOPE, appendOAuthParameters, hashOAuthToken, normalizeMcpScope, oauthError, randomOAuthToken, validRedirectUri } from "@/lib/server/cmpri-mcp-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const clientId = request.nextUrl.searchParams.get("client_id") || "";
  const admin = createSupabaseAdmin();
  if (!admin || !clientId) return Response.json({ error: "invalid_request" }, { status: 400 });
  const { data, error } = await admin.from("cmpri_mcp_oauth_clients")
    .select("client_id, client_name")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return Response.json({ error: "invalid_client" }, { status: 400 });
  return Response.json({ client_id: data.client_id, client_name: data.client_name }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return oauthError("access_denied", "Sign in to your CMPRI account before authorizing ChatGPT.", 401);
  if (!allows(auth.principal, "view_dashboard") && !allows(auth.principal, "submit")) {
    return oauthError("access_denied", "This CMPRI role is not eligible to connect external AI tools.", 403);
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return oauthError("invalid_request", "Authorization details are required.");
  const data = body as Record<string, unknown>;
  const clientId = typeof data.client_id === "string" ? data.client_id : "";
  const redirectUri = typeof data.redirect_uri === "string" ? data.redirect_uri : "";
  const challenge = typeof data.code_challenge === "string" ? data.code_challenge : "";
  const state = typeof data.state === "string" ? data.state : "";
  const requestedScope = typeof data.scope === "string" ? data.scope : CMPRI_MCP_SCOPE;
  const scope = normalizeMcpScope(requestedScope);
  const resource = typeof data.resource === "string" ? data.resource : CMPRI_MCP_RESOURCE;
  if (!clientId || !validRedirectUri(redirectUri) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    || !state || state.length > 1024 || !scope || resource !== CMPRI_MCP_RESOURCE
    || data.code_challenge_method !== "S256") {
    return oauthError("invalid_request", "The OAuth request is invalid or does not use PKCE S256.");
  }
  const { data: client, error: clientError } = await auth.admin.from("cmpri_mcp_oauth_clients")
    .select("client_id, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (clientError || !client || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirectUri)) {
    return oauthError("invalid_client", "The client or redirect URI is not registered.");
  }
  const code = randomOAuthToken();
  const { error } = await auth.admin.from("cmpri_mcp_oauth_codes").insert({
    code_hash: hashOAuthToken(code),
    client_id: clientId,
    user_id: auth.principal.identity.id,
    redirect_uri: redirectUri,
    resource,
    code_challenge: challenge,
    scope,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  if (error) {
    console.error("CMPRI MCP OAuth authorization code could not be stored:", error.message);
    return oauthError("server_error", "CMPRI could not complete authorization.", 503);
  }
  return Response.json({
    redirect_uri: appendOAuthParameters(redirectUri, { code, state }),
  }, { headers: { "Cache-Control": "no-store" } });
}
