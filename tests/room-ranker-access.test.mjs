import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

function load(relativePath, dependencies = {}) {
  const source = readFileSync(path.join(sourceRoot, relativePath), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    process,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected import ${name} from ${relativePath}`);
    },
  });
  return exports;
}

const roleModule = load("lib/server/roles.ts");
const accessPolicy = load("lib/room-ranker-access.ts", {
  "@/lib/server/roles": roleModule,
});

let currentAuth = null;
let roomRankerCalls = [];
const apiRoute = load("app/api/room-ranker/route.ts", {
  "next/server": {
    NextResponse: {
      json(body, init = {}) {
        const status = init.status ?? 200;
        return { status, ok: status >= 200 && status < 300, headers: init.headers, json: async () => body };
      },
    },
  },
  "@/lib/server/auth": { requireUser: async () => currentAuth },
  "@/lib/integrations/spreadsheet-input": {
    jsonObject: async (request) => request.json(),
    rankerUpdate: (payload) => ({ action: "update", ...payload }),
  },
  "@/lib/server/room-ranker": {
    callRoomRanker: async (payload) => {
      roomRankerCalls.push(payload);
      return payload.action === "read" ? { ok: true, rooms: [], fetchedAt: "2026-10-09T00:00:00.000Z" } : { ok: true };
    },
  },
  "@/lib/server/integrations-safe-mode": {
    integrationErrorMessage: (error) => String(error),
    integrationErrorStatus: () => 503,
    isIntegrationsSafeMode: () => false,
  },
  "@/lib/room-ranker-access": accessPolicy,
});

const cronAdmin = { service: true };
let syncCalls = [];
const syncRoute = load("app/api/integrations/room-ranker/sync/route.ts", {
  "next/server": {
    NextResponse: {
      json(body, init = {}) {
        const status = init.status ?? 200;
        return { status, ok: status >= 200 && status < 300, json: async () => body };
      },
    },
  },
  "@/lib/server/auth": { requireUser: async () => currentAuth },
  "@/lib/server/supabase-admin": { createSupabaseAdmin: () => cronAdmin },
  "@/lib/server/room-ranker": {
    processDueRoomRankerSync: async (admin) => {
      syncCalls.push(admin);
      return [];
    },
  },
  "@/lib/server/integrations-safe-mode": { integrationErrorMessage: (error) => String(error) },
  "@/lib/room-ranker-access": accessPolicy,
});

function principal(role, email = `${role.toLowerCase().replace(/[^a-z]+/g, "-")}@example.invalid`) {
  return {
    identity: { id: `account-${role}`, email },
    profile: { id: `account-${role}`, email, role, secondary_roles: [], active: true, full_name: role },
    hotelId: "test-hotel",
    membership: { user_id: `account-${role}`, hotel_id: "test-hotel", active: true, role: "admin" },
    permissions: [],
  };
}

function authenticate(role, email) {
  currentAuth = { principal: principal(role, email), admin: {} };
}

test("Room Ranker page entry points and work-order context use the shared viewer policy", () => {
  const engineering = readFileSync(new URL("../src/app/engineering/page.tsx", import.meta.url), "utf8");
  const technician = readFileSync(new URL("../src/app/technician/page.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../src/app/work-orders/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(engineering, /canViewRanker && \{ key: "\/engineering\/room-ranker"/);
  assert.match(technician, /roomRankerProfileCanView\(account, account\.email\) && \([\s\S]*?data-cmpri-modal-href="\/engineering\/room-ranker"/);
  assert.match(detail, /const canViewRanker = roomRankerProfileCanView\(current\.user, current\.user\.email\)/);
  assert.match(detail, /if \(canViewRanker\) \{[\s\S]*?fetch\("\/api\/room-ranker"/);
  assert.match(detail, /roomRankerProfileCanView\(cmpriSession\.user, cmpriSession\.user\.email\) && \(/);
});

test("Room Ranker policy checks secondary roles and both account email identities", () => {
  const viewer = principal("Chief Engineer");
  viewer.profile.secondary_roles = ["technician"];
  assert.equal(accessPolicy.canViewRoomRanker(viewer), true);
  assert.equal(accessPolicy.canEditRoomRanker(viewer), false);
  assert.equal(accessPolicy.canAccessTroubleshootingGuides(viewer.profile), true);
  const scott = principal("System Administrator", "maint.cmpri@hawkeyehotels.com");
  scott.profile.email = "another@example.invalid";
  assert.equal(accessPolicy.canViewRoomRanker(scott), false);
  assert.equal(accessPolicy.canEditRoomRanker(scott), false);
});

test("Room Ranker read access is limited to the four requested roles and Scott's mapped account", async () => {
  roomRankerCalls = [];
  for (const role of ["Front Desk Manager", "Assistant General Manager", "Maintenance Technician", "General Manager"]) {
    authenticate(role);
    const response = await apiRoute.GET({});
    assert.equal(response.status, 200, role);
    assert.equal((await response.json()).can_edit, false, role);
  }

  authenticate("Chief Engineer");
  assert.equal((await apiRoute.GET({})).status, 403, "other Chief Engineers must not be granted access");
  authenticate("System Administrator", "pickering.scott@gmail.com");
  assert.equal((await apiRoute.GET({})).status, 403, "other system administrators must not be granted access");

  authenticate("System Administrator", "maint.cmpri@hawkeyehotels.com");
  const scottResponse = await apiRoute.GET({});
  assert.equal(scottResponse.status, 200);
  assert.equal((await scottResponse.json()).can_edit, true);
  assert.equal(roomRankerCalls.length, 5);
  assert.ok(roomRankerCalls.every((call) => call.action === "read"));
});

test("direct Room Ranker PATCH requests reject viewers and other administrators before writing", async () => {
  roomRankerCalls = [];
  authenticate("Maintenance Technician");
  const readOnlyResponse = await apiRoute.PATCH({ json: async () => ({ rowNumber: 2, rank: "A" }) });
  assert.equal(readOnlyResponse.status, 403);

  authenticate("System Administrator", "pickering.scott@gmail.com");
  const otherAdminResponse = await apiRoute.PATCH({ json: async () => ({ rowNumber: 2, rank: "A" }) });
  assert.equal(otherAdminResponse.status, 403);
  assert.equal(roomRankerCalls.length, 0);

  authenticate("System Administrator", "maint.cmpri@hawkeyehotels.com");
  const scottResponse = await apiRoute.PATCH({ json: async () => ({ rowNumber: 2, expectedRoom: "101", rank: "A" }) });
  assert.equal(scottResponse.status, 200);
  assert.deepEqual(roomRankerCalls, [{ action: "update", rowNumber: 2, expectedRoom: "101", rank: "A" }]);
});

test("authenticated Room Ranker sync is Scott-only while the server cron path remains available", async () => {
  syncCalls = [];
  authenticate("General Manager");
  assert.equal((await syncRoute.POST({ headers: { get: () => "Bearer viewer-token" } })).status, 401);

  authenticate("System Administrator", "pickering.scott@gmail.com");
  assert.equal((await syncRoute.POST({ headers: { get: () => "Bearer other-admin-token" } })).status, 401);
  assert.equal(syncCalls.length, 0);

  authenticate("System Administrator", "maint.cmpri@hawkeyehotels.com");
  assert.equal((await syncRoute.POST({ headers: { get: () => "Bearer scott-token" } })).status, 200);
  assert.equal(syncCalls[0], currentAuth.admin);

  const priorCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "room-ranker-test-cron-secret";
  try {
    assert.equal((await syncRoute.POST({
      headers: { get: (name) => name.toLowerCase() === "authorization" ? "Bearer room-ranker-test-cron-secret" : null },
    })).status, 200);
    assert.equal(syncCalls[1], cronAdmin);
  } finally {
    if (priorCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = priorCronSecret;
  }
});
