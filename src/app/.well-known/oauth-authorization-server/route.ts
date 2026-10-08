import { CMPRI_MCP_RESOURCE } from "@/lib/server/cmpri-mcp-oauth-scope";

export const dynamic = "force-dynamic";

export function GET() {
  const origin = new URL(CMPRI_MCP_RESOURCE).origin;
  return Response.json({
    issuer: origin,
    authorization_endpoint: `${origin}/mcp/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["cmpri:read", "cmpri:write"],
  }, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
