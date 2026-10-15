import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

const exports = {};
const source = readFileSync(process.env.LOGOUT_STORAGE_SOURCE || new URL('../src/lib/auth/session-storage.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { exports, crypto });
const { createSessionStoragePolicy, SESSION_KEY } = exports;
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('app-window revocation marker does not invalidate an independent tab session', () => {
  const persistent = storage(), firstTab = storage(), secondTab = storage();
  const first = createSessionStoragePolicy(persistent, firstTab);
  const second = createSessionStoragePolicy(persistent, secondTab);
  first.setRemember(false);
  second.storage.setItem(SESSION_KEY, 'independent-tab-session');
  first.revoke();
  assert.equal(second.revoked(), false);
  assert.equal(second.storage.getItem(SESSION_KEY), 'independent-tab-session');
});
for (const remembered of [false, true]) {
  test(`profile iframe logout prevents parent refresh restoring session (remembered=${remembered})`, () => {
    const persistent = storage(), temporary = storage();
    const parent = createSessionStoragePolicy(persistent, temporary);
    parent.setRemember(remembered);
    parent.storage.setItem(SESSION_KEY, 'synthetic-old-session');
    // Same-origin iframe shares browser storage but owns another module/client.
    const profile = createSessionStoragePolicy(persistent, temporary);
    profile.revoke();
    parent.storage.setItem(SESSION_KEY, 'synthetic-late-parent-refresh');
    assert.equal(persistent.getItem(SESSION_KEY), null);
    assert.equal(temporary.getItem(SESSION_KEY), null);
    const reloadedPage = createSessionStoragePolicy(persistent, temporary);
    assert.equal(reloadedPage.storage.getItem(SESSION_KEY), null);
  });
}
test('installed SDK refresh cannot commit across a profile logout after its storage snapshot', async () => {
  const persistent = storage(), temporary = storage();
  const parent = createSessionStoragePolicy(persistent, temporary);
  parent.setRemember(false);
  const user = { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const session = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
  parent.storage.setItem(SESSION_KEY, JSON.stringify(session));
  const profile = createSessionStoragePolicy(persistent, temporary);
  let returnedRefresh = false, interleavedLogout = false;
  const sdk = createClient('https://example.invalid', 'synthetic-key', {
    auth: { storageKey: SESSION_KEY, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: {
      ...parent.storage,
      getItem(key) {
        const captured = parent.storage.getItem(key);
        if (key === SESSION_KEY && returnedRefresh && !interleavedLogout) {
          interleavedLogout = true;
          // Force the microtask boundary after the SDK takes its final snapshot
          // and before that snapshot is consumed by its commit guard.
          queueMicrotask(() => profile.revoke());
        }
        return captured;
      },
    } },
    global: { fetch: async url => {
      assert.match(String(url), /\/auth\/v1\/token\?grant_type=refresh_token$/);
      returnedRefresh = true;
      return new Response(JSON.stringify({ ...session, access_token: 'synthetic-rotated', refresh_token: 'synthetic-rotated-refresh' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  await sdk.auth.initialize();
  await sdk.auth.refreshSession({ refresh_token: session.refresh_token });
  assert.equal(interleavedLogout, true);
  assert.equal(temporary.getItem(SESSION_KEY), null);
  assert.equal(persistent.getItem(SESSION_KEY), null);
});
