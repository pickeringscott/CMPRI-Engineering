import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, ResourceLoader } from 'jsdom';

const source = readFileSync(new URL('../public/previews/weather/willard-airport.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/previews/weather/willard-airport.css', import.meta.url), 'utf8');
const clockSource = readFileSync(new URL('../public/previews/weather/weather-clock.js', import.meta.url), 'utf8');
const TRACKER = '/api/willard-tracker';
const START = Date.parse('2026-11-20T20:05:00Z');
const MINUTE = 60000;

function payload() {
  const board = (kind, flights) => ({status:'live',sourceUrl:'https://www.avionio.com/en/airport/cmi/'+kind,
    retrievedAt:'2026-11-20T20:05:00Z',providerDate:'2026-11-20',explicitEmpty:false,flights,error:null});
  return {airport:'KCMI',iata:'CMI',timeZone:'America/Chicago',checkedAt:'2026-11-20T20:05:00Z',boards:{
    arrivals:board('arrivals',[
      {id:'a1',flight:'AA 100',airline:'American Airlines',location:'Chicago',iata:'ORD',date:'2026-11-20',time:'00:05',status:'Landed'},
      {id:'a2',flight:'BA 200',airline:'British Airways',location:'Chicago',iata:'ORD',date:'2026-11-20',time:'00:05',status:'Landed'},
      {id:'a3',flight:'AA 101',airline:'American Airlines',location:'Dallas',iata:'DFW',date:'2026-11-21',time:'14:25',status:'Delayed'},
    ]),
    departures:board('departures',[
      {id:'d1',flight:'AA 102',airline:'American Airlines',location:'Chicago',iata:'ORD',date:'2026-11-20',time:'07:11',status:'Estimated 07:22'},
    ]),
  }};
}

function fixture(options = {}) {
  const chief = options.chief !== false;
  const requests = [], flightCalls = [], forbidden = [], errors = [], timers = new Map(), trackers = [];
  class CapturedResources extends ResourceLoader {
    fetch(url) { requests.push(url); return null; }
  }
  const dom = new JSDOM('<!doctype html><details id="willardAirport"><summary>Willard Airport</summary></details>', {
    url: 'https://preview.example/previews/cmpri-weather-preview.html' + (chief ? '?clock=24' : ''),
    runScripts: 'outside-only', pretendToBeVisual: true, resources: new CapturedResources(),
  });
  const { window } = dom;
  let now = options.now ?? START, nextTimer = 0, hidden = false;
  Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
  const OriginalDate = window.Date;
  window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  window.setTimeout = (fn, delay) => {
    const id = ++nextTimer; timers.set(id, { fn, at: now + Number(delay || 0) }); return id;
  };
  window.clearTimeout = id => timers.delete(id);
  const reject = name => () => { forbidden.push(name); throw new Error('Willard must not use ' + name); };
  window.fetch = async (url, init) => {
    assert.equal(url, '/api/willard-flights', 'only the fixed same-origin flight transport is permitted');
    assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin');
    const call = { url, init }; flightCalls.push(call);
    return options.fetch ? options.fetch(call, flightCalls.length) : Response.json(payload());
  };
  window.XMLHttpRequest = reject('XMLHttpRequest');
  window.WebSocket = reject('WebSocket');
  window.setInterval = reject('interval polling');
  window.Notification = { requestPermission: reject('notification permission') };
  window.PushManager = class { subscribe() { return reject('push subscription')(); } };
  window.Storage.prototype.setItem = reject('persistent storage');
  window.supabase = { from: reject('database'), rpc: reject('database') };
  window.cmpriWillardTracker = { create(host, trackerOptions) {
    assert.equal(host.matches('[data-willard-tracker]'), true);
    assert.ok(['24', '12'].includes(trackerOptions.clockMode));
    const record = { host, options: trackerOptions, activeCalls: [], destroyCalls: 0,
      state: { active: false, status: 'not-requested', pendingRequests: 0, destroyed: false } };
    trackers.push(record);
    record.api = {
      setActive(value) { record.activeCalls.push(value); record.state.active = value === true;
        record.state.status = record.state.active ? 'live' : 'inactive'; },
      getState() { return { ...record.state }; },
      destroy() { record.destroyCalls++; record.state.active = false; record.state.destroyed = true; },
    };
    return record.api;
  } };
  window.addEventListener('error', event => errors.push(event.error?.message || event.message));
  window.eval(clockSource); window.eval(source);
  const details = window.document.getElementById('willardAirport');
  const api = window.cmpriWillardAirport.create(details, { use24HourTime: !window.cmpriWeatherClock.hour12 });
  const frame = () => details.querySelector('iframe');
  function disclose(open) { details.open = open; details.dispatchEvent(new window.Event('toggle')); }
  function visibility(value) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); }
  function advance(milliseconds) {
    const target = now + milliseconds;
    for (let count = 0; count < 100; count++) {
      const due = Array.from(timers).filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { now = target; return; }
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    throw new Error('Foreground clock timers did not settle');
  }
  async function settle() { for (let count = 0; count < 8; count++) await new Promise(resolve => setImmediate(resolve)); }
  async function cleanup() {
    api.destroy(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(timers.size, 0); assert.equal(frame(), null);
    assert.ok(trackers.every(tracker => tracker.destroyCalls === 1 && !tracker.state.active),
      'airport destruction releases every retained native tracker exactly once');
    assert.deepEqual(requests, [], 'the airport never creates an external browsing context');
    assert.deepEqual(forbidden, [], 'no polling, notification, storage or database work');
    assert.deepEqual(errors, []); dom.window.close();
  }
  return { window, details, api, frame, trackers, disclose, visibility, advance, timers, requests, flightCalls, settle, cleanup };
}

function rows(f, kind) { return Array.from(f.details.querySelectorAll('[data-willard-'+kind+'] tbody tr[data-flight]')); }

test('collapsed and inactive airport do no work; expansion activates one native tracker and reads boards once', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); await f.settle();
    assert.equal(f.details.open, false); assert.equal(f.frame(), null); assert.deepEqual(f.flightCalls, []);
    assert.deepEqual(f.requests, []); assert.equal(f.trackers.length, 0); assert.equal(f.timers.size, 0);
    f.api.setActive(false); f.disclose(true); await f.settle();
    assert.equal(f.frame(), null); assert.equal(f.flightCalls.length, 0);
    f.api.setActive(true); await f.settle();
    assert.deepEqual(f.requests, []); assert.equal(f.flightCalls.length, 1); assert.equal(f.frame(), null);
    assert.equal(f.trackers.length, 1); assert.equal(f.trackers[0].state.active, true);
    assert.equal(f.api.getState().trackerSource, TRACKER);
    assert.equal(f.api.getState().trackerMounted, true); assert.equal(f.api.getState().trackerActive, true);
    assert.equal(f.trackers[0].options.clockMode, '24');
    f.api.setActive(true); f.disclose(true); await f.settle();
    assert.equal(f.flightCalls.length, 1); assert.equal(f.requests.length, 0); assert.equal(f.trackers.length, 1);
    assert.equal(f.timers.size, 1, 'only the display clock runs');
    assert.equal(f.api.getState().boardStatus, 'live'); assert.equal(f.api.getState().backgroundPolling, false);
    f.disclose(false); await f.settle();
    assert.equal(f.api.getState().trackerMounted, true, 'collapse retains the same native map instance');
    assert.equal(f.api.getState().trackerActive, false); assert.equal(f.trackers[0].destroyCalls, 0);
    f.disclose(true); await f.settle();
    assert.equal(f.trackers.length, 1); assert.equal(f.api.getState().trackerActive, true);
    assert.equal(f.flightCalls.length, 1, 'quick reopen reuses board cache independently of tracker activation');
  } finally { await f.cleanup(); }
});

test('native London boards preserve every codeshare, published status and wall time without inventing timing semantics', async () => {
  for (const chief of [true, false]) {
    const f = fixture({ chief });
    try {
      f.api.setActive(true); f.disclose(true); await f.settle();
      assert.equal(f.details.querySelector('[data-willard-board]').dataset.style, 'london');
      assert.deepEqual(rows(f,'arrivals').map(row => row.querySelector('.wa-flight-number').textContent), ['AA 100','BA 200','AA 101']);
      assert.deepEqual(rows(f,'arrivals').map(row => row.querySelector('.wa-flight-time').textContent), chief ? ['00:05','00:05','14:25'] : ['12:05 AM','12:05 AM','2:25 PM']);
      assert.equal(rows(f,'departures')[0].querySelector('.wa-flight-time').textContent, chief ? '07:11' : '7:11 AM');
      assert.equal(rows(f,'departures')[0].querySelector('td:last-child').textContent, chief ? 'Estimated 07:22' : 'Estimated 7:22 AM');
      assert.equal(rows(f,'arrivals')[2].querySelector('td:last-child').textContent, 'Delayed');
      assert.equal(rows(f,'arrivals')[2].querySelector('time').getAttribute('datetime'), '2026-11-21T14:25');
      assert.equal(rows(f,'arrivals')[2].querySelector('.wa-flight-date').textContent, 'Nov 21');
      const board = f.details.querySelector('[data-willard-board]');
      assert.doesNotMatch(board.textContent, /actual|scheduled|\d+\s*min(?:ute)?s?\s*(?:late|delay)|last updated/i);
      assert.equal(f.details.querySelectorAll('iframe').length, 0, 'boards and tracker use native DOM, without provider iframes');
      assert.equal(f.details.querySelector('.wa-source a').textContent, 'Avionio');
      assert.match(f.details.querySelector('.wa-source').textContent, chief ? /Retrieved:.*14:05 CST/ : /Retrieved:.*2:05 PM CST/);
      assert.equal(board.querySelector('input,select,button,img'), null, 'no style controls or provider logo');
    } finally { await f.cleanup(); }
  }
});

test('one failed board remains unknown without erasing its successful sibling; empty arrays are not a no-flight claim', async () => {
  const data = payload();
  data.boards.arrivals = { status:'unavailable',sourceUrl:'https://www.avionio.com/en/airport/cmi/arrivals',flights:[],explicitEmpty:false,error:'Source unavailable' };
  const f = fixture({fetch:async()=>Response.json(data)});
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    assert.equal(f.api.getState().boardStatus, 'partial');
    assert.equal(f.api.getState().arrivals.status, 'unavailable'); assert.equal(f.api.getState().departures.status, 'live');
    assert.equal(rows(f,'arrivals').length,0); assert.equal(rows(f,'departures').length,1);
    assert.match(f.details.querySelector('[data-willard-arrivals]').textContent,/Flight data unavailable/);
    assert.doesNotMatch(f.details.querySelector('[data-willard-arrivals]').textContent,/No flights|0 flights/i);
  } finally { await f.cleanup(); }
  for (const explicitEmpty of [false,true]) {
    const data = payload(); data.boards.arrivals.flights=[]; data.boards.arrivals.explicitEmpty=explicitEmpty;
    const g = fixture({fetch:async()=>Response.json(data)});
    try {
      g.api.setActive(true); g.disclose(true); await g.settle();
      assert.equal(g.api.getState().arrivals.status,explicitEmpty?'live':'unavailable');
      assert.equal(g.details.querySelector('[data-willard-arrivals] tbody td').textContent,explicitEmpty?'No flights listed by source':'Flight data unavailable');
    } finally { await g.cleanup(); }
  }
});

test('RAM cache survives quick reopen, expires after60seconds, and display clocks never poll flight data', async () => {
  const f = fixture();
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    f.advance(30*MINUTE); await f.settle();
    assert.equal(f.flightCalls.length,1,'even a long visible session has no flight polling');
    f.disclose(false); f.disclose(true); await f.settle();
    assert.equal(f.flightCalls.length,2,'reopening after expiry checks once');
    f.disclose(false); f.advance(59000); f.disclose(true); await f.settle();
    assert.equal(f.flightCalls.length,2,'cache younger than60s is reused');
    f.disclose(false); f.advance(1001); f.disclose(true); await f.settle();
    assert.equal(f.flightCalls.length,3);
    assert.equal(f.api.getState().flightRequests,3); assert.equal(f.api.getState().notifications,0);
  } finally { await f.cleanup(); }
});

test('failed refresh retains prior rows as last known and unverified with original retrieval time', async () => {
  const f = fixture({fetch:async(_call,count)=>count===1?Response.json(payload()):new Response('Unavailable',{status:503})});
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    const source = f.details.querySelector('.wa-source').textContent;
    f.disclose(false); f.advance(MINUTE+1); f.disclose(true); await f.settle();
    assert.equal(rows(f,'arrivals').length,3); assert.equal(rows(f,'departures').length,1);
    assert.equal(f.api.getState().boardStatus,'stale');
    assert.equal(f.api.getState().arrivals.status,'stale');
    assert.equal(f.details.querySelector('[data-willard-arrivals] .wa-board-status').textContent,'Last known · unverified');
    assert.equal(f.details.querySelector('.wa-source').textContent,source);
    assert.match(f.api.getState().arrivals.error,/HTTP 503/);
  } finally { await f.cleanup(); }
});

test('crossing Central midnight invalidates a younger-than60second cache without a background check', async () => {
  const f = fixture({ now: Date.parse('2026-11-21T05:59:40Z') });
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    f.disclose(false); f.advance(30000); await f.settle();
    assert.equal(f.flightCalls.length,1,'crossing midnight while closed does not poll');
    f.disclose(true); await f.settle();
    assert.equal(f.flightCalls.length,2,'the new Central calendar day invalidates the old board');
  } finally { await f.cleanup(); }
});

test('pending requests dedupe and abort on collapse, hide, inactive Weather, removal and destroy; late results are ignored', async () => {
  for (const stop of ['collapse','hidden','inactive','remove','destroy']) {
    let resolve;
    const f = fixture({fetch:()=>new Promise(done=>{resolve=done;})});
    try {
      f.api.setActive(true); f.disclose(true); await f.settle();
      f.api.setActive(true); f.disclose(true); await f.settle();
      assert.equal(f.flightCalls.length,1); assert.equal(f.api.getState().flightPending,true);
      const tracker=f.trackers[0];
      if(stop==='collapse')f.disclose(false);
      if(stop==='hidden')f.visibility(true);
      if(stop==='inactive')f.api.setActive(false);
      if(stop==='remove')f.details.remove();
      if(stop==='destroy')f.api.destroy();
      await f.settle();
      assert.equal(f.flightCalls[0].init.signal.aborted,true,stop+' must abort');
      assert.equal(tracker.state.active,false); assert.equal(f.timers.size,0);
      assert.equal(tracker.destroyCalls,stop==='destroy'?1:0,'only airport destruction destroys the retained tracker');
      resolve(Response.json(payload())); await f.settle();
      assert.equal(rows(f,'arrivals').length,0,'late data must not render after '+stop);
      assert.equal(f.api.getState().arrivals?.status==='live',false);
    } finally { await f.cleanup(); }
  }
});

test('shared page request and cache serve multiple native consumers without aborting the remaining visible board', async () => {
  let resolve;
  const f = fixture({fetch:()=>new Promise(done=>{resolve=done;})});
  let second;
  try {
    const detail=f.window.document.createElement('details');f.window.document.body.append(detail);
    second=f.window.cmpriWillardAirport.create(detail,{use24HourTime:false});
    f.api.setActive(true);f.disclose(true);
    second.setActive(true);detail.open=true;detail.dispatchEvent(new f.window.Event('toggle'));await f.settle();
    assert.equal(f.flightCalls.length,1);
    f.disclose(false);assert.equal(f.flightCalls[0].init.signal.aborted,false,'the other active consumer still needs the shared result');
    resolve(Response.json(payload()));await f.settle();
    assert.equal(second.getState().boardStatus,'live');
    assert.equal(detail.querySelector('.wa-flight-time').textContent,'12:05 AM');
    second.setActive(false);f.disclose(true);await f.settle();assert.equal(f.flightCalls.length,1,'shared RAM result is reused');
  } finally { second?.destroy();await f.cleanup(); }
});

test('unavailable or unverified responses remain unknown and all provider text is rendered safely', async () => {
  for (const response of [new Response('error',{status:502}),Response.json({airport:'OTHER',boards:{}})]) {
    const f=fixture({fetch:async()=>response});
    try {f.api.setActive(true);f.disclose(true);await f.settle();assert.equal(f.api.getState().boardStatus,'unavailable');assert.equal(rows(f,'arrivals').length,0);}
    finally {await f.cleanup();}
  }
  const data=payload();data.boards.arrivals.flights[0].location='<img src=x onerror=alert(1)>';
  data.boards.arrivals.sourceUrl='javascript:alert(1)';
  const f=fixture({fetch:async()=>Response.json(data)});
  try {
    f.api.setActive(true);f.disclose(true);await f.settle();
    assert.equal(f.details.querySelector('img'),null);assert.match(rows(f,'arrivals')[0].textContent,/<img src=x/);
    assert.equal(f.details.querySelector('.wa-source a').href,'https://www.avionio.com/en/airport/cmi/arrivals');
  } finally {await f.cleanup();}
});

test('the Central clock follows role preference and the native tracker deactivates on page hide', async () => {
  for (const chief of [true,false]) {
    const f=fixture({chief});
    try {
      f.api.setActive(true);f.disclose(true);await f.settle();
      assert.equal(f.frame(),null);assert.equal(f.trackers.length,1);
      assert.equal(f.api.getState().trackerState.active,true);
      assert.equal(f.trackers[0].options.clockMode,chief?'24':'12');
      const clock=f.details.querySelector('[data-willard-clock]');
      assert.equal(clock.textContent,chief?'14:05 CST':'2:05 PM CST');
      f.advance(MINUTE+50);assert.equal(clock.textContent,chief?'14:06 CST':'2:06 PM CST');
      f.window.dispatchEvent(new f.window.Event('pagehide'));
      assert.equal(f.frame(),null);assert.equal(f.timers.size,0);assert.equal(f.api.getState().active,false);
      assert.equal(f.api.getState().trackerActive,false);assert.equal(f.trackers[0].destroyCalls,0);
    } finally {await f.cleanup();}
  }
  for(const asset of [source,styles]) {
    assert.match(asset,/Copyright \(c\) 2026 P-M Nilsson/);
    assert.match(asset,/Permission is hereby granted, free of charge/);
    assert.match(asset,/The above copyright notice and this permission notice shall be included/);
    assert.match(asset,/THE SOFTWARE IS PROVIDED "AS IS"/);
  }
});

test('visible boards age at the retrieval deadline without polling or discarding rows', async () => {
  const f = fixture({ fetch: async () => {
    const value = payload();
    for (const board of Object.values(value.boards)) board.retrievedAt = new Date(START - 20000).toISOString();
    return Response.json(value);
  } });
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    const retrieved = f.details.querySelector('.wa-source').textContent;
    assert.equal(f.api.getState().boardStatus, 'live');
    f.advance(39999); assert.equal(f.api.getState().boardStatus, 'live');
    f.advance(1); assert.equal(f.api.getState().boardStatus, 'stale');
    assert.equal(rows(f, 'arrivals').length, 3);
    assert.equal(f.details.querySelector('.wa-source').textContent, retrieved);
    assert.match(f.details.querySelector('[data-willard-arrivals] .wa-board-status').title, /one minute/);
    f.advance(10 * MINUTE);
    assert.equal(f.flightCalls.length, 1, 'aging is local display work, never flight polling');
    assert.equal(f.api.getState().backgroundPolling, false);
  } finally { await f.cleanup(); }
});

test('an open board becomes unverified across Central midnight without a request', async () => {
  const night = Date.parse('2026-11-21T05:59:40Z');
  const f = fixture({ now: night, fetch: async () => {
    const value = payload();
    for (const board of Object.values(value.boards)) board.retrievedAt = new Date(night).toISOString();
    return Response.json(value);
  } });
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    assert.equal(f.api.getState().boardStatus, 'live');
    f.advance(20025);
    assert.equal(f.api.getState().boardStatus, 'stale');
    assert.match(f.details.querySelector('[data-willard-arrivals] .wa-board-status').title, /earlier Central date/);
    assert.equal(f.flightCalls.length, 1);
    assert.equal(rows(f, 'arrivals').length, 3);
  } finally { await f.cleanup(); }
});

test('reopening an aged board checks once and accepts newly retrieved data', async () => {
  const f = fixture({ fetch: async () => {
    const value = payload();
    for (const board of Object.values(value.boards)) board.retrievedAt = new f.window.Date().toISOString();
    return Response.json(value);
  } });
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    f.advance(MINUTE); assert.equal(f.api.getState().boardStatus, 'stale');
    f.disclose(false); f.disclose(true); await f.settle();
    assert.equal(f.flightCalls.length, 2);
    assert.equal(f.api.getState().boardStatus, 'live');
    f.advance(MINUTE); assert.equal(f.api.getState().boardStatus, 'stale');
    assert.equal(f.flightCalls.length, 2);
  } finally { await f.cleanup(); }
});

test('unverifiable retrieval time cannot keep flight rows labeled live', async () => {
  const f = fixture({ fetch: async () => {
    const value = payload();
    for (const board of Object.values(value.boards)) board.retrievedAt = null;
    return Response.json(value);
  } });
  try {
    f.api.setActive(true); f.disclose(true); await f.settle();
    assert.equal(f.api.getState().boardStatus, 'stale');
    assert.equal(rows(f, 'departures').length, 1);
    assert.match(f.details.querySelector('[data-willard-departures] .wa-board-status').title, /cannot be verified/);
    assert.equal(f.flightCalls.length, 1);
  } finally { await f.cleanup(); }
});
