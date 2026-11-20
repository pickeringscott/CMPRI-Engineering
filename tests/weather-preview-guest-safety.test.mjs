import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../public/previews/weather/notification-preview.js', import.meta.url), 'utf8');
const START = Date.parse('2026-11-19T18:00:00Z');
const MINUTE = 60000;

function fixture() {
  const dom = new JSDOM('<!doctype html><div id="guestSafetySummary"></div><div id="notificationPreviewHost"></div><div id="guestSafetyHost"></div>', {
    url: 'https://cmpri.example/previews/cmpri-weather-preview.html', runScripts: 'outside-only',
  });
  const window = dom.window;
  let now = START, nextTimer = 0;
  const timers = new Map(), forbidden = [];
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  window.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + Number(delay || 0) }); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.setInterval = () => { forbidden.push('scheduler'); throw new Error('No scheduler is permitted'); };
  window.fetch = () => { forbidden.push('fetch'); throw new Error('The notification module must not fetch'); };
  window.Notification = { requestPermission() { forbidden.push('notification permission'); } };
  window.PushManager = class { subscribe() { forbidden.push('push'); } };
  window.supabase = { from() { forbidden.push('database'); throw new Error('No database client is permitted'); } };
  window.Storage.prototype.setItem = () => { forbidden.push('storage write'); };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(source);
  const api = window.initNotificationPreview();
  function alert(id, event, overrides = {}) {
    return { type: 'Feature', id: 'https://api.weather.gov/alerts/' + encodeURIComponent(id), geometry: null,
      properties: { id, event, status: 'Actual', messageType: 'Alert', effective: new Date(now - MINUTE).toISOString(),
        expires: new Date(now + 60 * MINUTE).toISOString(), headline: 'TEST official NWS summary: ' + event,
        description: 'TEST bulletin description for the hotel.', instruction: 'TEST official action from the bulletin.', ...overrides } };
  }
  function receive(alerts, status = 'live') {
    return api.receiveOfficial({ status, checkedAt: new Date(now).toISOString(),
      source: 'https://api.weather.gov/alerts/active?point=40.138080,-88.251416', alerts });
  }
  function advance(milliseconds) {
    now += milliseconds;
    for (let turn = 0; turn < 100; turn++) {
      const due = Array.from(timers).find(([, timer]) => timer.at <= now);
      if (!due) return;
      timers.delete(due[0]); due[1].fn();
    }
    throw new Error('Display expiration timer did not settle');
  }
  function cleanup() {
    window.dispatchEvent(new window.Event('pagehide'));
    assert.equal(timers.size, 0, 'display-only timers clean up on pagehide');
    assert.deepEqual(forbidden, [], 'no network, permission, push, storage, scheduler, or database calls');
    dom.window.close();
  }
  return { window, api, alert, receive, advance, cleanup, forbidden };
}

const actions = [
  ['Tornado Warning', 'Staff and guests go immediately to the first-floor interior hallways, away from windows and exterior doors.'],
  ['Severe Thunderstorm Warning', 'Staff and guests stay indoors and away from windows.'],
  ...['Flood Watch', 'Flood Warning', 'Flash Flood Warning'].map(event => [event, 'Monitor low spots and access routes. For a flash flood warning, move anyone threatened by rising water to higher ground and keep guests clear of flooded walkways and roads.']),
  ['Winter Storm Watch', 'Check entrances and walkways and get ice melt ready.'],
  ...['Winter Weather Advisory', 'Winter Storm Warning', 'Ice Storm Warning', 'Blizzard Warning'].map(event => [event, 'Check guest walkways for snow and ice. Share travel impacts with guests. Ice melt is in the boiler room. Available staff, including front desk and housemen, can treat sidewalks as needed.']),
  ['Freeze Warning', 'Check guest walkways for ice. Ice melt is in the boiler room. Available staff can treat sidewalks as needed.'],
  ['Snow Squall Warning', 'Warn guests about sudden whiteouts and deteriorating roads. Advise delaying departures until the squall passes.'],
  ['Extreme Heat Warning', 'Direct guests to air-conditioned areas and make drinking water available.'],
  ['Extreme Cold Warning', 'Provide a warm indoor waiting area for guests and minimize time outdoors.'],
  ['High Wind Warning', 'Bring people indoors, keep guests clear of exposed entrances, and secure loose outdoor items before winds arrive if safe.'],
  ...['Dense Fog Advisory', 'Blowing Dust Advisory', 'Dust Storm Warning'].map(event => [event, 'Notify departing guests of poor visibility. Advise delaying departures if a dust storm warning affects their route.']),
];

test('official hazard notices use every user-approved hotel action and the official NWS summary', () => {
  const f = fixture();
  try {
    actions.forEach(([event, expected], index) => {
      const result = f.receive([f.alert('hazard-' + index, event)]);
      const notice = result.inbox.find(item => item.event === event);
      assert.equal(notice.hotelInstruction, expected, event);
      assert.equal(notice.summary, 'TEST official NWS summary: ' + event);
      assert.equal(notice.simulated, false);
      assert.equal(result.alerts.length, 1, 'polygonless point-query alert retained');
    });
    let result = f.receive([f.alert('other', 'Special Weather Statement', { instruction: 'Use the official source action verbatim.' })]);
    assert.equal(result.inbox.at(-1).hotelInstruction, 'Use the official source action verbatim.');
    result = f.receive([f.alert('other-no-instruction', 'Unlisted Weather Advisory', { instruction: null, description: 'Official bulletin description contains the action.' })]);
    assert.equal(result.inbox.at(-1).hotelInstruction, 'Official bulletin description contains the action.');
  } finally { f.cleanup(); }
});

test('all official categories are in-app regardless of prep opt-ins; unchanged notices deduplicate and material updates notify once', () => {
  const f = fixture();
  try {
    assert.equal(f.window.document.querySelector('#npWeatherPrep').checked, false);
    assert.equal(f.window.document.querySelector('#npWinterPrep').checked, false);
    assert.equal(f.window.document.querySelector('#npDelivery'), null);
    assert.equal(f.window.document.querySelector('#simPushEnabled'), null);
    const alerts = [f.alert('watch', 'Winter Storm Watch'), f.alert('advisory', 'Winter Weather Advisory'),
      f.alert('warning', 'Winter Storm Warning'), f.alert('statement', 'Special Weather Statement')];
    let result = f.receive(alerts);
    assert.equal(result.inbox.length, 4);
    assert.equal(result.safetyOpens, 1, 'only the warning auto-opens');
    f.api.closeSafety();
    result = f.receive(alerts);
    assert.equal(result.inbox.length, 4);
    assert.equal(result.safetyOpens, 1);
    assert.equal(f.window.document.querySelector('#guestSafetyDialog').open, false);
    alerts[2].properties.expires = new Date(START + 75 * MINUTE).toISOString();
    result = f.receive(alerts);
    assert.equal(result.inbox.length, 5);
    assert.equal(result.safetyOpens, 2);
    assert.equal(result.inbox.filter(item => item.event === 'Winter Storm Warning' && item.status === 'active').length, 1,
      'older bulletin versions are visibly superseded');
    f.api.closeSafety();
    result = f.receive(alerts);
    assert.equal(result.inbox.length, 5);
    assert.equal(result.safetyOpens, 2);
    assert.equal(result.databaseCalls, 0);
    assert.equal(result.pushes, 0);
  } finally { f.cleanup(); }
});

test('cancellation references remove only the referenced warning and a failed response does not imply all-clear', () => {
  const f = fixture();
  try {
    const watch = f.alert('urn:fixture:watch', 'Tornado Watch');
    const warning = f.alert('urn:fixture:warning', 'Tornado Warning');
    f.receive([watch, warning]);
    let result = f.receive([], 'unavailable');
    assert.equal(result.alerts.length, 2);
    assert.equal(result.alerts.every(item => item.stale), true);
    assert.match(f.window.document.querySelector('#npOfficialStatus').textContent, /No all-clear/);
    const cancel = f.alert('cancel-warning', 'Tornado Warning', { messageType: 'Cancel', references: [{ identifier: 'urn:fixture:warning' }] });
    result = f.receive([watch, cancel]);
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0].event, 'Tornado Watch');
    assert.equal(result.inbox.find(item => item.event === 'Tornado Warning').status, 'canceled');
    const messagesBeforeReorderedResponse = result.inbox.length;
    result = f.receive([cancel, warning, watch]);
    assert.equal(result.alerts.length, 1, 'a later old-warning row cannot override an earlier cancellation');
    assert.equal(result.alerts[0].event, 'Tornado Watch');
    assert.equal(result.inbox.length, messagesBeforeReorderedResponse, 'the canceled warning is not re-delivered');
    const capCancel = f.alert('cancel-watch', 'Tornado Watch', { messageType: 'Cancel', references: 'nws@example.invalid,urn:fixture:watch,2026-11-19T18:00:00Z' });
    result = f.receive([capCancel]);
    assert.equal(result.alerts.length, 0);
  } finally { f.cleanup(); }
});

test('an earlier official ends time removes an inactive notice while preserving its actual NWS expiration', () => {
  const f = fixture();
  try {
    const rawExpiry = START + 60 * MINUTE, ends = START + 5 * MINUTE;
    const alert = f.alert('early-end', 'Winter Storm Watch', { expires: new Date(rawExpiry).toISOString(), ends: new Date(ends).toISOString() });
    let result = f.receive([alert]);
    assert.equal(result.alerts[0].expires, rawExpiry);
    assert.equal(result.alerts[0].activeUntil, ends);
    f.advance(5 * MINUTE + 25);
    result = f.api.snapshot();
    assert.equal(result.alerts.length, 0);
    assert.equal(result.inbox[0].status, 'ended');
    assert.equal(result.inbox[0].expires, rawExpiry);
    assert.equal(f.forbidden.length, 0, 'expiration is local display cleanup only');
  } finally { f.cleanup(); }
});

test('a same-ID ended update preserves its ended status and future official expiration', () => {
  const f = fixture();
  try {
    const rawExpiry = START + 60 * MINUTE;
    const watch = f.alert('updated-end', 'Winter Storm Watch', { expires: new Date(rawExpiry).toISOString() });
    f.receive([watch]);
    watch.properties.ends = new Date(START - MINUTE).toISOString();
    const result = f.receive([watch]);
    assert.equal(result.alerts.length, 0);
    assert.equal(result.inbox.at(-1).status, 'ended');
    assert.equal(result.inbox.at(-1).expires, rawExpiry);
    assert.equal(result.inbox.some(item => item.id === 'NWS:updated-end' && item.status === 'canceled'), false);
  } finally { f.cleanup(); }
});

test('the agreed forecast freeze stays simulated, uses the exact freeze action, and sample reset preserves official alerts', () => {
  const f = fixture();
  try {
    f.receive([f.alert('official-watch', 'Winter Storm Watch')]);
    const result = f.api.receive(f.api.sample('freeze-risk'));
    assert.equal(result.safety, true);
    assert.equal(f.window.document.querySelector('#npSafetyInstruction').textContent,
      'Check guest walkways for ice. Ice melt is in the boiler room. Available staff can treat sidewalks as needed.');
    assert.match(f.window.document.querySelector('#npSafetyLabel').textContent, /SIMULATED/);
    const reset = f.api.reset();
    assert.equal(reset.alerts.length, 1);
    assert.equal(reset.alerts[0].id, 'NWS:official-watch');
    assert.equal(reset.inbox.length, 1);
  } finally { f.cleanup(); }
});

test('reset removes every active simulated alert even after its notification history aged out', () => {
  const f = fixture();
  try {
    f.receive([f.alert('keep-official', 'Winter Storm Watch')]);
    for (let index = 0; index < 102; index++) f.api.receive({ ...f.api.sample('tornado-warning'), id: 'SIM-RESET-' + index });
    assert.equal(f.api.snapshot().alerts.filter(item => item.simulated).length, 102);
    const reset = f.api.reset();
    assert.equal(reset.alerts.filter(item => item.simulated).length, 0);
    assert.equal(reset.alerts.length, 1);assert.equal(reset.alerts[0].id, 'NWS:keep-official');
    assert.equal(reset.inbox.some(item => item.simulated), false);
  } finally { f.cleanup(); }
});

test('shared-check reset clears manual warning samples before a new watch can be shown', () => {
  const f = fixture();
  try {
    f.api.receive(f.api.sample('tornado-warning'));
    f.window.document.dispatchEvent(new f.window.CustomEvent('cmpri:simulated-alert-reset'));
    assert.equal(f.api.snapshot().alerts.length, 0);
    f.api.receive(f.api.sample('winter-watch'));
    assert.deepEqual(Array.from(f.api.snapshot().alerts, item => item.level), ['watch']);
    assert.equal(f.window.document.querySelector('#guestSafetyDialog').open, false);
  } finally { f.cleanup(); }
});

test('clearing notifications dismisses history without canceling active official alerts or redelivering unchanged notices', () => {
  const f = fixture();
  try {
    const watch = f.alert('clear-watch', 'Tornado Watch'), warning = f.alert('clear-warning', 'Tornado Warning');
    f.receive([watch, warning]);
    const cleared = f.api.clearNotifications();
    assert.equal(cleared.inbox.length, 0);assert.equal(cleared.alerts.length, 2);
    assert.equal(f.window.document.querySelector('#guestSafetyDialog').open, false);
    const repeated = f.receive([watch, warning]);
    assert.equal(repeated.inbox.length, 0);assert.equal(repeated.safetyOpens, 1);
    assert.equal(f.window.document.querySelector('#guestSafetyDialog').open, false);
    assert.match(f.window.document.querySelector('#npClearStatus').textContent, /NWS alerts remain/);
    warning.properties.headline += ' · updated official bulletin';
    const changed = f.receive([watch, warning]);
    assert.equal(changed.inbox.length, 1);assert.equal(changed.safetyOpens, 2);
  } finally { f.cleanup(); }
});

test('live inbox excludes resolved and superseded history and derives each current notice color from its current hazard', () => {
  const f = fixture();
  try {
    const sameId = f.alert('revision', 'Tornado Warning');
    f.receive([sameId]);
    sameId.properties.event = 'Tornado Watch';sameId.properties.headline = 'TEST current watch';
    f.receive([sameId]);
    const current = f.window.document.querySelectorAll('#npLiveInbox button');
    assert.equal(current.length, 1);assert.match(current[0].textContent, /Tornado Watch/);
    assert.equal(current[0].dataset.level, 'watch');
    f.receive([]);
    assert.equal(f.window.document.querySelectorAll('#npLiveInbox button').length, 0);
    assert.ok(f.api.snapshot().inbox.some(item => item.status === 'superseded' || item.status === 'canceled'));
    f.api.clearNotifications();assert.equal(f.api.snapshot().inbox.length, 0);
  } finally { f.cleanup(); }
});

test('open details follow a same-ID downgrade and canceled historical warnings reopen only as past compact notices', () => {
  const f = fixture();
  try {
    const sameId = f.alert('selected-revision', 'Tornado Warning');f.receive([sameId]);
    const dialog = f.window.document.querySelector('#guestSafetyDialog');
    assert.equal(dialog.dataset.fullscreen,'true');assert.equal(dialog.dataset.level,'warning');
    sameId.properties.event='Tornado Watch';sameId.properties.headline='TEST replacement watch';f.receive([sameId]);
    assert.equal(dialog.open,true);assert.equal(dialog.dataset.fullscreen,'false');assert.equal(dialog.dataset.level,'watch');
    assert.equal(f.window.document.querySelector('#npSafetyEvent').textContent,'Tornado Watch');
    f.receive([]);assert.equal(dialog.open,false);
    const warning=f.api.snapshot().inbox.find(item=>item.event==='Tornado Warning');f.api.openDetails(warning.key);
    assert.equal(dialog.dataset.fullscreen,'false');assert.equal(dialog.dataset.level,'history');
    assert.match(f.window.document.querySelector('#npSafetyDisclaimer').textContent,/Past notification/);
    f.api.clearNotifications();assert.equal(dialog.open,false);
  } finally { f.cleanup(); }
});
