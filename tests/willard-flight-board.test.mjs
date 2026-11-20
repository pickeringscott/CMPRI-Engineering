import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/load-ts.mjs';

const { parseWillardBoard } = loadTs('src/lib/server/willard-flight-board.ts');
const NOW = new Date('2026-11-20T13:06:00Z');
// Synthetic records follow the verified public structure; no captured rows,
// provider stylesheet, script or flight schedule is committed as a fixture.
function row({ flight = 'ZZ123', time = '12:30', date = '20 Nov', airline = 'Example &amp; Co', location = 'Example City', iata = 'XYZ',
  status = 'Estimated 12:45', child = false, counter = '', token = '1795158000000', kind = 'arrivals' } = {}) {
  return `<tr class="tt-row estimated ${child ? 'tt-child' : ''}"><td class="tt-t si estimated">${time}</td><td class="tt-d">${date}</td>
  <td class="tt-i"><a href="/en/airport/${iata.toLowerCase()}/${kind === 'arrivals' ? 'departures' : 'arrivals'}">${iata}</a></td>
  <td class="tt-ap">${location}</td><td class="tt-f"><a class="flight-ts" href="/en/flight/${flight.slice(0, 2).toLowerCase()}-${flight.slice(2).toLowerCase()}" data-ts="${token}">${flight}</a></td>
  <td class="tt-al">${airline}${counter ? '<a class="tt-child-count" title="Codeshare flights">' + counter + '</a>' : ''}</td><td class="tt-s sc estimated">${status}</td></tr>`;
}
function page({ kind = 'arrivals', date = '2026-11-20', rows = row(), headers, canonical, extra = '' } = {}) {
  const label = kind === 'arrivals' ? 'Arrivals' : 'Departures';
  return `<!doctype html><html lang="en"><head><title>CMI • Champaign/Urbana University of Illinois Willard - Live ${label}</title>
  <link rel="canonical" href="${canonical || 'https://www.avionio.com/en/airport/cmi/' + kind}"><script>throw new Error('NEVER EXECUTE')</script></head><body><main id="content">
  <h1>Champaign/Urbana University of Illinois Willard Airport (CMI) — Live ${kind} board</h1>
  <div id="tt-date" data-value="${date}"></div><table class="tt"><thead><tr>${(headers || ['Time', 'Date', 'IATA', kind === 'arrivals' ? 'Origin' : 'Destination', 'Flight', 'Airline', 'Status']).map(value => '<th>' + value + '</th>').join('')}</tr></thead><tbody>
  <tr class="tt-nav" id="tt-nav-prev"><td colspan="7"><a>Previous flights</a></td></tr>${rows}</tbody></table>${extra}</main></body></html>`;
}

test('extracts only published facts, preserves codeshares, ignores UI counters and treats data-ts as opaque identity', () => {
  const source = page({ rows: row({ counter: '1' }) + row({ flight: 'YY456', airline: 'Another Carrier', child: true }) });
  const result = parseWillardBoard(source, 'arrivals', NOW);
  assert.equal(result.providerDate, '2026-11-20'); assert.equal(result.explicitEmpty, false);
  assert.deepEqual(Array.from(result.flights, flight => flight.flight), ['ZZ123', 'YY456']);
  assert.equal(result.flights[0].airline, 'Example & Co');
  assert.equal(result.flights[0].time, '12:30'); assert.equal(result.flights[0].date, '2026-11-20');
  assert.equal(result.flights[0].status, 'Estimated 12:45');
  assert.notEqual(result.flights[0].id, result.flights[1].id);
  assert.deepEqual(Object.keys(result.flights[0]).sort(), ['airline', 'date', 'flight', 'iata', 'id', 'location', 'status', 'time']);
  assert.equal(result.flights[0].location, 'Example City');
});

test('uses the actual source calendar across midnight and year boundaries without deriving movement time from link tokens', () => {
  const result = parseWillardBoard(page({ date: '2026-12-31', rows: row({ date: '31 Dec', time: '23:59', token: '1234567890000' }) + row({ flight: 'YY456', date: '1 Jan', time: '00:05' }) }), 'arrivals', new Date('2027-01-01T05:30:00Z'));
  assert.deepEqual(Array.from(result.flights, flight => [flight.date, flight.time]), [['2026-12-31', '23:59'], ['2027-01-01', '00:05']]);
  const january = parseWillardBoard(page({ date: '2027-01-01', rows: row({ date: '31 Dec' }) }), 'arrivals', new Date('2027-01-01T12:00:00Z'));
  assert.equal(january.flights[0].date, '2026-12-31');
  assert.throws(() => parseWillardBoard(page({ rows: row({ date: '25 Nov' }) }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page({ date: '2026-02-30' }), 'arrivals', NOW));
});

test('fails closed for stale calendars, wrong airport/direction, challenges and unknown or empty source states', () => {
  assert.throws(() => parseWillardBoard(page(), 'arrivals', new Date('2026-11-21T13:06:00Z')), /current Central day/);
  assert.throws(() => parseWillardBoard(page({ kind: 'departures', rows: row({ kind: 'departures' }) }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page({ canonical: 'https://www.avionio.com/en/airport/ord/arrivals' }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard('<html><body>Checking your browser</body></html>', 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page({ rows: '' }), 'arrivals', NOW), /verified flight records/);
  assert.throws(() => parseWillardBoard(page({ rows: '<tr><td colspan="7">No flights</td></tr>' }), 'arrivals', NOW));
});

test('rejects partial and changed records rather than returning a plausible subset or silently truncating', () => {
  for (const broken of [row().replace('<td class="tt-ap">Example City</td>', ''), row({ time: '24:05' }), row({ date: '31 Feb' }), row({ iata: 'XX' }), row({ status: '' }), row().replace('</tr>', '')]) {
    assert.throws(() => parseWillardBoard(page({ rows: row({ flight: 'YY456' }) + broken }), 'arrivals', NOW));
  }
  assert.throws(() => parseWillardBoard(page({ rows: row() + row() }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page({ headers: ['Time', 'Date', 'Flight', 'Status'] }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page().replace('</html>', ''), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page({ extra: '<table><tr><td>unexpected second board</td></tr></table>' }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page() + ' '.repeat(1024 * 1024), 'arrivals', NOW));
});

test('decodes plain facts safely, never runs provider scripts, and accepts the verified departure structure', () => {
  const result = parseWillardBoard(page({ kind: 'departures', rows: row({ kind: 'departures', location: 'Test &#x26; Town', airline: 'Carrier &quot;One&quot;', status: 'Cancelled', time: '00:00' }) }), 'departures', NOW);
  assert.equal(result.flights[0].location, 'Test & Town'); assert.equal(result.flights[0].airline, 'Carrier "One"');
  assert.equal(result.flights[0].time, '00:00'); assert.equal(result.flights[0].status, 'Cancelled');
  assert.throws(() => parseWillardBoard(page({ rows: row({ location: 'Bad &#xD800;' }) }), 'arrivals', NOW));
  assert.throws(() => parseWillardBoard(page({ rows: row({ location: 'Bad &#0;' }) }), 'arrivals', NOW));
});
