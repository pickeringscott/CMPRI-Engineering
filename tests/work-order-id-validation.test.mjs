import * as commonAreas from "../src/lib/cmpri-location-groups.ts";
import { ticketReadDependency } from "./helpers/load-ts.mjs";
import * as accountDisplay from "../src/lib/account-display.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const uuidExports = {};
vm.runInNewContext(ts.transpileModule(
  readFileSync(new URL('../src/lib/uuid.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, { exports: uuidExports });

function routeFixture(relativePath, config = {}) {
  const calls = [];
  const response = {
    json(body, init = {}) {
      return { body, status: init.status ?? 200 };
    },
  };
  const admin = {
    from(table) {
      calls.push(table);
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: config.workOrder ?? null, error: config.lookupError ? { message: 'failed' } : null }),
      };
      return query;
    },
  };
  const principal = {
    identity: { id: 'tester' },
    profile: { id: 'tester', role: 'Engineer', full_name: 'Test Engineer', active: true },
    membership: { user_id: 'tester', hotel_id: 'hotel', role: 'admin', active: true },
  };
  const auth = { requireUser: async () => config.authenticated === false ? null : { principal, admin } };
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};

  vm.runInNewContext(code, {
    exports,
    console,
    process: { env: {} },
    require(name) {if(name==='@/lib/server/work-order-mentions')return {persistMentionedWorkOrder:async()=>null};if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name);
      if (name === "@/lib/account-display") return accountDisplay;
      if (name === 'next/server') return { NextResponse: response };
      if (name === '@supabase/supabase-js') return { createClient: () => admin };
      if (name === 'server-only') return {};
      if (name === '@/lib/constants') return { HOTEL_ID: 'hotel' };
      if (name === '@/lib/supabase/config') return { SUPABASE_PUBLISHABLE_KEY: 'test', SUPABASE_URL: 'http://127.0.0.1' };
      if (name === '@/lib/server/access') return { allows: () => true };
      if (name === '@/lib/server/auth') return auth;
      if (name === '@/lib/work-order-categories') return { normalizeWorkOrderCategory: value => value };
      if (name === '@/lib/server/room-ranker') return { processRoomRankerSyncForWorkOrder: async () => {} };
      if (name === '@/lib/server/roles') return { profileIsChiefEngineer: () => false, profileIsEstablishedHoursChief: () => false, roleKey: value => String(value).toLowerCase() };
      if (name === '@/lib/server/work-order-notification-resolution') return {
        isEngineeringWorkOrderActor: () => false,
        recordEngineeringWorkOrderView: async () => undefined,
      };
      if (name === '@/lib/server/work-order-assignment') return { canAccessWorkOrderByAssignment: () => true };
      if (name === '@/lib/server/room-availability') return {
        currentRoomOperation:()=>null,currentRoomStatus: () => null,
        loadCurrentRoomStatuses: async () => ({ statuses: new Map(), error: null }),
      };
      if (name === '@/lib/work-order-edit-policy') return {
        TECHNICAL_WORK_ORDER_FIELDS: [],
        workOrderEditableFields: () => [],
      };
      if (name === '@/lib/uuid') return uuidExports;
      throw new Error(`Unexpected route dependency: ${name}`);
    },
  });

  const request = {
    headers: new Headers({ authorization: 'Bearer fixture' }),
    nextUrl: new URL('http://127.0.0.1/api/work-orders'),
    json: async () => ({ expected_revision: 1, status: 'In Progress' }),
    formData: async () => new FormData(),
  };
  return {
    calls,
    invoke: (method, id) => exports[method](request, { params: Promise.resolve({ id }) }),
  };
}

const paths = {
  detail: '../src/app/api/work-orders/[id]/route.ts',
  activity: '../src/app/api/work-orders/[id]/activity/route.ts',
  attachments: '../src/app/api/work-orders/[id]/attachments/route.ts',
};

test('all work-order ID routes reject malformed input before querying Supabase', async () => {
  for (const [kind, route] of Object.entries(paths)) {
    const methods = kind === 'detail' ? ['GET', 'PATCH', 'DELETE'] : kind === 'activity' ? ['GET'] : ['GET', 'POST'];
    for (const method of methods) {
      const fixture = routeFixture(route);
      assert.equal((await fixture.invoke(method, 'test-id')).status, 400, `${kind} ${method}`);
      assert.equal(fixture.calls.length, 0, `${kind} ${method} must not query`);
    }
  }
});

test('valid but nonexistent work-order IDs keep the not-found response', async () => {
  const id = '00000000-0000-0000-0000-000000000099';
  for (const [kind, route] of Object.entries(paths)) {
    const methods = kind === 'detail' ? ['GET'] : ['GET'];
    for (const method of methods) {
      const fixture = routeFixture(route);
      assert.equal((await fixture.invoke(method, id)).status, 404, `${kind} ${method}`);
      assert.equal(fixture.calls.length, 1, `${kind} ${method}`);
    }
  }
  const attachment = routeFixture(paths.attachments);
  assert.equal((await attachment.invoke('POST', id)).status, 404, 'attachments POST');
  assert.equal(attachment.calls.length, 1, 'attachments POST');
});

test('work-order ID validation uses canonical UUID shape', () => {
  assert.equal(uuidExports.isUuid('00000000-0000-0000-0000-000000000001'), true);
  assert.equal(uuidExports.isUuid('test-id'), false);
  assert.equal(uuidExports.isUuid('00000000-0000-0000-0000-000000000001x'), false);
});
