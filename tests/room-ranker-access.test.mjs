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
    profile: { id: `account-${role}`, email, role, secondary_roles: email === "maint.cmpri@hawkeyehotels.com" ? ["engineer"] : [], active: true, full_name: role },
    hotelId: "test-hotel",
    membership: { user_id: `account-${role}`, hotel_id: "test-hotel", active: true, role: "admin" },
    permissions: [],
  };
}

function authenticate(role, email) {
  currentAuth = { principal: principal(role, email), admin: {} };
}

test("Room Ranker policy checks secondary roles and both account email identities", () => {
  const viewer = principal("Chief Engineer");
  viewer.profile.secondary_roles = ["technician"];
  assert.equal(accessPolicy.canViewRoomRanker(viewer), true);
  assert.equal(accessPolicy.canEditRoomRanker(viewer), false);
  assert.equal(accessPolicy.canAccessTroubleshootingGuides(viewer.profile), false);
  const scott = principal("System Administrator", "maint.cmpri@hawkeyehotels.com");
  scott.profile.email = "another@example.invalid";
  assert.equal(accessPolicy.canViewRoomRanker(scott), true, "engineer secondary role grants legacy read regardless of email");
  assert.equal(accessPolicy.canEditRoomRanker(scott), false);
});

test("legacy Ranker endpoints deny all roles without provider calls",async()=>{
 for(const role of ["Chief Engineer","General Manager","Front Desk","System Administrator"]){
  authenticate(role);
  for(const response of [await apiRoute.GET(),await apiRoute.PATCH(),await syncRoute.GET(),await syncRoute.POST()])assert.equal(response.status,410);
 }
 assert.equal(roomRankerCalls.length,0);assert.equal(syncCalls.length,0);
});

test("guide visibility preserves management roles and excludes engineering and technician identities", () => {
 for(const role of ["General Manager","Assistant General Manager","Front Desk Manager"]) assert.equal(accessPolicy.canAccessTroubleshootingGuides({role}),true,role);
 for(const role of ["Engineer","Chief Engineer","Engineering Manager","Regional Maintenance","Technician","Maintenance Technician","System Administrator","Front Desk","Lead Housekeeper"]) assert.equal(accessPolicy.canAccessTroubleshootingGuides({role}),false,role);
 assert.equal(accessPolicy.canAccessTroubleshootingGuides({role:"system_admin",email:"maint.cmpri@hawkeyehotels.com",secondary_roles:["engineer"]}),false);
 assert.equal(accessPolicy.canAccessTroubleshootingGuides({role:"manager",secondary_roles:["technician"]}),false);
 const technician=readFileSync(new URL("../src/app/technician/page.tsx",import.meta.url),"utf8");
 assert.doesNotMatch(technician,/TroubleshootingGuideDropdown/);
});
