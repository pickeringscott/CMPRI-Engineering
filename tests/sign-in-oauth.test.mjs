import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const signInPage = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
const supabaseClient = readFileSync(new URL('../src/lib/supabase/client.ts', import.meta.url), 'utf8');

test('sign-in accepts the Front Desk session destination and rejects untrusted destinations', async () => {
  const ast = ts.createSourceFile('page.tsx', signInPage, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'authorizedLanding');
  assert.ok(fn);
  const code = ts.transpileModule(`${fn.getText(ast)}\nexports.landing = authorizedLanding;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let destination = '/front-desk', status = 200, signedOut = 0;
  const exported = {};
  vm.runInNewContext(code, { exports: exported, signOutDevice: async () => { signedOut++; },
    fetch: async (url, options) => {
      assert.equal(url, '/api/session');
      assert.equal(options.headers.Authorization, 'Bearer isolated-token');
      return Response.json({landing: destination}, {status});
    },
  });
  for (destination of ['/front-desk', '/engineering', '/technician', '/work-orders']) {
    assert.equal(await exported.landing('isolated-token'), destination);
  }
  for (destination of ['https://example.invalid', '//example.invalid', '/management/users', '/front-desk?role=engineer', null]) {
    await assert.rejects(exported.landing('isolated-token'), /invalid account destination/);
  }
  status = 403;
  await assert.rejects(exported.landing('isolated-token'), /not authorized/);
  assert.equal(signedOut, 1);
});

test('password entry does not trigger React state updates and remains scrollable on mobile', () => {
  assert.match(signInPage, /const passwordRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(signInPage, /password: passwordRef\.current\?\.value \|\| ""/);
  assert.doesNotMatch(signInPage, /setPassword|onChange=\{\(event\) => setPassword/);
  assert.match(signInPage, /min-h-\[100svh\].*overflow-y-auto overscroll-contain/);
});

test('only an OAuth flow started in this tab is treated as a sign-in callback', () => {
  assert.match(signInPage, /function hasOAuthCallback\(\)\s*\{\s*return window\.sessionStorage\.getItem\(OAUTH_PENDING_KEY\) === "true";\s*\}/);
  assert.match(signInPage, /if \(session\) \{[\s\S]*?removeItem\(OAUTH_PENDING_KEY\)/);
});

test('signing out clears stale OAuth callback state', () => {
  assert.match(supabaseClient, /export const OAUTH_PENDING_KEY = "cmpri:auth:oauth-pending"/);
  assert.match(supabaseClient, /window\.sessionStorage\.removeItem\(OAUTH_PENDING_KEY\);\s*\}\s*finally\s*\{\s*sessionPolicy\(\)\.revoke\(\);/);
});

test('Google OAuth returns to the browser origin, including the local development port', async () => {
  const ast = ts.createSourceFile('page.tsx', signInPage, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let signIn;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'signInWithGoogle') signIn = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(signIn);
  const source = ts.transpileModule(`${signIn.getText(ast)}\nexports.signIn = signInWithGoogle;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const origin of ['http://127.0.0.1:3100', 'http://localhost:3100', 'https://www.cmpri-engineering.com']) {
    const exported = {};
    const requests = [];
    const navigations = [];
    const messages = [];
    vm.runInNewContext(source, {
      exports: exported,
      window: { location: { origin, assign: url => navigations.push(url) }, sessionStorage: { setItem() {}, removeItem() {} } },
      OAUTH_PENDING_KEY: 'pending', rememberMe: false,
      setBusy() {}, setRememberOnDevice() {}, setRedirecting() {}, setMessage: value => messages.push(value),
      createClient: () => ({ auth: { signInWithOAuth: async request => {
        requests.push(request);
        return { data: { url: 'https://auth.example/authorize' }, error: null };
      } } }),
    });
    await exported.signIn();
    assert.equal(requests[0].provider, 'google');
    assert.equal(requests[0].options.redirectTo, `${origin}/`);
    assert.deepEqual(navigations, ['https://auth.example/authorize']);
    assert.deepEqual(messages, ['']);
  }
});
