// Run against a local CI-configured build with Playwright available. All API data is isolated.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)('playwright');
const origin = process.env.CMPRI_TEST_ORIGIN || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Local fixtures only');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CMPRI_CHROMIUM_PATH, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let canManage = true;
let failLocations = false;
let failSave = false;
let posts = [];
let releaseSave;
const assets = [];
const locations = [{ id: 'room-105', name: 'Room 105' }, { id: 'room-327', name: 'Room 327' }];
await page.addInitScript(() => {
  sessionStorage.setItem('cmpri:auth:v1', JSON.stringify({ access_token: 'isolated-test-token', refresh_token: 'isolated-refresh', expires_at: Math.floor(Date.now()/1000)+3600, token_type: 'bearer', user: { id: 'isolated-engineer', aud: 'authenticated', role: 'authenticated' } }));
});
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  let body = {};
  let status = 200;
  if (url.pathname === '/api/assets' && route.request().method() === 'POST') {
    posts.push(route.request().postDataJSON());
    await new Promise(resolve => { releaseSave = resolve; });
    if (failSave) { status = 400; body = { error: 'Isolated save rejected' }; }
    else {
      const input = posts.at(-1);
      const asset = { ...input, id: 'created-fixture', name: `${input.asset_type} – ${locations.find(l => l.id === input.location_id).name}`, active: true, status: 'Active', documentation_verified: false };
      assets.push(asset);
      body = { asset };
    }
  } else if (url.pathname === '/api/assets') body = { assets, can_manage: canManage };
  else if (url.pathname === '/api/rooms') {
    body = failLocations ? { error: 'Isolated locations unavailable' } : { locations };
    status = failLocations ? 503 : 200;
  } else if (url.pathname === '/api/assets/documentation') body = { documents: [], verified: false };
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
});
try {
  await page.goto(`${origin}/management/equipment`);
  const add = page.getByRole('button', { name: 'Add Asset', exact: true });
  await add.waitFor();
  await add.click();
  let dialog = page.getByRole('dialog', { name: 'Add Asset' });
  await dialog.getByLabel('Room / Location').selectOption('room-327');
  await dialog.getByLabel('Equipment type', { exact: true }).fill('Refrigerator');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await add.click();
  assert.equal(await dialog.getByLabel('Equipment type', { exact: true }).inputValue(), '');
  assert.equal(await dialog.getByLabel('Room / Location').inputValue(), '');
  await dialog.getByRole('button', { name: 'Save Asset', exact: true }).click();
  assert.equal(posts.length, 0, 'required inputs prevent a request');
  await dialog.getByLabel('Room / Location').selectOption('room-105');
  await dialog.getByLabel('Equipment type', { exact: true }).fill('Refrigerator');
  failSave = true;
  await dialog.getByRole('button', { name: 'Save Asset', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
  assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
  // Dispatch repeated submits while the first request is in flight.
  await dialog.evaluate(form => { for (let i=0;i<3;i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await page.waitForTimeout(100);
  assert.equal(posts.length, 1);
  releaseSave();
  await page.getByRole('alert').filter({ hasText: 'Isolated save rejected' }).waitFor();
  assert.equal(await dialog.getByLabel('Equipment type', { exact: true }).inputValue(), 'Refrigerator');
  assert.equal(await dialog.getByLabel('Room / Location').inputValue(), 'room-105');
  await mkdir('/tmp/cmpri-evidence', { recursive: true });
  await page.screenshot({ path: '/tmp/cmpri-evidence/add-asset-error.png', fullPage: true, animations: 'disabled' });
  failSave = false;
  await dialog.getByRole('button', { name: 'Save Asset', exact: true }).click();
  await page.waitForTimeout(100);
  releaseSave();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Refrigerator – Room 105', exact: true }).waitFor();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].location_id, 'room-105');
  for (const field of ['manufacturer', 'model_family', 'model_number', 'serial_number', 'install_year']) assert.equal(posts[1][field], null);
  await page.screenshot({ path: '/tmp/cmpri-evidence/add-asset-created.png', fullPage: true, animations: 'disabled' });
  await add.click();
  assert.equal(await dialog.getByLabel('Equipment type', { exact: true }).inputValue(), '');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  failLocations = true;
  await add.click();
  await page.getByRole('alert').filter({ hasText: 'Isolated locations unavailable' }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Save Asset', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  failLocations = false;
  await add.click();
  await dialog.getByLabel('Room / Location').selectOption('room-327');
  await page.screenshot({ path: '/tmp/cmpri-evidence/add-asset-form.png', fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  canManage = false;
  await page.reload();
  await page.getByText('1 records', { exact: true }).waitFor();
  assert.equal(await add.count(), 0, 'read-only role has no Add Asset control');
  console.log('PASS: isolated browser creation, room assignment, unknown fields, errors/retry, duplicate submits, Cancel/Close/reopen, permission gating.');
} finally { await browser.close(); }
