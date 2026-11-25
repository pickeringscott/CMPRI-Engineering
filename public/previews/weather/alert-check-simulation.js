
/* Standalone review-only simulator. It has no network, persistence, timers,
   service workers, notification APIs, or references to a real database client. */
(function () {
  'use strict';
  window.initWeatherSimulation = function initWeatherSimulation() {
    if (window.weatherSim && window.weatherSim.initialized) return window.weatherSim;
    const byId = (id) => document.getElementById(id);
    const central = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hourCycle: new URLSearchParams(location.search).get('clock') === '24' ? 'h23' : 'h12', timeZoneName: 'short'
    });
    const stamp = (value) => window.cmpriWeatherClock?.format(value, { month: 'short', day: 'numeric', timeZoneName: 'short' }) || central.format(new Date(value));
    const MINUTE = 60000;
    const start = Math.floor(Date.now() / MINUTE) * MINUTE;
    let now, sequenceStep, requests, transactions, pushes, cache, delivered, log;
    let checks = [];
    function clone(value) { return JSON.parse(JSON.stringify(value)); }
    function write(id, value) { const node = byId(id); if (node) node.textContent = value; }
    function isActive(alert) { return alert.effective <= now && alert.expires > now; }
    function fingerprint(alert) {
      return JSON.stringify([alert.id, alert.event, alert.effective, alert.expires,
        alert.severity, alert.certainty, alert.urgency, alert.headline, alert.instruction]);
    }
    function activeAlerts() {
      return Array.from(cache.values()).filter((row) => row.active && isActive(row.alert)).map((row) => row.alert);
    }
    function rank(alert) {
      if (/Warning$/.test(alert.event)) return 3;
      if (/Watch$|Advisory$/.test(alert.event)) return 2;
      return 1;
    }
    function mode() {
      const highest = activeAlerts().reduce((value, alert) => Math.max(value, rank(alert)), 1);
      return highest === 3 ? { name: 'Warning', minutes: 1 } :
        highest === 2 ? { name: 'Watch / advisory', minutes: 2 } : { name: 'Clear', minutes: 5 };
    }
    function append(message) {
      log.unshift({ at: now, message });
      if (log.length > 24) log.length = 24;
    }
    function render() {
      const current = mode();
      write('simMode', current.name);
      write('simInterval', current.minutes + (current.minutes === 1 ? ' minute' : ' minutes'));
      write('simNext', stamp(now + current.minutes * MINUTE) + ' · virtual');
      write('simNws', String(requests));
      write('simDb', String(transactions));
      write('simPush', String(pushes));
      write('simStage', 'Clear → Watch → Warning → Clear · ' + (sequenceStep + 1) + ' of 4');
      const step = byId('simStep');
      if (step) {
        step.textContent = ['Advance to Watch', 'Advance to Warning', 'Advance to Clear', 'Sequence complete'][sequenceStep];
        step.disabled = sequenceStep === 3;
      }
      const change = byId('simChange');
      const cancel = byId('simCancel');
      const expire = byId('simExpire');
      if (change) change.disabled = !activeAlerts().length;
      if (cancel) cancel.disabled = !activeAlerts().length;
      if (expire) expire.disabled = !activeAlerts().length;
      const db = byId('simDb');
      if (db) db.title = 'Simulated transactions only. Each alert change stores state and any push outbox/dedup entry together. Unchanged results cause no writes.';
      const list = byId('simLog');
      if (list) {
        const fragment = document.createDocumentFragment();
        log.forEach((item) => {
          const row = document.createElement('li');
          const time = document.createElement('span');
          time.className = 'sim-log-time';
          time.textContent = stamp(item.at) + ' · ';
          row.append(time, document.createTextNode(item.message));
          fragment.append(row);
        });
        list.replaceChildren(fragment);
      }
      if (byId('simLog')) byId('simLog').setAttribute('aria-live', 'polite');
    }
    function alertTemplate(type) {
      return {
        id: type === 'watch' ? 'SIM-WATCH-001' : 'SIM-WARNING-001',
        event: type === 'watch' ? 'Severe Thunderstorm Watch' : 'Severe Thunderstorm Warning',
        effective: now, expires: now + (type === 'watch' ? 60 : 30) * MINUTE,
        severity: type === 'watch' ? 'Severe' : 'Extreme', certainty: 'Likely', urgency: 'Immediate',
        headline: 'SIMULATION — ' + (type === 'watch' ? 'Severe Thunderstorm Watch' : 'Severe Thunderstorm Warning'),
        instruction: 'SIMULATION ONLY. Example property alert; no NWS alert or push has been issued.'
      };
    }
    function notify(alert, version, action, changedThisCheck) {
      // One representative opted-in recipient. A real implementation would use
      // a unique alert/version/recipient delivery key inside the shared worker.
      const key = [alert.id, version, action, 'SIM-RECIPIENT-1'].join('|');
      if (delivered.has(key)) return false;
      delivered.add(key);
      pushes++;
      if (!changedThisCheck) transactions++; // A push now needs an outbox/dedup entry.
      return true;
    }
    function announceSample(alert, version, action) {
      // A DOM event joins two review simulations. It never invokes notification,
      // network, permission, persistence, or database APIs.
      document.dispatchEvent(new CustomEvent('cmpri:simulated-alert', { detail: {
        id: alert.id, event: alert.event, version, action,
        effective: alert.effective, expires: alert.expires, virtualNow: now,
        applies: true, simulated: true
      } }));
    }
    function tick(result, options) {
      options = options || {};
      const before = mode();
      const advance = options.advanceMinutes === undefined ? before.minutes : options.advanceMinutes;
      now += advance * MINUTE;
      requests++; // Exactly one property-wide simulated NWS alert request.
      const beforeDb = transactions;
      const beforePush = pushes;
      const changes = [];
      const incoming = new Map(result.map((alert) => [alert.id, clone(alert)]));
      incoming.forEach((alert, id) => {
        const old = cache.get(id);
        const version = fingerprint(alert);
        const active = isActive(alert);
        if (!active) {
          // A response may still contain an item at its expiration boundary.
          if (old && old.active) {
            old.active = false;
            old.transition = 'expired';
            transactions++;
            changes.push(alert.event + ' expired');
            notify(old.alert, old.fingerprint, 'expired', true);
            announceSample(old.alert, old.fingerprint, 'expired');
          }
          return;
        }
        const changed = !old || !old.active || old.fingerprint !== version;
        if (changed) {
          transactions++;
          changes.push(alert.event + (!old ? ' new' : ' materially changed'));
          announceSample(alert, version, 'active');
        }
        cache.set(id, { alert, active: true, fingerprint: version, transition: 'active' });
        notify(alert, version, 'active', changed);
      });
      cache.forEach((row, id) => {
        if (!row.active || incoming.has(id)) return;
        const action = row.alert.expires <= now ? 'expired' : 'canceled';
        row.active = false;
        row.transition = action;
        transactions++;
        changes.push(row.alert.event + ' ' + action);
        notify(row.alert, row.fingerprint, action, true);
        announceSample(row.alert, row.fingerprint, action);
      });
      const current = mode();
      const deltaDb = transactions - beforeDb;
      const deltaPush = pushes - beforePush;
      const message = (options.reason ? options.reason + ': ' : '') +
        (changes.length ? changes.join('; ') : 'cached comparison unchanged') +
        '. +1 simulated NWS request; +' + deltaDb + ' simulated DB transaction' + (deltaDb === 1 ? '' : 's') +
        '; +' + deltaPush + ' simulated in-app notification' + (deltaPush === 1 ? '' : 's') +
        '. Shared interval ' + current.minutes + ' min.';
      append(message);
      checks.push({ now, request: requests, changes: clone(changes), db: deltaDb, push: deltaPush, mode: current.name, minutes: current.minutes });
      render();
      return snapshot();
    }
    function step() {
      if (sequenceStep === 3) return snapshot();
      const result = activeAlerts().map(clone);
      sequenceStep++;
      if (sequenceStep === 1) {
        const watch = alertTemplate('watch');
        // Creation represents the response received at the next scheduled check.
        watch.effective = now + mode().minutes * MINUTE;
        return tick([watch], { reason: 'Sequence · Watch' });
      }
      if (sequenceStep === 2) {
        const warning = alertTemplate('warning');
        warning.effective = now + mode().minutes * MINUTE;
        return tick(result.filter((alert) => alert.id !== warning.id).concat(warning), { reason: 'Sequence · Warning (watch retained)' });
      }
      return tick([], { reason: 'Sequence · Clear (alerts canceled)' });
    }
    function unchanged() {
      return tick(activeAlerts().map(clone), { reason: 'Repeat identical cached result' });
    }
    function change() {
      const alerts = activeAlerts().map(clone).sort((a, b) => rank(b) - rank(a));
      if (!alerts.length) return snapshot();
      alerts[0].expires += 15 * MINUTE;
      alerts[0].instruction += ' Updated simulated expiry and instructions.';
      return tick(alerts, { reason: 'Material bulletin update' });
    }
    function cancel() {
      const alerts = activeAlerts().map(clone).sort((a, b) => rank(b) - rank(a));
      if (!alerts.length) return snapshot();
      const canceled = alerts.shift();
      return tick(alerts, { reason: 'Cancel most urgent · ' + canceled.event });
    }
    function expire() {
      const alerts = activeAlerts().map(clone).sort((a, b) => rank(b) - rank(a));
      if (!alerts.length) return snapshot();
      const highest = alerts[0];
      const advance = Math.max(0, (highest.expires - now) / MINUTE);
      return tick(alerts, { advanceMinutes: advance, reason: 'Jump virtual clock to most urgent expiry' });
    }
    function snapshot() {
      return {
        now, sequenceStep, requests, transactions, pushes, messages: pushes, mode: clone(mode()),
        nextCheck: now + mode().minutes * MINUTE,
        alerts: activeAlerts().map(clone), cache: Array.from(cache.values()).map(clone),
        deliveredKeys: Array.from(delivered), checks: clone(checks), log: clone(log)
      };
    }
    function reset() {
      document.dispatchEvent(new CustomEvent('cmpri:simulated-alert-reset'));
      now = start; sequenceStep = 0; requests = 0; transactions = 0; pushes = 0;
      cache = new Map(); delivered = new Set(); log = []; checks = [];
      append('SIMULATION baseline: no active alerts in the sample. One shared property check every 5 minutes. No timer is running.');
      render();
      return snapshot();
    }
    const actions = { simStep: step, simUnchanged: unchanged, simChange: change,
      simCancel: cancel, simExpire: expire, simReset: reset };
    Object.entries(actions).forEach(([id, action]) => { if (byId(id)) byId(id).addEventListener('click', action); });
    window.weatherSim = { initialized: true, step, unchanged, change, cancel, expire, reset, snapshot };
    reset();
    window.cmpriTimeFormat?.subscribe(render);
    return window.weatherSim;
  };
}());
