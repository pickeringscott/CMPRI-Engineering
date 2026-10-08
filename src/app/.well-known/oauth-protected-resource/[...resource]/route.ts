import type { NextRequest } from "next/server";
import { CMPRI_MCP_RESOURCE } from "@/lib/server/cmpri-mcp-oauth-scope";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/.well-known/oauth-protected-resource/[...resource]">,
) {
  const { resource } = await context.params;
  if (resource.join("/") !== "api/mcp") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    resource: CMPRI_MCP_RESOURCE,
    authorization_servers: [new URL(CMPRI_MCP_RESOURCE).origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["cmpri:read", "cmpri:write"],
  }, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
