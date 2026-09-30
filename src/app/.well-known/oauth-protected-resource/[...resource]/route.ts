import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/.well-known/oauth-protected-resource/[...resource]">,
) {
  const { resource } = await context.params;
  if (resource.join("/") !== "api/mcp") return Response.json({ error: "not_found" }, { status: 404 });
  const origin = request.nextUrl.origin;
  return Response.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["cmpri:read", "cmpri:write"],
  }, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
