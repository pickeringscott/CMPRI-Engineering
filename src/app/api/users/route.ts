import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { ASSIGNABLE_ROLE_LABELS, canManageTargetRole, membershipRole, roleKey } from "@/lib/server/roles";

function callerCanChangeAccount(callerRole: unknown, callerId: string, target: { id: string; role: unknown }): boolean {
  if (!callerId || !target.id || callerId === target.id) return false;
  return canManageTargetRole(callerRole, target.role);
}

function callerCanAssignRole(callerRole: unknown, role: unknown): boolean {
  return canManageTargetRole(callerRole, role);
}

async function readBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function ensureServiceRoleAdmin(admin: { auth?: { admin?: unknown } } | null | undefined) {
  const authAdmin = admin && typeof admin === "object" ? (admin as { auth?: { admin?: unknown } }).auth?.admin : undefined;
  return authAdmin && typeof authAdmin === "object" ? (authAdmin as Record<string, unknown>) : null;
}

export async function GET(request: NextRequest) {
  const access = await requireCapability(request, "manage_users");
  if (!access) return NextResponse.json({ error: "User management access is required." }, { status: 403 });
  const { principal, admin } = access;

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, active")
    .order("full_name", { ascending: true });
  if (profileError) return NextResponse.json({ error: "Unable to read CMPRI user profiles." }, { status: 503 });

  const callerRole = principal.profile.role;
  const callerId = principal.identity?.id ?? principal.profile.id;
  const users = (profiles || []).map((user: { id: string; role: unknown }) => ({
    ...user,
    can_manage: callerCanChangeAccount(callerRole, callerId, { id: user.id, role: user.role }),
  }));

  const managedRoles = new Set<string>();
  for (const label of ASSIGNABLE_ROLE_LABELS) {
    if (callerCanAssignRole(callerRole, label)) managedRoles.add(label);
  }
  return NextResponse.json({ users, assignable_roles: Array.from(managedRoles) });
}

export async function POST(request: NextRequest) {
  const access = await requireCapability(request, "manage_users");
  if (!access) return NextResponse.json({ error: "User management access is required." }, { status: 403 });
  const { principal, admin } = access;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const profileRole = roleKey(role);
  const password = typeof body.password === "string" ? body.password : "";
  if (!role || profileRole === "unknown" || !callerCanAssignRole(principal.profile.role, role)) {
    return NextResponse.json({ error: "You may only assign roles below your own CMPRI access level." }, { status: 403 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !fullName || fullName.length > 200) {
    return NextResponse.json({ error: "A valid name and email are required." }, { status: 400 });
  }
  if (password && password.length < 10) {
    return NextResponse.json({ error: "A temporary password must be at least 10 characters." }, { status: 400 });
  }

  const adminAuth = ensureServiceRoleAdmin(admin);
  if (!adminAuth) {
    return NextResponse.json({ error: "This deployment is missing Supabase service-role credentials. Set SUPABASE_SERVICE_ROLE_KEY before creating users." }, { status: 500 });
  }

  let id: string | undefined;
  if (password) {
    const { data: created, error: createError } = await (adminAuth as any).createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError) return NextResponse.json({ error: createError.message }, { status: 400 });
    id = created.user?.id;
  } else {
    const { data: invited, error: inviteError } = await (adminAuth as any).inviteUserByEmail(email, { data: { full_name: fullName } });
    if (inviteError) return NextResponse.json({ error: inviteError.message }, { status: 400 });
    id = invited.user?.id;
  }
  if (!id) return NextResponse.json({ error: "The account could not be created." }, { status: 502 });

  const { error: profileError } = await admin.from("profiles").upsert({
    id,
    email,
    full_name: fullName,
    role: profileRole,
    property_scope: "assigned_property",
    active: true,
  });
  if (profileError) {
    return NextResponse.json({ error: `The login was created, but its CMPRI profile could not be set up: ${profileError.message}` }, { status: 500 });
  }

  const { error: membershipError } = await admin.from("hotel_members").upsert({
    hotel_id: HOTEL_ID,
    user_id: id,
    role: membershipRole(role),
    active: true,
  }, { onConflict: "hotel_id,user_id" });
  if (membershipError) {
    await admin.from("profiles").update({ active: false }).eq("id", id);
    return NextResponse.json({ error: `The login was created, but property access could not be assigned: ${membershipError.message}` }, { status: 500 });
  }

  return NextResponse.json({ user: { id, email, full_name: fullName, role: profileRole, active: true, invited: !password } });
}

export async function PATCH(request: NextRequest) {
  const access = await requireCapability(request, "manage_users");
  if (!access) return NextResponse.json({ error: "User management access is required." }, { status: 403 });
  const { principal, admin } = access;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "A valid JSON object is required." }, { status: 400 });
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "User id is required." }, { status: 400 });

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, active")
    .eq("id", id)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: "Unable to verify this account." }, { status: 503 });
  if (!target) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const callerRole = principal.profile.role;
  const callerId = principal.identity?.id ?? principal.profile.id;
  if (!callerCanChangeAccount(callerRole, callerId, { id: target.id, role: target.role })) {
    return NextResponse.json({ error: "You cannot manage your own, an equal, or a superior CMPRI account." }, { status: 403 });
  }

  let proposedRole: string = typeof target.role === "string" ? target.role : "";
  if (body.role !== undefined) {
    const raw = typeof body.role === "string" ? body.role.trim() : "";
    const isKnownLabel = raw && (ASSIGNABLE_ROLE_LABELS as readonly string[]).includes(raw);
    if (!isKnownLabel || !callerCanAssignRole(callerRole, raw)) {
      return NextResponse.json({ error: "You may only assign roles below your own CMPRI access level." }, { status: 403 });
    }
    proposedRole = roleKey(raw);
  }

  if (body.full_name !== undefined && (typeof body.full_name !== "string" || !body.full_name.trim() || body.full_name.trim().length > 200)) {
    return NextResponse.json({ error: "A valid full name is required." }, { status: 400 });
  }
  if (body.active !== undefined && typeof body.active !== "boolean") {
    return NextResponse.json({ error: "Active must be true or false." }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (typeof body.full_name === "string") update.full_name = body.full_name.trim();
  if (body.role !== undefined) update.role = proposedRole;
  if (typeof body.active === "boolean") update.active = body.active;
  if (!Object.keys(update).length) return NextResponse.json({ error: "No account changes were supplied." }, { status: 400 });

  const { data, error } = await admin.from("profiles")
    .update(update)
    .eq("id", id)
    .eq("role", target.role)
    .select("id, email, full_name, role, active")
    .single();
  if (error) {
    return NextResponse.json({ error: "This account changed while you were editing it. Reload the user list and try again." }, { status: 409 });
  }

  const membershipUpdate: Record<string, unknown> = {};
  if (body.role !== undefined) membershipUpdate.role = membershipRole(proposedRole);
  if (typeof body.active === "boolean") membershipUpdate.active = body.active;
  if (Object.keys(membershipUpdate).length) {
    const { error: membershipError } = await admin.from("hotel_members")
      .update(membershipUpdate)
      .eq("hotel_id", HOTEL_ID)
      .eq("user_id", id);
    if (membershipError) {
      return NextResponse.json({ error: "The profile changed, but property membership could not be synchronized." }, { status: 500 });
    }
  }

  return NextResponse.json({
    user: {
      ...data,
      can_manage: callerCanChangeAccount(callerRole, callerId, { id: data.id, role: data.role }),
    },
  });
}

/**
 * Account removal is intentionally a soft deactivation. CMPRI preserves identity,
 * ticket attribution, notes, assignments, AI provenance, and audit history.
 */
export async function DELETE(request: NextRequest) {
  const access = await requireCapability(request, "manage_users");
  if (!access) return NextResponse.json({ error: "User management access is required." }, { status: 403 });
  const { principal, admin } = access;

  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim() ?? "";
  const confirmName = url.searchParams.get("confirm_name")?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "User id is required." }, { status: 400 });

  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, active")
    .eq("id", id)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: "Unable to verify this account." }, { status: 503 });
  if (!target) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const callerRole = principal.profile.role;
  const callerId = principal.identity?.id ?? principal.profile.id;
  if (!callerCanChangeAccount(callerRole, callerId, { id: target.id, role: target.role })) {
    return NextResponse.json({ error: "You cannot deactivate your own, an equal, or a superior CMPRI account." }, { status: 403 });
  }

  const expected = (target.full_name || "").trim();
  if (!expected || confirmName !== expected) {
    return NextResponse.json({ error: "Type the account's full name exactly to confirm deactivation." }, { status: 400 });
  }

  const { error: profileError } = await admin.from("profiles").update({ active: false }).eq("id", id);
  if (profileError) return NextResponse.json({ error: "Unable to deactivate this CMPRI profile." }, { status: 500 });

  const { error: membershipError } = await admin.from("hotel_members")
    .update({ active: false })
    .eq("hotel_id", HOTEL_ID)
    .eq("user_id", id);
  if (membershipError) return NextResponse.json({ error: "The profile was deactivated, but property access could not be revoked." }, { status: 500 });

  return NextResponse.json({ deactivated: id, preserved_history: true });
}
