import * as commonAreas from "../src/lib/cmpri-location-groups.ts";
import { ticketReadDependency } from "./helpers/load-ts.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fetchAllPages } from '../src/lib/server/paginated-query.ts';
import { EQUIPMENT_SELECTION_COLUMNS } from '../src/lib/equipment-selection.ts';
import { newlyAvailableTechnicianWork } from '../src/lib/dashboard/technician-work-notifications.ts';

const routePath = new URL('../src/app/api/work-orders/route.ts', import.meta.url);
const routeCode = ts.transpileModule(readFileSync(routePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(config = {}) {
  const calls = [];
  const profile = config.profile ?? { active: true, role: 'Maintenance Technician', full_name: 'Morgan Lee' };
  const rows = config.workOrders ?? [];
  const db = {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(field, value) { filters.push(['eq', field, value]); return query; },
        neq(field, value) { filters.push(['neq', field, value]); return query; },
        in(field, value) { filters.push(['in', field, value]); return query; },
        or(expression) { filters.push(['or', expression]); return query; },
        limit() { return query; },
        range() { return query; },
        order() { return query; },
        then(resolve, reject) {
          calls.push({ table, filters });
          const data = rows.filter((row) => filters.every(([operator, field, value]) => {
            if (operator === 'eq') return row[field] === value;
            if (operator === 'neq') return row[field] !== value;
            if (operator === 'in') return value.includes(row[field]);
            if (field.startsWith('status.in.')) return ['Open','In Progress'].includes(row.status) || row.status === 'Closed' && row.created_by === principal.identity.id || row.technician_name == null || row.technician_name === '' || row.technician_name === profile.full_name;
            return row.technician_name == null || row.technician_name === '';
          }));
          return Promise.resolve({
            data,
            error: config.queryError ? { message: 'database unavailable' } : null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const principal = { profile, hotelId: 'hotel-id', identity: { id: '00000000-0000-4000-8000-000000000001' } };
  const exports = {};
  vm.runInNewContext(routeCode, {
    exports,
    process: { env: {} },
    require(name) {if(name === "@/lib/cmpri-location-groups") return commonAreas;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name, () => true);
      if (name === 'next/server') return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
      if (name === '@supabase/supabase-js') return { createClient: () => db };
      if (name === '@/lib/constants') return { HOTEL_ID: 'hotel-id' };
      if (name === '@/lib/supabase/config') return { SUPABASE_URL: 'https://example.invalid', SUPABASE_PUBLISHABLE_KEY: 'public-key' };
      if (name === '@/lib/server/access') return { allows: () => true };
      if (name === '@/lib/server/auth') return { requireUser: async () => ({ principal, admin: db }) };
      if (name === '@/lib/server/request-auth') return { authenticatedUser: async () => null };
      if (name === '@/lib/server/roles') return {
        roleAllows: (role, capability) => config.allowed !== false && role === 'Maintenance Technician' && capability === 'edit_tickets',
        roleKey: (role) => String(role).toLowerCase().includes('technician') ? 'technician' : 'unknown',
        isFrontDesk: () => false,
        isSubmitOnlyRole: () => false,
        canSuperviseDraftRole: () => false,
      };
      if (name === '@/lib/server/supabase-admin') return { createSupabaseAdmin: () => db };
      if (name === '@/lib/integrations/spreadsheet-input') return { jsonObject: async () => null };
      if (name === '@/lib/work-order-attribution') return { validFirstName: () => false, workOrderAttribution: () => ({}) };
      if (name === '@/lib/work-order-duplicates') return { likelyDuplicate: () => false };
      if (name === '@/lib/equipment-selection') return { EQUIPMENT_SELECTION_COLUMNS };
      if (name === '@/lib/work-order-suggestions') return { inferWorkOrder: () => ({}), separateIssueFromReporterNotes: () => ({}) };
      if (name === '@/lib/work-order-categories') return { normalizeWorkOrderCategory: () => null };
      if (name === '@/lib/server/room-ranker') return { processRoomRankerSyncForWorkOrder: async () => ({}) };
      if (name === '@/lib/server/room-availability') return {
        currentRoomOperation: () => null,
        loadCurrentRoomStatuses: async () => ({ date: '2026-10-01', statuses: new Map(), operations: new Map(), error: null }),
        currentRoomStatus: () => null,
      };
      if (name === '@/lib/server/paginated-query') return { fetchAllPages };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const request = { nextUrl: { searchParams: new URLSearchParams(`mode=${config.mode ?? 'technician'}`) } };
  return { run: () => exports.GET(request), calls };
}

test('technician coverage includes their assigned and unassigned open work only', async () => {
  const f = fixture({
    workOrders: [
      { id: 'assigned-self', hotel_id: 'hotel-id', technician_name: 'Morgan Lee', status: 'Open' },
      { id: 'assigned-self-progress', hotel_id: 'hotel-id', technician_name: 'Morgan Lee', status: 'In Progress' },
      { id: 'unassigned-null', hotel_id: 'hotel-id', technician_name: null, status: 'Open' },
      { id: 'unassigned-empty', hotel_id: 'hotel-id', technician_name: '', status: 'Open' },
      { id: 'unassigned-progress', hotel_id: 'hotel-id', technician_name: '', status: 'In Progress' },
      { id: 'assigned-other', hotel_id: 'hotel-id', technician_name: 'Taylor Smith', status: 'Open' },
      { id: 'pending-unassigned', hotel_id: 'hotel-id', technician_name: null, status: 'Pending Verification' },
      { id: 'pending-assigned', hotel_id: 'hotel-id', technician_name: 'Morgan Lee', status: 'Pending Verification' },
      { id: 'completed-unassigned', hotel_id: 'hotel-id', technician_name: null, status: 'Completed' },
      { id: 'closed', hotel_id: 'hotel-id', technician_name: null, status: 'Closed' },
      { id: 'other-hotel', hotel_id: 'another-hotel', technician_name: null, status: 'Open' },
    ],
  });
  const response = await f.run();
  assert.equal(response.status, 200);
  assert.deepEqual(
    Array.from(response.body.work_orders, (order) => order.id).sort(),
    ['assigned-self', 'assigned-self-progress', 'unassigned-empty', 'unassigned-null', 'unassigned-progress'],
  );
  assert.equal(f.calls.length, 2);
});

test('technician with no profile name still receives unassigned work only', async () => {
  const f = fixture({
    profile: { active: true, role: 'Maintenance Technician', full_name: null },
    workOrders: [
      { id: 'unassigned', hotel_id: 'hotel-id', technician_name: null, status: 'Open' },
      { id: 'assigned', hotel_id: 'hotel-id', technician_name: 'Morgan Lee', status: 'Open' },
    ],
  });
  const response = await f.run();
  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(response.body.work_orders, (order) => order.id), ['unassigned']);
  assert.equal(f.calls.length, 1);
});

test('general technician list includes all active tickets and preserves prior unassigned technical detail reads', async () => {
  const workOrders = [
    { id: 'self', hotel_id: 'hotel-id', technician_name: 'Morgan Lee', status: 'Open' },
    { id: 'unassigned', hotel_id: 'hotel-id', technician_name: null, status: 'In Progress' },
    { id: 'other-tech', hotel_id: 'hotel-id', technician_name: 'Taylor Smith', status: 'Open' },
    { id: 'pending', hotel_id: 'hotel-id', technician_name: null, status: 'Pending Verification' },
  ];

  for (const mode of ['dashboard', 'duplicate-candidates']) {
    const response = await fixture({ mode, workOrders }).run();
    assert.equal(response.status, 200, mode);
    assert.deepEqual(
      Array.from(response.body.work_orders, (order) => order.id).sort(),
      ['other-tech', 'pending', 'self', 'unassigned'],
      mode,
    );
  }
});

test('technician dashboard query failures are surfaced', async () => {
  const response = await fixture({ queryError: true }).run();
  assert.equal(response.status, 503);
  assert.match(response.body.error, /could not be loaded/i);
});

test('technician coverage does not bypass existing edit-ticket capability checks', async () => {
  const f = fixture({ allowed: false });
  const response = await f.run();
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});

test('technician dashboard polls for new work and displays in-app sound alerts', () => {
  const source = readFileSync(new URL('../src/app/technician/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /window\.setInterval\(\(\) => \{ void loadAssignedWork\(\); \}, REFRESH_MS\)/);
  assert.match(source, /role="alert"/);
  assert.match(source, /Unassigned coverage/);
  assert.match(source, /Assigned to you/);
});

test('mobile technician refresh retains the current work list and keeps its page header pinned', () => {
  const source = readFileSync(new URL('../src/app/technician/page.tsx', import.meta.url), 'utf8');
  assert.match(source, /const hasLoadedWorkRef = useRef\(false\)/);
  assert.match(source, /if \(!hasLoadedWorkRef\.current\) setLoading\(false\)/);
  assert.match(source, /sticky top-0 z-20[^"]*sm:static/);
  assert.match(source, /min-h-\[100svh\]/);
});

test('technician arrival alert only queues newly available unassigned work', () => {
  const existing = [{ id: 'unassigned', technician_name: null }];
  assert.deepEqual(newlyAvailableTechnicianWork(null, existing), []);
  const snapshot = new Map(existing.map((order) => [order.id, order.technician_name || '']));
  assert.deepEqual(
    newlyAvailableTechnicianWork(snapshot, [
      { id: 'unassigned', technician_name: 'Morgan Lee' },
      { id: 'new-unassigned', technician_name: '' },
      { id: 'assigned-to-other', technician_name: 'Taylor Smith' },
    ]),
    [{ id: 'new-unassigned', technician_name: '' }],
  );
});
