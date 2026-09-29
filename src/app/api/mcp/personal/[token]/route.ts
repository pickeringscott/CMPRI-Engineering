import { NextRequest } from "next/server";
import { POST as mcpPost } from "@/app/api/mcp/route";

export const dynamic = "force-dynamic";

function invalidLink() {
  return Response.json({ error: "This CMPRI connection link is invalid or revoked." }, {
    status: 401,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function POST(request: NextRequest, context: RouteContext<"/api/mcp/personal/[token]">) {
  const { token } = await context.params;
  if (!/^cmpri_link_[A-Za-z0-9_-]{64}$/.test(token)) return invalidLink();
  if (Number(request.headers.get("content-length") || 0) > 1_000_000) {
    return Response.json({ error: "The CMPRI request is too large." }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "A CMPRI tool request is required." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const mcpRequest = new NextRequest(new URL("/api/mcp", request.nextUrl.origin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(request.headers.get("mcp-protocol-version")
        ? { "MCP-Protocol-Version": request.headers.get("mcp-protocol-version") as string }
        : {}),
    },
    body: JSON.stringify(payload),
  });
  const response = await mcpPost(mcpRequest);
  return new Response(response.body, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers.entries()),
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
