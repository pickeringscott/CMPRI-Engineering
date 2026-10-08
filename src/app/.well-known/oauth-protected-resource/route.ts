import { CMPRI_MCP_RESOURCE } from "@/lib/server/cmpri-mcp-oauth-scope";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    resource: CMPRI_MCP_RESOURCE,
    authorization_servers: [new URL(CMPRI_MCP_RESOURCE).origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["cmpri:read", "cmpri:write"],
  }, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
