import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function compileModule(relativePath, dependencies = {}) {
  const exports = {};
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    exports,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected module dependency: ${name}`);
    },
  });
  return exports;
}

const roleModule = compileModule("../src/lib/server/roles.ts");
const accessModule = compileModule("../src/lib/server/access.ts", { "./roles": roleModule });

const capabilities = [
  "submit",
  "view_dashboard",
  "view_engineering_operations",
  "view_pool_log",
  "operate_pool_log",
  "receive_pool_closed_notifications",
  "view_work_orders",
  "add_work_order_notes",
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
const grantNames = [
  "manage_work_orders",
  "edit_work_orders",
  "update_work_orders",
  "approve_work_orders",
  "review_work_orders",
  "close_work_orders",
  "manage_assets",
  "manage_rooms",
  "manage_users",
  "manage_pm",
  "manage_integrations",
];

const roleCases = [
  { role: "Engineer", landing: "/engineering", membership: "admin" },
  { role: "Chief Engineer", landing: "/engineering", membership: "admin" },
  { role: "Engineering Manager", landing: "/engineering", membership: "admin" },
  { role: "Maintenance Technician", landing: "/technician", membership: "technician" },
  { role: "Technician", landing: "/technician", membership: "technician" },
  { role: "Regional Maintenance", landing: "/engineering", membership: "admin" },
  { role: "General Manager", landing: "/engineering", membership: "manager" },
  { role: "Assistant Manager", landing: "/engineering", membership: "technician" },
  { role: "Assistant General Manager", landing: "/engineering", membership: "technician" },
  { role: "Front Desk", landing: "/work-orders", membership: "technician" },
  { role: "Front Desk Manager", landing: "/engineering", membership: "technician" },
  { role: "Housekeeping", landing: "/work-orders", membership: "technician" },
  { role: "Lead Housekeeper", landing: "/work-orders", membership: "technician" },
  { role: "Senior Management", landing: "/engineering", membership: "viewer" },
  { role: "System Administrator", landing: "/engineering", membership: "admin" },
];
const hotelId = "c81ad01a-7a9f-4880-ac1c-5e849f30bad6";

const sessionSource = readFileSync(new URL("../src/app/api/session/route.ts", import.meta.url), "utf8");
const sessionCode = ts.transpileModule(sessionSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function makePrincipal(role) {
  const id = `user-${role.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return {
    identity: { id, email: `${id}@example.invalid` },
    profile: { id, role, secondary_roles: [], active: true, full_name: "Local Test User" },
    hotelId,
    membership: { user_id: id, hotel_id: hotelId, role: roleModule.membershipRole(role), active: true },
    permissions: grantNames.map((permission) => ({ role, permission, allowed: true })),
  };
}

test("every actual application role's /api/session capabilities match its role and membership policy", async () => {
  let principal = makePrincipal(roleCases[0].role);
  const exports = {};
  vm.runInNewContext(sessionCode, {
    exports,
    Response,
    require(name) {
      if (name === "@/lib/server/auth") return { requireUserAttempt: async () => ({ ok: true, principal }) };
      if (name === "@/lib/server/access") return accessModule;
      if (name === "@/lib/server/roles") return roleModule;
      throw new Error(`Unexpected session route dependency: ${name}`);
    },
  });

  for (const { role, landing, membership } of roleCases) {
    assert.equal(roleModule.roleAllows(role, "add_work_order_notes"), true, `${role} note capability`);
    principal = makePrincipal(role);
    const response = await exports.GET({});
    const body = await response.json();
    const expectedCapabilities = capabilities.filter((capability) => roleModule.roleAllows(role, capability));
    const grantedCapabilities = capabilities.filter((capability) => accessModule.allows(principal, capability));
    assert.equal(response.status, 200, `${role} session status`);
    assert.equal(body.user.role, role);
    assert.equal(body.landing, landing, `${role} landing`);
    assert.equal(principal.membership.role, membership, `${role} membership role`);
    assert.deepEqual(body.capabilities, expectedCapabilities, `${role} /api/session capabilities`);
    assert.deepEqual(body.capabilities, grantedCapabilities, `${role} UI/API capability source`);
  }
});

test("the three work-order-only manager roles cannot access engineering operations through broad memberships", () => {
  for (const role of ["General Manager", "Assistant General Manager", "Front Desk Manager"]) {
    const principal = makePrincipal(role);
    principal.membership.role = "admin";
    assert.equal(accessModule.allows(principal, "view_engineering_operations"), false, role);
  }
  for (const role of ["Chief Engineer", "Senior Management", "System Administrator"]) {
    assert.equal(accessModule.allows(makePrincipal(role), "view_engineering_operations"), true, role);
  }
});

test("Maintenance Technician receives workflow permissions but not engineering administration", () => {
  const principal = makePrincipal("Maintenance Technician");
  for (const capability of ["edit_tickets", "close_tickets", "view_pm", "operate_pool_log", "receive_pool_closed_notifications"]) {
    assert.equal(accessModule.allows(principal, capability), true, capability);
  }
  for (const capability of ["view_engineering_operations", "manage_assets", "manage_rooms", "manage_users", "operate_integrations", "review_tickets", "reopen"]) {
    assert.equal(accessModule.allows(principal, capability), false, capability);
  }
});

test("CMPRI go-live roles receive only their approved operational capabilities", () => {
  const expected = new Map([
    ["Housekeeping", ["submit", "add_work_order_notes", "submit_feedback", "view_profiles"]],
    ["Front Desk", ["submit", "add_work_order_notes", "submit_feedback", "view_profiles"]],
    ["Front Desk Manager", ["submit", "view_pool_log", "operate_pool_log", "view_work_orders", "add_work_order_notes", "receive_pool_closed_notifications", "submit_feedback", "view_profiles"]],
    ["Assistant General Manager", ["submit", "view_pool_log", "operate_pool_log", "view_work_orders", "add_work_order_notes", "receive_pool_closed_notifications", "submit_feedback", "view_profiles"]],
    ["General Manager", ["submit", "view_dashboard", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "view_work_orders", "add_work_order_notes", "view_pm", "view_profiles"]],
    ["Assistant Manager", ["submit", "view_pool_log", "operate_pool_log", "view_work_orders", "add_work_order_notes", "receive_pool_closed_notifications", "submit_feedback", "view_profiles"]],
    ["Maintenance Technician", ["submit", "add_work_order_notes", "view_dashboard", "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "edit_tickets", "close_tickets", "submit_feedback"]],
    ["Chief Engineer", ["submit", "add_work_order_notes", "view_dashboard", "view_engineering_operations", "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "edit_tickets", "review_tickets", "close_tickets", "reopen", "manage_assets", "manage_rooms", "manage_users", "operate_integrations", "submit_feedback", "review_feedback", "view_profiles"]],
    ["System Administrator", ["submit", "add_work_order_notes", "view_dashboard", "view_engineering_operations", "view_work_orders", "view_pm", "view_pool_log", "operate_pool_log", "receive_pool_closed_notifications", "edit_tickets", "review_tickets", "close_tickets", "reopen", "manage_assets", "manage_rooms", "manage_users", "operate_integrations", "submit_feedback", "review_feedback", "view_profiles"]],
  ]);
  for (const [role, approved] of expected) {
    const actual = capabilities.filter((capability) => accessModule.allows(makePrincipal(role), capability)).sort();
    assert.deepEqual(actual, [...approved].sort(), `${role} CMPRI permission set`);
  }
});
