import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = new URL('../../.sandbox/', import.meta.url);
const keys = JSON.parse(readFileSync(new URL('local-keys.json', out)));
const users = JSON.parse(readFileSync(new URL('synthetic-users.json', out)));
assert.match(keys.API_URL, /^http:\/\/(127\.0\.0\.1|localhost):54321$/);
const results = [];
for (const user of users) {
  const client = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false } });
  try {
    const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    assert.ifError(error);
    const { data, error: readError } = await client.from('work_orders').select('id,hotel_id');
    const restricted = ['front_desk', 'housekeeping'].includes(user.role);
    const passed = restricted ? ((!readError && Array.isArray(data) && data.length === 0) || readError?.code === '42501') : !readError && data?.length === 28 && data.every(row => row.hotel_id === 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6');
    results.push({ role: user.label, storedRole: user.role, readCount: data?.length ?? null, error: readError?.message, expected: restricted ? 'No rows' : '28 same-hotel rows', passed });
    await client.auth.signOut();
  } catch (error) { results.push({ role: user.label, passed: false, error: String(error) }); }
}
const anon = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false } });
const anonymous = await anon.from('work_orders').select('id');
results.push({ role: 'unauthenticated boundary', readCount: anonymous.data?.length ?? null, passed: (!anonymous.error && Array.isArray(anonymous.data) && anonymous.data.length === 0) || anonymous.error?.code === '42501' });
writeFileSync(new URL('rls-results.json', out), JSON.stringify(results, null, 2));
for (const result of results) {
  const safe = { ...result, phase: 'rls', error: result.error?.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted JWT]') };
  console.log(JSON.stringify(safe));
}
assert.ok(results.every(result => result.passed), 'RLS checks failed; see rls-results.json');
