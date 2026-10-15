import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultNotificationSchedule,
  isNotificationScheduleEligibleProfile,
  isWithinNotificationSchedule,
  isWebPushEligibleProfile,
  normalizeNotificationSettings,
} from '../src/lib/notifications/schedule.ts';

test('notification hours use the recipient timezone and weekday schedule', () => {
  const schedule = defaultNotificationSchedule();
  schedule.monday = { enabled: true, start: '09:00', end: '12:00' };
  const settings = { timezone: 'UTC', schedule };
  assert.equal(isWithinNotificationSchedule(settings, new Date('2026-01-05T10:00:00Z')), true);
  assert.equal(isWithinNotificationSchedule(settings, new Date('2026-01-05T12:00:00Z')), false);
  assert.equal(isWithinNotificationSchedule(settings, new Date('2026-01-06T10:00:00Z')), false);
});

test('overnight schedules continue into the following day', () => {
  const schedule = defaultNotificationSchedule();
  schedule.monday = { enabled: true, start: '22:00', end: '02:00' };
  const settings = { timezone: 'UTC', schedule };
  assert.equal(isWithinNotificationSchedule(settings, new Date('2026-01-06T01:59:00Z')), true);
  assert.equal(isWithinNotificationSchedule(settings, new Date('2026-01-06T02:00:00Z')), false);
});

test('schedule validation rejects malformed days and time zones', () => {
  assert.equal(normalizeNotificationSettings({ timezone: 'Not/AZone', schedule: defaultNotificationSchedule() }), null);
  const incomplete = defaultNotificationSchedule();
  delete incomplete.friday;
  assert.equal(normalizeNotificationSettings({ timezone: 'UTC', schedule: incomplete }), null);
});

test('work-order Web Push delivery is restricted to Chief Engineers and Maintenance Technicians', () => {
  assert.equal(isWebPushEligibleProfile({ role: 'Chief Engineer' }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'Maintenance Technician' }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'System Administrator' }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'System Admin' }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'Engineer' }), false);
  assert.equal(isWebPushEligibleProfile({ role: 'engineer' }), false);
  assert.equal(isWebPushEligibleProfile({ role: 'technician' }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'Engineering Manager' }), false);
  assert.equal(isWebPushEligibleProfile({ role: 'Technician' }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'System Administrator', secondary_roles: ['engineer'] }), true);
  assert.equal(isWebPushEligibleProfile({ role: 'Front Desk', secondary_roles: ['Chief Engineer'] }), true);
});

test('notification schedules are available only to Group 4 roles and all System Administrators', () => {
  for (const role of [
    'Chief Engineer',
    'Engineer',
    'Engineering Manager',
    'Regional Maintenance',
    'Maintenance Technician',
    'Technician',
    'Front Desk Manager',
    'Assistant General Manager',
    'General Manager',
    'System Administrator',
    'System Admin',
    'Lead Housekeeper',
    'Housekeeping',
  ]) {
    assert.equal(isNotificationScheduleEligibleProfile({ role }), true, role);
  }
  for (const role of ['Front Desk', 'Senior Management']) {
    assert.equal(isNotificationScheduleEligibleProfile({ role }), false, role);
  }
});
