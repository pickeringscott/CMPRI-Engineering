import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sourceRoot = process.env.LOGOUT_SOURCE_ROOT
  ? new URL(process.env.LOGOUT_SOURCE_ROOT)
  : new URL('../src/', import.meta.url);
function source(file) { return readFileSync(new URL(file, sourceRoot), 'utf8'); }
function evaluate(file, context) {
  const exports = {};
  const code = ts.transpileModule(source(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { exports, crypto, ...context });
  return exports;
}
function store() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function fixture(signOut = async () => ({ error: null })) {
  const storageModule = evaluate('lib/auth/session-storage.ts', {});
  const persistent = store(), temporary = store(), timers = new Map(), calls = [];
  for (const storage of [persistent, temporary]) {
    for (const suffix of ['', '-code-verifier', '-user']) storage.setItem(`${storageModule.SESSION_KEY}${suffix}`, 'synthetic');
    storage.setItem('unrelated', 'keep');
  }
  persistent.setItem(storageModule.REMEMBER_KEY, 'true');
  temporary.setItem('cmpri:auth:oauth-pending', 'true');
  let adapter;
  const auth = { signOut: options => { calls.push(options.scope); return signOut(); }, getSession: async () => ({ data: { session: { access_token: 'synthetic', expires_at: 1 } }, error: null }), refreshSession: async () => ({ data: { session: null }, error: null }) };
  const client = evaluate('lib/supabase/client.ts', {
    window: { localStorage: persistent, sessionStorage: temporary },
    setTimeout: (callback, delay) => { timers.set(1, { callback, delay }); return 1; },
    clearTimeout: id => timers.delete(id),
    require: name => {
      if (name === '@/lib/auth/session-storage') return storageModule;
      if (name === '@/lib/supabase/config') return { SUPABASE_URL: 'https://example.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic' };
      if (name === '@supabase/supabase-js') return { createClient: (_url, _key, options) => { adapter = options.auth.storage; return { auth }; } };
      throw Error(name);
    },
  });
  return { client, auth, persistent, temporary, timers, calls, adapter: () => adapter, ...storageModule };
}
function assertCleared(f) {
  for (const storage of [f.persistent, f.temporary]) {
    for (const suffix of ['', '-code-verifier', '-user']) assert.equal(storage.getItem(`${f.SESSION_KEY}${suffix}`), null);
    assert.equal(storage.getItem('unrelated'), 'keep');
  }
  assert.equal(f.persistent.getItem(f.REMEMBER_KEY), null);
  assert.equal(f.temporary.getItem('cmpri:auth:oauth-pending'), null);
}
test('successful logout clears both storage modes and requests only local revocation', async () => {
  const f = fixture(); await f.client.signOutDevice(); assertCleared(f);
  assert.deepEqual(f.calls, ['local']); assert.equal(f.timers.size, 0);
});
test('SDK rejection still completes device logout so callers can navigate', async () => {
  const f = fixture(async () => { throw Error('network unavailable'); });
  await f.client.signOutDevice(); assertCleared(f);
});
test('a stalled SDK cannot prevent cleanup; late refresh writes cannot restore session', async () => {
  const f = fixture(() => new Promise(() => {}));
  const completion = f.client.signOutDevice();
  assert.equal(f.timers.size, 1, 'logout must have a bounded wait');
  assert.equal([...f.timers.values()][0].delay, 3000);
  [...f.timers.values()][0].callback();
  await completion; assertCleared(f);
  f.adapter().setItem(f.SESSION_KEY, 'late-refresh');
  assertCleared(f); assert.equal(await f.client.getValidSession(), null);
  const oldAdapter = f.adapter();
  f.client.setRememberOnDevice(false);
  f.client.createClient();
  f.adapter().setItem(f.SESSION_KEY, 'new-explicit-login');
  oldAdapter.setItem(f.SESSION_KEY, 'old-refresh');
  oldAdapter.removeItem(f.SESSION_KEY);
  assert.equal(f.temporary.getItem(f.SESSION_KEY), 'new-explicit-login');
});
test('an in-flight session read cannot return a credential after logout starts', async () => {
  const f = fixture(); let finish;
  f.auth.getSession = () => new Promise(resolve => { finish = resolve; });
  const read = f.client.getValidSession();
  await f.client.signOutDevice();
  finish({ data: { session: { access_token: 'synthetic', expires_at: 9999999999 } }, error: null });
  assert.equal(await read, null);
});
test('parent session read is refused after a separate profile-frame client logs out', async () => {
  const f = fixture(); let finish;
  f.auth.getSession = () => new Promise(resolve => { finish = resolve; });
  const read = f.client.getValidSession();
  const profilePolicy = f.createSessionStoragePolicy(f.persistent, f.temporary);
  profilePolicy.revoke();
  finish({ data: { session: { access_token: 'synthetic', expires_at: 9999999999 } }, error: null });
  assert.equal(await read, null);
  const oldAdapter = f.adapter();
  f.client.setRememberOnDevice(false);
  f.client.createClient();
  f.adapter().setItem(f.SESSION_KEY, 'new-explicit-login');
  oldAdapter.removeItem(f.SESSION_KEY);
  oldAdapter.setItem(f.SESSION_KEY, 'late-parent-refresh');
  assert.equal(f.temporary.getItem(f.SESSION_KEY), 'new-explicit-login');
});
test('storage removal failures remain visible instead of claiming a successful logout', async () => {
  const f = fixture(); f.temporary.removeItem = () => { throw Error('blocked'); };
  await assert.rejects(f.client.signOutDevice(), /storage could not be cleared/);
  assert.equal(f.persistent.getItem(f.SESSION_KEY), null);
});
test('profile loading screen offers a working Sign Out without profile data or name', async () => {
  let signedOut = 0; const navigations = [];
  const jsx = (type, props) => ({ type, props });
  const profile = evaluate('app/profile/page.tsx', {
    window: { location: { replace: url => navigations.push(url) } },
    require: name => {
      if (name === 'react') return { useEffect() {}, useState: value => [value, () => {}] };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@/lib/supabase/client') return { signOutDevice: async () => { signedOut++; } };
      if (name === '@/lib/account-display') return { roleDisplayName: () => '', accountRoleDisplayName: () => '' };
      if (name === '@/components/use-embedded-modal') return { default: () => false };
      if (name === '@/lib/server/roles') return { isSubmitOnlyRole: () => false };
      return {};
    },
  }).default;
  const buttons = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'button') buttons.push(node);
    visit(node.props?.children);
  }
  visit(profile());
  const button = buttons.find(node => node.props.children === 'Sign Out');
  assert.ok(button, 'sign out must be available before profile loads');
  assert.equal(button.props.type, 'button'); assert.ok(!button.props.disabled);
  button.props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(signedOut, 1); assert.deepEqual(navigations, ['/']);
});
