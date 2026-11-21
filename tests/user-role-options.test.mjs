import test from 'node:test';
import assert from 'node:assert/strict';
import { uniqueUserRoleChoices, userRoleChoice } from '../src/lib/ui/user-role-options.ts';

test('stored account roles select the authorized server label in either language', () => {
  const roles = ['Lead Housekeeper', 'Front Desk', 'Maintenance Technician'];
  for (const alias of ['housekeeping', 'Housekeeping', 'Executive Housekeeper', 'lead_housekeeper']) {
    assert.equal(userRoleChoice(alias, roles), 'Lead Housekeeper');
  }
  assert.equal(userRoleChoice('front_desk', roles), 'Front Desk');
  assert.equal(userRoleChoice('technician', roles), 'Maintenance Technician');
  assert.deepEqual(roles, ['Lead Housekeeper', 'Front Desk', 'Maintenance Technician']);
});

test('one choice remains for each semantic role without rewriting server-provided payload values', () => {
  const roles = ['Lead Housekeeper', 'Housekeeping', 'Front Desk', 'front_desk'];
  assert.deepEqual(uniqueUserRoleChoices(roles), ['Lead Housekeeper', 'Front Desk']);
  assert.deepEqual(roles, ['Lead Housekeeper', 'Housekeeping', 'Front Desk', 'front_desk']);
});

test('Chief Engineer stays distinct from historical generic engineering assignments', () => {
  const roles = ['Chief Engineer', 'Engineer', 'Front Desk'];
  assert.deepEqual(uniqueUserRoleChoices(roles), roles);
  assert.equal(userRoleChoice('chief_engineer', roles), 'Chief Engineer');
  assert.equal(userRoleChoice('engineer', roles), 'Engineer');
  assert.equal(userRoleChoice('engineer', ['Chief Engineer']), 'engineer');
});

test('unknown or unassignable current roles stay display-only rather than adopting an authorized role', () => {
  const roles = ['Lead Housekeeper', 'Front Desk'];
  assert.equal(userRoleChoice('system_admin', roles), 'system_admin');
  assert.equal(userRoleChoice('Unrecognized historical title', roles), 'Unrecognized historical title');
  assert.equal(userRoleChoice(null, roles), '');
});
