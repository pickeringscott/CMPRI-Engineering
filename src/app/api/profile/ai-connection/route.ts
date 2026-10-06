import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { isSubmitOnlyRole } from "@/lib/server/roles";
import { connectionFromActiveTokens } from "@/lib/server/cmpri-mcp";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" };

async function authorized(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return { response: NextResponse.json({ error: "Sign in to manage your ChatGPT connection." }, { status: 401, headers: NO_STORE }) };
  if (isSubmitOnlyRole(auth.principal.profile.role)) {
    return { response: NextResponse.json({ error: "ChatGPT connections are unavailable to submit-only CMPRI roles." }, { status: 403, headers: NO_STORE }) };
  }
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
  const oauthConnection = connectionFromActiveTokens(
    (oauthTokens || []).map((token) => token.scope),
    oauthError,
  );
  if (personalError) throw new Error("Legacy ChatGPT connection status could not be loaded.");
  return {
    ...oauthConnection,
    oauth_connected: oauthConnection.connected,
    oauth_access: oauthConnection.access,
    message: oauthConnection.message,
    personal_link_active: (personalLinks || []).length > 0,
  };
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

export async function POST() {
  return NextResponse.json({
    error: "Private-link connections are retired. Connect ChatGPT using OAuth from the ChatGPT app settings.",
  }, { status: 410, headers: NO_STORE });
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
