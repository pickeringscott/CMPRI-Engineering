const PROJECT_REF = "uavotsoanubpowvyqaii";
const HOTEL_ID = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";
const GO_LIVE_ROLES = [
  "housekeeping",
  "front_desk",
  "front_desk_manager",
  "assistant_manager",
  "manager",
  "technician",
  "engineer",
  "system_admin",
];
const SUBMIT_ONLY_CAPABILITIES = ["submit", "submit_feedback", "view_profiles"];
const NOTE_AND_POOL_CAPABILITIES = [
  "submit",
  "view_pool_log",
  "operate_pool_log",
  "receive_pool_closed_notifications",
  "view_work_orders",
  "add_work_order_notes",
  "submit_feedback",
  "view_profiles",
];
const ENGINEERING_CAPABILITIES = [
  "submit",
  "view_dashboard",
  "view_engineering_operations",
  "view_pool_log",
  "operate_pool_log",
  "receive_pool_closed_notifications",
  "view_work_orders",
  "view_pm",
  "edit_tickets",
  "review_tickets",
  "close_tickets",
  "reopen",
  "manage_assets",
  "manage_rooms",
  "manage_users",
  "submit_feedback",
  "review_feedback",
  "view_profiles",
  "operate_integrations",
];
const EXPECTED_CAPABILITIES = {
  front_desk: SUBMIT_ONLY_CAPABILITIES,
  housekeeping: SUBMIT_ONLY_CAPABILITIES,
  front_desk_manager: NOTE_AND_POOL_CAPABILITIES,
  assistant_manager: NOTE_AND_POOL_CAPABILITIES,
  manager: [
    "submit",
    "view_dashboard",
    "view_pool_log",
    "operate_pool_log",
    "receive_pool_closed_notifications",
    "view_work_orders",
    "add_work_order_notes",
    "view_pm",
    "view_profiles",
  ],
  technician: [
    "submit",
    "view_dashboard",
    "view_work_orders",
    "view_pm",
    "view_pool_log",
    "operate_pool_log",
    "receive_pool_closed_notifications",
    "edit_tickets",
    "close_tickets",
    "submit_feedback",
  ],
  engineer: ENGINEERING_CAPABILITIES,
  system_admin: ENGINEERING_CAPABILITIES,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  assert(value && value !== "[SENSITIVE]", `${name} is missing or still contains a placeholder.`);
  return value;
}

function isTestMarked(user) {
  return /test|audit|example\.invalid/i.test(
    `${user.email ?? ""} ${JSON.stringify(user.user_metadata ?? {})}`,
  );
}

function expectedLanding(role) {
  if (["front_desk", "housekeeping"].includes(role)) return "/work-orders";
  if (role === "technician") return "/technician";
  if (["engineer", "manager", "assistant_manager", "front_desk_manager", "senior_management", "system_admin"].includes(role)) {
    return "/engineering";
  }
  return null;
}

function roleKey(role) {
  const normalized = String(role ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const aliases = {
    frontdesk: "front_desk",
    assistantmanager: "assistant_manager",
    generalmanager: "manager",
    assistantgeneralmanager: "assistant_manager",
    frontdeskmanager: "front_desk_manager",
    maintenancetechnician: "technician",
    systemadmin: "system_admin",
    systemadministrator: "system_admin",
  };
  return aliases[normalized] ?? normalized;
}

const args = new Set(process.argv.slice(2));
assert(
  args.has("--confirm-production-read-only-auth-smoke"),
  "Pass --confirm-production-read-only-auth-smoke to permit ephemeral test-account sign-ins.",
);

const supabaseUrl = new URL(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"));
assert(
  supabaseUrl.hostname === `${PROJECT_REF}.supabase.co`,
  "Refusing to run: Supabase URL is not the CMPRI production project.",
);
const appUrl = new URL(
  process.env.CMRI_PRODUCTION_SMOKE_APP_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || "",
);
assert(
  ["www.cmpri-engineering.com", "cmpri-engineering.com"].includes(appUrl.hostname)
    && appUrl.protocol === "https:",
  "Refusing to run: app URL is not the CMPRI production site.",
);

const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const adminHeaders = {
  apikey: serviceKey,
  authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
};
const publicHeaders = {
  apikey: publishableKey,
  "content-type": "application/json",
};
const baseUrl = supabaseUrl.origin;

async function getTestUsers() {
  const response = await fetch(`${baseUrl}/auth/v1/admin/users?per_page=100`, {
    headers: adminHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Could not enumerate test-account candidates (HTTP ${response.status}).`);
  const users = (await response.json()).users ?? [];
  const markedUsers = users.filter(isTestMarked);
  assert(markedUsers.length > 0, "No explicitly test-marked accounts are available.");

  const ids = markedUsers.map((user) => user.id).join(",");
  const profileResponse = await fetch(
    `${baseUrl}/rest/v1/profiles?select=id,role,active&id=in.(${ids})`,
    { headers: adminHeaders, signal: AbortSignal.timeout(30_000) },
  );
  assert(profileResponse.ok, `Could not inspect test account roles (HTTP ${profileResponse.status}).`);
  const profiles = await profileResponse.json();

  const membershipResponse = await fetch(
    `${baseUrl}/rest/v1/hotel_members?select=user_id,role,active&hotel_id=eq.${HOTEL_ID}&user_id=in.(${ids})`,
    { headers: adminHeaders, signal: AbortSignal.timeout(30_000) },
  );
  assert(membershipResponse.ok, `Could not inspect test account memberships (HTTP ${membershipResponse.status}).`);
  const memberships = await membershipResponse.json();
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const membershipById = new Map(memberships.map((membership) => [membership.user_id, membership]));

  return markedUsers.flatMap((user) => {
    const profile = profileById.get(user.id);
    if (!profile) return [];
    return [{
      user,
      profile,
      membership: membershipById.get(user.id) ?? null,
    }];
  });
}

async function createTestSession(email) {
  const linkResponse = await fetch(`${baseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ type: "magiclink", email }),
    signal: AbortSignal.timeout(30_000),
  });
  assert(linkResponse.ok, `One-time test sign-in link generation failed (HTTP ${linkResponse.status}).`);
  const tokenHash = (await linkResponse.json()).hashed_token;
  assert(tokenHash, "Supabase did not return a one-time token hash.");

  const sessionResponse = await fetch(`${baseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
    signal: AbortSignal.timeout(30_000),
  });
  assert(sessionResponse.ok, `One-time test session exchange failed (HTTP ${sessionResponse.status}).`);
  const session = await sessionResponse.json();
  assert(session.access_token, "Supabase did not return an access token.");
  return session.access_token;
}

async function revokeTestSession(accessToken) {
  const response = await fetch(`${baseUrl}/auth/v1/logout`, {
    method: "POST",
    headers: { ...publicHeaders, authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert([200, 204].includes(response.status), `Test session revocation failed (HTTP ${response.status}).`);
}

async function checkActiveTestUser(entry) {
  const role = roleKey(entry.profile.role);
  const expected = EXPECTED_CAPABILITIES[role];
  assert(expected, `No role expectation is defined for active test role ${role}.`);
  assert(entry.membership?.active === true, `Active test role ${role} lacks active CMPRI membership.`);

  let accessToken;
  try {
    accessToken = await createTestSession(entry.user.email);
    const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
    const sessionResponse = await fetch(`${appUrl.origin}/api/session`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    assert(sessionResponse.ok, `Production session endpoint failed for test role ${role} (HTTP ${sessionResponse.status}).`);
    const session = await sessionResponse.json();
    assert(roleKey(session.user?.role) === role, `Production session role mismatch for test role ${role}.`);
    assert(session.landing === expectedLanding(role), `Production landing route mismatch for test role ${role}.`);
    assert(
      JSON.stringify([...session.capabilities].sort()) === JSON.stringify([...expected].sort()),
      `Production capabilities do not match the expected ${role} capability set.`,
    );

    const profileResponse = await fetch(`${appUrl.origin}/api/profile`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    assert(profileResponse.ok, `Own-profile GET failed for test role ${role} (HTTP ${profileResponse.status}).`);
    const profile = await profileResponse.json();
    assert(roleKey(profile.profile?.role) === role, `Own-profile role mismatch for test role ${role}.`);
    console.log(`PASS active test role=${role}: sign-in, exact session capabilities, landing, own-profile GET`);
  } finally {
    if (accessToken) {
      await revokeTestSession(accessToken);
      console.log(`PASS test session revoked for role=${role}`);
    }
  }
}

async function checkInactiveTestUser(entry) {
  const role = roleKey(entry.profile.role);
  let accessToken;
  try {
    accessToken = await createTestSession(entry.user.email);
    const headers = { authorization: `Bearer ${accessToken}` };
    const sessionResponse = await fetch(`${appUrl.origin}/api/session`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const session = await sessionResponse.json();
    assert(
      sessionResponse.status === 401 && session.reason === "profile-inactive",
      `Inactive test role ${role} was not rejected by /api/session.`,
    );

    const workOrdersResponse = await fetch(`${appUrl.origin}/api/work-orders?mode=dashboard`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    assert(
      workOrdersResponse.status === 401,
      `Inactive test role ${role} reached work-order access (HTTP ${workOrdersResponse.status}).`,
    );
    console.log(`PASS inactive test role=${role}: session and work-order access rejected`);
  } finally {
    if (accessToken) {
      await revokeTestSession(accessToken);
      console.log(`PASS test session revoked for inactive role=${role}`);
    }
  }
}

const entries = await getTestUsers();
const active = entries.filter((entry) => entry.profile.active === true);
const inactive = entries.filter((entry) => entry.profile.active !== true);
const availableRoles = [...new Set(active.map((entry) => roleKey(entry.profile.role)))].sort();
console.log(
  `Marked accounts=${entries.length}; active test roles=${availableRoles.join(",") || "none"}; inactive test accounts=${inactive.length}.`,
);

let passed = 0;
for (const entry of active) {
  await checkActiveTestUser(entry);
  passed += 1;
}
for (const entry of inactive) {
  await checkInactiveTestUser(entry);
  passed += 1;
}

const unavailableRoles = GO_LIVE_ROLES.filter((role) => !availableRoles.includes(role));
console.log(
  `Authenticated test-account checks passed=${passed}; no work orders, pool logs, assets, attachments, or user records were read or changed.`,
);
if (unavailableRoles.length) {
  console.log(`No active marked production fixtures for roles: ${unavailableRoles.join(", ")}.`);
}
