import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const out = new URL('../../.sandbox/', import.meta.url);
const keys = JSON.parse(readFileSync(new URL('local-keys.json', out)));
if (!/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(keys.API_URL)) throw Error('Local stack only');
const admin = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const hotel = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
async function ok(query) { const r = await query; if (r.error) throw r.error; return r.data; }
await ok(admin.from('hotels').insert({ id: hotel, code: 'SYNTHETIC_QA', name: 'Synthetic QA Hotel' }));
const cases = [
  ['General Manager', 'manager', 'manager'],
  ['Assistant General Manager', 'assistant_manager', 'technician'],
  ['Front Desk Manager', 'front_desk_manager', 'technician'],
  ['Maintenance Technician', 'technician', 'technician'],
  ['Chief Engineer', 'engineer', 'admin'],
  ['Lead Housekeeper', 'housekeeping', 'technician'],
  ['Front Desk', 'front_desk', 'technician'],
];
const scenarios = [
  { name: 'lamp', issue: 'desk lamp not working', category: 'Electrical', assets: [{ name: 'Desk lamp', asset_type: 'Desk lamp' }], expected: 0 },
  { name: 'washer', issue: 'Washer #2 not draining', category: 'Laundry', assets: [1, 2, 12].map(n => ({ name: `Washer #${n}`, asset_type: 'Washer' })), expected: 1 },
  { name: 'pool', issue: 'Pool filter pressure high', category: 'Pool/Spa', assets: [{ name: 'Sand filter', asset_type: 'Pool Filter' }], expected: 0 },
  { name: 'manufacturer', issue: 'Beta washer not working', category: 'Laundry', assets: ['Alpha', 'Beta'].map(manufacturer => ({ name: 'Washer', asset_type: 'Washer', manufacturer })), expected: 1 },
];
const users = [], gaps = [];
for (const [i, [label, canonicalRole, membership]] of cases.entries()) {
  const email = `cmpri-role-${i + 1}@example.invalid`, password = `Synthetic-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  let role = canonicalRole;
  if (label === 'Chief Engineer') {
    const probe = await admin.from('profiles').upsert({ id, email, full_name: `Synthetic ${label}`, role: label, active: true });
    if (probe.error) gaps.push({ role: label, code: probe.error.code, message: probe.error.message, gap: 'Literal Chief Engineer rejected; engineer alias checks do not prove title-specific notifications.' });
    else role = label;
  }
  await ok(admin.from('profiles').upsert({ id, email, full_name: `Synthetic ${label}`, role, active: true }));
  await ok(admin.from('hotel_members').insert({ hotel_id: hotel, user_id: id, role: membership, active: true }));
  const fixtures = [];
  for (const [j, scenario] of scenarios.entries()) {
    const room = String(409 + i * 4 + j), location_id = randomUUID();
    await ok(admin.from('locations').insert({ id: location_id, hotel_id: hotel, area: 'Guest Rooms', name: `Room ${room}`, room_number: room, location_type: 'Guest Room' }));
    const assets = scenario.assets.map(asset => ({ ...asset, id: randomUUID(), hotel_id: hotel, location_id, active: true }));
    await ok(admin.from('assets').insert(assets));
    fixtures.push({ name: scenario.name, room, location_id, issue: scenario.issue, category: scenario.category, asset_id: assets[scenario.expected].id });
  }
  users.push({ label, role, id, email, password, fixtures });
}
// Synthetic local grants only, matching the existing seven-role fixture.
for (const role of ['Chief Engineer', 'Maintenance Technician']) for (const permission of ['manage_work_orders', 'close_work_orders']) {
  await ok(admin.from('role_permissions').upsert({ role, permission, allowed: true }, { onConflict: 'role,permission' }));
}
writeFileSync(new URL('synthetic-users.json', out), JSON.stringify(users, null, 2), { mode: 0o600 });
writeFileSync(new URL('role-gaps.json', out), JSON.stringify(gaps, null, 2));
console.log('Seeded seven synthetic accounts and 28 isolated equipment scenarios');
