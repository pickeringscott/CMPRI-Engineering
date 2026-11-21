import test from 'node:test';
import { makeUiTranslator, uiTitleCase } from '../src/lib/i18n/ui.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const dom = new JSDOM('<div id="root"></div>', { url: 'https://cmpri.test/engineering/preventive-maintenance?embedded=1&modalToken=fresh', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
let verified, serverEntries, requests, root, getBlocked, releaseGet;
const modules = new Map();
const fetchPm = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ url, method: options.method || 'GET', body, cache: options.cache });
  if (options.method === 'POST') {
    const existing = serverEntries.find(entry => entry.template_id === body.templateId && entry.period_start === body.periodStart && entry.scope_key === body.scopeKey);
    if ((existing?.revision || 0) !== body.expectedRevision) return { ok: false, json: async () => ({ error: 'This PM entry changed elsewhere. Your draft has been retained.' }) };
    const entry = { ...existing, id: 'saved', template_id: body.templateId, period_start: body.periodStart, scope_key: body.scopeKey, revision: body.expectedRevision + 1,
      responses: body.responses, form_data: body.formData, notes: body.notes, deficiency_notes: body.deficiencyNotes, completed_on: body.completedOn, status: 'pending', can_edit_entry: true };
    serverEntries = [...serverEntries.filter(candidate => candidate !== existing), entry];
    return { ok: true, json: async () => ({ entry }) };
  }
  if (getBlocked) await new Promise(resolve => { releaseGet = resolve; });
  return { ok: true, json: async () => ({ entries: serverEntries, workbook: { daily: {}, weekly: {}, monthly: {}, rooms: [], fetchedAt: '2026-11-20' }, actor_id: verified.user.id, actor_name: 'Alex', can_edit: true, can_review: false, locations: [{ id: 'room-location', name: 'Room 101', room_number: '101' }] }) };
};
function loadModule(path) {
  if (modules.has(path)) return modules.get(path);
  const exports = {};
  modules.set(path, exports);
  const globals = { exports, window, document, localStorage: window.localStorage, URLSearchParams, setTimeout, clearTimeout, console, crypto: globalThis.crypto, fetch: fetchPm };
  globals.require = name => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name === '@/components/UiLanguageProvider') return { useUiLanguage: () => ({ t: makeUiTranslator('en'), tt: (text, values) => uiTitleCase(makeUiTranslator('en')(text, values)), locale: 'en-US' }) };
    if (name === 'next/dynamic') return () => () => null;
    if (name === 'next/navigation') return { useRouter: () => ({ push() {} }) };
    if (name.endsWith('/supabase/client')) return { getValidSession: async () => ({ access_token: 'fixture-token' }) };
    if (name.endsWith('/auth/client-session')) return { loadCmpriSession: async () => verified };
    if (name.endsWith('/auth/session-preference')) return { enforceSessionPreference: async () => true };
    if (name.endsWith('/use-embedded-modal')) return () => true;
    if (name.endsWith('/PmRecordedIssues') || name.endsWith('.css')) return () => null;
    if (name === './source-catalog.json') return require('../src/lib/pm/source-catalog.json');
    if (name.startsWith('@/lib/pm/')) return loadModule(`src/lib/pm/${name.slice('@/lib/pm/'.length)}.ts`);
    if (name.startsWith('./')) return loadModule(`src/lib/pm/${name.slice(2)}.ts`);
    throw Error('Unexpected import ' + name);
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, globals, { filename: path });
  return exports;
}
const catalog = loadModule('src/lib/pm/catalog.ts');
const rules = loadModule('src/lib/pm/form-workspace.ts');
const Page = loadModule('src/app/engineering/preventive-maintenance/page.tsx').default;
const owner = { hotelId: 'hotel', userId: 'alex' };
const identity = { templateId: catalog.PM_ROOM_TEMPLATE_ID, periodStart: '2026-10-01', scopeKey: 'room:101' };
const inspection = catalog.PM_TEMPLATES.find(template => template.scope === 'equipment' && template.cadence === 'monthly');
const inspectionIdentity = { templateId: inspection.id, periodStart: '2026-11-01', scopeKey: 'equipment:valve-a' };
function contents(revision = 2) {
  return { revision, formData: { completedBy: 'Draft inspector' }, checklist: { [catalog.findPmTemplate(identity.templateId).checklist[0].id]: 'follow-up' }, repeatableRows: [],
    formNotes: 'Unsaved room observations', deficiencyNotes: 'Keep this follow-up', completedOn: '2026-11-19', deficiencyLocationId: 'room-location' };
}
function seed(form = identity, data = contents(), scope = owner) {
  window.localStorage.setItem(rules.pmFormWorkspaceKey(scope), JSON.stringify({ version: 1, owner: scope, weekStart: '2026-11-16', activeForm: form }));
  window.localStorage.setItem(rules.pmFormDraftKey(scope, form), JSON.stringify({ version: 1, owner: scope, identity: form, ...data }));
}
function entry(form = identity, revision = 2) {
  return { id: 'entry', template_id: form.templateId, period_start: form.periodStart, scope_key: form.scopeKey, revision, responses: {}, form_data: {}, notes: 'Server notes', deficiency_notes: '', completed_on: null, status: 'pending', can_edit_entry: true };
}
function reset() {
  window.localStorage.clear();
  verified = { user: { id: 'alex' }, hotelId: 'hotel', capabilities: ['view_pm'] };
  serverEntries = [entry()]; requests = []; getBlocked = false; releaseGet = null;
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
async function mount() { root = createRoot(document.getElementById('root')); await React.act(async () => { root.render(React.createElement(Page)); await settle(); }); }
async function unmount() { await React.act(async () => { root.unmount(); await settle(); }); }
const dialog = () => document.querySelector('[aria-labelledby="pm-form-title"]');
const notes = () => dialog()?.querySelector('textarea[placeholder="Record observations, readings, or context…"]');
async function click(button) { assert.ok(button, 'Expected button'); await React.act(async () => { button.click(); await settle(); }); }
async function editNotes(value) {
  await React.act(async () => {
    const field = notes();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle();
  });
}

test('draft keys bind a validated form to its verified property and account, rejecting legacy or copied payloads', () => {
  reset(); const data = { version: 1, owner, identity, ...contents() };
  assert.ok(rules.readPmFormDraft(JSON.stringify(data), owner, identity));
  assert.equal(rules.readPmFormDraft(JSON.stringify(contents()), owner, identity), null);
  assert.equal(rules.readPmFormDraft(JSON.stringify(data), { ...owner, hotelId: 'other' }, identity), null);
  assert.equal(rules.readPmFormDraft(JSON.stringify(data), { ...owner, userId: 'other' }, identity), null);
  assert.notEqual(rules.pmFormDraftKey(owner, identity), rules.pmFormDraftKey({ ...owner, hotelId: 'other' }, identity));
  assert.notEqual(rules.pmFormDraftKey(owner, identity), rules.pmFormDraftKey({ ...owner, userId: 'other' }, identity));
  assert.equal(rules.validPmFormIdentity({ ...identity, scopeKey: 'room:9999' }), false);
  assert.equal(rules.validPmFormIdentity({ ...identity, templateId: catalog.PM_DAILY_TEMPLATE_ID }), false);
  assert.equal(rules.validPmFormIdentity({ ...identity, periodStart: '2026-99-01' }), false);
  assert.equal(rules.readPmFormDraft(JSON.stringify({ ...data, revision: -1 }), owner, identity), null);
  assert.equal(rules.readPmFormDraft(JSON.stringify({ ...data, checklist: { task: 'bogus' } }), owner, identity), null);
});

test('nested room form and unsaved contents reopen automatically after a complete page restart', async () => {
  reset(); seed(); await mount();
  try {
    assert.match(dialog().textContent, /Room 101/); assert.equal(notes().value, 'Unsaved room observations');
    await editNotes('Changed locally before restart');
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  } finally { await unmount(); }
  await mount();
  try {
    assert.equal(notes().value, 'Changed locally before restart');
    assert.equal(dialog().querySelector('button[aria-pressed="true"]').textContent, '/ Follow-up');
    assert.equal([...dialog().querySelectorAll('label')].find(label => label.textContent.startsWith('Work-order location')).querySelector('select').value, 'room-location');
    assert.ok(requests.some(request => request.url.includes('week=2026-11-16')));
    assert.ok(requests.filter(request => request.url.includes('week=2026-11-16')).every(request => request.cache === 'reload'));
  } finally { await unmount(); }
});

test('inspection form restores its equipment identity and contents after restart', async () => {
  reset(); serverEntries = [entry(inspectionIdentity)]; seed(inspectionIdentity, { ...contents(), formData: { unitIdentifier: 'valve-a', valveId: 'Valve A' } });
  await mount(); try { assert.match(dialog().textContent, new RegExp(inspection.title)); assert.equal(notes().value, 'Unsaved room observations'); }
  finally { await unmount(); }
  await mount(); try { assert.equal(notes().value, 'Unsaved room observations'); } finally { await unmount(); }
});

test('restoration waits for the saved week fresh server read before exposing a saved form', async () => {
  reset(); seed(); getBlocked = true; await mount();
  try {
    assert.equal(dialog(), null);
    await React.act(async () => { getBlocked = false; releaseGet(); await settle(); });
    assert.ok(dialog());
  } finally { await unmount(); }
});

test('a stale server revision restores local contents and keeps the original CAS baseline on failed save', async () => {
  reset(); seed(); serverEntries = [entry(identity, 9)]; await mount();
  try {
    assert.equal(notes().value, 'Unsaved room observations');
    assert.match(dialog().textContent, /changed elsewhere/);
    await click([...dialog().querySelectorAll('button')].find(button => button.textContent === 'Save draft'));
    const post = requests.find(request => request.method === 'POST');
    assert.equal(post.body.expectedRevision, 2);
    assert.equal(serverEntries[0].revision, 9);
    const retained = rules.readPmFormDraft(window.localStorage.getItem(rules.pmFormDraftKey(owner, identity)), owner, identity);
    assert.equal(retained.revision, 2); assert.equal(retained.formNotes, 'Unsaved room observations');
  } finally { await unmount(); }
});

test('other properties and accounts cannot reopen a form or consume its draft; legacy drafts stay untouched', async () => {
  reset(); seed(); const legacyKey = `cmpri-pm-draft:alex:${identity.templateId}|${identity.periodStart}|${identity.scopeKey}`;
  window.localStorage.setItem(legacyKey, JSON.stringify(contents()));
  const original = window.localStorage.getItem(rules.pmFormDraftKey(owner, identity));
  verified = { ...verified, hotelId: 'other' }; await mount();
  try { assert.equal(dialog(), null); } finally { await unmount(); }
  verified = { ...verified, hotelId: 'hotel', user: { id: 'sam' } }; await mount();
  try { assert.equal(dialog(), null); } finally { await unmount(); }
  assert.equal(window.localStorage.getItem(rules.pmFormDraftKey(owner, identity)), original);
  assert.ok(window.localStorage.getItem(legacyKey));
  verified = { ...verified, user: { id: 'alex' } }; await mount();
  try { assert.equal(notes().value, 'Unsaved room observations'); } finally { await unmount(); }
});

test('nested Close keeps the form draft and records that the form was intentionally closed', async () => {
  reset(); seed(); await mount();
  try { await click([...dialog().querySelectorAll('button')].find(button => button.textContent === 'Close')); assert.equal(dialog(), null); }
  finally { await unmount(); }
  await mount();
  try {
    assert.equal(dialog(), null);
    assert.ok(window.localStorage.getItem(rules.pmFormDraftKey(owner, identity)));
  } finally { await unmount(); }
});

test('a changed authenticated property cannot save the old form or erase its local draft', async () => {
  reset(); seed(); await mount();
  try {
    verified = { ...verified, hotelId: 'other' };
    await click([...dialog().querySelectorAll('button')].find(button => button.textContent === 'Save draft'));
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    assert.match(dialog().textContent, /same account and property/);
  } finally { await unmount(); }
  assert.ok(window.localStorage.getItem(rules.pmFormDraftKey(owner, identity)));
});

test('successful save advances only the acknowledged draft baseline, including a save finishing after nested Close', async () => {
  reset(); seed(); await mount();
  try {
    await editNotes('Edited before nested close');
    await click([...dialog().querySelectorAll('button')].find(button => button.textContent === 'Close'));
    assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(serverEntries[0].revision, 3);
    const saved = rules.readPmFormDraft(window.localStorage.getItem(rules.pmFormDraftKey(owner, identity)), owner, identity);
    assert.equal(saved.revision, 3); assert.equal(saved.formNotes, 'Edited before nested close');
  } finally { await unmount(); }
});

test('logout revokes authentication without deleting PM drafts, active form identity, checkbox outbox, or unscoped legacy contents', () => {
  reset(); seed();
  const queue = loadModule('src/lib/pm/task-queue.ts');
  const { createSessionStoragePolicy, SESSION_KEY, REMEMBER_KEY } = loadModule('src/lib/auth/session-storage.ts');
  const queueKey = queue.pmQueueStorageKey(owner.hotelId, owner.userId);
  window.localStorage.setItem(queueKey, 'retained checkbox outbox');
  window.localStorage.setItem('cmpri-pm-draft:alex:legacy', 'unattributed draft');
  window.localStorage.setItem(SESSION_KEY, 'fixture-auth'); window.localStorage.setItem(REMEMBER_KEY, 'true');
  const before = [rules.pmFormDraftKey(owner, identity), rules.pmFormWorkspaceKey(owner), queueKey, 'cmpri-pm-draft:alex:legacy'].map(key => [key, window.localStorage.getItem(key)]);
  createSessionStoragePolicy(window.localStorage, window.sessionStorage).revoke();
  assert.equal(window.localStorage.getItem(SESSION_KEY), null);
  assert.equal(window.localStorage.getItem(REMEMBER_KEY), null);
  for (const [key, value] of before) assert.equal(window.localStorage.getItem(key), value);
});

test('forms outside the selected week query range resume against a week that can freshly validate their revision', () => {
  assert.equal(rules.pmFormRestoreWeek('2026-11-16', identity), '2026-11-16');
  const future = { ...identity, periodStart: '2027-01-01' };
  assert.equal(rules.pmFormRestoreWeek('2026-11-16', future), '2026-12-28');
  const old = { ...identity, periodStart: '2026-01-01' };
  assert.equal(rules.pmFormRestoreWeek('2026-11-16', old), '2025-12-29');
});

test('a closed retained form draft still forces a fresh server revision, while ordinary PM opens keep normal caching', async () => {
  reset(); await mount();
  try { assert.ok(requests.filter(request => request.method === 'GET').every(request => request.cache === 'no-store')); }
  finally { await unmount(); }
  seed(); window.localStorage.setItem(rules.pmFormWorkspaceKey(owner), JSON.stringify({ version: 1, owner, weekStart: '2026-11-16', activeForm: null }));
  assert.equal(rules.hasPmFormRecovery(window.localStorage, owner, '2026-11-16'), true);
  assert.equal(rules.hasPmFormRecovery(window.localStorage, { ...owner, hotelId: 'other' }, '2026-11-16'), false);
  assert.equal(rules.hasPmFormRecovery(window.localStorage, { ...owner, userId: 'sam' }, '2026-11-16'), false);
});
