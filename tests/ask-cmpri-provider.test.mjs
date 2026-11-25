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
export function fixture(respond = () => providerResponse([{ text: JSON.stringify(answer) }])) {
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
  vm.runInNewContext(compiled.outputText, { exports, Buffer, console, Date, Intl, Error, URL, AbortSignal, structuredClone, process: { env: {} }, require(name) {
    assert.ok(name in dependencies, `Unexpected agent import: ${name}`);
    return dependencies[name];
  } });
  const run = (question = 'Which rooms have Gold Bonvoy guests?') => exports.runNativeAsk({
    request: new Request('https://cmpri.invalid/api/ask-cmpri'), auth: { ok: true, mcp: false, principal }, question,
    language: 'en', chief: true, signal: new AbortController().signal,
  });
  return { run, requests, nativeCalls };
}

test('the real installed Google provider serializes every native tool and the structured answer', async () => {
  const h = fixture();
  const result = await h.run();
  assert.equal(result.summary, answer.summary);
  assert.equal(h.requests.length, 1);
  assert.equal(h.nativeCalls.length, 0);
  const { url, body } = h.requests[0];
  assert.match(url, /\/models\/gemini-3\.5-flash:generateContent$/);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseJsonSchema.type, 'object');
  const declarations = body.tools.flatMap(tool => tool.functionDeclarations || []);
  assert.ok(declarations.length >= 14);
  assert.ok(declarations.every(tool => tool.parametersJsonSchema?.type === 'object'));
  assert.ok(declarations.some(tool => tool.name === 'readCmpri'));
  assert.ok(declarations.some(tool => tool.name === 'proposeChange'));
  const requests = declarations.find(tool => tool.name === 'proposeChange').parametersJsonSchema.properties.requests;
  assert.equal(requests.type, 'array');
  assert.equal(requests.maxItems, undefined);
  assert.equal(requests.items.properties.files.items.properties.name.maxLength, undefined);
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'VALIDATED');
  assert.equal(h.requests[0].headers.get('x-goog-api-key'), 'not-a-real-provider-key');
  // A mocked accepted response proves SDK construction/parsing, not live Google schema acceptance.
});

for (const reason of ['INVALID_ARGUMENT', 'API_KEY_INVALID']) {
  test(`a real Google SDK HTTP 400 preserves ${reason} diagnostics before any native read`, async () => {
    const responseBody = JSON.stringify({ error: {
      code: 400, status: 'INVALID_ARGUMENT',
      message: reason === 'API_KEY_INVALID' ? 'API key not valid. Please pass a valid API key.' : 'The function declaration schema is invalid.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'generativelanguage.googleapis.com' }],
    } });
    const h = fixture(() => new Response(responseBody, { status: 400, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(h.run(), error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.isRetryable, false);
      assert.equal(error.responseBody, responseBody);
      assert.equal(JSON.parse(error.responseBody).error.details[0].reason, reason);
      assert.equal(error.data.error.status, 'INVALID_ARGUMENT');
      assert.equal(error.data.error.details[0].reason, reason, 'the parsed SDK error exposes a safe classification field');
      assert.equal(error.message, JSON.parse(responseBody).error.message);
      return true;
    });
    assert.equal(h.requests.length, 1, 'HTTP 400 is not retried');
    assert.equal(h.nativeCalls.length, 0, 'a rejected first provider request cannot invent native evidence');
  });
}

test('the fallback quota error stops the request and each request starts with the primary', async () => {
  const h = fixture((_request, count) => {
    const status = count % 2 ? 503 : 429;
    return Response.json({ error: { code: status, message: 'Fixture provider rejection' } }, { status });
  });
  for (let count = 0; count < 2; count++) await assert.rejects(h.run(), { statusCode: 429 });
  assert.deepEqual(h.requests.map(({ url }) => url.split('/').at(-1)), [
    'gemini-3.6-flash:generateContent', 'gemini-3.5-flash-lite:generateContent',
    'gemini-3.6-flash:generateContent', 'gemini-3.5-flash-lite:generateContent',
  ]);
  assert.equal(h.nativeCalls.length, 0);
});

test('model fallback does not replay a request after a tool runs', async () => {
  const h = fixture((_request, count) => count === 1
    ? providerResponse([{ functionCall: { name: 'readCmpri', args: { operation: 'room_operations.read' } }, thoughtSignature: 'fixture-thought' }])
    : Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'Model unavailable' } }, { status: 503 }));
  const result = await h.run();
  assert.match(result.summary, /stopped before the full request/);
  assert.equal(h.requests.length, 2);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(h.requests[0].url, h.requests[1].url);
});

test('real tool-loop and Google response serialization discover, describe, read and query native data', async () => {
  const steps = [
    ['discoverOperations', { query: 'room' }],
    ['describeOperation', { operation: 'room_operations.read' }],
    ['readCmpri', { operation: 'room_operations.read' }],
    ['querySnapshot', { snapshotId: 'snapshot:1', path: 'rooms', filters: [{ path: 'bonvoy_tier', operator: 'eq', valueJson: '"Gold"' }] }],
  ];
  const final = { title: 'Gold guests', summary: 'The fixture contains one Gold guest in room 201.', itemIds: ['query:2:0'], format: 'default' };
  const h = fixture((_request, count) => {
    assert.ok(count <= steps.length + 1, 'the real SDK must finish after the structured answer');
    if (count > steps.length) return providerResponse([{ text: JSON.stringify(final) }]);
    const [name, args] = steps[count - 1];
    return providerResponse([{ functionCall: { name, args }, thoughtSignature: `fixture-thought-${count}` }]);
  });
  const result = await h.run();
  assert.equal(h.requests.length, 5);
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(h.nativeCalls[0].operation, 'room_operations.read');
  assert.deepEqual(JSON.parse(JSON.stringify(h.nativeCalls[0].query)), {});
  assert.equal(result.summary, final.summary);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'query:2:0');
  assert.equal(result.items[0].facts.find(fact => fact.label === 'bonvoy_tier').value, 'Gold');
  assert.equal(result.items[0].record.id, '/engineering');
  const parts = h.requests.at(-1).body.contents.flatMap(content => content.parts);
  assert.deepEqual(parts.filter(part => part.functionCall).map(part => part.functionCall.name), steps.map(([name]) => name));
  assert.deepEqual(parts.filter(part => part.functionResponse).map(part => part.functionResponse.name), steps.map(([name]) => name));
  assert.deepEqual(parts.filter(part => part.functionCall).map(part => part.thoughtSignature), steps.map((_step, index) => `fixture-thought-${index + 1}`));
  assert.ok(parts.filter(part => part.functionResponse).every(part => part.functionResponse.response), 'native results are serialized as actual function responses');
});
