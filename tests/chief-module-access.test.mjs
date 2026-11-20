import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const policy = loadTs("src/lib/dashboard/chief-module-access.ts");
const { allows } = loadTs("src/lib/server/access.ts");

function principal(role = "senior_management") {
  return {
    identity: { id: "member", email: "member@example.invalid" },
    profile: { id: "member", role, active: true },
    hotelId: "property",
    membership: { user_id: "member", hotel_id: "property", role: "viewer", active: true },
    permissions: [],
  };
}

function reader(auth) {
  const { requireChiefModuleRead } = loadTs("src/lib/server/chief-module-read.ts", {
    "@/lib/dashboard/chief-module-access": policy,
    "./access": { allows },
    "./auth": { requireUserAttempt: async () => auth },
  });
  return capability => requireChiefModuleRead({}, capability);
}

test("Chief menu grants Senior Management property-scoped reads, without management capabilities", async () => {
  const actor = principal();
  const authenticate = reader({ ok: true, principal: actor, mcp: false, admin: {} });
  assert.equal(policy.canReadChiefModules(actor.profile), true);
  assert.equal(policy.canReadChiefModules({ role: "manager" }), false);
  for (const capability of ["manage_assets", "manage_users", "review_feedback"]) {
    assert.equal(allows(actor, capability), false);
    assert.equal((await authenticate(capability))?.canManage, false, capability);
  }
});

test("the additional reads require the matching active property and a signed-in browser", async () => {
  const actor = principal();
  const invalid = [
    principal("manager"),
    principal("front_desk"),
    { ...actor, identity: { id: "someone-else" } },
    { ...actor, profile: { ...actor.profile, active: false } },
    { ...actor, membership: { ...actor.membership, active: false } },
    { ...actor, membership: { ...actor.membership, user_id: "someone-else" } },
    { ...actor, membership: { ...actor.membership, hotel_id: "other-property" } },
  ];
  for (const candidate of invalid) {
    const authenticate = reader({ ok: true, principal: candidate, mcp: false });
    assert.equal(await authenticate("manage_assets"), null);
  }
  assert.equal(await reader({ ok: false })("manage_assets"), null);
  assert.equal(await reader({ ok: true, principal: actor, mcp: true })("manage_assets"), null);
});

test("original management access still determines whether controls are available", async () => {
  const actor = principal("system_admin");
  actor.membership.role = "admin";
  for (const mcp of [false, true]) {
    const authenticate = reader({ ok: true, principal: actor, mcp });
    for (const capability of ["manage_assets", "manage_users", "review_feedback"]) {
      assert.equal((await authenticate(capability))?.canManage, true, capability);
    }
  }
});
