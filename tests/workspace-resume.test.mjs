import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_MAX_AGE_MS, clearWorkspace, normalizeWorkspaceHref, readWorkspace,
  saveWorkspace, workspaceIdentity, workspaceStorageKey,
} from '../src/lib/ui/workspace-resume.ts';

const origin = 'https://cmpri.example';
const now = Date.UTC(2026, 10, 20, 12);
const identity = { userId: 'user-a', hotelId: 'hotel-a', role: 'engineer', secondaryRoles: ['manager'], capabilities: ['view_pm', 'view_work_orders'] };
const frame = (href, extra = {}) => ({ key: new URL(href, origin).pathname, href, kind: 'frame', ...extra });
const list = { key: 'work-order-list', kind: 'list' };
const options = { origin, now, isAllowed: () => true };
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function stored(port) { return JSON.parse(port.getItem(workspaceStorageKey(identity))); }
function alter(port, change) { port.setItem(workspaceStorageKey(identity), JSON.stringify(change(stored(port)))); }

test('independent hosts patch their sections without replacing the other host or top view', () => {
  const port = storage();
  assert.equal(saveWorkspace(port, identity, { topHref: '/engineering', desktop: { views: [list, frame('/notes')], zOrder: ['/notes', 'work-order-list'] } }, options), true);
  assert.equal(saveWorkspace(port, identity, { modals: { views: [frame('/engineering/pool-log')], activeKey: '/engineering/pool-log' } }, options), true);
  assert.equal(saveWorkspace(port, identity, { topHref: '/technician', desktop: undefined }, options), true);
  const saved = readWorkspace(port, identity, options);
  assert.equal(saved.topHref, '/technician');
  assert.deepEqual(saved.desktop, { views: [list, frame('/notes')], zOrder: ['/notes', 'work-order-list'] });
  assert.deepEqual(saved.modals, { views: [frame('/engineering/pool-log')], activeKey: '/engineering/pool-log' });
  assert.equal(saveWorkspace(port, identity, { desktop: { views: [], zOrder: [] } }, options), true);
  assert.deepEqual(readWorkspace(port, identity, options).desktop.views, []);
  assert.equal(readWorkspace(port, identity, options).modals.views.length, 1);
  saveWorkspace(port, identity, { topHref: null, modals: { views: [], activeKey: null } }, options);
  assert.equal(readWorkspace(port, identity, options).topHref, null);
  assert.deepEqual(readWorkspace(port, identity, options).modals, { views: [], activeKey: null });
});

test('persisted descriptors exclude form, guest, HTML, title, source URL and authentication fields', () => {
  const port = storage();
  saveWorkspace(port, identity, {
    topHref: '/engineering?access_token=secret&oauth=secret#private-text',
    desktop: { views: [frame('/notes?embedded=1&modalToken=secret&text=private-text', {
      title: 'private-title', guest: { name: 'private-name' }, form: { text: 'private-text' },
      src: 'https://signed.example/?token=secret', access_token: 'secret', html: '<p>private-html</p>',
    })], zOrder: ['/notes'] },
  }, options);
  const raw = port.getItem(workspaceStorageKey(identity));
  assert.doesNotMatch(raw, /secret|private-|guest|access_token|modalToken|embedded|signed\.example|<p>/);
  assert.deepEqual(stored(port).desktop.views, [frame('/notes')]);
  assert.equal(stored(port).topHref, '/engineering');
});

test('route sanitization accepts same-origin navigation and only bounded known query scalars', () => {
  const href = '/engineering/preventive-maintenance?draft=d1&draftId=id1&date=2026-11-20&week=2026-11-16&template=t1&templateId=t2&periodStart=2026-11-01&tab=monthly&view=form&filter=open&sort=date&page=2&workOrder=wo1&embedded=1&modalToken=token&code=oauth&access_token=secret&redirect=https://evil.example&notes=text#private';
  const safe = normalizeWorkspaceHref(href, origin);
  const parsed = new URL(safe, origin);
  assert.deepEqual([...parsed.searchParams.keys()], ['draft', 'draftId', 'date', 'week', 'template', 'templateId', 'periodStart', 'tab', 'view', 'filter', 'sort', 'page', 'workOrder']);
  assert.equal(parsed.hash, '');
  assert.equal(normalizeWorkspaceHref(origin + '/notes', origin), '/notes');
  assert.equal(normalizeWorkspaceHref('/notes?filter=' + 'a'.repeat(161) + '&page=no&date=invalid&tab=%7B%22form%22%3A1%7D', origin), '/notes');
  assert.equal(normalizeWorkspaceHref('/feedback?route=%2Fengineering', origin), '/feedback?route=%2Fengineering');
  assert.equal(normalizeWorkspaceHref('/feedback?route=%2Fapi%2Fusers', origin), '/feedback');
  assert.equal(normalizeWorkspaceHref('/previews/cmpri-weather-preview.html?weather=open', origin), '/previews/cmpri-weather-preview.html?weather=open');
});

test('external, executable, auth, API, framework and encoded bypass routes cannot be restored', () => {
  for (const href of ['https://elsewhere.example/notes', '//elsewhere.example/notes', 'javascript:alert(1)', 'data:text/html,x', 'mailto:x@example.com', '/api', '/api/users', '/%61pi/users', '/auth/callback', '/oauth/callback', '/login', '/logout', '/sign-in', '/sign-out', '/_next/static/x', '/%5fnext/x', '/notes%2f..%2fapi/users', '/notes%5capi/users', '/notes%00', '#tab', '/', 'https://name:password@cmpri.example/notes', '/notes\\other']) {
    assert.equal(normalizeWorkspaceHref(href, origin), null, href);
  }
});

test('every restored view and top route is checked against current authorization', () => {
  const port = storage();
  saveWorkspace(port, identity, { topHref: '/management/users', desktop: { views: [list, frame('/notes'), frame('/management/users')], zOrder: ['work-order-list', '/notes', '/management/users'] }, modals: { views: [frame('/engineering/pool-log')], activeKey: '/engineering/pool-log' } }, options);
  const limited = { ...options, isAllowed: item => item.kind === 'frame' && item.key === '/notes' };
  const result = readWorkspace(port, identity, limited);
  assert.equal(result.topHref, null);
  assert.deepEqual(result.desktop, { views: [frame('/notes')], zOrder: ['/notes'] });
  assert.deepEqual(result.modals, { views: [], activeKey: null });
  // Saving one host's patch must not retain a now-forbidden sibling host.
  saveWorkspace(port, identity, { topHref: '/notes' }, limited);
  assert.deepEqual(stored(port).modals.views, []);
  assert.deepEqual(stored(port).desktop.views, [frame('/notes')]);
});

test('authorizer failures deny individual views without propagating private saved data', () => {
  const port = storage();
  saveWorkspace(port, identity, { topHref: '/notes', desktop: { views: [list, frame('/notes')], zOrder: [] } }, options);
  const result = readWorkspace(port, identity, { ...options, isAllowed: () => { throw Error('Session changed'); } });
  assert.equal(result.topHref, null);
  assert.deepEqual(result.desktop.views, []);
});

test('ownership includes account, property, primary role, secondary roles and capabilities', () => {
  const port = storage();
  saveWorkspace(port, identity, { topHref: '/notes' }, options);
  for (const changed of [
    { ...identity, userId: 'user-b' }, { ...identity, hotelId: 'hotel-b' },
    { ...identity, role: 'technician' }, { ...identity, secondaryRoles: [] },
    { ...identity, capabilities: ['view_work_orders'] },
  ]) {
    // Even copying a record to another account/property storage key cannot restore it.
    port.setItem(workspaceStorageKey(changed), JSON.stringify(stored(port)));
    assert.equal(readWorkspace(port, changed, options), null);
  }
  const equivalent = { ...identity, capabilities: [...identity.capabilities].reverse(), secondaryRoles: ['manager', 'manager'] };
  assert.ok(readWorkspace(port, equivalent, options));
  assert.deepEqual(workspaceIdentity({ user: { id: identity.userId, role: identity.role, secondary_roles: ['manager'] }, hotelId: identity.hotelId, capabilities: [...identity.capabilities].reverse() }), identity);
});

test('route-only workspace age expires after thirty days and never accepts future timestamps', () => {
  const port = storage();
  saveWorkspace(port, identity, { topHref: '/notes' }, options);
  assert.ok(readWorkspace(port, identity, { ...options, now: now + WORKSPACE_MAX_AGE_MS }));
  assert.equal(readWorkspace(port, identity, { ...options, now: now + WORKSPACE_MAX_AGE_MS + 1 }), null);
  assert.equal(readWorkspace(port, identity, { ...options, now: now - 1 }), null);
  assert.equal(readWorkspace(port, identity, { ...options, now: now + 5001, maxAgeMs: 5000 }), null);
  assert.equal(readWorkspace(port, identity, { ...options, now: now + WORKSPACE_MAX_AGE_MS + 1, maxAgeMs: Infinity }), null);
});

test('corrupt, oversized, unknown-version and invalid-timestamp records are ignored', () => {
  for (const corrupt of ['not json', '[]', '{}', 'null', 'x'.repeat(65537)]) {
    const port = storage(); port.setItem(workspaceStorageKey(identity), corrupt);
    assert.equal(readWorkspace(port, identity, options), null);
  }
  for (const change of [row => ({ ...row, version: 2 }), row => ({ ...row, savedAt: 'today' }), row => ({ ...row, savedAt: -1 }), row => ({ ...row, savedAt: null }), row => ({ ...row, scope: 'other' })]) {
    const port = storage(); saveWorkspace(port, identity, {}, options); alter(port, change);
    assert.equal(readWorkspace(port, identity, options), null);
  }
});

test('malformed and duplicate descriptors cannot smuggle presentation or ordering state', () => {
  const port = storage();
  saveWorkspace(port, identity, { desktop: { views: [frame('/notes', { key: 'wrong' }), frame('/notes'), { key: 'wrong', kind: 'list', href: '/api/users' }, { key: '/notes', kind: 'unknown' }, { key: 'evil', kind: 'frame', href: 'https://evil.example/' }], zOrder: ['wrong', '/notes', '/notes', 'work-order-list', 'missing'] }, modals: { views: [frame('/profile'), frame('/notes')], activeKey: 'missing' } }, options);
  assert.deepEqual(stored(port).desktop, { views: [frame('/notes'), list], zOrder: ['/notes', 'work-order-list'] });
  assert.equal(stored(port).modals.activeKey, '/notes');
  const many = Array.from({ length: 40 }, (_, i) => frame('/work-orders/order-' + i));
  saveWorkspace(port, identity, { desktop: { views: many, zOrder: [] } }, options);
  assert.equal(stored(port).desktop.views.length, 20);
});

test('review draft identity can be retained without persisting an iframe token', () => {
  const port = storage();
  const draft = frame('/work-orders?draftId=draft-1&reviewDraft=1&embedded=1&modalToken=secret', { key: 'work-order-draft:draft-1' });
  saveWorkspace(port, identity, { desktop: { views: [draft], zOrder: ['work-order-draft:draft-1'] } }, options);
  assert.deepEqual(stored(port).desktop.views, [{ key: 'work-order-draft:draft-1', kind: 'frame', href: '/work-orders?draftId=draft-1&reviewDraft=1' }]);
});

test('storage failures return honest results and a failed read never overwrites sibling state', () => {
  let writes = 0;
  const deniedRead = { getItem: () => { throw Error('Storage blocked'); }, setItem: () => { writes++; }, removeItem: () => { throw Error('Storage blocked'); } };
  assert.equal(readWorkspace(deniedRead, identity, options), null);
  assert.equal(saveWorkspace(deniedRead, identity, { topHref: '/notes' }, options), false);
  assert.equal(writes, 0);
  assert.equal(clearWorkspace(deniedRead, identity), false);
  assert.equal(saveWorkspace({ getItem: () => null, setItem: () => { throw Error('Quota exceeded'); } }, identity, { topHref: '/notes' }, options), false);
  assert.equal(saveWorkspace(storage(), { ...identity, userId: '' }, {}, options), false);
  assert.equal(readWorkspace(storage(), { ...identity, capabilities: null }, options), null);
});

test('clearing a workspace leaves every account draft and unrelated property untouched', () => {
  const port = storage();
  const other = { ...identity, hotelId: 'hotel-b' };
  saveWorkspace(port, identity, { topHref: '/notes' }, options);
  saveWorkspace(port, other, { topHref: '/notes' }, options);
  port.setItem('cmpri:general-notes:v1:hotel-a:user-a:outbox', 'unsynced notes');
  port.setItem('cmpri:ticket-draft:hotel-a:user-a:order-1', 'unsynced ticket');
  assert.equal(clearWorkspace(port, identity), true);
  assert.equal(readWorkspace(port, identity, options), null);
  assert.ok(readWorkspace(port, other, options));
  assert.equal(port.getItem('cmpri:general-notes:v1:hotel-a:user-a:outbox'), 'unsynced notes');
  assert.equal(port.getItem('cmpri:ticket-draft:hotel-a:user-a:order-1'), 'unsynced ticket');
});
