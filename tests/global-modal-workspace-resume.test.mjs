import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as registry from '../src/lib/open-work-orders.ts';
import * as workspace from '../src/lib/ui/workspace-resume.ts';
import { canResumeWorkspaceView } from '../src/lib/ui/workspace-route-access.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://cmpri.test/notes', pretendToBeVisual: true,
});
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync('src/components/GlobalModalHost.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
let pathname = '/notes', nextId = 0, sessionRead, reads = 0;
const empty = () => null;
const globals = {
  exports: {}, window, document, URL, URLSearchParams,
  HTMLElement: dom.window.HTMLElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
  Element: dom.window.Element, HTMLDialogElement: dom.window.HTMLDialogElement,
  Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
  CSS: { escape: value => value }, crypto: { randomUUID: () => `new-modal-${++nextId}` },
  require(name) {
    if (['react', 'react/jsx-runtime', 'react-dom'].includes(name)) return require(name);
    if (name === 'next/navigation') return { usePathname: () => pathname };
    if (name === '@/lib/open-work-orders') return registry;
    if (name === '@/lib/ui/workspace-resume') return workspace;
    if (name === '@/lib/ui/workspace-route-access') return { canResumeWorkspaceView };
    if (name === '@/lib/ui/header-palette') return {
      modalActionForRoute: () => '', modalThemeStyle: () => ({}), modalTitleStyle: () => ({}),
      modalDisplayTitle: (_path, title) => title, hasBonvoyTierHelp: () => false,
    };
    if (name === '@/lib/auth/client-session') return { loadCmpriSession: () => { reads++; return sessionRead; } };
    if (['./WorkOrderTierKey', './RoomRankerKey', './WorkOrderTitleGuest', './desktop/WorkOrderListWindow'].includes(name)) return { default: empty };
    throw Error(`Unexpected import: ${name}`);
  },
};
vm.runInNewContext(code, globals);
const Component = globals.exports.default;
const session = {
  user: { id: 'fixture-user', role: 'engineer', secondary_roles: [], email: null, name: null },
  hotelId: 'fixture-hotel', landing: '/engineering', capabilities: ['view_work_orders', 'view_profiles', 'view_pm', 'submit'],
};
const frame = href => ({ kind: 'frame', key: new URL(href, window.location.origin).pathname, href });
const options = { origin: window.location.origin, isAllowed: view => canResumeWorkspaceView(session, view) };
const identity = workspace.workspaceIdentity(session);
function seed(patch) { workspace.saveWorkspace(window.localStorage, identity, patch, { ...options, isAllowed: () => true }); }
function saved() { return workspace.readWorkspace(window.localStorage, identity, options); }
function route(path) { window.history.replaceState({}, '', path); pathname = window.location.pathname; }
function reset(path = '/notes') {
  window.localStorage.clear(); route(path); sessionRead = Promise.resolve(session); reads = 0;
}
async function mount() {
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Component)));
  return root;
}
async function unmount(root) { await React.act(async () => root.unmount()); }
async function click(element) {
  assert.ok(element);
  await React.act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

test('fresh authorization precedes restoring the stack, active screen, and fresh iframe tokens', async () => {
  reset('/notes?tab=journal');
  seed({ topHref: '/notes?tab=journal', desktop: { views: [frame('/engineering/preventive-maintenance')], zOrder: ['/engineering/preventive-maintenance'] },
    modals: { views: [frame('/profile?embedded=1&modalToken=old-token'), frame('/engineering/preventive-maintenance'), frame('/management/users')], activeKey: '/profile' } });
  let resolve;
  sessionRead = new Promise(done => { resolve = done; });
  const root = await mount();
  try {
    assert.equal(document.querySelectorAll('iframe').length, 0, 'no stored private frame mounts while server session is pending');
    await React.act(async () => { resolve(session); await sessionRead; });
    const frames = Array.from(document.querySelectorAll('iframe'));
    assert.equal(frames.length, 2, 'the current capability guard rejects stored user management');
    assert.equal(document.querySelector('iframe[title="Manage Profile"]').closest('[data-modal-entry]').getAttribute('aria-hidden'), 'false');
    const tokens = frames.map(item => new URL(item.src).searchParams.get('modalToken'));
    assert.ok(tokens.every(value => value && value !== 'old-token'));
    assert.equal(new Set(tokens).size, 2);
    assert.deepEqual(saved().desktop.views, [frame('/engineering/preventive-maintenance')], 'modal writes preserve the authorized desktop section');
    assert.equal(saved().topHref, '/notes?tab=journal');
    const raw = window.localStorage.getItem(workspace.workspaceStorageKey(identity));
    assert.doesNotMatch(raw, /old-token|new-modal|modalToken|guest|title/);
    assert.ok(reads >= 1);
  } finally { await unmount(root); }
});

test('restored forms retain cancel refusal, and completed closes persist without resurrecting on remount', async () => {
  reset(); seed({ modals: { views: [frame('/profile'), frame('/engineering/preventive-maintenance')], activeKey: '/profile' } });
  let root = await mount();
  try {
    const profile = document.querySelector('iframe[title="Manage Profile"]');
    const refuse = event => event.preventDefault();
    profile.contentDocument.addEventListener('cmpri-modal-cancel-request', refuse);
    await click(document.querySelector('button[aria-label="Close Manage Profile"]'));
    assert.equal(document.querySelector('iframe[title="Manage Profile"]'), profile);
    assert.equal(saved().modals.views.length, 2, 'an unacknowledged close cannot remove its resume descriptor');
    profile.contentDocument.removeEventListener('cmpri-modal-cancel-request', refuse);
    await click(document.querySelector('button[aria-label="Close Manage Profile"]'));
    assert.equal(saved().modals.views.length, 1);
    await unmount(root); root = await mount();
    assert.equal(document.querySelector('iframe[title="Manage Profile"]'), null);
    assert.ok(document.querySelector('iframe[title="Preventative Maintenance"]'));
  } finally { await unmount(root); }
});

test('unverified sessions and different account or capability scopes never hydrate stored screens', async () => {
  for (const result of ['denied', 'other-account', 'changed-permissions']) {
    reset(); seed({ modals: { views: [frame('/profile')], activeKey: '/profile' } });
    const before = window.localStorage.getItem(workspace.workspaceStorageKey(identity));
    sessionRead = result === 'denied' ? Promise.reject(Error('Session denied'))
      : Promise.resolve(result === 'other-account' ? { ...session, user: { ...session.user, id: 'another-user' } }
        : { ...session, capabilities: ['view_work_orders'] });
    // Attach the expected rejection before React's effect starts.
    sessionRead.catch(() => {});
    const root = await mount();
    try {
      assert.equal(document.querySelectorAll('iframe').length, 0, result);
      if (result === 'denied') assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)), before);
    } finally { await unmount(root); }
  }
});

test('sign-out clears only the navigation workspace and disables late pagehide writes', async () => {
  reset(); seed({ modals: { views: [frame('/profile')], activeKey: '/profile' } });
  window.localStorage.setItem('fixture:notes-outbox', 'unacknowledged notes');
  window.localStorage.setItem('fixture:pool-draft', 'unacknowledged pool checks');
  const root = await mount();
  try {
    await React.act(async () => window.dispatchEvent(new dom.window.Event('cmpri-workspace-sign-out')));
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)), null);
    await React.act(async () => window.dispatchEvent(new dom.window.Event('pagehide')));
    await click(document.querySelector('button[aria-label="Close Manage Profile"]'));
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)), null);
    assert.equal(window.localStorage.getItem('fixture:notes-outbox'), 'unacknowledged notes');
    assert.equal(window.localStorage.getItem('fixture:pool-draft'), 'unacknowledged pool checks');
  } finally { await unmount(root); }
});

test('dashboard-host modal writes preserve the independently restored top-level route', async () => {
  reset('/engineering'); seed({ topHref: '/notes?tab=journal', modals: { views: [frame('/profile')], activeKey: '/profile' } });
  const root = await mount();
  try {
    assert.ok(document.querySelector('iframe[title="Manage Profile"]'));
    assert.equal(saved().topHref, '/notes?tab=journal');
    await React.act(async () => window.dispatchEvent(new dom.window.Event('pagehide')));
    assert.equal(saved().topHref, '/notes?tab=journal');
  } finally { await unmount(root); }
});

test('every restored frame gets a fresh embedded token, including ordinarily tokenless routes', async () => {
  reset('/technician');
  const technician = { ...session, user: { ...session.user, role: 'technician' } };
  const technicianIdentity = workspace.workspaceIdentity(technician);
  workspace.saveWorkspace(window.localStorage, technicianIdentity,
    { modals: { views: [frame('/technician')], activeKey: '/technician' } }, { ...options, isAllowed: () => true });
  sessionRead = Promise.resolve(technician);
  const root = await mount();
  try {
    const restored = document.querySelector('iframe');
    assert.ok(restored);
    const url = new URL(restored.src);
    assert.equal(url.searchParams.get('embedded'), '1');
    assert.ok(url.searchParams.get('modalToken')?.startsWith('new-modal-'));
  } finally { await unmount(root); }
});

test('an explicit open then close while session verification is pending wins over an old saved stack', async () => {
  reset(); seed({ modals: { views: [frame('/engineering/preventive-maintenance')], activeKey: '/engineering/preventive-maintenance' } });
  let resolve; sessionRead = new Promise(done => { resolve = done; });
  const root = await mount();
  try {
    await React.act(async () => window.dispatchEvent(new dom.window.CustomEvent('cmpri-open-modal', { detail: { href: '/profile', title: 'Profile' } })));
    await click(document.querySelector('button[aria-label="Close Profile"]'));
    assert.equal(document.querySelectorAll('iframe').length, 0);
    await React.act(async () => { resolve(session); await sessionRead; });
    assert.equal(document.querySelectorAll('iframe').length, 0, 'the closed stack must not resurrect when authorization finishes');
    assert.deepEqual(saved().modals.views, []);
  } finally { await unmount(root); }
});

test('sign-out during a pending first session check clears its late verified scope without hydrating', async () => {
  reset(); seed({ modals: { views: [frame('/profile')], activeKey: '/profile' } });
  let resolve; sessionRead = new Promise(done => { resolve = done; });
  const root = await mount();
  await React.act(async () => window.dispatchEvent(new dom.window.Event('cmpri-workspace-sign-out')));
  await unmount(root);
  await React.act(async () => { resolve(session); await sessionRead; });
  assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)), null);
  assert.equal(document.querySelectorAll('iframe').length, 0);
});

test('a changed account never inherits the old stack, and guarded old editors must acknowledge closing first', async () => {
  reset(); seed({ modals: { views: [frame('/profile')], activeKey: '/profile' } });
  const other = { ...session, user: { ...session.user, id: 'different-owner' } };
  const otherIdentity = workspace.workspaceIdentity(other);
  const root = await mount();
  try {
    const original = document.querySelector('iframe[title="Manage Profile"]');
    const refuse = event => event.preventDefault();
    original.contentDocument.addEventListener('cmpri-modal-cancel-request', refuse);
    sessionRead = Promise.resolve(other); route('/staff-notes');
    await React.act(async () => root.render(React.createElement(Component)));
    assert.equal(document.querySelector('iframe[title="Manage Profile"]'), original);
    assert.equal(original.closest('[hidden]')?.hasAttribute('inert'), true, 'retained fields are hidden and inert after the verified owner changes');
    assert.equal(document.querySelector('dialog[data-cmpri-global-modal-shell]').open, false);
    await React.act(async () => window.dispatchEvent(new dom.window.Event('pagehide')));
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(otherIdentity)), null, 'old routes cannot be written under the new owner');
    await React.act(async () => window.dispatchEvent(new dom.window.CustomEvent('cmpri-open-modal', { detail: { href: '/engineering/preventive-maintenance', title: 'PM' } })));
    assert.equal(document.querySelectorAll('iframe').length, 1, 'a new screen cannot enter the unresolved old host');
    original.contentDocument.removeEventListener('cmpri-modal-cancel-request', refuse);
    await React.act(async () => window.dispatchEvent(new dom.window.MessageEvent('message', {
      origin: window.location.origin, source: original.contentWindow,
      data: { type: 'cmpri-modal-close', modalToken: new URL(original.src).searchParams.get('modalToken') },
    })));
    const next = workspace.readWorkspace(window.localStorage, otherIdentity,
      { origin: window.location.origin, isAllowed: view => canResumeWorkspaceView(other, view) });
    assert.deepEqual(next.modals.views, []);
    assert.equal(next.topHref, '/staff-notes');
  } finally { await unmount(root); }
});

test('failed revalidation retains but hides and disables existing private modal contents', async () => {
  reset(); seed({ modals: { views: [frame('/profile')], activeKey: '/profile' } });
  const root = await mount();
  try {
    const original = document.querySelector('iframe[title="Manage Profile"]');
    const before = window.localStorage.getItem(workspace.workspaceStorageKey(identity));
    sessionRead = Promise.reject(Error('Your CMPRI session is no longer authorized.')); sessionRead.catch(() => {});
    route('/staff-notes'); await React.act(async () => root.render(React.createElement(Component)));
    assert.equal(document.querySelector('iframe[title="Manage Profile"]'), original, 'a failed check cannot discard a protected editor');
    assert.equal(original.closest('[hidden]')?.hasAttribute('inert'), true);
    assert.equal(document.querySelector('dialog[data-cmpri-global-modal-shell]').open, false);
    await React.act(async () => window.dispatchEvent(new dom.window.Event('pagehide')));
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(identity)), before);
  } finally { await unmount(root); }
});

test('sign-out clears the latest verified owner even while an earlier editor is protected', async () => {
  reset(); seed({ modals: { views: [frame('/profile')], activeKey: '/profile' } });
  const other = { ...session, user: { ...session.user, id: 'latest-verified-owner' } };
  const otherIdentity = workspace.workspaceIdentity(other);
  workspace.saveWorkspace(window.localStorage, otherIdentity,
    { topHref: '/staff-notes', modals: { views: [frame('/engineering/preventive-maintenance')], activeKey: '/engineering/preventive-maintenance' } },
    { ...options, isAllowed: () => true });
  const root = await mount();
  try {
    document.querySelector('iframe').contentDocument.addEventListener('cmpri-modal-cancel-request', event => event.preventDefault());
    sessionRead = Promise.resolve(other); route('/staff-notes');
    await React.act(async () => root.render(React.createElement(Component)));
    await React.act(async () => window.dispatchEvent(new dom.window.Event('cmpri-workspace-sign-out')));
    assert.equal(window.localStorage.getItem(workspace.workspaceStorageKey(otherIdentity)), null);
    assert.ok(window.localStorage.getItem(workspace.workspaceStorageKey(identity)), 'a different owner’s navigation is not accidentally cleared');
  } finally { await unmount(root); }
});
