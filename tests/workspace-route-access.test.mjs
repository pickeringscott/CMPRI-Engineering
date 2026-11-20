import test from 'node:test';
import assert from 'node:assert/strict';
import { canResumeWorkspaceView } from '../src/lib/ui/workspace-route-access.ts';

const session = (capabilities, role = 'engineer', extra = {}) => ({
  user: { id: 'fixture-user', role, email: null, name: null, ...extra },
  hotelId: 'fixture-hotel', landing: '/engineering', capabilities,
});
const frame = href => ({ kind: 'frame', key: href, href });

test('resume uses fresh granted capabilities and rejects unknown/private routes without them', () => {
  const granted = session(['view_work_orders', 'submit', 'manage_assets', 'manage_users']);
  for (const href of ['/work-orders/fixture-order', '/work-orders?draft=fixture', '/management/equipment', '/engineering/parts', '/management/users']) {
    assert.equal(canResumeWorkspaceView(granted, frame(href)), true, href);
    assert.equal(canResumeWorkspaceView(session([]), frame(href)), false, href);
  }
  for (const href of ['/api/session', '/unknown', 'https://outside.test/profile', '//outside.test/profile']) {
    assert.equal(canResumeWorkspaceView(granted, frame(href)), false, href);
  }
  assert.equal(canResumeWorkspaceView({ ...granted, hotelId: '' }, frame('/notes')), false);
});

test('private hours eligibility and specialized existing profile guards remain authoritative', () => {
  assert.equal(canResumeWorkspaceView(session(['view_dashboard'], 'system_admin'), frame('/engineering/hours-tracker')), false);
  assert.equal(canResumeWorkspaceView(session([], 'chief_engineer'), frame('/engineering/hours-tracker')), true);
  assert.equal(canResumeWorkspaceView(session([], 'assistant_manager'), frame('/engineering/hours-tracker')), true);
  assert.equal(canResumeWorkspaceView(session([], 'front_desk'), frame('/engineering/winter-preparedness')), false);
  assert.equal(canResumeWorkspaceView(session([], 'manager'), frame('/engineering/winter-preparedness')), true);
  assert.equal(canResumeWorkspaceView(session([], 'manager'), frame('/engineering/employment')), false);
  assert.equal(canResumeWorkspaceView(session([], 'assistant_manager'), frame('/engineering/employment')), true);
});

test('shared persistence keeps authorized desktop-only views without granting unrelated actions', () => {
  const reader = session(['view_work_orders', 'receive_pool_closed_notifications']);
  assert.equal(canResumeWorkspaceView(reader, { kind: 'list', key: 'work-order-list' }), true);
  assert.equal(canResumeWorkspaceView(reader, { kind: 'pool-status', key: 'pool-status' }), true);
  assert.equal(canResumeWorkspaceView(reader, { kind: 'approvals', key: 'work-order-approvals' }), true);
  assert.equal(canResumeWorkspaceView(session([]), { kind: 'approvals', key: 'work-order-approvals' }), false);
  assert.equal(canResumeWorkspaceView(session(['review_tickets']), { kind: 'approvals', key: 'work-order-approvals' }), true);
  assert.equal(canResumeWorkspaceView(reader, frame('/engineering')), true);
  assert.equal(canResumeWorkspaceView(reader, frame('/notes')), true);
  assert.equal(canResumeWorkspaceView(session(['view_dashboard']), frame('/engineering/pool-log')), false);
  assert.equal(canResumeWorkspaceView(session(['view_pool_log']), frame('/engineering/pool-log')), true);
});

test('restorable operational screens use the unchanged shared menu-access policy', () => {
  const technician = session([], 'technician');
  for (const href of ['/engineering/gss', '/engineering/room-operations', '/engineering/enseo-assignments']) {
    assert.equal(canResumeWorkspaceView(technician, frame(href)), true, href);
  }
  const frontManager = session([], 'front_desk_manager');
  assert.equal(canResumeWorkspaceView(frontManager, frame('/engineering/gss')), true);
  assert.equal(canResumeWorkspaceView(frontManager, frame('/engineering/room-operations')), false);
  assert.equal(canResumeWorkspaceView(frontManager, frame('/engineering/enseo-assignments')), false);
});
