import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearFrontDeskEmployeeName,
  frontDeskSessionId,
  readFrontDeskEmployeeName,
  saveFrontDeskEmployeeName,
  validEmployeeFullName,
} from '../src/lib/auth/front-desk-session.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('full employee names accept international names and reject initials', () => {
  assert.equal(validEmployeeFullName('Scott Pickering'), true);
  assert.equal(validEmployeeFullName('María García'), true);
  assert.equal(validEmployeeFullName("Anne-Marie O'Neil"), true);
  assert.equal(validEmployeeFullName('李 雷'), true);
  assert.equal(validEmployeeFullName('李雷'), true);
  assert.equal(validEmployeeFullName('Scott'), false);
  assert.equal(validEmployeeFullName('S P'), false);
  assert.equal(validEmployeeFullName('Scott123 Pickering'), false);
});

test('Front Desk employee names are isolated by verified user and authenticated session', () => {
  const storage = memoryStorage();
  assert.equal(saveFrontDeskEmployeeName(storage, 'shared-profile', 'session-one', 'Scott Pickering'), true);
  assert.equal(readFrontDeskEmployeeName(storage, 'shared-profile', 'session-one'), 'Scott Pickering');
  assert.equal(readFrontDeskEmployeeName(storage, 'shared-profile', 'session-two'), '');
  assert.equal(readFrontDeskEmployeeName(storage, 'another-profile', 'session-one'), '');
  assert.equal(saveFrontDeskEmployeeName(storage, 'shared-profile', 'session-one', 'María García'), true);
  assert.equal(readFrontDeskEmployeeName(storage, 'shared-profile', 'session-one'), 'María García');
  clearFrontDeskEmployeeName(storage, 'shared-profile', 'session-one');
  assert.equal(readFrontDeskEmployeeName(storage, 'shared-profile', 'session-one'), '');
});

test('Supabase session key is read from its signed-session id claim', () => {
  const claims = Buffer.from(JSON.stringify({ session_id: 'session-123' })).toString('base64url');
  assert.equal(frontDeskSessionId(`header.${claims}.signature`), 'session-123');
  assert.equal(frontDeskSessionId('invalid'), '');
});

test('Front Desk Profile saves the employee name only to session storage and not account full_name', () => {
  const profile = readFileSync(new URL('../src/app/profile/page.tsx', import.meta.url), 'utf8');
  const workOrders = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  assert.match(profile, /saveFrontDeskEmployeeName\(window\.sessionStorage/);
  assert.match(profile, /\.\.\.\(isFrontDesk \? \{\} : \{ full_name: name \}\)/);
  assert.match(profile, /frontDeskSessionConfirmed/);
  assert.match(workOrders, /readFrontDeskEmployeeName\(window\.sessionStorage/);
  assert.match(workOrders, /saveFrontDeskEmployeeName\(window\.sessionStorage/);
});

test('Front Desk dashboard shows the active employee name without the shared-account email', () => {
  const workOrders = readFileSync(new URL('../src/app/work-orders/page.tsx', import.meta.url), 'utf8');
  const accountSummary = readFileSync(new URL('../src/components/AccountSummary.tsx', import.meta.url), 'utf8');
  assert.match(workOrders, /displayName=\{isFrontDeskUser \? staffFirstName \|\| "Employee name required" : undefined\}/);
  assert.match(workOrders, /hideEmail=\{isSubmitOnlyUser\}/);
  assert.match(accountSummary, /!hideEmail && user\.email/);
});

test('new individual accounts start Profile confirmation incomplete; Front Desk entry is per session', () => {
  const users = readFileSync(new URL('../src/app/api/users/route.ts', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../src/app/api/session/route.ts', import.meta.url), 'utf8');
  const signIn = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  const profileApi = readFileSync(new URL('../src/app/api/profile/route.ts', import.meta.url), 'utf8');
  assert.match(users, /manage_profile_first_login_complete: roleKey\(profileRole\) === "front_desk"/);
  assert.match(session, /manage_profile_first_login_complete: attempt\.principal\.profile\.manage_profile_first_login_complete !== false/);
  assert.match(signIn, /needsFrontDeskConfirmation/);
  assert.match(signIn, /needsIndividualConfirmation/);
  assert.match(signIn, /readFrontDeskEmployeeName\(window\.sessionStorage/);
  assert.match(profileApi, /if \(isFrontDesk\(auth\.principal\.profile\.role\)\)\s*\{\s*return NextResponse\.json\(\{ error: "The shared Front Desk profile name cannot be changed here\."/);
  assert.match(profileApi, /update\.manage_profile_first_login_complete = true/);
});
