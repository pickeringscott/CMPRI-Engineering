import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { randomOAuthToken, validRedirectUri } from "@/lib/server/cmpri-mcp-oauth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const data = body as Record<string, unknown>;
  const name = typeof data.client_name === "string" ? data.client_name.trim().slice(0, 120) : "";
  const redirects = data.redirect_uris;
  if (!name || !Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10
    || redirects.some((uri) => !validRedirectUri(uri))) {
    return Response.json({ error: "invalid_client_metadata", error_description: "A client name and valid HTTPS redirect URIs are required." }, { status: 400 });
  }
  const admin = createSupabaseAdmin();
  if (!admin) return Response.json({ error: "server_error" }, { status: 503 });
  const clientId = randomOAuthToken(24);
  const { error } = await admin.from("cmpri_mcp_oauth_clients").insert({
    client_id: clientId,
    client_name: name,
    redirect_uris: [...new Set(redirects as string[])],
  });
  if (error) {
    console.error("CMPRI MCP OAuth client registration failed:", error.message);
    return Response.json({ error: "server_error" }, { status: 503 });
  }
  return Response.json({
    client_id: clientId,
    client_name: name,
    redirect_uris: [...new Set(redirects as string[])],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, {
    status: 201,
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}
