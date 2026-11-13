import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { assetGuideIdentity, reconcileAssetGuide } from '../src/lib/work-orders/asset-guide-cache.ts';
import { deriveTroubleshootingChecklistContext } from '../src/lib/work-orders/troubleshooting-checklist.ts';
import { normalizeManualKnowledge } from '../src/lib/manual-knowledge.ts';
import { eventRefresh } from '../src/lib/events/refresh.ts';

const source = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let result;
  function visit(node) { if (predicate(node)) result = node; ts.forEachChild(node, visit); }
  visit(ast); assert.ok(result); return result;
}
const loadSource = find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadManualForAsset').getText(ast);
const effectSource = find(node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
  && node.arguments[0]?.getText(ast).includes('manualCompletedIdentity.current !== manualSelectionKey')).arguments[0].getText(ast);
const currentSource = find(node => ts.isVariableDeclaration(node) && node.name?.text === 'manualCurrent').initializer.getText(ast);
function evaluate(code, context) {
  const sandbox = { exports: {}, Error, AbortController, ...context };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  return sandbox.exports.value;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const asset = (id = 'washer', fields = {}) => ({ id, name: `${id} equipment`, location_id: 'test-location', asset_type: id,
  manufacturer: 'Fixture Maker', model_family: 'Model', model_number: 'Model-A', documentation_key: 'manual-a',
  documentation_revision_id: 'revision-a', documentation_verified_at: null, ...fields });
const knowledge = (id = 'washer') => ({ manufacturer: 'Fixture Maker', model_number: 'Model-A',
  source: { verified: true, source_kind: 'asset-upload', storage_path: `test/${id}/manual.pdf`, sha256: 'a'.repeat(64), registered_file_id: `file-${id}` },
  symptom_rules: [{ match: ['will not start'], steps: ['Check the source-listed power supply.'], source_pages: [2] }],
});
const response = (current, overrides = {}) => ({ ok: true, status: 200, json: async () => ({ assets: [current], manualKnowledge: { ...knowledge(current.id), manufacturer: current.manufacturer, model_number: current.model_number }, documentation_status: 'verified', ...overrides }) });

function fixture(initial = asset()) {
  const state = { assets: [initial], selectedId: initial.id, result: null, retry: 0, calls: [], pending: [], subscriptions: [] };
  const completed = { current: '' }, selection = { current: '' };
  let cleanup;
  const selected = () => state.assets.find(item => item.id === state.selectedId);
  const base = { id: 'test-ticket', assetGuideIdentity, reconcileAssetGuide, normalizeManualKnowledge,
    fetch: (...args) => globalThis.fetch(...args),
    getValidSession: async () => ({ access_token: 'fixture-token' }),
    manualCompletedIdentity: completed, manualSelection: selection, manualLoadGeneration: { current: 0 },
    setAssets: next => { state.assets = typeof next === 'function' ? next(state.assets) : next; },
    setManualResult: next => { state.result = next; },

  };
  const load = evaluate(`${loadSource}\nexports.value = loadManualForAsset;`, base);
  function render() {
    cleanup?.();
    const selectedAsset = selected();
    selection.current = `test-ticket:${assetGuideIdentity(selectedAsset)}`;
    const run = evaluate(`exports.value = ${effectSource};`, { ...base, selectedAsset, manualSelectionKey: selection.current,
      loadManualForAsset: load,
      subscribeResources(topics, callback, initial) {
        assert.deepEqual(Array.from(topics), ['reference']);
        const refresh = eventRefresh(() => { const promise = callback(); state.pending.push(promise); return promise; });
        state.subscriptions.push({ initial, request: refresh.request });
        if (initial) refresh.request();
        return refresh.stop;
      },
    });
    cleanup = run();
  }
  return { state, render, selected, reload: () => load(selected()),
    current: () => evaluate(`exports.value = ${currentSource};`, { selectedAsset: selected(), manualResult: state.result, assetGuideIdentity }),
    refresh: () => state.subscriptions.at(-1).request(),
    settle: async () => { await tick(); await Promise.all(state.pending); await tick(); },
    dispose: () => cleanup?.(),
  };
}

for (const type of ['washer', 'television', 'shower', 'door-lock']) test(`successful ${type} guide reconciles a newer revision/model and remains visible without a load loop`, async t => {
  const initial = asset(type), updated = { ...initial, model_number: 'Model-B', documentation_revision_id: 'revision-b', documentation_verified_at: '2026-11-10T12:00:00Z' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls++; assert.ok(url.includes(`assetId=${type}&source=asset-upload`)); assert.equal(options.method || 'GET', 'GET'); return response(updated); });
  const f = fixture(initial); t.after(f.dispose); f.render(); await f.settle();
  assert.equal(f.state.result.status, 'verified'); assert.equal(f.current(), true); assert.equal(f.selected().model_number, 'Model-B');
  assert.equal(f.selected().documentation_revision_id, 'revision-b'); assert.equal(f.selected().name, initial.name);
  assert.equal(f.state.result.knowledge.source.registered_file_id, `file-${type}`);
  const checklist = deriveTroubleshootingChecklistContext({ issue: 'will not start', asset: f.selected() }, f.state.result.knowledge);
  assert.equal(checklist.steps.length, 1); assert.ok(checklist.contextIdentity);
  const serverContext = deriveTroubleshootingChecklistContext({ issue: 'will not start', asset: updated }, f.state.result.knowledge);
  assert.equal(checklist.contextIdentity, serverContext.contextIdentity);
  f.render(); await f.settle(); assert.equal(calls, 1); assert.equal(f.state.subscriptions.at(-1).initial, false);
  f.refresh(); await f.settle(); assert.equal(calls, 2); assert.equal(f.current(), true);
});

test('a failed guide request exposes its error and can recover for the same equipment', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? { ok: false, status: 503, json: async () => ({ error: 'The attachment register is temporarily unavailable.' }) }
    : response(asset()));
  const f = fixture(); t.after(f.dispose); f.render(); await f.settle();
  assert.equal(f.current(), true);
  assert.equal(f.state.result.status, 'lookup_unavailable');
  assert.match(f.state.result.reason, /attachment register is temporarily unavailable/);
  await f.reload();
  assert.equal(attempts, 2);
  assert.equal(f.state.result.status, 'verified');
  assert.equal(f.state.result.knowledge.source.registered_file_id, 'file-washer');
});

test('a non-JSON timeout response remains retryable and does not hide behind an empty result', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 504, json: async () => { throw Error('Unexpected HTML'); } }));
  const f = fixture(); t.after(f.dispose); f.render(); await f.settle();
  assert.equal(f.state.result.knowledge, null);
  assert.match(f.state.result.reason, /504/);
});

test('a same-equipment reload shows loading and cannot be overwritten by an older response', async t => {
  const old = deferred(), fresh = deferred(); let attempts = 0;
  t.mock.method(globalThis, 'fetch', () => ++attempts === 1 ? old.promise : fresh.promise);
  const f = fixture(); t.after(f.dispose); f.render(); await tick();
  const reloaded = f.reload(); await tick();
  assert.equal(f.current(), false);
  fresh.resolve(response(asset())); await reloaded;
  old.resolve({ ok: false, status: 503, json: async () => ({ error: 'An older read failed.' }) });
  await f.settle();
  assert.equal(f.state.result.status, 'verified');
  assert.equal(f.current(), true);
});

test('null and absent optional values are equivalent; revisions and exact model numbers are not', () => {
  assert.equal(assetGuideIdentity({ id: 'a' }), assetGuideIdentity({ id: 'a', documentation_revision_id: null, model_family: null }));
  assert.notEqual(assetGuideIdentity(asset()), assetGuideIdentity(asset('washer', { model_number: 'Model-B' })));
  assert.notEqual(assetGuideIdentity(asset()), assetGuideIdentity(asset('washer', { documentation_revision_id: 'revision-b' })));
});

test('reconciliation preserves unrelated edits and never overwrites newer model/revision or another asset', () => {
  const requested = asset(), newer = { ...requested, model_number: 'User-selected-model', name: 'Edited name' }, other = asset('television');
  const result = reconcileAssetGuide([newer, other], requested, { ...requested, model_number: 'Response-model' });
  assert.equal(result[0], newer); assert.equal(result[1], other);
  const edited = { ...requested, name: 'Edited name', location_id: 'new-location' };
  const applied = reconcileAssetGuide([edited], requested, { ...requested, documentation_revision_id: 'revision-b', name: 'Old name' });
  assert.equal(applied[0].name, 'Edited name'); assert.equal(applied[0].location_id, 'new-location'); assert.equal(applied[0].documentation_revision_id, 'revision-b');
});

test('switching equipment suppresses an older successful response without changing the selection', async t => {
  const gate = deferred();
  t.mock.method(globalThis, 'fetch', async url => url.includes('assetId=washer') ? gate.promise : response(asset('television')));
  const f = fixture(); t.after(f.dispose); f.state.assets.push(asset('television')); f.render(); await tick();
  f.state.selectedId = 'television'; f.render(); await tick();
  gate.resolve(response(asset('washer', { model_number: 'Stale model' }))); await f.settle();
  assert.equal(f.state.result.asset.id, 'television'); assert.equal(f.state.assets[0].model_number, 'Model-A'); assert.equal(f.current(), true);
});

test('unmount cannot publish a late result or reconcile its cache', async t => {
  const gate = deferred();
  t.mock.method(globalThis, 'fetch', async () => gate.promise);
  const f = fixture(); f.render(); await tick(); f.dispose();
  gate.resolve(response(asset('washer', { documentation_revision_id: 'late' }))); await f.settle();
  assert.equal(f.state.result, null); assert.equal(f.selected().documentation_revision_id, 'revision-a');
});

test('a newer model edit invalidates the older result and is never overwritten by it', async t => {
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? gate.promise : response(asset('washer', { model_number: 'Latest model' })));
  const f = fixture(); t.after(f.dispose); f.render(); await tick();
  f.state.assets = [asset('washer', { model_number: 'Latest model' })]; f.render(); await tick();
  gate.resolve(response(asset('washer', { model_number: 'Stale model' }))); await f.settle();
  assert.equal(f.selected().model_number, 'Latest model'); assert.equal(f.state.result.asset.model_number, 'Latest model');
});

test('an unrelated name/location edit made while loading survives reconciliation', async t => {
  const gate = deferred();
  t.mock.method(globalThis, 'fetch', async () => gate.promise);
  const f = fixture(); t.after(f.dispose); f.render(); await tick();
  f.state.assets = [{ ...f.selected(), name: 'Edited name', location_id: 'Edited location' }];
  gate.resolve(response(asset('washer', { documentation_revision_id: 'revision-b' }))); await f.settle();
  assert.equal(f.selected().name, 'Edited name'); assert.equal(f.selected().location_id, 'Edited location');
  assert.equal(f.selected().documentation_revision_id, 'revision-b'); assert.equal(f.current(), true);
});

test('a later resource invalidation refreshes an already cached guide', async t => {
  let current = asset(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(current); });
  const f = fixture(); t.after(f.dispose); f.render(); await f.settle(); f.render(); await f.settle(); assert.equal(calls, 1);
  current = { ...current, documentation_revision_id: 'revision-after-event' }; f.refresh(); await f.settle();
  assert.equal(calls, 2); assert.equal(f.selected().documentation_revision_id, 'revision-after-event'); assert.equal(f.current(), true);
  f.render(); await f.settle(); assert.equal(calls, 2);
});

test('null hydration remains current without weakening a later revision change', async t => {
  const initial = asset(); delete initial.documentation_revision_id; delete initial.documentation_verified_at;
  let current = { ...initial, documentation_revision_id: null, documentation_verified_at: null };
  t.mock.method(globalThis, 'fetch', async () => response(current));
  const f = fixture(initial); t.after(f.dispose); f.render(); await f.settle(); assert.equal(f.current(), true);
  f.state.assets = [{ ...initial, documentation_revision_id: 'new-revision' }]; assert.equal(f.current(), false);
  current = f.selected(); f.render(); await f.settle(); assert.equal(f.current(), true);
});

for (const invalidSource of [{ source_kind: 'generic' }, { sha256: '' }, { registered_file_id: '' }, { storage_path: '' }]) test(`client still rejects untrusted source: ${JSON.stringify(invalidSource)}`, async t => {
  const manualKnowledge = knowledge(); Object.assign(manualKnowledge.source, invalidSource);
  t.mock.method(globalThis, 'fetch', async () => response(asset(), { manualKnowledge }));
  const f = fixture(); t.after(f.dispose); f.render(); await f.settle();
  assert.equal(f.state.result.knowledge, null); assert.match(f.state.result.reason, /Only an approved document/);
});


test('serial identity participates in cache reconciliation and prevents older responses overwriting serial edits', async t => {
  const initial = asset('washer', { serial_number: 'SERIAL-A' });
  const updated = { ...initial, serial_number: 'SERIAL-B' };
  assert.notEqual(assetGuideIdentity(initial), assetGuideIdentity(updated));
  assert.equal(assetGuideIdentity({ id: 'a', serial_number: null }), assetGuideIdentity({ id: 'a' }));
  const newer = { ...initial, serial_number: 'USER-EDIT' };
  assert.equal(reconcileAssetGuide([newer], initial, updated)[0], newer);
  t.mock.method(globalThis, 'fetch', async () => response(updated));
  const f = fixture(initial); t.after(f.dispose); f.render(); await f.settle();
  assert.equal(f.selected().serial_number, 'SERIAL-B'); assert.equal(f.current(), true);
  f.render(); await f.settle(); assert.equal(f.state.subscriptions.at(-1).initial, false);
});

test('reconciliation preserves every linked manual and its document-specific checklist provenance', async t => {
  const initial = asset();
  const updated = { ...initial, documentation_revision_id: 'multi-manual-revision' };
  const manual = knowledge();
  manual.sources = [manual.source, { ...manual.source, registered_file_id: 'second-file', storage_path: 'test/washer/second.pdf', sha256: 'b'.repeat(64) }];
  manual.symptom_rules = manual.sources.map(source => ({ match: ['will not start'], steps: ['Inspect the listed connection.'], source_pages: [2], source_document_id: source.registered_file_id, source_sha256: source.sha256 }));
  t.mock.method(globalThis, 'fetch', async () => response(updated, { manualKnowledge: manual }));
  const f = fixture(initial); t.after(f.dispose); f.render(); await f.settle();
  assert.equal(f.current(), true); assert.equal(f.state.result.knowledge.sources.length, 2);
  const checklist = deriveTroubleshootingChecklistContext({ issue: 'will not start', asset: f.selected() }, f.state.result.knowledge);
  assert.equal(checklist.steps.length, 2);
  assert.deepEqual(checklist.steps.map(step => step.source_document_id), ['file-washer', 'second-file']);
});
