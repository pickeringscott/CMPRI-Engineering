import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { expectedVisibleRows, matchesVisibleRows } from './rls-expectations.mjs';
const out = new URL('../../.sandbox/', import.meta.url);
const keys = JSON.parse(readFileSync(new URL('local-keys.json', out)));
const users = JSON.parse(readFileSync(new URL('synthetic-users.json', out)));
// Browser evidence captures persisted rows before lifecycle changes their status.
const submissions = JSON.parse(readFileSync(new URL('e2e-results.json', out)));
assert.equal(submissions.length, 28);
assert.ok(submissions.every(result => result.passed && result.rows?.length === 1));
const fixtureRows = submissions.flatMap(result => result.rows);
assert.equal(new Set(fixtureRows.map(row => row.id)).size, 28);
assert.match(keys.API_URL, /^http:\/\/(127\.0\.0\.1|localhost):54321$/);
const results = [];
for (const user of users) {
  const client = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false } });
  try {
    const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
    assert.ifError(error);
    const { data, error: readError } = await client.from('work_orders').select('id,hotel_id,status');
    const restricted = ['front_desk', 'housekeeping'].includes(user.role);
    const expected = expectedVisibleRows(user.role, fixtureRows);
    const passed = (!readError && matchesVisibleRows(data, expected)) || (restricted && readError?.code === '42501');
    const statusCounts = rows => rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {});
    results.push({ role: user.label, storedRole: user.role, readCount: data?.length ?? null, error: readError?.message, expectedCount: expected.length, expectedStatusCounts: statusCounts(expected), actualStatusCounts: statusCounts(data ?? []), passed });
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
