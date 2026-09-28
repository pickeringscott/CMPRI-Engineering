import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authSessionId,
  confirmFrontDeskSession,
  isFrontDeskRole,
  isFrontDeskSessionConfirmed,
  manageProfileConfirmationUrl,
  needsManageProfileConfirmation,
  readFrontDeskSessionName,
  saveFrontDeskSessionName,
  validFrontDeskFullName,
} from '../src/lib/auth/profile-confirmation.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function token(claims) {
  return `header.${btoa(JSON.stringify(claims)).replace(/=/g, '')}.signature`;
}

test('individual profiles prompt only while the server says first-login confirmation is incomplete', () => {
  const storage = memoryStorage();
  const session = { landing: '/engineering', user: { role: 'Engineer' }, profile_setup_complete: false };
  assert.equal(needsManageProfileConfirmation(session, token({ sub: 'u1', session_id: 's1' }), storage), true);
  assert.equal(needsManageProfileConfirmation({ ...session, profile_setup_complete: true }, token({ sub: 'u1', session_id: 's1' }), storage), false);
});

test('Front Desk confirmation and full name are isolated to the authenticated session id', () => {
  const storage = memoryStorage();
  const firstToken = token({ sub: 'shared-front-desk', session_id: 'session-one' });
  const refreshedToken = token({ sub: 'shared-front-desk', session_id: 'session-one', iat: 200 });
  const nextLoginToken = token({ sub: 'shared-front-desk', session_id: 'session-two' });
  const session = { landing: '/work-orders', user: { role: 'Front Desk' }, profile_setup_complete: true };
  const sessionId = authSessionId(firstToken);
  assert.equal(needsManageProfileConfirmation(session, firstToken, storage), true);
  confirmFrontDeskSession(storage, sessionId, 'Taylor Smith');
  assert.equal(isFrontDeskSessionConfirmed(storage, sessionId), true);
  assert.equal(readFrontDeskSessionName(storage, sessionId), 'Taylor Smith');
  assert.equal(needsManageProfileConfirmation(session, refreshedToken, storage), false);
  assert.equal(needsManageProfileConfirmation(session, nextLoginToken, storage), true);
  assert.equal(readFrontDeskSessionName(storage, authSessionId(nextLoginToken)), '');
});

test('front desk role aliases are recognized without changing other role handling', () => {
  assert.equal(isFrontDeskRole('Front Desk'), true);
  assert.equal(isFrontDeskRole('assistant_manager'), true);
  assert.equal(isFrontDeskRole('Lead Housekeeper'), false);
  assert.equal(isFrontDeskRole('Engineer'), false);
});

test('confirmation URL reuses Manage Profile and carries the authorized return route', () => {
  assert.equal(manageProfileConfirmationUrl('/engineering', false), '/profile?first_login=1&next=%2Fengineering');
  assert.equal(manageProfileConfirmationUrl('/work-orders', true), '/profile?first_login=1&next=%2Fwork-orders&shared_front_desk=1');
});

test('Front Desk requires a full name rather than initials', () => {
  assert.equal(validFrontDeskFullName('Taylor Smith'), true);
  assert.equal(validFrontDeskFullName('María-José García'), true);
  assert.equal(validFrontDeskFullName('TS'), false);
  assert.equal(validFrontDeskFullName('T Smith'), false);
  assert.equal(validFrontDeskFullName('Taylor'), false);
});
