import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as ai from 'ai';
import * as googleSdk from '@ai-sdk/google';
import * as zod from 'zod';
import { loadTs } from './helpers/load-ts.mjs';

const principal = { identity: { id: '00000000-0000-4000-8000-000000000001', email: 'provider-fixture@example.invalid' }, hotelId: '00000000-0000-4000-8000-000000000002', profile: { role: 'system_admin', active: true } };
const catalog = loadTs('src/lib/server/ask-cmpri-native-catalog.ts', {
  'server-only': {}, '@/lib/ai/cmpri-operation-guidance': loadTs('src/lib/ai/cmpri-operation-guidance.ts'),
});
const nativeQuery = loadTs('src/lib/ask-cmpri/native-query.ts', { '@/lib/loyalty-tier': loadTs('src/lib/loyalty-tier.ts') }, { Error });
const nativeContext = loadTs('src/lib/ask-cmpri/native-context.ts');
const answer = { title: 'Provider boundary', summary: 'The recorded provider response was parsed.', itemIds: [], format: 'default' };
const providerResponse = parts => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 }, modelVersion: 'gemini-provider-fixture',
}), { status: 200, headers: { 'content-type': 'application/json' } });

/** Actual SDK, Google provider and CMPRI schemas; only HTTP and native data/auth edges are substituted. */
function fixture(respond = () => providerResponse([{ text: JSON.stringify(answer) }])) {
  const requests = [], nativeCalls = [];
  const unexpected = () => { throw new Error('Unexpected native edge'); };
  const dependencies = {
    'server-only': {}, 'node:crypto': { createHash }, ai, zod,
    '@ai-sdk/google': { ...googleSdk, createGoogleGenerativeAI(options) {
      assert.equal(options.apiKey, 'not-a-real-provider-key');
      return googleSdk.createGoogleGenerativeAI({ ...options, fetch: async (url, init) => {
        const call = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) };
        requests.push(call);
        return respond(call, requests.length);
      } });
    } },
    '@/lib/ask-cmpri/native-query': nativeQuery,
    '@/lib/ask-cmpri/native-context': nativeContext,
    './ask-cmpri-native-catalog': catalog,
    './ask-cmpri-native': {
      askNativeScreen: () => '/engineering',
      beginAskNativeChange: unexpected,
      nativeReadItem: (source, id) => ({ id, title: source.source, source: source.source, sourceType: 'local', record: { kind: 'module', id: source.screen, label: 'Open source' } }),
      runAskNativeRequest: async (_request, call) => {
        nativeCalls.push(call);
        return { operation: call.operation, ok: true, status: 200, screen: '/engineering', source: 'CMPRI · fixture', data: { rooms: [{ number: '201', guest_name: 'Fixture Guest', bonvoy_tier: 'Gold' }] } };
      },
    },
    './ask-cmpri-pm': { readAskPm: unexpected },
    './ask-cmpri-gemini': { askGeminiKey: () => 'not-a-real-provider-key', publicAskQuery: unexpected, searchPublicAsk: unexpected },
    './ask-cmpri-public-search': { searchAskVendorDocuments: unexpected },
    './ask-cmpri-public-document': { askPublicDocumentUrl: value => new URL(value) },
    './ask-cmpri-vendor-document': { loadAskVendorAsset: unexpected, prepareAskVendorDocument: unexpected, readAskVendorEvidence: unexpected, reviewAskVendorDocument: unexpected },
  };
  const fileName = 'src/lib/server/ask-cmpri-native-agent.ts', exports = {};
  const compiled = ts.transpileModule(readFileSync(fileName, 'utf8'), { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { exports, Buffer, console, Date, Intl, Error, URL, AbortSignal, process: { env: {} }, require(name) {
    assert.ok(name in dependencies, `Unexpected agent import: ${name}`);
    return dependencies[name];
  } });
  const run = (question = 'Which rooms have Gold Bonvoy guests?') => exports.runNativeAsk({
    request: new Request('https://cmpri.invalid/api/ask-cmpri'), auth: { ok: true, mcp: false, principal }, question,
    language: 'en', chief: true, signal: new AbortController().signal,
  });
  return { run, requests, nativeCalls };
}


const unavailable = () => new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Service unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });

test('the first Gemini 503 makes one fallback request with the same authorized tool contract', async () => {
  const h = fixture((_request, count) => count === 1 ? unavailable() : providerResponse([{ text: JSON.stringify(answer) }]));
  const result = await h.run('What is CMPRI Engineering?');
  assert.equal(result.summary, answer.summary);
  assert.equal(h.nativeCalls.length, 0);
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[0].url, /\/models\/gemini-3\.6-flash:generateContent$/);
  assert.match(h.requests[1].url, /\/models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.deepEqual(h.requests[0].body.contents, h.requests[1].body.contents);
  assert.deepEqual(h.requests[0].body.tools, h.requests[1].body.tools);
  assert.deepEqual(h.requests[0].body.generationConfig.responseJsonSchema, h.requests[1].body.generationConfig.responseJsonSchema);
});

test('two unavailable provider responses stop after the single fallback', async () => {
  const h = fixture(() => unavailable());
  await assert.rejects(h.run(), error => error.statusCode === 503);
  assert.equal(h.requests.length, 2);
  assert.equal(h.nativeCalls.length, 0);
});

for (const status of [400, 401, 429]) {
  test(`provider HTTP ${status} never triggers the alternate model`, async () => {
    const h = fixture(() => new Response(JSON.stringify({ error: { code: status, status: 'ERROR', message: 'Fixture error' } }), { status, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(h.run(), error => error.statusCode === status);
    assert.equal(h.requests.length, 1);
  });
}

test('a 503 after a completed discovery tool must not restart the agent or switch models', async () => {
  const h = fixture((_request, count) => count === 1
    ? providerResponse([{ functionCall: { name: 'discoverOperations', args: { query: 'room' } }, thoughtSignature: 'fixture-thought-1' }])
    : unavailable());
  await assert.rejects(h.run(), error => error.statusCode === 503);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => /\/models\/gemini-3\.6-flash:generateContent$/.test(request.url)));
  assert.equal(h.nativeCalls.length, 0);
});
