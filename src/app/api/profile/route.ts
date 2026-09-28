import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { allows } from "@/lib/server/access";
import { DEFAULT_PROFILE_PREFERENCES, disableProfileNotifications, normalizeProfilePreferences } from "@/lib/profile-preferences";
import { isSubmitOnlyRole } from "@/lib/server/roles";

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

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await auth.admin.from("profiles")
    .select("id, email, full_name, role, preferences, personal_ai_connected")
    .eq("id", auth.principal.identity.id)
    .maybeSingle();
  if (error) {
    const { data: basicProfile, error: basicError } = await auth.admin.from("profiles")
      .select("id, email, full_name, role")
      .eq("id", auth.principal.identity.id)
      .maybeSingle();
    if (basicError) return NextResponse.json({ error: "Profile could not be loaded." }, { status: 503 });
    if (!basicProfile) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
    return NextResponse.json({
      profile: { id: basicProfile.id, email: basicProfile.email, full_name: basicProfile.full_name, role: basicProfile.role },
      preferences: preferencesForRole(auth.principal.profile.role, DEFAULT_PROFILE_PREFERENCES),
      profile_settings_available: false,
      can_manage_users: allows(auth.principal, "manage_users"),
      personal_ai: { connected: false, status: "disconnected", message: "Personal settings storage is unavailable. Apply the CMPRI profile-preferences migration to enable saved preferences and connection state." },
    });
  }
  if (!data) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  return NextResponse.json({
    profile: { id: data.id, email: data.email, full_name: data.full_name, role: data.role },
    preferences: preferencesForRole(auth.principal.profile.role, data.preferences || DEFAULT_PROFILE_PREFERENCES),
    profile_settings_available: true,
    can_manage_users: allows(auth.principal, "manage_users"),
    personal_ai: { connected: data.personal_ai_connected === true, status: data.personal_ai_connected === true ? "connected" : "disconnected", message: "Personal AI uses controlled CMPRI actions and inherits this user's current permissions." },
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const isSubmitOnly = isSubmitOnlyRole(auth.principal.profile.role);

  const update: Record<string, unknown> = {};
  if (body.personal_ai_action !== undefined) {
    if (isSubmitOnly) return NextResponse.json({ error: "Personal AI is unavailable for this role." }, { status: 403 });
    if (body.personal_ai_action !== "connect" && body.personal_ai_action !== "disconnect") {
      return NextResponse.json({ error: "Invalid personal AI connection action." }, { status: 400 });
    }
    update.personal_ai_connected = body.personal_ai_action === "connect";
  }
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
    .select("id, email, full_name, role, preferences, personal_ai_connected")
    .single();
  if (error) {
    if (typeof update.full_name !== "string" || "personal_ai_action" in body) {
      return NextResponse.json({ error: "Personal settings storage is unavailable. Apply the CMPRI profile-preferences migration before changing preferences or connection state." }, { status: 503 });
    }
    const { data: basicProfile, error: basicError } = await auth.admin.from("profiles")
      .update({ full_name: update.full_name })
      .eq("id", auth.principal.identity.id)
      .select("id, email, full_name, role")
      .single();
    if (basicError || !basicProfile) return NextResponse.json({ error: "Profile could not be saved." }, { status: 400 });
    return NextResponse.json({
      profile: { id: basicProfile.id, email: basicProfile.email, full_name: basicProfile.full_name, role: basicProfile.role },
      preferences: preferencesForRole(auth.principal.profile.role, DEFAULT_PROFILE_PREFERENCES),
      profile_settings_available: false,
      can_manage_users: allows(auth.principal, "manage_users"),
      personal_ai: { connected: false, status: "disconnected", message: "Personal settings storage is unavailable. Apply the CMPRI profile-preferences migration to enable saved preferences and connection state." },
      warning: "Display name was saved, but personal preferences could not be saved.",
    });
  }
  return NextResponse.json({
    profile: { id: data.id, email: data.email, full_name: data.full_name, role: data.role },
    preferences: preferencesForRole(auth.principal.profile.role, data.preferences || DEFAULT_PROFILE_PREFERENCES),
    profile_settings_available: true,
    personal_ai: { connected: data.personal_ai_connected === true, status: data.personal_ai_connected === true ? "connected" : "disconnected" },
  });
}
