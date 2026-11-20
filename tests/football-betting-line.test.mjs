import test from 'node:test';
import assert from 'node:assert/strict';
import { createFootballBettingFeed } from '../src/lib/server/football-betting-line.ts';

const NOW = Date.parse('2026-11-20T22:00:00Z');
const competitor = (id, name, abbreviation, homeAway) => ({ homeAway, team: { id, shortDisplayName: name, abbreviation } });
const game = (overrides = {}) => ({ id: '401858527', date: '2026-11-21T19:30:00Z', competitions: [{
  id: '401858527', status: { type: { state: 'pre' } }, competitors: [competitor('2294', 'Iowa', 'IOWA', 'away'), competitor('356', 'Illinois', 'ILL', 'home')],
}], ...overrides });
const market = (overrides = {}) => ({ provider: { id: '58', name: 'Fixture Book' }, details: 'IOWA -8.5',
  open: { details: 'IOWA -5.5' }, close: { details: 'IOWA -6.5' }, ...overrides });
const response = data => Response.json(data);
function fixture({ events = [game()], items = [market()], now = NOW, handler } = {}) {
  const state = { now, calls: [] };
  const feed = createFootballBettingFeed({ now: () => state.now, fetcher: async (url, init) => {
    state.calls.push({ url, init });
    if (handler) return handler(url, init, state);
    return response(url.includes('/schedule?') ? { events } : { items });
  } });
  return { state, feed };
}

test('reads the next actual Iowa–Illinois event and current spread, preserving bookmaker/source timing', async () => {
  const { feed, state } = fixture();
  const value = await feed();
  assert.equal(value.status, 'available');
  assert.equal(value.line, 'IOWA -8.5');
  assert.equal(value.provider, 'Fixture Book');
  assert.equal(value.retrievedAt, new Date(NOW).toISOString());
  assert.equal(value.sourceUpdatedAt, null);
  assert.deepEqual(value.event, { id: '401858527', date: '2026-11-21T19:30:00.000Z', state: 'pre', away: 'Iowa', home: 'Illinois' });
  assert.equal(state.calls[0].url, 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/2294/schedule?season=2026');
  assert.equal(state.calls[1].url, 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/401858527/competitions/401858527/odds?lang=en&region=us');
  for (const { init } of state.calls) {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('never substitutes opening/closing prices, absent data, numeric zero or another team for the current published line', async () => {
  for (const details of [null, undefined, '', 0, '0', 'MICH -8.5']) {
    const { feed } = fixture({ items: [market({ details })] });
    const value = await feed();
    assert.equal(value.status, 'unavailable', String(details));
    assert.equal(value.line, null); assert.equal(value.retrievedAt, null);
  }
});

test('an explicitly published pick-em is available; missing data is never converted to pick-em', async () => {
  for (const details of ['PK', 'EVEN', 'IOWA PK', 'ILL +0']) {
    assert.equal((await fixture({ items: [market({ details })] }).feed()).line, details);
  }
});

test('uses an advertised in-progress matchup before a later scheduled matchup', async () => {
  const live = game({ id: '555', date: '2026-11-20T21:30:00Z', competitions: [{ ...game().competitions[0], id: '555', status: { type: { state: 'in' } } }] });
  const value = await fixture({ events: [game(), live] }).feed();
  assert.equal(value.event.id, '555'); assert.equal(value.event.state, 'in');
});

test('completed, unrelated or old unstarted games do not produce a live betting line or trigger odds reads', async () => {
  const final = game({ competitions: [{ ...game().competitions[0], status: { type: { state: 'post' } } }] });
  const unrelated = game({ competitions: [{ ...game().competitions[0], competitors: [competitor('2294', 'Iowa', 'IOWA', 'away'), competitor('999', 'Other', 'OTH', 'home')] }] });
  for (const events of [[], [final], [unrelated], [game({ date: '2026-11-14T19:30:00Z' })]]) {
    const { feed, state } = fixture({ events });
    assert.equal((await feed()).status, 'unavailable'); assert.equal(state.calls.length, 1);
  }
});

test('football postseason lookup uses the preceding season in January', async () => {
  const { feed, state } = fixture({ now: Date.parse('2027-01-05T12:00:00Z'), events: [] });
  await feed(); assert.match(state.calls[0].url, /season=2026$/);
});

test('retains only a real source update timestamp and never invents one from fetch time', async () => {
  const stamp = '2026-11-20T20:15:00Z';
  const value = await fixture({ items: [market({ lastUpdated: stamp })] }).feed();
  assert.equal(value.sourceUpdatedAt, '2026-11-20T20:15:00.000Z');
  assert.equal((await fixture({ items: [market({ lastUpdated: '2030-01-01T00:00:00Z' })] }).feed()).sourceUpdatedAt, null);
});

test('cache deduplicates concurrent foreground reads and preserves retrieval time until the next actual refresh', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { feed, state } = fixture({ handler: async url => {
    if (url.includes('/schedule?')) { await gate; return response({ events: [game()] }); }
    return response({ items: [market()] });
  } });
  const one = feed(), two = feed(); release();
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(a, b); assert.equal(state.calls.length, 2);
  state.now += 59_000; assert.equal((await feed()).retrievedAt, a.retrievedAt); assert.equal(state.calls.length, 2);
  state.now += 1_001; assert.notEqual((await feed()).retrievedAt, a.retrievedAt); assert.equal(state.calls.length, 4);
});

test('failed refresh marks the retained prior line stale without changing its timestamp and drops it after five minutes', async () => {
  let broken = false;
  const { feed, state } = fixture({ handler: async url => {
    if (broken) throw new Error('Fixture offline');
    return response(url.includes('/schedule?') ? { events: [game()] } : { items: [market()] });
  } });
  const initial = await feed(); broken = true; state.now += 60_001;
  const stale = await feed();
  assert.equal(stale.status, 'stale'); assert.equal(stale.line, initial.line); assert.equal(stale.retrievedAt, initial.retrievedAt);
  state.now = NOW + 300_001;
  const expired = await feed(); assert.equal(expired.status, 'unavailable'); assert.equal(expired.line, null);
});

test('a verified final/missing market clears retained prices rather than leaving an old live line', async () => {
  let ended = false;
  const { feed, state } = fixture({ handler: async url => response(url.includes('/schedule?') ? {
    events: ended ? [] : [game()],
  } : { items: [market()] }) });
  assert.equal((await feed()).status, 'available'); ended = true; state.now += 60_001;
  assert.equal((await feed()).status, 'unavailable');
});

test('HTML errors, oversized bodies, malformed JSON and missing event structure are unavailable, not empty/all-clear', async () => {
  for (const invalid of [
    () => new Response('<html>Blocked</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => response({ message: 'Rate limit' }),
    () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
  ]) {
    assert.equal((await fixture({ handler: invalid }).feed()).status, 'unavailable');
  }
});

test('provider references cannot redirect a read to another host, event, port or supplied query', async () => {
  const refs = ['https://attacker.invalid/odds/58', 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/999/competitions/999/odds/58'];
  for (const ref of refs) {
    const { feed, state } = fixture({ items: [{ $ref: ref }] });
    assert.equal((await feed()).status, 'unavailable'); assert.equal(state.calls.length, 2);
  }
  const { feed, state } = fixture({ handler: async url => {
    if (url.includes('/schedule?')) return response({ events: [game()] });
    if (url.includes('/odds/58?')) return response(market());
    return response({ items: [{ $ref: 'http://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/401858527/competitions/401858527/odds/58?arbitrary=ignored' }] });
  } });
  assert.equal((await feed()).status, 'available');
  assert.equal(state.calls[2].url, 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/401858527/competitions/401858527/odds/58?lang=en&region=us');
});

test('timeouts return unavailable and a canceled caller does not receive an available result', async () => {
  const hold = setTimeout(() => {}, 100);
  try {
    const feed = createFootballBettingFeed({ now: () => NOW, timeoutMs: 5, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }) });
    assert.equal((await feed()).status, 'unavailable');
  } finally { clearTimeout(hold); }
  const controller = new AbortController(); controller.abort();
  const { feed, state } = fixture(); await assert.rejects(feed(controller.signal), { name: 'AbortError' }); assert.equal(state.calls.length, 0);
});
