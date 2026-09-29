import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { connectionFromActiveTokens } from "@/lib/server/cmpri-mcp";

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
  const { data, error } = await admin.from("cmpri_mcp_oauth_tokens")
    .select("scope")
    .eq("user_id", userId)
    .eq("token_type", "access_token")
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  return connectionFromActiveTokens((data || []).map((token) => token.scope), error);
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

export async function DELETE(request: NextRequest) {
  const { auth, response } = await authorized(request);
  if (response) return response;
  const { error } = await auth.admin.from("cmpri_mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", auth.principal.identity.id)
    .is("revoked_at", null);
  if (error) return NextResponse.json({ error: "ChatGPT could not be disconnected." }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ connection: await connection(auth.admin, auth.principal.identity.id) }, { headers: NO_STORE });
}
