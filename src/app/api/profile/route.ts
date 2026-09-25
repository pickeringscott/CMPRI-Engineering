import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/auth";
import { roleAllows } from "@/lib/server/roles";
import { DEFAULT_PROFILE_PREFERENCES, normalizeProfilePreferences } from "@/lib/profile-preferences";

async function readBody(request: NextRequest) {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await auth.admin.from("profiles")
    .select("id, email, full_name, role, preferences, personal_ai_connected")
    .eq("id", auth.principal.identity.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Profile could not be loaded." }, { status: 503 });
  if (!data) return NextResponse.json({ error: "Profile not found." }, { status: 404 });
  return NextResponse.json({
    profile: { id: data.id, email: data.email, full_name: data.full_name, role: data.role },
    preferences: normalizeProfilePreferences(data.preferences || DEFAULT_PROFILE_PREFERENCES),
    can_manage_users: roleAllows(auth.principal.profile.role, "manage_users"),
    personal_ai: { connected: data.personal_ai_connected === true, status: data.personal_ai_connected === true ? "connected" : "disconnected", message: "Personal AI uses controlled CMPRI actions and inherits this user's current permissions." },
  });
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (body.personal_ai_action !== undefined) {
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
  if (body.preferences !== undefined) update.preferences = normalizeProfilePreferences(body.preferences);
  if (!Object.keys(update).length) return NextResponse.json({ error: "No profile changes were supplied." }, { status: 400 });

  const { data, error } = await auth.admin.from("profiles")
    .update(update)
    .eq("id", auth.principal.identity.id)
    .select("id, email, full_name, role, preferences, personal_ai_connected")
    .single();
  if (error) return NextResponse.json({ error: "Profile could not be saved." }, { status: 400 });
  return NextResponse.json({
    profile: { id: data.id, email: data.email, full_name: data.full_name, role: data.role },
    preferences: normalizeProfilePreferences(data.preferences || DEFAULT_PROFILE_PREFERENCES),
    personal_ai: { connected: data.personal_ai_connected === true, status: data.personal_ai_connected === true ? "connected" : "disconnected" },
  });
}
