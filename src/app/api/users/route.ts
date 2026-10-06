import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_ID } from "@/lib/constants";
import { requireCapability } from "@/lib/server/auth";
import { ASSIGNABLE_ROLE_LABELS, canManageTargetProfile, membershipRole, roleKey } from "@/lib/server/roles";

function callerCanChangeAccount(
  callerProfile: { role: unknown; secondary_roles?: readonly unknown[] },
  callerId: string,
  target: { id: string; role: unknown },
): boolean {
  if (!callerId || !target.id || callerId === target.id) return false;
  return canManageTargetProfile(callerProfile, target.role);
}

function callerCanAssignRole(callerProfile: { role: unknown; secondary_roles?: readonly unknown[] }, role: unknown): boolean {
  return canManageTargetProfile(callerProfile, role);
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
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const authAdmin = admin && typeof admin === "object" ? (admin as { auth?: { admin?: unknown } }).auth?.admin : undefined;
  return authAdmin && typeof authAdmin === "object" ? (authAdmin as Record<string, unknown>) : null;
}

async function rollbackCreatedAccount(id: string, authAdmin: Record<string, unknown>, admin: SupabaseClient) {
  const failures: string[] = [];
  const cleanupSteps = [
    {
      label: "property membership",
      run: () => admin.from("hotel_members").delete().eq("hotel_id", HOTEL_ID).eq("user_id", id),
    },
    {
      label: "CMPRI profile",
      run: () => admin.from("profiles").delete().eq("id", id),
    },
  ];

  for (const step of cleanupSteps) {
    try {
      const { error } = await step.run();
      if (error) failures.push(step.label);
    } catch {
      failures.push(step.label);
    }
  }

  const deleteUser = authAdmin.deleteUser as ((userId: string) => Promise<{ error: { message?: string } | null }>) | undefined;
  if (!deleteUser) {
    failures.push("Auth login");
  } else {
    try {
      const { error } = await deleteUser.call(authAdmin, id);
      if (error) failures.push("Auth login");
    } catch {
      failures.push("Auth login");
    }
  }

  return failures;
}

async function setupFailureResponse(
  id: string,
  authAdmin: Record<string, unknown>,
  admin: SupabaseClient,
  failedStep: string,
  cause: string,
) {
  const cleanupFailures = await rollbackCreatedAccount(id, authAdmin, admin);
  const error = cleanupFailures.length
    ? `The login was created, but ${failedStep} failed: ${cause}. Automatic cleanup could not remove the ${cleanupFailures.join(", ")}; remove this account manually.`
    : `${failedStep} failed: ${cause}. The newly created login and CMPRI records were rolled back.`;
  return NextResponse.json({ error }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const access = await requireCapability(request, "manage_users");
  if (!access) return NextResponse.json({ error: "User management access is required." }, { status: 403 });
  const { principal, admin } = access;

  const { data: propertyMemberships, error: membershipError } = await admin
    .from("hotel_members")
    .select("user_id, hotel_id, active")
    .eq("hotel_id", HOTEL_ID);
  if (membershipError) return NextResponse.json({ error: "Unable to read property memberships." }, { status: 503 });

  const memberIds = Array.from(new Set((propertyMemberships || []).map((membership) => String(membership.user_id || "")).filter(Boolean)));
  if (!memberIds.length) return NextResponse.json({ users: [], assignable_roles: [] });

  const [{ data: profiles, error: profileError }, { data: allMemberships, error: allMembershipsError }] = await Promise.all([
    admin.from("profiles")
      .select("id, email, full_name, role, secondary_roles, active")
      .in("id", memberIds)
      .order("full_name", { ascending: true }),
    admin.from("hotel_members")
      .select("user_id, hotel_id")
      .in("user_id", memberIds),
  ]);
  if (profileError) return NextResponse.json({ error: "Unable to read CMPRI user profiles." }, { status: 503 });
  if (allMembershipsError) return NextResponse.json({ error: "Unable to verify property account scope." }, { status: 503 });

  const callerProfile = principal.profile;
  const callerId = principal.identity?.id ?? principal.profile.id;
  const membershipsByUserId = new Map((propertyMemberships || []).map((membership) => [String(membership.user_id), membership]));
  const userIdsWithOtherPropertyMemberships = new Set((allMemberships || [])
    .filter((membership) => membership.hotel_id !== HOTEL_ID)
    .map((membership) => String(membership.user_id)));
  const users = (profiles || []).map((user: { id: string; role: unknown; active: boolean | null }) => ({
    ...user,
    active: user.active === true && membershipsByUserId.get(user.id)?.active === true,
    can_manage: !userIdsWithOtherPropertyMemberships.has(user.id)
      && callerCanChangeAccount(callerProfile, callerId, { id: user.id, role: user.role }),
  }));

  const managedRoles = new Set<string>();
  for (const label of ASSIGNABLE_ROLE_LABELS) {
    if (callerCanAssignRole(callerProfile, label)) managedRoles.add(label);
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
  if (!role || profileRole === "unknown" || !callerCanAssignRole(principal.profile, role)) {
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
    const createUser = adminAuth.createUser as
      | ((attrs: { email: string; password: string; email_confirm: boolean; role: string; user_metadata: Record<string, unknown> }) => Promise<{ data: { user?: { id?: string } }; error: { message: string } | null }>)
      | undefined;
    if (!createUser) return NextResponse.json({ error: "Supabase Auth admin user creation is unavailable." }, { status: 500 });
    const { data: created, error: createError } = await createUser.call(adminAuth, {
      email,
      password,
      email_confirm: true,
      role: "authenticated",
      user_metadata: { full_name: fullName },
    });
    if (createError) return NextResponse.json({ error: createError.message }, { status: 400 });
    id = created.user?.id;
  } else {
    const inviteUserByEmail = adminAuth.inviteUserByEmail as
      | ((email: string, options?: { data?: Record<string, unknown> }) => Promise<{ data: { user?: { id?: string } }; error: { message: string } | null }>)
      | undefined;
    if (!inviteUserByEmail) return NextResponse.json({ error: "Supabase Auth email invitations are unavailable." }, { status: 500 });
    const { data: invited, error: inviteError } = await inviteUserByEmail.call(adminAuth, email, { data: { full_name: fullName } });
    if (inviteError) return NextResponse.json({ error: inviteError.message }, { status: 400 });
    id = invited.user?.id;
  }
  if (!id) return NextResponse.json({ error: "The account could not be created." }, { status: 502 });

  if (!password) {
    const updateUserById = adminAuth.updateUserById as
      | ((userId: string, attributes: { role: string }) => Promise<{ error: { message: string } | null }>)
      | undefined;
    if (!updateUserById) {
      return setupFailureResponse(id, adminAuth, admin, "Supabase Auth role setup", "Auth user role updates are unavailable.");
    }
    try {
      const { error: roleError } = await updateUserById.call(adminAuth, id, { role: "authenticated" });
      if (roleError) {
        return setupFailureResponse(id, adminAuth, admin, "Supabase Auth role setup", roleError.message);
      }
    } catch (error) {
      return setupFailureResponse(
        id,
        adminAuth,
        admin,
        "Supabase Auth role setup",
        error instanceof Error ? error.message : "Auth user role update failed.",
      );
    }
  }

  const { error: profileError } = await admin.from("profiles").upsert({
    id,
    email,
    full_name: fullName,
    role: profileRole,
    property_scope: "assigned_property",
    active: true,
  });
  if (profileError) {
    return setupFailureResponse(id, adminAuth, admin, "CMPRI profile setup", profileError.message);
  }

  const { error: membershipError } = await admin.from("hotel_members").upsert({
    hotel_id: HOTEL_ID,
    user_id: id,
    role: membershipRole(role),
    active: true,
  }, { onConflict: "hotel_id,user_id" });
  if (membershipError) {
    return setupFailureResponse(id, adminAuth, admin, "Property access setup", membershipError.message);
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
    .select("id, email, full_name, role, secondary_roles, active")
    .eq("id", id)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: "Unable to verify this account." }, { status: 503 });
  if (!target) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const { data: targetMemberships, error: membershipScopeError } = await admin.from("hotel_members")
    .select("user_id, hotel_id")
    .eq("user_id", id);
  if (membershipScopeError) return NextResponse.json({ error: "Unable to verify this account's property scope." }, { status: 503 });
  if (!(targetMemberships || []).some((membership) => membership.hotel_id === HOTEL_ID)) {
    return NextResponse.json({ error: "This account is not a member of this property." }, { status: 404 });
  }
  if ((targetMemberships || []).some((membership) => membership.hotel_id !== HOTEL_ID)) {
    return NextResponse.json({ error: "This account is shared with another property and must be managed centrally." }, { status: 409 });
  }

  const callerProfile = principal.profile;
  const callerId = principal.identity?.id ?? principal.profile.id;
  if (!callerCanChangeAccount(callerProfile, callerId, { id: target.id, role: target.role })) {
    return NextResponse.json({ error: "You cannot manage your own, an equal, or a superior CMPRI account." }, { status: 403 });
  }

  let proposedRole: string = typeof target.role === "string" ? target.role : "";
  if (body.role !== undefined) {
    const raw = typeof body.role === "string" ? body.role.trim() : "";
    const isKnownLabel = raw && (ASSIGNABLE_ROLE_LABELS as readonly string[]).includes(raw);
    if (!isKnownLabel || !callerCanAssignRole(callerProfile, raw)) {
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
    .select("id, email, full_name, role, secondary_roles, active")
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
      can_manage: callerCanChangeAccount(callerProfile, callerId, { id: data.id, role: data.role }),
    },
  });
}

/**
 * Account removal permanently purges CMPRI data (tickets, notes, assignments, AI
 * provenance, audit history) via the purge_cmpri_user database function, then
 * removes the Supabase Auth login. This requires service-role credentials.
 */
export async function DELETE(request: NextRequest) {
  const access = await requireCapability(request, "manage_users");
  if (!access) return NextResponse.json({ error: "User management access is required." }, { status: 403 });
  const { principal, admin } = access;

  const adminAuth = ensureServiceRoleAdmin(admin);
  if (!adminAuth) {
    return NextResponse.json({ error: "This deployment is missing Supabase service-role credentials. Set SUPABASE_SERVICE_ROLE_KEY before permanently removing an account." }, { status: 503 });
  }

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

  const { data: targetMemberships, error: membershipScopeError } = await admin.from("hotel_members")
    .select("user_id, hotel_id")
    .eq("user_id", id);
  if (membershipScopeError) return NextResponse.json({ error: "Unable to verify this account's property scope." }, { status: 503 });
  if (!(targetMemberships || []).some((membership) => membership.hotel_id === HOTEL_ID)) {
    return NextResponse.json({ error: "This account is not a member of this property." }, { status: 404 });
  }
  if ((targetMemberships || []).some((membership) => membership.hotel_id !== HOTEL_ID)) {
    return NextResponse.json({ error: "This account is shared with another property and must be managed centrally." }, { status: 409 });
  }

  const callerProfile = principal.profile;
  const callerId = principal.identity?.id ?? principal.profile.id;
  if (!callerCanChangeAccount(callerProfile, callerId, { id: target.id, role: target.role })) {
    return NextResponse.json({ error: "You cannot permanently remove your own, an equal, or a superior CMPRI account." }, { status: 403 });
  }

  const expected = (target.full_name || "").trim();
  if (!expected || confirmName !== expected) {
    return NextResponse.json({ error: "Type the account's full name exactly to confirm permanent removal." }, { status: 400 });
  }

  const { error: purgeError } = await admin.rpc("purge_cmpri_user", { target_id: id });
  if (purgeError) {
    return NextResponse.json({ error: `CMPRI data could not be fully purged: ${purgeError.message}. The Auth login was not deleted.` }, { status: 503 });
  }

  const deleteUser = adminAuth.deleteUser as ((userId: string) => Promise<{ error: { message?: string } | null }>) | undefined;
  const { error: authDeleteError } = deleteUser
    ? await deleteUser.call(adminAuth, id)
    : { error: { message: "Auth admin client is unavailable." } };
  if (authDeleteError) {
    return NextResponse.json({ error: `CMPRI data was purged, but the Auth login remains: ${authDeleteError.message || "unknown error"}. Remove it manually in Supabase Auth.` }, { status: 500 });
  }

  return NextResponse.json({ deleted: id, preserved_history: false });
}
