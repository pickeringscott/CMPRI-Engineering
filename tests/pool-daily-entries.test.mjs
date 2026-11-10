import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';
import { fetchAllPages } from '../src/lib/server/paginated-query.ts';

const { loadPoolDailyEntries } = loadTs('src/lib/server/pool-daily-entries.ts', {
  '@/lib/server/paginated-query': { fetchAllPages },
});

function fixture(data, failTable = '') {
  const queries = [];
  return { queries, from(table) {
    const filters = [], order = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(['eq', key, value]); return query; },
      gte(key, value) { filters.push(['gte', key, value]); return query; },
      lt(key, value) { filters.push(['lt', key, value]); return query; },
      in(key, value) { filters.push(['in', key, value]); return query; },
      order(key) { order.push(key); return query; },
      range(from, to) { query.from = from; query.to = to; return query; },
      then(resolve, reject) {
        queries.push({ table, filters: [...filters], order: [...order] });
        if (table === failTable) return Promise.resolve({ data: null, error: { message: 'unavailable' } }).then(resolve, reject);
        const rows = (data[table] || []).filter(row => filters.every(([op, key, value]) =>
          op === 'eq' ? row[key] === value : op === 'gte' ? row[key] >= value : op === 'lt' ? row[key] < value : value.includes(row[key])));
        return Promise.resolve({ data: rows.slice(query.from ?? 0, (query.to ?? rows.length) + 1), error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
}

test('combines immutable readings and scoped manual events for the selected Chicago day, including DST', async () => {
  const readings = [
    { id: 'r1', hotel_id: 'hotel', pool_log_id: 'log', actor_id: 'one', recorded_at: '2026-11-01T14:00:00.000Z', snapshot: { revision: 1, ph_am: 7.4, sanitizer_band_am: '3-6', flow_rate_gpm: 0, main_drain_visible: false } },
    { id: 'r2', hotel_id: 'hotel', pool_log_id: 'log', actor_id: 'two', recorded_at: '2026-11-01T17:00:00.000Z', snapshot: { revision: 2, ph_am: 7.4, ph_pm: 8, retest_submission: { id: 'r', ph: 7.4 } } },
    { id: 'other', hotel_id: 'other', pool_log_id: 'log', actor_id: 'x', recorded_at: '2026-11-01T17:00:00.000Z', snapshot: { ph_am: 99 } },
  ];
  const control = (id, timestamp, action, facility = 'pool', hotel = 'hotel') => ({ id, recorded_at: timestamp, action, facility_id: facility, hotel_id: hotel, actor_id: 'one', request: { reason: action === 'close' ? 'Maintenance' : '' } });
  const db = fixture({
    cmpri_pool_log_history: readings,
    cmpri_pool_control_history: [
      control('before', '2026-11-01T04:59:59.999Z', 'close'),
      control('open', '2026-11-01T05:00:00.000Z', 'open'),
      control('clear', '2026-11-02T05:59:59.999Z', 'clear-manual'),
      control('after', '2026-11-02T06:00:00.000Z', 'open'),
      control('other-pool', '2026-11-01T10:00:00.000Z', 'close', 'other'),
      control('other-hotel', '2026-11-01T10:00:00.000Z', 'close', 'pool', 'other'),
    ],
    profiles: [{ id: 'one', full_name: 'Alex Example' }, { id: 'two', full_name: 'Jordan Example' }, { id: 'x', full_name: 'Not visible' }],
  });
  const result = await loadPoolDailyEntries(db, 'hotel', 'pool', '2026-11-01', { id: 'log' });
  assert.deepEqual(Array.from(result.entries, entry => entry.id), ['control:open', 'reading:r1', 'reading:r2', 'control:clear']);
  assert.equal(result.entries[1].actor_name, 'Alex Example');
  assert.equal(result.entries[1].snapshot.flow_rate_gpm, 0);
  assert.equal(result.entries[1].snapshot.main_drain_visible, false);
  assert.equal(result.entries[2].snapshot.retest_submission.id, 'r');
  assert.equal(result.entries[1].previous_snapshot, null);
  assert.equal(result.entries[2].previous_snapshot.revision, 1, 'UI can display only the newly recorded or corrected readings');
  assert.equal(result.entries[3].kind, 'clear-manual');
  assert.equal(result.readingHistory.length, 2);
  assert.ok(db.queries.filter(query => query.table !== 'profiles').every(query => query.filters.some(([op, key, value]) => op === 'eq' && key === 'hotel_id' && value === 'hotel')));
  assert.ok(db.queries.find(query => query.table === 'cmpri_pool_control_history').filters.some(([op, key, value]) => op === 'eq' && key === 'facility_id' && value === 'pool'));
});

test('current saved record remains visible when historical snapshots are unavailable', async () => {
  const db = fixture({ profiles: [{ id: 'one', full_name: 'Alex' }] });
  const result = await loadPoolDailyEntries(db, 'hotel', 'pool', '2026-11-01', { id: 'log', ph_am: 7.2, updated_at: '2026-11-01T14:00:00Z', updated_by: 'one' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].source, 'current');
  assert.equal(result.entries[0].snapshot.ph_am, 7.2);
  assert.equal(result.entries[0].actor_name, 'Alex');
});

test('missing activity data reports an error instead of showing an incomplete day', async () => {
  const db = fixture({}, 'cmpri_pool_control_history');
  await assert.rejects(loadPoolDailyEntries(db, 'hotel', 'pool', '2026-11-01', null), /activity could not be loaded/);
});
