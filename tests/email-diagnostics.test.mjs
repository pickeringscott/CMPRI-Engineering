import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(relative, env, imports = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/' + relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { URLSearchParams, exports, process: { env }, require(name) {
    if (name === 'server-only') return {};
    if (name in imports) return imports[name];
    throw new Error('Unexpected import: ' + name);
  }, fetch() { throw new Error('Diagnostic must not access network'); } });
  return exports;
}
function diagnostic(env) {
  return load('lib/server/email-diagnostics.ts', env, {
    '../integrations/email-provider': load('lib/integrations/email-provider.ts', env),
    './integrations-safe-mode': load('lib/server/integrations-safe-mode.ts', env),
  }).emailDiagnostics;
}
const emptyShape = { quoteWrapped:false, jsonWrapped:false, hasEdgeWhitespace:false, hasInternalWhitespace:false, hasControlCharacters:false, hasLiteralEscapedNewline:false };
const clean = value => JSON.parse(JSON.stringify(value));

test('diagnostic allowlist exposes only identities, booleans and normalized classification', () => {
  const env = {
    VERCEL_DEPLOYMENT_ID: 'dpl_Test123', VERCEL_URL: 'example-123.vercel.app',
    VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), VERCEL_ENV: 'production',
    CMPRI_EMAIL_PROVIDER: 'GOOGLE', CMPRI_GMAIL_CLIENT_ID: 'secret-id',
    CMPRI_GMAIL_CLIENT_SECRET: 'secret-client', CMPRI_GMAIL_REFRESH_TOKEN: 'secret-refresh',
    CMPRI_GMAIL_ADDRESS: 'private-mailbox@example.invalid', CMPRI_GMAIL_QUERY: 'private-query',
    VERCEL_AUTOMATION_BYPASS_SECRET: 'secret-bypass', CMPRI_INTEGRATIONS_SAFE_MODE: 'false',
  };
  const result = clean(diagnostic(env)());
  assert.deepEqual(result, {
    deployment: { id: 'dpl_Test123', url: 'example-123.vercel.app', commit: 'a'.repeat(40), environment: 'production' },
    provider: 'gmail', safe_mode: false, gmail_public_client_id: null,
    gmail_credential_shape: {
      client_secret: emptyShape, refresh_token: emptyShape,
      dryRunClientSecretSerializationMatchesRuntime: true,
      dryRunRefreshTokenSerializationMatchesRuntime: true,
    },
    configuration_present: {
      CMPRI_EMAIL_PROVIDER: true, CMPRI_GMAIL_CLIENT_ID: true, CMPRI_GMAIL_CLIENT_SECRET: true,
      CMPRI_GMAIL_REFRESH_TOKEN: true, CMPRI_GMAIL_ADDRESS: true,
      CMPRI_MS_TENANT_ID: false, CMPRI_MS_CLIENT_ID: false, CMPRI_MS_CLIENT_SECRET: false, CMPRI_MS_MAILBOX: false,
    },
  });
  for (const value of ['secret-id','secret-client','secret-refresh','private-mailbox','private-query','secret-bypass']) {
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('runtime changes, absent/empty settings, and invalid provider values are reported without echo', () => {
  const env = {};
  const read = diagnostic(env);
  assert.equal(read().provider, 'unset');
  assert.equal(read().safe_mode, true);
  assert.deepEqual(clean(read().deployment), { id: null, url: null, commit: null, environment: null });
  Object.assign(env, { CMPRI_GMAIL_CLIENT_ID: 'a', CMPRI_GMAIL_CLIENT_SECRET: 'b', CMPRI_GMAIL_REFRESH_TOKEN: 'c' });
  assert.equal(read().provider, 'gmail');
  assert.equal(read().configuration_present.CMPRI_GMAIL_ADDRESS, false);
  env.CMPRI_GMAIL_REFRESH_TOKEN = '';
  assert.equal(read().provider, 'unset');
  assert.equal(read().configuration_present.CMPRI_GMAIL_REFRESH_TOKEN, false);
  for (const invalid of [' gmail ', 'do-not-return-this-value']) {
    env.CMPRI_EMAIL_PROVIDER = invalid;
    assert.equal(read().provider, 'invalid');
    assert.equal(JSON.stringify(read()).includes(invalid), false);
  }
  env.CMPRI_EMAIL_PROVIDER = 'Outlook';
  assert.equal(read().provider, 'microsoft365');
  env.CMPRI_INTEGRATIONS_SAFE_MODE = ' FALSE ';
  assert.equal(read().safe_mode, false);
  Object.assign(env, { VERCEL_URL: 'https://secret.example/?token=secret', VERCEL_DEPLOYMENT_ID: 'bad secret', VERCEL_GIT_COMMIT_SHA: 'secret', VERCEL_ENV: 'secret' });
  assert.deepEqual(clean(read().deployment), { id: null, url: null, commit: null, environment: null });
});

function routeFixture({ signedIn = true, view = true, operate = true } = {}) {
  const calls = [], filters = [];
  let diagnosticCalls = 0;
  const query = { select() { return query; }, eq(...args) { filters.push(args); return query; }, order() { return query; }, async limit() { return { data: [], error: null }; } };
  const auth = signedIn ? { principal: {}, admin: { from(table) { calls.push(table); return query; } } } : null;
  const route = load('app/api/engineering/operations/route.ts', {}, {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } },
    '@/lib/constants': { HOTEL_ID: 'current-hotel' },
    '@/lib/server/access': { allows: (_, capability) => capability === 'operate_integrations' ? operate : view },
    '@/lib/server/auth': { requireUser: async () => auth },
    '@/lib/integrations/operations': {},
    '@/lib/server/integrations-safe-mode': { isIntegrationsSafeMode: () => true },
    '@/lib/server/email-diagnostics': { emailDiagnostics: () => { diagnosticCalls++; return { provider: 'unset' }; } },
  });
  return { route, calls, filters, diagnosticCalls: () => diagnosticCalls };
}
for (const [name, options, status] of [
  ['anonymous', { signedIn: false }, 401], ['denied reader', { view: false }, 403],
]) test(name + ' cannot reach diagnostic or database', async () => {
  const f = routeFixture(options);
  const result = await f.route.GET({});
  assert.equal(result.status, status);
  assert.equal(f.diagnosticCalls(), 0);
  assert.equal(f.calls.length, 0);
});
for (const operate of [false, true]) test('existing reader access and hotel filters preserved; operator=' + operate, async () => {
  const f = routeFixture({ operate });
  const result = await f.route.GET({});
  assert.equal(result.status, 200);
  assert.equal('email_diagnostics' in result.body, operate);
  assert.equal(f.diagnosticCalls(), Number(operate));
  assert.equal(f.calls.length, 6);
  assert.equal(f.filters.length, 6);
  for (const filter of f.filters) assert.deepEqual(filter, ['hotel_id', 'current-hotel']);
});

test('authenticated diagnostic returns only well-formed public client ID and reads runtime changes',()=>{
  const id='880987317943-e16mlfpc6oqb355dnlfc91046jo7n42m.apps.googleusercontent.com';
  const env={CMPRI_GMAIL_CLIENT_ID:id,CMPRI_GMAIL_CLIENT_SECRET:'private-secret',CMPRI_GMAIL_REFRESH_TOKEN:'private-token'};
  const read=diagnostic(env);
  assert.equal(read().gmail_public_client_id,id);
  for(const value of [undefined,'', ' '+id,id+'\n','private-secret','<script>private-token</script>',id+'?token=private-token']){
    env.CMPRI_GMAIL_CLIENT_ID=value;
    const result=read();
    assert.equal(result.gmail_public_client_id,null);
    assert.doesNotMatch(JSON.stringify(result),/private-secret|private-token|<script>/);
  }
  env.CMPRI_GMAIL_CLIENT_ID=id;
  assert.equal(read().gmail_public_client_id,id);
});


test('credential shape checks use synthetic values, expose booleans only, and never mutate configuration or call Google', () => {
  const env = {};
  const read = diagnostic(env);
  const cases = [
    [undefined, {}], ['', {}], ['synthetic+&=%ü', {}],
    ['"synthetic"', {quoteWrapped:true,jsonWrapped:true}],
    ["'synthetic'", {quoteWrapped:true}],
    ['{"refresh_token":"synthetic"}', {jsonWrapped:true}],
    ['["synthetic"]', {jsonWrapped:true}],
    [' synthetic ', {hasEdgeWhitespace:true}],
    ['syn thetic', {hasInternalWhitespace:true}],
    ['syn\tthetic', {hasInternalWhitespace:true,hasControlCharacters:true}],
    ['synthetic\r\n', {hasEdgeWhitespace:true,hasControlCharacters:true}],
    ['syn\u0001thetic', {hasControlCharacters:true}],
    [String.raw`synthetic\n`, {hasLiteralEscapedNewline:true}],
    [String.raw`synthetic\r\n`, {hasLiteralEscapedNewline:true}],
    ['synthetic"unterminated', {}],
  ];
  for (const [value, flags] of cases) {
    env.CMPRI_GMAIL_CLIENT_SECRET=value;
    env.CMPRI_GMAIL_REFRESH_TOKEN=value;
    const result=clean(read().gmail_credential_shape);
    assert.deepEqual(result, {
      client_secret:{...emptyShape,...flags}, refresh_token:{...emptyShape,...flags},
      dryRunClientSecretSerializationMatchesRuntime:typeof value==='string',
      dryRunRefreshTokenSerializationMatchesRuntime:typeof value==='string',
    });
    assert.equal(env.CMPRI_GMAIL_CLIENT_SECRET,value);
    assert.equal(env.CMPRI_GMAIL_REFRESH_TOKEN,value);
    assert.doesNotMatch(JSON.stringify(result),/synthetic|unterminated/);
    for(const entry of Object.values(result)) for(const flag of typeof entry==='object'?Object.values(entry):[entry]) assert.equal(typeof flag,'boolean');
  }
});
