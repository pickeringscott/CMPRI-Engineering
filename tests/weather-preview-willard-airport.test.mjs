import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, ResourceLoader } from 'jsdom';

const source = readFileSync(new URL('../public/previews/weather/willard-airport.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/previews/weather/willard-airport.css', import.meta.url), 'utf8');
const clockSource = readFileSync(new URL('../public/previews/weather/weather-clock.js', import.meta.url), 'utf8');
const TRACKER = 'https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9';
const START = Date.parse('2026-11-20T20:05:00Z');
const MINUTE = 60000;

function fixture(chief = true) {
  const requests = [], forbidden = [], errors = [], timers = new Map();
  class CapturedResources extends ResourceLoader {
    fetch(url) {
      // Record iframe navigation without loading any actual provider resource.
      requests.push(url);
      return null;
    }
  }
  const dom = new JSDOM('<!doctype html><details id="willardAirport"><summary>Willard Airport</summary></details>', {
    url: 'https://preview.example/previews/cmpri-weather-preview.html' + (chief ? '?clock=24' : ''),
    runScripts: 'outside-only', pretendToBeVisual: true, resources: new CapturedResources(),
  });
  const { window } = dom;
  let now = START, nextTimer = 0, hidden = false;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  const OriginalDate = window.Date;
  window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  window.setTimeout = (fn, delay) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + Number(delay || 0) });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  const reject = name => () => { forbidden.push(name); throw new Error('Willard must not use ' + name); };
  window.fetch = reject('independent flight fetch');
  window.XMLHttpRequest = reject('XMLHttpRequest');
  window.WebSocket = reject('WebSocket');
  window.setInterval = reject('interval polling');
  window.Notification = { requestPermission: reject('notification permission') };
  window.PushManager = class { subscribe() { return reject('push subscription')(); } };
  window.Storage.prototype.setItem = reject('persistent storage');
  window.supabase = { from: reject('database'), rpc: reject('database') };
  window.addEventListener('error', event => errors.push(event.error?.message || event.message));
  window.eval(clockSource);
  window.eval(source);
  const details = window.document.getElementById('willardAirport');
  const api = window.cmpriWillardAirport.create(details, { use24HourTime: !window.cmpriWeatherClock.hour12 });
  const frame = () => details.querySelector('iframe');
  function disclose(open) {
    details.open = open;
    details.dispatchEvent(new window.Event('toggle'));
  }
  function visibility(value) {
    hidden = value;
    window.document.dispatchEvent(new window.Event('visibilitychange'));
  }
  function advance(milliseconds) {
    const target = now + milliseconds;
    for (let count = 0; count < 100; count++) {
      const due = Array.from(timers).filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { now = target; return; }
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    throw new Error('Foreground clock timers did not settle');
  }
  async function cleanup() {
    api.destroy();
    // jsdom queues its native details toggle separately from the fake clock.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(timers.size, 0, 'no display clock remains after teardown');
    assert.equal(frame(), null, 'the provider browsing context is removed');
    assert.deepEqual(forbidden, [], 'no own feed, polling, notification, storage or database work');
    assert.deepEqual(errors, []);
    dom.window.close();
  }
  return { window, details, api, frame, disclose, visibility, advance, timers, requests, cleanup };
}

test('the collapsed airport makes no request; only active expansion inserts the approved unmodified tracker', async () => {
  const f = fixture();
  try {
    assert.equal(f.details.open, false);
    assert.equal(f.frame(), null);
    f.api.setActive(true);
    assert.deepEqual(f.requests, []);
    assert.equal(f.timers.size, 0);

    f.api.setActive(false);
    f.disclose(true);
    assert.equal(f.frame(), null, 'an expanded inactive Weather view still must not load the provider');
    f.api.setActive(true);
    const frame = f.frame();
    assert.ok(frame);
    assert.deepEqual(f.requests, [TRACKER]);
    assert.deepEqual(Object.fromEntries(Array.from(frame.attributes, attribute => [attribute.name, attribute.value])), {
      src: TRACKER, width: '100%', height: '450', style: 'border:0;max-width:100%',
      title: 'Live flight tracker map by AvioADSB', loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin',
    });
    assert.equal(frame.hasAttribute('sandbox'), false);
    assert.equal(f.details.querySelector('[data-willard-tracker]').children.length, 1, 'no overlay, extra key or explanatory tracker text');
    f.api.setActive(true);
    f.disclose(true);
    assert.equal(f.frame(), frame);
    assert.deepEqual(f.requests, [TRACKER], 'repeated active state does not duplicate iframe navigation');
    assert.equal(f.timers.size, 1, 'only the foreground display clock runs');
  } finally { await f.cleanup(); }
});

test('collapse, inactive Weather, hidden document and pagehide unload the provider and ignore old frame events', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); f.disclose(true);
    const first = f.frame();
    first.dispatchEvent(new f.window.Event('load'));
    const lastKnown = f.api.getState().lastDocumentLoadedAt;
    assert.ok(lastKnown);
    assert.equal(f.api.getState().aircraftCoverageVerified, false, 'iframe load never proves actual aircraft coverage');

    f.disclose(false);
    assert.equal(first.isConnected, false);
    assert.equal(f.frame(), null);
    assert.equal(f.timers.size, 0);
    f.advance(2 * MINUTE);
    first.dispatchEvent(new f.window.Event('load'));
    assert.equal(f.api.getState().trackerStatus, 'inactive');
    assert.equal(f.api.getState().lastDocumentLoadedAt, lastKnown, 'last-known RAM state survives without accepting a late detached load');

    f.disclose(true);
    const pending = f.frame();
    f.api.setActive(false);
    assert.equal(pending.isConnected, false, 'an unfinished provider context is removed too');
    pending.dispatchEvent(new f.window.Event('load'));
    assert.equal(f.api.getState().trackerStatus, 'inactive');
    assert.equal(f.timers.size, 0);

    f.api.setActive(true);
    assert.ok(f.frame());
    f.visibility(true);
    assert.equal(f.frame(), null);
    assert.equal(f.timers.size, 0);
    f.api.setActive(true);
    assert.equal(f.frame(), null, 'hidden documents cannot resume the provider');
    f.visibility(false);
    assert.ok(f.frame());
    f.window.dispatchEvent(new f.window.Event('pagehide'));
    assert.equal(f.frame(), null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.api.getState().active, false);
  } finally { await f.cleanup(); }
});

test('the London board preserves unknown flight data and performs no own feed or background polling', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); f.disclose(true);
    const board = f.details.querySelector('[data-willard-board]');
    assert.equal(board.dataset.style, 'london');
    assert.deepEqual(Array.from(board.querySelectorAll('.wa-flight-heading'), heading => heading.textContent), ['Arrivals', 'Departures']);
    assert.deepEqual(Array.from(board.querySelectorAll('tbody td'), cell => cell.textContent), ['Flight data unavailable', 'Flight data unavailable']);
    assert.equal(board.querySelector('input,select,button,[data-flight]'), null, 'no search, selectors or copied fictional flights');
    assert.doesNotMatch(board.textContent, /DEMO\d|SAMPLE|no flights|0 flights/i);
    assert.equal(f.api.getState().arrivals, null);
    assert.equal(f.api.getState().departures, null);

    f.advance(20 * MINUTE);
    assert.deepEqual(f.requests, [TRACKER], 'the current clock does not poll flight data or reload the iframe');
    assert.equal(f.api.getState().backgroundPolling, false);
    assert.equal(f.api.getState().flightRequests, 0);
    assert.equal(f.api.getState().notifications, 0);
    f.disclose(false);
    f.advance(30 * MINUTE);
    assert.deepEqual(f.requests, [TRACKER]);
    assert.equal(f.timers.size, 0);

    for (const asset of [source, styles]) {
      assert.match(asset, /Copyright \(c\) 2026 P-M Nilsson/);
      assert.match(asset, /Permission is hereby granted, free of charge/);
      assert.match(asset, /The above copyright notice and this permission notice shall be included/);
      assert.match(asset, /THE SOFTWARE IS PROVIDED "AS IS"/);
    }
  } finally { await f.cleanup(); }
});

test('the foreground Central clock follows the shared Chief24-hour or ordinary12-hour preference and stops on destroy', async () => {
  for (const chief of [true, false]) {
    const f = fixture(chief);
    try {
      f.api.setActive(true); f.disclose(true);
      const clock = f.details.querySelector('[data-willard-clock]');
      assert.equal(clock.textContent, chief ? '14:05 CST' : '2:05 PM CST');
      assert.match(clock.getAttribute('aria-label'), /^Current Central time:/);
      assert.equal(f.api.getState().timeFormat, chief ? '24-hour' : '12-hour');
      assert.equal(f.api.getState().timeZone, 'America/Chicago');
      f.advance(MINUTE + 50);
      assert.equal(clock.textContent, chief ? '14:06 CST' : '2:06 PM CST');
      assert.equal(f.timers.size, 1);
      f.api.destroy();
      assert.equal(f.timers.size, 0);
      assert.equal(f.frame(), null);
      assert.equal(f.details.querySelector('[data-willard-airport]'), null);
      f.advance(10 * MINUTE);
      assert.equal(f.timers.size, 0);
      assert.deepEqual(f.requests, [TRACKER]);
    } finally { await f.cleanup(); }
  }
});
