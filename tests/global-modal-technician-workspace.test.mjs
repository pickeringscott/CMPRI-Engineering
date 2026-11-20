import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as registry from '../src/lib/open-work-orders.ts';
import * as workspace from '../src/lib/ui/workspace-resume.ts';
import { defaultWindowRect } from '../src/lib/ui/desktop-windows.ts';

const dom = new JSDOM('<!doctype html><html><body><main><header></header><div data-cmpri-technician-window-anchor></div></main><div id="root"></div></body></html>', {
  url: 'https://cmpri.test/technician', pretendToBeVisual: true,
});
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const require = createRequire(import.meta.url);
const router = { replace() {} };
const originalSession = () => ({ user: { id: 'technician-A', role: 'technician' }, hotelId: 'hotel-A', landing: '/technician', capabilities: ['view_work_orders'] });
let session = originalSession(), reads = 0, nextId = 0;
const empty = () => null;
const globals = {
  exports: {}, window, document, URL, URLSearchParams,
  HTMLElement: dom.window.HTMLElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
  Element: dom.window.Element, HTMLDialogElement: dom.window.HTMLDialogElement,
  Event: dom.window.Event, MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle: dom.window.getComputedStyle,
  CSS: { escape: value => value }, crypto: { randomUUID: () => `technician-modal-${++nextId}` },
  require(name) {
    if (['react', 'react/jsx-runtime', 'react-dom'].includes(name)) return require(name);
    if (name === 'next/navigation') return { usePathname: () => '/technician', useRouter: () => router, useSearchParams: () => new URLSearchParams() };
    if (name === '@/lib/open-work-orders') return registry;
    if (name === '@/lib/ui/workspace-resume') return workspace;
    if (name === '@/lib/ui/workspace-route-access') return { canResumeWorkspaceView: () => true };
    if (name === '@/lib/ui/desktop-windows') return { defaultWindowRect };
    if (name === '@/lib/auth/client-session') return { loadCmpriSession: async () => { reads++; return session; } };
    if (name === './desktop/WeatherPreviewWindow') return { default: props => React.createElement('button', {
      'data-weather-stub': '', 'data-visible': String(props.visible), onClick: props.onClose,
    }, 'Close Weather') };
    if (name === './desktop/DesktopWindow') return { default: props => React.createElement('section', {}, props.children) };
    if (name === '@/lib/ui/header-palette') return {
      modalActionForRoute: () => '', modalThemeStyle: () => ({}), modalTitleStyle: () => ({}),
      modalDisplayTitle: (_path, title) => title, hasBonvoyTierHelp: () => false,
    };
    if (['./WorkOrderTierKey', './RoomRankerKey', './WorkOrderTitleGuest', './desktop/WorkOrderListWindow'].includes(name)) return { default: empty };
    throw Error(`Unexpected import: ${name}`);
  },
};
const code = ts.transpileModule(readFileSync('src/components/GlobalModalHost.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
vm.runInNewContext(code, globals);
const Component = globals.exports.default;
async function mount() {
  session = originalSession(); reads = 0; window.localStorage.clear();
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Component)));
  return root;
}
async function open(href, title) {
  await React.act(async () => window.dispatchEvent(new dom.window.CustomEvent('cmpri-open-modal', { detail: { href, title } })));
}
async function changeScope() {
  session = { ...session, hotelId: 'hotel-B' };
  await React.act(async () => window.dispatchEvent(new dom.window.CustomEvent('cmpri-data-cache-invalidated', { detail: { topics: ['session'] } })));
}
function saved() {
  return workspace.readWorkspace(window.localStorage, workspace.workspaceIdentity(session), { origin: window.location.origin, isAllowed: () => true });
}
async function closeWeather() {
  const button = document.querySelector('[data-weather-stub]'); assert.ok(button);
  await React.act(async () => button.click());
  return button;
}

test('closed Technician Weather retains page memory but cannot reopen from persistence or block a fresh property scope', async () => {
  const root = await mount();
  try {
    await open('/previews/cmpri-weather-preview.html', 'Weather');
    const cached = await closeWeather();
    assert.equal(cached.dataset.visible, 'false');
    assert.equal(saved().modals.views.length, 0, 'a deliberate close is not saved as an open modal');
    await open('/previews/cmpri-weather-preview.html', 'Weather');
    assert.equal(document.querySelector('[data-weather-stub]'), cached, 'ordinary reopen reuses its in-memory window');
    assert.equal(cached.dataset.visible, 'true');
    await closeWeather();
    await changeScope();
    assert.equal(document.querySelector('[data-weather-stub]'), null, 'the previous property cache is discarded');
    await open('/profile', 'Profile');
    assert.ok(document.querySelector('iframe[title="Profile"]'), 'newly verified property can open screens after cached Weather is evicted');
    assert.equal(saved().modals.views[0].href, '/profile');
    assert.ok(reads >= 2);
  } finally { await React.act(async () => root.unmount()); }
});

test('Technician scope changes retain a guard-refused editor hidden and inert until its close acknowledgment', async () => {
  const root = await mount();
  try {
    await open('/previews/cmpri-weather-preview.html', 'Weather');
    await closeWeather();
    await open('/profile', 'Profile');
    const original = document.querySelector('iframe[title="Profile"]'); assert.ok(original);
    original.contentWindow.unsavedValue = 'still in progress';
    let guardRequests = 0;
    original.contentDocument.addEventListener('cmpri-modal-cancel-request', event => { guardRequests++; event.preventDefault(); });
    await changeScope();
    assert.equal(document.querySelector('iframe[title="Profile"]'), original, 'scope revalidation cannot unmount an editor which refused its save/close');
    assert.equal(original.contentWindow.unsavedValue, 'still in progress');
    assert.equal(original.closest('[hidden]')?.hasAttribute('inert'), true, 'old private contents are retained but hidden and disabled');
    assert.equal(document.querySelector('[data-weather-stub]'), null, 'cache-only entries do not obstruct the guarded close');
    assert.equal(guardRequests, 1);
    assert.equal(saved(), null, 'new property navigation is not persisted before the old editor acknowledges closing');
    const modalToken = new URL(original.src).searchParams.get('modalToken');
    await React.act(async () => window.dispatchEvent(new dom.window.MessageEvent('message', {
      origin: window.location.origin, source: original.contentWindow, data: { type: 'cmpri-modal-close', modalToken },
    })));
    assert.equal(document.querySelector('iframe[title="Profile"]'), null);
    assert.equal(guardRequests, 1, 'an acknowledgment closes without recursively invoking the refused guard');
    await open('/profile', 'Profile');
    const fresh = document.querySelector('iframe[title="Profile"]'); assert.ok(fresh);
    assert.notEqual(fresh, original);
    assert.equal(fresh.contentWindow.unsavedValue, undefined, 'the new property never inherits the previous private editor');
    assert.equal(saved().modals.views[0].href, '/profile');
  } finally { await React.act(async () => root.unmount()); }
});
