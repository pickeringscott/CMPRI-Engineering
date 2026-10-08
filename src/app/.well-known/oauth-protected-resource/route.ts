import { CANONICAL_APP_URL } from "@/lib/constants";

export const dynamic = "force-dynamic";

export function GET() {
  const origin = CANONICAL_APP_URL;
  return Response.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["cmpri:read", "cmpri:write"],
  }, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
