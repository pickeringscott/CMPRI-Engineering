import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { DEFAULT_PROFILE_PREFERENCES, disableProfileNotifications, normalizeProfilePreferences } from "@/lib/profile-preferences";
import { isSubmitOnlyRole } from "@/lib/server/roles";
import { connectionFromActiveTokens } from "@/lib/server/cmpri-mcp";

async function readBody(request: NextRequest) {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function preferencesForRole(role: unknown, value: unknown) {
  return isSubmitOnlyRole(role)
    ? disableProfileNotifications(value)
    : normalizeProfilePreferences(value);
}

async function chatgptConnectionForUser(admin: NonNullable<Awaited<ReturnType<typeof requireUser>>>["admin"], userId: string) {
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
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await auth.admin.from("profiles")
    .select("id, email, full_name, role, preferences")
    .eq("id", auth.principal.identity.id)
    .maybeSingle();
  if (error) {
    const { data: legacyProfile, error: legacyError } = await auth.admin.from("profiles")
      .select("id, email, full_name, role, preferences")
      .eq("id", auth.principal.identity.id)
      .maybeSingle();
    if (legacyError) return NextResponse.json({ error: "Profile could not be loaded." }, { status: 503 });
    if (!legacyProfile) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    let chatgptConnection;
    try {
      chatgptConnection = await chatgptConnectionForUser(auth.admin, auth.principal.identity.id);
    } catch {
      return NextResponse.json({ error: "ChatGPT connection status could not be loaded. Apply the CMPRI MCP authorization migration." }, { status: 503 });
    }
    return NextResponse.json({
      profile: { id: legacyProfile.id, email: legacyProfile.email, full_name: legacyProfile.full_name, role: legacyProfile.role },
      preferences: preferencesForRole(auth.principal.profile.role, legacyProfile.preferences || DEFAULT_PROFILE_PREFERENCES),
      profile_settings_available: true,
      can_manage_users: allows(auth.principal, "manage_users"),
      chatgpt_connection: chatgptConnection,
      warning: "Profile preferences are available, but ChatGPT connections require the CMPRI MCP authorization migration.",
    });
  }
  if (!data) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  let chatgptConnection;
  try {
    chatgptConnection = await chatgptConnectionForUser(auth.admin, auth.principal.identity.id);
  } catch {
    return NextResponse.json({ error: "ChatGPT connection status could not be loaded. Apply the CMPRI MCP authorization migration." }, { status: 503 });
  }
  return NextResponse.json({
    profile: { id: data.id, email: data.email, full_name: data.full_name, role: data.role },
    preferences: preferencesForRole(auth.principal.profile.role, data.preferences || DEFAULT_PROFILE_PREFERENCES),
    profile_settings_available: true,
    can_manage_users: allows(auth.principal, "manage_users"),
    chatgpt_connection: chatgptConnection,
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const update: Record<string, unknown> = {};
  if (body.full_name !== undefined) {
    if (typeof body.full_name !== "string" || !body.full_name.trim() || body.full_name.trim().length > 200) {
      return NextResponse.json({ error: "A valid display name is required." }, { status: 400 });
    }
    update.full_name = body.full_name.trim();
  }
  if (body.preferences !== undefined) update.preferences = preferencesForRole(auth.principal.profile.role, body.preferences);
  if (!Object.keys(update).length) return NextResponse.json({ error: "No profile changes were supplied." }, { status: 400 });

  const { data, error } = await auth.admin.from("profiles")
    .update(update)
    .eq("id", auth.principal.identity.id)
    .select("id, email, full_name, role, preferences")
    .single();
  if (error) {
    const legacyUpdate: Record<string, unknown> = {};
    if (typeof update.full_name === "string") legacyUpdate.full_name = update.full_name;
    if (update.preferences !== undefined) legacyUpdate.preferences = update.preferences;
    const { data: legacyProfile, error: legacyError } = await auth.admin.from("profiles")
      .update(legacyUpdate)
      .eq("id", auth.principal.identity.id)
      .select("id, email, full_name, role, preferences")
      .single();
    if (legacyError || !legacyProfile) return NextResponse.json({ error: "Profile could not be saved." }, { status: 400 });
    let chatgptConnection;
    try {
      chatgptConnection = await chatgptConnectionForUser(auth.admin, auth.principal.identity.id);
    } catch {
      return NextResponse.json({ error: "Profile was saved, but ChatGPT connection status could not be loaded." }, { status: 503 });
    }
    return NextResponse.json({
      profile: { id: legacyProfile.id, email: legacyProfile.email, full_name: legacyProfile.full_name, role: legacyProfile.role },
      preferences: preferencesForRole(auth.principal.profile.role, legacyProfile.preferences || DEFAULT_PROFILE_PREFERENCES),
      profile_settings_available: true,
      can_manage_users: allows(auth.principal, "manage_users"),
      chatgpt_connection: chatgptConnection,
      warning: "Profile changes were saved, but ChatGPT connections require the CMPRI MCP authorization migration.",
    });
  }
  let chatgptConnection;
  try {
    chatgptConnection = await chatgptConnectionForUser(auth.admin, auth.principal.identity.id);
  } catch {
    return NextResponse.json({ error: "Profile was saved, but ChatGPT connection status could not be loaded." }, { status: 503 });
  }
  return NextResponse.json({
    profile: { id: data.id, email: data.email, full_name: data.full_name, role: data.role },
    preferences: preferencesForRole(auth.principal.profile.role, data.preferences || DEFAULT_PROFILE_PREFERENCES),
    profile_settings_available: true,
    chatgpt_connection: chatgptConnection,
  });
}
