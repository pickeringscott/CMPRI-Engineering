import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { connectionFromActiveTokens } from "@/lib/server/cmpri-mcp";
import { CMPRI_MCP_RESOURCE, CMPRI_MCP_WRITE_SCOPE } from "@/lib/server/cmpri-mcp-oauth-scope";
import { hashOAuthToken, randomPersonalMcpLinkToken } from "@/lib/server/cmpri-mcp-oauth";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" };

async function authorized(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return { response: NextResponse.json({ error: "Sign in to manage your ChatGPT connection." }, { status: 401, headers: NO_STORE }) };
  if (!allows(auth.principal, "view_dashboard") && !allows(auth.principal, "submit")) {
    return { response: NextResponse.json({ error: "External AI tools are unavailable to this CMPRI role." }, { status: 403, headers: NO_STORE }) };
  }
  return { auth };
}

async function connection(admin: NonNullable<Awaited<ReturnType<typeof requireUser>>>["admin"], userId: string) {
  const [{ data: oauthTokens, error: oauthError }, { data: personalLinks, error: personalError }] = await Promise.all([
    admin.from("cmpri_mcp_oauth_tokens")
    .select("scope")
    .eq("user_id", userId)
    .eq("token_type", "access_token")
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString()),
    admin.from("cmpri_personal_mcp_links")
      .select("scope")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
  ]);
  const result = connectionFromActiveTokens(
    [...(oauthTokens || []), ...(personalLinks || [])].map((token) => token.scope),
    oauthError || personalError,
  );
  return { ...result, personal_link_active: (personalLinks || []).length > 0 };
}

export async function GET(request: NextRequest) {
  const { auth, response } = await authorized(request);
  if (response) return response;
  try {
    return NextResponse.json({ connection: await connection(auth.admin, auth.principal.identity.id) }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ChatGPT status could not be loaded." }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const { auth, response } = await authorized(request);
  if (response) return response;
  const admin = auth.admin;
  const userId = auth.principal.identity.id;
  const token = randomPersonalMcpLinkToken();
  const now = Date.now();
  const { error: insertError } = await admin.from("cmpri_personal_mcp_links").insert({
    token_hash: hashOAuthToken(token),
    user_id: userId,
    resource: CMPRI_MCP_RESOURCE,
    scope: CMPRI_MCP_WRITE_SCOPE,
    expires_at: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (insertError) {
    console.error("CMPRI personal AI connection could not be stored:", insertError.message);
    return NextResponse.json({ error: "A CMPRI connection link could not be created." }, { status: 503, headers: NO_STORE });
  }

  const { error: revokeError } = await admin.from("cmpri_personal_mcp_links")
    .update({ revoked_at: new Date(now).toISOString() })
    .eq("user_id", userId)
    .neq("token_hash", hashOAuthToken(token))
    .is("revoked_at", null);
  if (revokeError) {
    const { error: rollbackError } = await admin.from("cmpri_personal_mcp_links")
      .update({ revoked_at: new Date(now).toISOString() })
      .eq("token_hash", hashOAuthToken(token))
      .is("revoked_at", null);
    if (rollbackError) console.error("CMPRI personal AI link rollback failed:", rollbackError.message);
    return NextResponse.json({ error: "The previous connection could not be rotated safely." }, { status: 503, headers: NO_STORE });
  }

  const result = await connection(admin, userId);
  return NextResponse.json({
    connection: result,
    connect_url: `${request.nextUrl.origin}/api/mcp/personal/${token}`,
    expires_at: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
  }, { headers: NO_STORE });
}

export async function DELETE(request: NextRequest) {
  const { auth, response } = await authorized(request);
  if (response) return response;
  const [{ error: oauthError }, { error: personalError }] = await Promise.all([
    auth.admin.from("cmpri_mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", auth.principal.identity.id)
    .is("revoked_at", null),
    auth.admin.from("cmpri_personal_mcp_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", auth.principal.identity.id)
      .is("revoked_at", null),
  ]);
  if (oauthError || personalError) return NextResponse.json({ error: "AI access could not be revoked." }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ connection: await connection(auth.admin, auth.principal.identity.id) }, { headers: NO_STORE });
}
