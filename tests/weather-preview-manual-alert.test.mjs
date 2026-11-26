import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const NOW = Date.parse('2026-11-26T18:00:00Z');
const PREVIEW_BRANCH = 'codex/weather-alert-radar-review';
const FIXTURE_ROLES = ['chief_engineer', 'system_admin', 'engineer', 'tech', 'front_desk', 'manager', 'housekeeping'];
const roles = loadTs('src/lib/server/roles.ts');
const issuer = (end = 120_000, modifications = {}) => ({id: 'urn:nws:test', properties: {
  status: 'Actual', messageType: 'Alert', event: 'Winter Storm Warning',
  effective: new Date(NOW).toISOString(), expires: new Date(NOW + end).toISOString(), ...modifications,
}});
const advisory = (text = 'Icy sidewalks') => ({severity: 'watch', custom: true, text, override: true, attention: true,
  color: '#f4c54e', textColor: '#000000', expires: NOW + 3_000_000});

function fixture(options = {}) {
  const current = options.current ?? {time: NOW, features: [], outage: false, pauses: []};
  const shared = options.shared ?? new Map();
  const env = options.env ?? {VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: PREVIEW_BRANCH};
  const Clock = class extends Date { static now() { return current.time; } };
  const requests = [];
  const authReads = [];
  const cacheReads = [];
  const getCache = ({namespace}) => ({
    async get(key) {
      cacheReads.push({namespace, key});
      const entry = shared.get(`${namespace}:${key}`);
      return entry && entry.until > current.time ? entry.value : null;
    },
    async set(key, value, {ttl}) {
      if (options.pauseTombstone && key.startsWith('removed:')) await options.pauseTombstone();
      shared.set(`${namespace}:${key}`, {value, until: current.time + ttl * 1000});
    },
  });
  const globals = {Response, Request, URL, URLSearchParams, TextDecoder, Date: Clock, AbortController, AbortSignal,
    fetch: async (source, init) => {
      requests.push({source, init});
      const archive = new URL(source).pathname === '/alerts';
      return current.outage ? Response.json({}, {status: 503}) : Response.json({features: archive ? current.archive ?? [] : current.features});
    }, process: {env}};
  const route = loadTs('src/app/api/weather-preview/manual-alert/route.ts', {
    '@vercel/functions': {getCache},
    '@/lib/server/auth': {requireUser: async request => {
      authReads.push(request.method);
      const role = request.headers.get('authorization')?.replace('Bearer ', '');
      return FIXTURE_ROLES.includes(role) || role?.startsWith('cmpri_mcp_') ? {principal: {hotelId: 'fixture-hotel', profile: {role}}} : null;
    }},
    '@/lib/server/roles': roles,
    '@/lib/weather/manual-alert': loadTs('src/lib/weather/manual-alert.ts', {}, globals),
    '@/lib/weather/manual-alert-preview': loadTs('src/lib/weather/manual-alert-preview.ts', {}, globals),
    '@/lib/weather/property-alerts': loadTs('src/lib/weather/property-alerts.ts', {}, globals),
    'node:timers/promises': {setTimeout: async ms => {
      current.time += ms;
      await current.pauses.shift()?.();
    }},
  }, globals);
  const send = (method, role, body, query = '') => route[method](new Request(`https://branch.example/api/weather-preview/manual-alert${query}`, {
    method, headers: role ? {authorization: `Bearer ${role}`} : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { send, current, shared, requests, authReads, cacheReads };
}

test('delivery is scoped to that Vercel preview and authenticates browser sessions before cache or feed reads', async () => {
  for (const env of [{}, {VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: PREVIEW_BRANCH},
    {VERCEL_ENV: 'preview', VERCEL: '1'}, {VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'another-branch'}]) {
    const f = fixture({env});
    assert.equal((await f.send('GET', 'chief_engineer')).status, 404);
    assert.equal((await f.send('POST', 'system_admin', advisory())).status, 404);
    assert.equal((await f.send('DELETE', 'chief_engineer')).status, 404);
    assert.equal(f.authReads.length + f.cacheReads.length + f.requests.length, 0);
  }
  const f = fixture();
  assert.equal((await f.send('GET')).status, 401);
  assert.equal((await f.send('POST', 'cmpri_mcp_fixture', advisory())).status, 401);
  assert.equal((await f.send('POST', 'engineer', advisory())).status, 403);
  assert.equal((await f.send('DELETE', 'manager')).status, 403);
  assert.equal(f.cacheReads.length + f.requests.length, 0);
});

test('a phone-style publisher and waiting app sessions on other preview instances share state', async () => {
  const publisher = fixture(), viewer = fixture({current: publisher.current, shared: publisher.shared});
  const first = await (await viewer.send('GET', 'front_desk')).json();
  assert.deepEqual(first, {alert: null, publicationId: null, revision: 'none:clear', nwsActive: false, nwsStatus: 'clear'});
  publisher.current.pauses.push(async () => {
    assert.equal((await publisher.send('POST', 'system_admin', advisory())).status, 200);
  });
  const response = await viewer.send('GET', 'tech', undefined, `?revision=${first.revision}`);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const delivered = await response.json();
  assert.equal(delivered.alert.text, 'Icy sidewalks');
  assert.equal(delivered.alert.override, true);
  assert.equal(delivered.alert.attention, true);
  assert.notEqual(delivered.revision, first.revision);
  assert.equal(delivered.revision, `${delivered.publicationId}:clear`);
  assert.equal(publisher.current.time, NOW + 1250);
  for (const role of FIXTURE_ROLES) assert.deepEqual(await (await viewer.send('GET', role)).json(), delivered);
  assert.equal((await (await viewer.send('DELETE', 'chief_engineer')).json()).alert, null);
  assert.equal((await (await publisher.send('GET', 'system_admin')).json()).alert, null);
});

test('a verified active NWS alert deletes the custom revision permanently even if its publisher is absent', async () => {
  const f = fixture();
  assert.equal((await f.send('POST', 'chief_engineer', advisory())).status, 200);
  f.current.features = [issuer()];
  f.current.time += 28_000;
  const superseded = (await (await f.send('GET', 'front_desk')).json());
  assert.deepEqual(superseded, {alert: null, publicationId: null, revision: 'none:active', nwsActive: true, nwsStatus: 'active'});
  assert.equal((await f.send('POST', 'system_admin', advisory('New message'))).status, 409);
  f.current.features = [];
  f.current.time += 130_000;
  assert.equal((await (await f.send('GET', 'manager')).json()).alert, null);
  assert.equal((await f.send('POST', 'system_admin', advisory('Later message'))).status, 200);
});

test('a concurrent deletion cannot clear a replacement publication', async () => {
  const f = fixture();
  let entered, proceed;
  const enteredDelete = new Promise(resolve => { entered = resolve; });
  const continueDelete = new Promise(resolve => { proceed = resolve; });
  const deleter = fixture({ current: f.current, shared: f.shared, pauseTombstone: async () => { entered(); await continueDelete; } });
  await f.send('POST', 'chief_engineer', advisory('Original'));
  const pendingDelete = deleter.send('DELETE', 'system_admin');
  await enteredDelete;
  await f.send('POST', 'chief_engineer', advisory('Replacement'));
  proceed();
  assert.equal((await (await pendingDelete).json()).alert.text, 'Replacement');
  assert.equal((await (await f.send('GET', 'tech')).json()).alert.text, 'Replacement');
});

test('an alert entirely between two viewing sessions is recovered from the fixed NWS point archive', async () => {
  const f = fixture();
  await f.send('POST', 'system_admin', advisory());
  const started = new Date(NOW + 10_000).toISOString();
  f.current.archive = [issuer(90_000, {effective: started})];
  f.current.time += 118_000;
  const after = await (await f.send('GET', 'housekeeping')).json();
  assert.equal(after.nwsActive, false);
  assert.equal(after.alert, null);
  const archive = new URL(f.requests.at(-1).source);
  assert.equal(archive.origin + archive.pathname, 'https://api.weather.gov/alerts');
  assert.equal(archive.searchParams.get('point'), '40.138080,-88.251416');
  assert.equal(archive.searchParams.get('start'), new Date(NOW).toISOString());
  assert.equal(archive.searchParams.get('end'), new Date(f.current.time).toISOString());
  assert.equal(archive.searchParams.get('status'), 'actual');
  assert.equal((await (await f.send('GET', 'system_admin')).json()).alert, null);
});

test('NWS outages preserve the accepted banner and block unverified publication', async () => {
  const f = fixture();
  await f.send('POST', 'chief_engineer', advisory());
  f.current.time += 30_000;
  f.current.outage = true;
  const status = await (await f.send('GET', 'front_desk')).json();
  assert.equal(status.alert.text, 'Icy sidewalks');
  assert.equal(status.nwsActive, false);
  assert.equal(status.nwsStatus, 'unavailable');
  assert.equal((await f.send('POST', 'system_admin', advisory('Unverified'))).status, 503);
  f.current.time = advisory().expires + 1;
  assert.equal((await (await f.send('GET', 'front_desk')).json()).alert, null);
});

test('only actual, effective, uncanceled and unexpired point bulletins affect precedence', async () => {
  const f = fixture();
  f.current.features = [issuer(60_000, {status: 'Test'}), issuer(-60_000),
    issuer(60_000, {effective: new Date(NOW + 50_000).toISOString()}),
    {...issuer(), id: 'urn:nws:canceled'}, issuer(0, {messageType: 'Cancel', references: [{identifier: 'urn:nws:canceled'}]})];
  const response = await f.send('POST', 'chief_engineer', advisory());
  assert.equal(response.status, 200);
  assert.deepEqual(f.requests.map(call => call.source), ['https://api.weather.gov/alerts/active?point=40.138080,-88.251416']);
  assert.equal(f.requests[0].init.redirect, 'manual');
  assert.equal(f.requests[0].init.credentials, 'omit');
  assert.equal((await f.send('POST', 'chief_engineer', {...advisory(), text: 'x'.repeat(2001)})).status, 400);
  assert.equal((await f.send('POST', 'chief_engineer', {...advisory(), expires: NOW})).status, 400);
  assert.equal((await f.send('POST', 'chief_engineer', {...advisory(), severity: 'notice', custom: false})).status, 400);
});
