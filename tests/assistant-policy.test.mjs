import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assistantPolicy } from "../src/lib/ai/assistant-policy.ts";

function policy(role, denied = []) {
  const roles = {
    engineer: ["viewDashboard", "submit", "editTickets", "reviewTickets", "manageAssets", "operateIntegrations"],
    manager: ["viewDashboard", "submit", "reviewTickets"],
    technician: ["viewDashboard", "submit", "editTickets"],
    frontDesk: ["submit"],
    seniorManagement: ["viewDashboard"],
  };
  const granted = roles[role] || [];
  const capabilities = Object.fromEntries(
    ["viewDashboard", "submit", "editTickets", "reviewTickets", "manageAssets", "operateIntegrations"]
      .map((name) => [name, granted.includes(name) && !denied.includes(name)]),
  );
  return assistantPolicy(capabilities, {
    canRead: ["engineer", "technician"].includes(role),
    canEdit: role === "engineer" && capabilities.manageAssets,
    assignedWorkOnly: role === "technician",
  });
}

test("assistant action map follows existing engineer permissions", () => {
  const access = policy("engineer");
  assert.deepEqual(access, {
    readAllWorkOrders: true,
    readAssignedWorkOrders: false,
    readOwnWorkOrders: false,
    createWorkOrders: true,
    updateWorkOrders: true,
    importRoomOperations: true,
    readEquipment: true,
    manageEquipment: true,
    readPm: true,
    updatePm: true,
    readReports: true,
  });
});

test("technician assistant access is assigned work and equipment only", () => {
  const access = policy("technician");
  assert.equal(access.readAllWorkOrders, false);
  assert.equal(access.readAssignedWorkOrders, true);
  assert.equal(access.readOwnWorkOrders, false);
  assert.equal(access.readEquipment, true);
  assert.equal(access.createWorkOrders, true);
  assert.equal(access.updatePm, false);
  assert.equal(access.importRoomOperations, true);
});

test("submit-only assistant access is limited to own tickets and creation", () => {
  const access = policy("frontDesk");
  assert.equal(access.readAllWorkOrders, false);
  assert.equal(access.readOwnWorkOrders, true);
  assert.equal(access.createWorkOrders, true);
  assert.equal(access.updateWorkOrders, false);
  assert.equal(access.importRoomOperations, false);
  assert.equal(access.readEquipment, false);
  assert.equal(access.readPm, false);
});

test("read-only senior management cannot perform mutations", () => {
  const access = policy("seniorManagement");
  assert.equal(access.readAllWorkOrders, true);
  assert.equal(access.updateWorkOrders, false);
  assert.equal(access.createWorkOrders, false);
  assert.equal(access.importRoomOperations, false);
  assert.equal(access.manageEquipment, false);
  assert.equal(access.updatePm, false);
});

test("database-denied grants fail closed for assistant mutations", () => {
  const access = policy("engineer", ["manageAssets"]);
  assert.equal(access.manageEquipment, false);
  assert.equal(access.createWorkOrders, true);
});

test("assistant diagnostics expose provider state without returning the API key", () => {
  const route = readFileSync(new URL("../src/app/api/assistant/route.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/components/DashboardAssistant.tsx", import.meta.url), "utf8");
  assert.match(route, /export async function GET\(request: NextRequest\)/);
  assert.match(route, /state: "key_missing"/);
  assert.match(route, /Vercel lists OPENAI_API_KEY for this project, but this deployed function received no usable value/);
  assert.match(route, /client\.models\.list\(\)/);
  assert.doesNotMatch(route, /JSON\.stringify\(\{[^}]*OPENAI_API_KEY/s);
  assert.match(client, /data-ai-state=\{diagnostic\.state\}/);
  assert.match(client, /diagnostic\?\.ok !== true/);
});

test("CMPRI AI callable tools are reachable from the shared app layout", () => {
  const layout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/components/DashboardAssistant.tsx", import.meta.url), "utf8");
  assert.match(layout, /import DashboardAssistant from "@\/components\/DashboardAssistant"/);
  assert.match(layout, /<DashboardAssistant \/>/);
  assert.match(client, /if \(!authenticated \|\| !isDashboard\) return null/);
  assert.match(client, /<section aria-label="CMPRI AI assistant"/);
  assert.doesNotMatch(client, /fixed bottom-4 right-4/);
  assert.doesNotMatch(client, /Open CMPRI AI assistant/);
});

test("Daily Room Ops AI prepares only for edit-ticket roles and waits for UI confirmation", () => {
  const route = readFileSync(new URL("../src/app/api/assistant/route.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/components/DashboardAssistant.tsx", import.meta.url), "utf8");
  const importer = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(access\.importRoomOperations\) allowedNames\.add\("prepare_room_operations_import"\)/);
  assert.match(route, /This only prepares the preview; it never imports or replaces the saved daily snapshot/);
  const toolStart = route.indexOf("prepare_room_operations_import:");
  const toolEnd = route.indexOf("\n};", toolStart);
  assert.ok(toolStart >= 0 && toolEnd > toolStart);
  assert.doesNotMatch(route.slice(toolStart, toolEnd), /guest_arrival_date/, "guest-specific arrival dates must not be sent to the model");
  assert.match(client, /Confirm import/);
  assert.match(client, /source: "ai"/);
  assert.match(route, /This will replace the entire saved daily room-operations snapshot/);
  assert.match(importer, /requireCapability\(request, "edit_tickets"\)/);
});

test("room-operations repair uses the existing schema and service-role RPC unchanged", () => {
  const schema = readFileSync(new URL("../supabase/cmpri_v1_0_room_operations.sql", import.meta.url), "utf8");
  const importer = readFileSync(new URL("../src/app/api/room-operations/route.ts", import.meta.url), "utf8");
  assert.match(schema, /source_type text not null check \(source_type in \('paste', 'file', 'photo'\)\)/);
  assert.match(schema, /create or replace function public\.cmpri_replace_room_operations/);
  assert.match(schema, /if auth\.role\(\) <> 'service_role'/i);
  assert.match(schema, /grant execute on function public\.cmpri_replace_room_operations[\s\S]*to service_role/i);
  assert.match(importer, /auth\.admin\.rpc\("cmpri_replace_room_operations"/);
  assert.doesNotMatch(importer, /create table|alter table/i);
});