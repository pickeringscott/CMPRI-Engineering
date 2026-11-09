import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/app/work-orders/[id]/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pageCallback(name, context) {
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, name);
  const code = ts.transpileModule(`exports.run = ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Error, ...context });
  return exports.run;
}
function pageEffect(marker, context) {
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes(marker)) callback = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, marker);
  const code = ts.transpileModule(`exports.run = ${callback.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, ...context });
  return exports.run;
}
function fixture(flushes = []) {
  const state = { busy: [], errors: [], left: 0 };
  const lifetime = { active: true };
  const context = {
    exitInFlight: { current: false },
    readLifetime: { current: lifetime },
    checklistExitFlushes: { current: new Set(flushes) },
    setExitFlushing: value => state.busy.push(value),
    setExitError: value => state.errors.push(value),
  };
  return { state, lifetime, context, run: pageCallback('runTicketExit', context), leave: () => { state.left++; } };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('controlled exit waits for every saved visit journal before closing', async () => {
  const pending = deferred(), calls = [];
  const h = fixture([async () => { calls.push('first'); await pending.promise; }, async () => { calls.push('second'); }]);
  const leaving = h.run(h.leave);
  assert.equal(h.state.left, 0);
  assert.deepEqual(calls, ['first']);
  assert.equal(await h.run(h.leave), false, 'a second click cannot start another exit');
  pending.resolve();
  assert.equal(await leaving, true);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(h.state.left, 1);
  assert.deepEqual(h.state.busy, [true, false]);
});

test('a failed note finalization keeps the view open and permits deliberate retry', async () => {
  let fail = true, writes = 0;
  const h = fixture([async () => { writes++; if (fail) throw new Error('The activity note could not be confirmed.'); }]);
  assert.equal(await h.run(h.leave), false);
  assert.equal(h.state.left, 0);
  assert.match(h.state.errors.at(-1), /view stayed open.*could not be confirmed/);
  fail = false;
  assert.equal(await h.run(h.leave), true);
  assert.equal(writes, 2);
  assert.equal(h.state.left, 1);
});

test('a completed finalizer cannot navigate a page that has already unmounted', async () => {
  const pending = deferred();
  const h = fixture([() => pending.promise]);
  const leaving = h.run(h.leave);
  h.lifetime.active = false;
  pending.resolve();
  assert.equal(await leaving, false);
  assert.equal(h.state.left, 0);
});

test('checklist unmounts retain their finalizer for this page editing visit', async () => {
  const h = fixture();
  let finalized = 0;
  const register = pageCallback('registerExitFlush', h.context);
  const unregister = register(async () => { finalized++; });
  unregister();
  await h.run(h.leave);
  assert.equal(finalized, 1);
});

test('a last-moment navigation failure keeps the view open and reports its reason', async () => {
  const h = fixture([async () => {}]);
  let removed = false;
  const closed = await h.run(() => { removed = true; throw new Error('The local draft could not be cleared. Your text is still here.'); });
  assert.equal(closed, false);
  assert.equal(removed, true);
  assert.equal(h.state.left, 0);
  assert.match(h.state.errors.at(-1), /still here/);
});

test('the cancel guard waits for an exit decision before finalizing a dirty visit', () => {
  let closed = 0, prompted = 0;
  const cancel = pageCallback('cancelTicket', {
    saving: false, issueSaveCount: { current: 0 }, saveInFlight: { current: false }, hasUnsavedChanges: true,
    setShowCancelConfirm: () => { prompted++; }, closeEmbeddedTicket: () => { closed++; },
  });
  cancel();
  assert.equal(prompted, 1);
  assert.equal(closed, 0);
});

test('Strict Mode effect replay never finalizes a live visit, while true unmount and pagehide do', async () => {
  let finalized = 0;
  const callbacks = new Map(), queued = [];
  const effect = pageEffect('exitFallbackGeneration.current', {
    exitFallbackGeneration: { current: 0 },
    checklistExitFlushes: { current: new Set([async () => { finalized++; }]) },
    queueMicrotask: callback => queued.push(callback),
    window: { addEventListener: (event, callback) => callbacks.set(event, callback), removeEventListener: event => callbacks.delete(event) },
  });
  const firstCleanup = effect();
  firstCleanup();
  const cleanup = effect();
  queued.splice(0).forEach(callback => callback());
  assert.equal(finalized, 0, 'replayed effects keep the current editing visit open');
  callbacks.get('pagehide')();
  assert.equal(finalized, 1);
  cleanup();
  queued.splice(0).forEach(callback => callback());
  assert.equal(finalized, 2, 'genuine unmount retries the idempotent finalizer');
});

test('a bfcache restoration starts a fresh page editing visit', () => {
  let restored = 0;
  const callbacks = new Map();
  const effect = pageEffect('event.persisted', {
    setRestoredVisit: update => { restored = update(restored); },
    window: { addEventListener: (event, callback) => callbacks.set(event, callback), removeEventListener: event => callbacks.delete(event) },
  });
  const cleanup = effect();
  callbacks.get('pageshow')({ persisted: false });
  assert.equal(restored, 0);
  callbacks.get('pageshow')({ persisted: true });
  assert.equal(restored, 1);
  cleanup();
  assert.equal(callbacks.has('pageshow'), false);
});
