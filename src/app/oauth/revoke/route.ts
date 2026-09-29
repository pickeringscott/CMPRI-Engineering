import { NextRequest } from "next/server";
import { createSupabaseAdmin } from "@/lib/server/supabase-admin";
import { hashOAuthToken, oauthError } from "@/lib/server/cmpri-mcp-oauth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = new URLSearchParams(await request.text());
  const token = body.get("token") || "";
  if (!token) return Response.json({}, { status: 200, headers: { "Cache-Control": "no-store" } });
  const admin = createSupabaseAdmin();
  if (!admin) return oauthError("server_error", "CMPRI OAuth storage is unavailable.", 503);
  const { data: row, error: lookupError } = await admin.from("cmpri_mcp_oauth_tokens")
    .select("token_family_id")
    .eq("token_hash", hashOAuthToken(token))
    .maybeSingle();
  if (lookupError) return oauthError("server_error", "CMPRI could not revoke this connection.", 503);
  if (row) {
    const { error } = await admin.from("cmpri_mcp_oauth_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_family_id", row.token_family_id)
      .is("revoked_at", null);
    if (error) return oauthError("server_error", "CMPRI could not revoke this connection.", 503);
  }
  return Response.json({}, { status: 200, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
