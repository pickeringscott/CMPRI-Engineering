/* Review-only notification and Guest Safety interactions. No real delivery,
   permission requests, persistence, database calls, network calls or timers. */
(function () {
  'use strict';
  window.initNotificationPreview = function initNotificationPreview() {
    if (window.notificationPreview && window.notificationPreview.initialized) return window.notificationPreview;
    const host = document.getElementById('notificationPreviewHost');
    if (!host) return null;
    const byId = (id) => document.getElementById(id);
    const MINUTE = 60000;
    const baseTime = Math.floor(Date.now() / MINUTE) * MINUTE;
    const central = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const instructions = {
      tornado: 'Staff and guests go to the first-floor interior hallways, away from windows and exterior doors.',
      severe: 'Staff and guests stay indoors and away from windows.',
      freeze: 'Check guest walkways for ice. Ice melt is in the boiler room. Available staff, including front desk and housemen, can treat sidewalks as needed.',
      other: 'Review the official NWS bulletin and follow the property’s emergency procedures. Share the applicable instructions with staff and guests.'
    };
    const warningEvents = new Set(['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning',
      'Winter Storm Warning', 'Ice Storm Warning', 'Blizzard Warning', 'Snow Squall Warning']);
    let inbox = [], regularKeys = new Set(), safetyKeys = new Set(),
      safetyOpens = 0, materialUpdateSequence = 0, lastSample = null, activeSafety = null, priorFocus = null;
    const sampleDefinitions = [
      ['tornado-warning', 'Tornado Warning', 'official'],
      ['severe-warning', 'Severe Thunderstorm Warning', 'official'],
      ['flash-flood-warning', 'Flash Flood Warning', 'official'],
      ['tornado-watch', 'Tornado Watch', 'official'],
      ['severe-watch', 'Severe Thunderstorm Watch', 'official'],
      ['winter-advisory', 'Winter Weather Advisory', 'official'],
      ['winter-watch', 'Winter Storm Watch', 'official'],
      ['winter-storm-warning', 'Winter Storm Warning', 'official'],
      ['ice-storm-warning', 'Ice Storm Warning', 'official'],
      ['blizzard-warning', 'Blizzard Warning', 'official'],
      ['snow-squall-warning', 'Snow Squall Warning', 'official'],
      ['freeze-agriculture', 'Freeze Warning · agricultural product', 'official'],
      ['snow24', 'Snow expected · 24-hour heads-up', 'forecast', 'snow', 24],
      ['snow12', 'Snow expected · 12-hour heads-up', 'forecast', 'snow', 12],
      ['freezing24', 'Freezing rain expected · 24-hour heads-up', 'forecast', 'freezing rain', 24],
      ['freezing12', 'Freezing rain expected · 12-hour heads-up', 'forecast', 'freezing rain', 12],
      ['storms24', 'Severe storms possible · 24-hour heads-up', 'forecast', 'severe storms', 24],
      ['storms12', 'Severe storms possible · 12-hour heads-up', 'forecast', 'severe storms', 12],
      ['heat24', 'Dangerous heat expected · 24-hour heads-up', 'forecast', 'dangerous heat', 24],
      ['heat12', 'Dangerous heat expected · 12-hour heads-up', 'forecast', 'dangerous heat', 12],
      ['wind24', 'Strong wind expected · 24-hour heads-up', 'forecast', 'strong wind', 24],
      ['wind12', 'Strong wind expected · 12-hour heads-up', 'forecast', 'strong wind', 12],
      ['freeze-risk', 'Forecast walkway icing risk · Guest Safety', 'forecast', 'walkway icing', 4],
      ['stale-forecast', 'Stale forecast · suppress heads-up', 'forecast', 'snow', 12],
      ['missing-forecast', 'Missing forecast · suppress heads-up', 'forecast', 'freezing rain', 12],
      ['outside-property', 'Warning outside property · suppress', 'official'],
      ['expired-warning', 'Expired warning · suppress', 'official']
    ];
    host.innerHTML = `
      <div class="np-intro row between">
        <div><h2>Proposed notification settings</h2><p class="muted small">Review simulations for Residence Inn Champaign. Changes stay in this page.</p></div>
        <span class="badge">SIMULATION ONLY</span>
      </div>
      <div class="np-layout">
        <section class="panel np-settings" aria-labelledby="npSettingsTitle">
          <h3 id="npSettingsTitle">Notify me about</h3>
          <label class="np-check"><input id="npOfficial" type="checkbox" checked><span><strong>Official watches, warnings, and advisories</strong><small>Year-round NWS alerts that apply to the property, including applicable county or forecast-zone alerts without polygons.</small></span></label>
          <p class="np-event-list">Tornado • Severe Thunderstorm • Flash Flood • Winter Weather Advisory • Winter Storm Watch • Winter Storm Warning • Ice Storm Warning • Blizzard Warning • Snow Squall Warning</p>
          <label class="np-check"><input id="npWeatherPrep" type="checkbox"><span><strong>Weather Prep · 24-hour and 12-hour heads-ups</strong><small>Opt in to year-round preparation messages for forecast-supported snow, freezing rain, severe storms, dangerous heat, or strong wind. Each lead-time message has its own deduplication key.</small></span></label>
          <label class="np-check"><input id="npWinterPrep" type="checkbox"><span><strong>Winter Prep · within 12 hours</strong><small>Separate opt-in for forecast snow or freezing rain expected within 12 hours, even without an NWS advisory. Overlap with Weather Prep creates one message.</small></span></label>
          <label class="np-check"><input id="npGuestSafety" type="checkbox" checked><span><strong>Guest Safety auto-open</strong><small>Proposed in-app safety dialog for a fresh, applicable warning or forecast walkway icing risk. This control is separate from regular notifications. Watches, advisories, and preparation heads-ups do not auto-open it.</small></span></label>
          <label class="np-check"><input id="simPushEnabled" type="checkbox" checked><span><strong>Phone notifications · simulate delivery</strong><small>Used only by the Shared check demonstration. No notification permission is requested and no push is sent.</small></span></label>
          <div class="np-delivery"><label for="npDelivery">Notification delivery</label><select id="npDelivery"><option value="in_app">In-app notifications</option><option value="email">Email notifications</option><option value="both">Both</option></select></div>
          <p class="np-note">All delivery choices are samples. No settings are saved. Missing, stale, expired, canceled, or inapplicable data cannot produce a preparation or safety message.</p>
          <p class="np-note">Weather Prep requires an explicit supported forecast signal. A generic thunderstorm forecast does not establish a severe-storm risk. Unknown snow or ice amounts stay unavailable.</p>
        </section>
        <section class="panel np-demo" aria-labelledby="npDemoTitle">
          <div class="row between"><h3 id="npDemoTitle">Sample messages</h3><span class="badge neutral">No real delivery</span></div>
          <label class="np-select-label" for="npScenario">Choose a simulated event</label>
          <select id="npScenario" class="np-scenario"></select>
          <div class="np-actions"><button id="npReceive" class="primary" type="button">Receive sample</button><button id="npRepeat" type="button">Repeat unchanged</button><button id="npUpdated" type="button">Receive material update</button><button id="npReset" type="button">Reset demo</button></div>
          <p id="npResult" class="np-result" role="status">Choose a sample. No simulated notification has been received.</p>
          <article class="np-message" aria-labelledby="npMessageTitle">
            <span class="np-app-name">CMPRI ENGINEERING · SIMULATED MESSAGE</span>
            <h3 id="npMessageTitle">Ready for review</h3><p id="npMessageBody">Use the sample controls to review official-alert messages, forecast heads-ups, and Guest Safety behavior.</p>
            <dl class="np-times"><div><dt>Effective / expected</dt><dd id="npEffective">Not received</dd></div><div><dt>Expires</dt><dd id="npExpires">Not received</dd></div></dl>
            <p id="npMessageSource" class="np-note">No current weather condition is represented by these examples.</p>
          </article>
          <div class="np-demo-counts"><span>Regular samples <strong id="npRegularCount">0</strong></span><span>Safety auto-opens <strong id="npSafetyCount">0</strong></span></div>
          <details class="np-inbox"><summary>Simulated notification history</summary><ol id="npInbox"><li>No samples received.</li></ol></details>
          <p class="np-note">Forecast heads-ups and official watches use regular notifications. Guest Safety auto-open is a separate proposed in-app behavior. Repeating the same event/version/recipient does not create duplicate messages or reopen a dismissed safety dialog.</p>
        </section>
      </div>`;
    const scenario = byId('npScenario');
    sampleDefinitions.forEach(([key, title, source]) => {
      const option = document.createElement('option'); option.value = key;
      option.textContent = (source === 'official' ? 'Official alert sample · ' : 'Forecast sample · ') + title;
      scenario.append(option);
    });
    const safetyContainer = byId('guestSafetyHost') || document.body;
    const dialog = document.createElement('dialog');
    dialog.id = 'guestSafetyDialog'; dialog.className = 'np-safety-dialog';
    dialog.setAttribute('aria-labelledby', 'npSafetyTitle');
    dialog.setAttribute('aria-describedby', 'npSafetyDisclaimer npSafetyInstruction');
    dialog.innerHTML = `<div class="np-safety-top"><span class="badge warning">SIMULATED GUEST SAFETY</span><button id="npSafetyClose" class="np-safety-close" type="button" aria-label="Close Guest Safety">×</button></div>
      <h2 id="npSafetyTitle">Guest Safety</h2><p id="npSafetyDisclaimer" class="np-safety-disclaimer">Review only · this is a simulated event, not a current NWS warning.</p>
      <p id="npSafetyEvent" class="np-safety-event"></p><p id="npSafetyInstruction" class="np-safety-instruction"></p>
      <dl class="np-times"><div><dt>Effective / expected</dt><dd id="npSafetyEffective"></dd></div><div><dt>Expires</dt><dd id="npSafetyExpires"></dd></div></dl>
      <p id="npSafetySource" class="np-note"></p><button id="npSafetyAcknowledge" class="primary np-safety-ack" type="button">Acknowledge sample</button>`;
    safetyContainer.append(dialog);
    const summary = byId('guestSafetySummary');
    if (summary) {
      summary.classList.add('np-safety-summary');
      const status = document.createElement('span'); status.id = 'npSafetySummaryText';
      status.textContent = 'Guest Safety · no simulated warning received';
      const test = document.createElement('button'); test.id = 'npTestGuestSafety'; test.type = 'button';
      test.textContent = 'Test Guest Safety';
      test.addEventListener('click', () => receive(sample('tornado-warning')));
      summary.replaceChildren(status, test);
    }
    function checked(id) { return Boolean(byId(id) && byId(id).checked); }
    function text(id, value) { if (byId(id)) byId(id).textContent = value; }
    function stamp(time) { return Number.isFinite(time) ? central.format(new Date(time)) : 'Unavailable'; }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function sample(key) {
      const definition = sampleDefinitions.find((item) => item[0] === key);
      if (!definition) throw new Error('Unknown simulated weather scenario: ' + key);
      const [, title, source, hazard, leadHours] = definition;
      const isForecast = source === 'forecast';
      const event = key === 'outside-property' || key === 'expired-warning' ? 'Tornado Warning' :
        key === 'freeze-agriculture' ? 'Freeze Warning' : isForecast ? 'Weather Prep: ' + hazard : title;
      const value = {
        id: 'SIM-NP-' + key, event, version: '1', source, simulated: true,
        applies: key !== 'outside-property', freshness: key === 'stale-forecast' ? 'stale' : key === 'missing-forecast' ? 'missing' : 'fresh',
        sourceTimestamp: baseTime - (key === 'stale-forecast' ? 6 * 60 * MINUTE : 5 * MINUTE),
        virtualNow: baseTime, effective: baseTime - MINUTE,
        expected: isForecast ? baseTime + leadHours * 60 * MINUTE : baseTime - MINUTE,
        expires: key === 'expired-warning' ? baseTime - MINUTE : baseTime + (isForecast ? (leadHours + 3) * 60 : 60) * MINUTE,
        action: 'active', hazard: hazard || null, leadHours: leadHours || null,
        forecastSupported: isForecast && key !== 'missing-forecast',
        walkwayIceRisk: key === 'freeze-risk',
        agricultural: key === 'freeze-agriculture'
      };
      value.headline = isForecast ? (key === 'freeze-risk' ? 'Forecast walkway icing risk · within 4 hours' :
        'Weather Prep · ' + hazard + ' · within ' + leadHours + ' hours') : event;
      if (key === 'freeze-risk') value.message = 'Forecast sample: wet walkways with temperatures at or below freezing may create an ice risk. This is a property preparation condition, not an agricultural NWS Freeze Warning.';
      else if (isForecast) value.message = 'Forecast sample: ' + hazard + ' expected within ' + leadHours +
        ' hours. Prepare staff and review the current forecast. No official NWS advisory is required for this opted-in heads-up. Snow and ice amounts are unavailable in this sample.';
      else value.message = 'Official-alert sample: ' + event + ' applies to Residence Inn Champaign. ' +
        (/Watch$|Advisory$/.test(event) ? 'Review the bulletin and prepare staff. This message does not auto-open Guest Safety.' :
          value.agricultural ? 'This agricultural freeze product does not establish ice on guest walkways.' : safetyInstruction(value));
      return value;
    }
    function safetyInstruction(value) {
      if (value.walkwayIceRisk) return instructions.freeze;
      if (value.event === 'Tornado Warning') return instructions.tornado;
      if (value.event === 'Severe Thunderstorm Warning') return instructions.severe;
      return instructions.other;
    }
    function versionKey(value) {
      return [value.id, value.version || '1', value.leadHours || '', 'SIM-RECIPIENT-1'].join('|');
    }
    function freshnessProblem(value, now) {
      if (value.freshness === 'missing' || value.source === 'forecast' && !value.forecastSupported) return 'missing or unsupported forecast';
      if (value.freshness === 'stale') return 'stale forecast or alert data';
      if (!Number.isFinite(value.sourceTimestamp)) return 'unknown source freshness';
      const maxAge = value.source === 'forecast' ? 3 * 60 * MINUTE : 10 * MINUTE;
      if (now - value.sourceTimestamp > maxAge || value.sourceTimestamp > now + MINUTE) return 'stale or invalid source timestamp';
      return '';
    }
    function renderHistory() {
      const list = byId('npInbox'); list.replaceChildren();
      if (!inbox.length) { const item = document.createElement('li'); item.textContent = 'No samples received.'; list.append(item); }
      inbox.slice(-8).reverse().forEach((entry) => {
        const item = document.createElement('li');
        item.textContent = stamp(entry.at) + ' · SIMULATION · ' + entry.headline + ' · ' + entry.delivery;
        list.append(item);
      });
      text('npRegularCount', String(inbox.length)); text('npSafetyCount', String(safetyOpens));
    }
    function showMessage(value) {
      text('npMessageTitle', 'SIMULATION · ' + (value.headline || value.event));
      text('npMessageBody', value.message || ('Official-alert sample: ' + value.event + '. ' + safetyInstruction(value)));
      text('npEffective', stamp(value.source === 'forecast' ? value.expected : value.effective));
      text('npExpires', stamp(value.expires));
      text('npMessageSource', value.source === 'forecast' ? 'FORECAST SAMPLE · no observation or official alert is implied. All times are Central.' :
        'OFFICIAL-ALERT FORMAT SAMPLE · not an issued NWS bulletin. All times are Central.');
    }
    function closeSafety() {
      if (dialog.open) dialog.close();
      activeSafety = null;
    }
    dialog.addEventListener('close', () => {
      activeSafety = null;
      if (priorFocus && priorFocus.isConnected) priorFocus.focus({ preventScroll: true });
    });
    byId('npSafetyClose').addEventListener('click', closeSafety);
    byId('npSafetyAcknowledge').addEventListener('click', closeSafety);
    dialog.addEventListener('cancel', () => { activeSafety = null; });
    function openSafety(value, key) {
      text('npSafetyEvent', value.walkwayIceRisk ? 'Forecast walkway icing risk' : value.event);
      text('npSafetyInstruction', safetyInstruction(value));
      text('npSafetyEffective', stamp(value.source === 'forecast' ? value.expected : value.effective));
      text('npSafetyExpires', stamp(value.expires));
      text('npSafetySource', value.walkwayIceRisk ?
        'FORECAST SAMPLE · simulated wet-walkway icing condition. This is separate from an agricultural NWS Freeze Warning.' :
        'OFFICIAL-ALERT FORMAT SAMPLE · property applicability and bulletin freshness are simulated. No real warning has been received.');
      activeSafety = { id: value.id, key };
      if (!dialog.open) { priorFocus = document.activeElement; dialog.showModal(); }
      safetyOpens++; safetyKeys.add(key);
      text('npSafetySummaryText', 'Guest Safety · simulated ' + (value.walkwayIceRisk ? 'walkway icing risk' : value.event));
    }
    function receive(input) {
      const value = copy(input);
      value.simulated = true; // This API is exclusively a review simulation.
      const now = Number.isFinite(value.virtualNow) ? value.virtualNow : Date.now();
      const key = versionKey(value);
      lastSample = value; showMessage(value);
      const result = { regular: false, safety: false, suppressed: '', duplicate: false };
      if (value.action === 'canceled' || value.action === 'expired') {
        if (activeSafety && activeSafety.id === value.id) closeSafety();
        result.suppressed = 'alert ' + value.action;
        text('npSafetySummaryText', 'Guest Safety · simulated alert ' + value.action);
      } else if (value.applies !== true) result.suppressed = 'outside the property or applicability unverified';
      else if (!Number.isFinite(value.expires) || value.expires <= now) result.suppressed = 'expired or unknown expiration';
      else if (value.source === 'official' && (!Number.isFinite(value.effective) || value.effective > now)) result.suppressed = 'alert not yet effective';
      else result.suppressed = freshnessProblem(value, now);
      if (!result.suppressed) {
        const winter = value.source === 'forecast' && ['snow', 'freezing rain'].includes(value.hazard) && value.leadHours > 0 && value.leadHours <= 12;
        const prep = value.source === 'forecast' && !value.walkwayIceRisk && [12, 24].includes(value.leadHours);
        const wantsRegular = value.source === 'official' ? checked('npOfficial') :
          value.walkwayIceRisk ? checked('npWeatherPrep') || checked('npWinterPrep') : prep && checked('npWeatherPrep') || winter && checked('npWinterPrep');
        if (wantsRegular && !regularKeys.has(key)) {
          inbox.push({ key, at: now, headline: value.headline || value.event, delivery: byId('npDelivery').selectedOptions[0].textContent });
          regularKeys.add(key); result.regular = true;
        }
        const isSafety = value.source === 'official' && warningEvents.has(value.event) || value.source === 'forecast' && value.walkwayIceRisk === true;
        if (isSafety && checked('npGuestSafety') && !safetyKeys.has(key)) { openSafety(value, key); result.safety = true; }
        result.duplicate = !result.regular && !result.safety && (regularKeys.has(key) || safetyKeys.has(key));
        if (!result.regular && !result.safety && !result.duplicate) result.suppressed = 'applicable simulated setting is off';
      }
      text('npResult', result.suppressed ? 'SIMULATION · suppressed: ' + result.suppressed + '. No delivery or safety auto-open.' :
        result.duplicate ? 'SIMULATION · unchanged event/version/recipient: no duplicate message or safety auto-open.' :
          'SIMULATION · ' + [result.regular ? 'regular sample added' : '', result.safety ? 'Guest Safety opened' : ''].filter(Boolean).join('; ') + '. No push was sent.');
      renderHistory();
      return result;
    }
    function snapshot() { return { inbox: copy(inbox), safetyOpens, safetyKeys: Array.from(safetyKeys), regularKeys: Array.from(regularKeys), activeSafety: copy(activeSafety), lastSample: copy(lastSample) }; }
    function reset() {
      closeSafety(); inbox = []; regularKeys.clear(); safetyKeys.clear(); safetyOpens = 0; lastSample = null;
      text('npResult', 'Simulation reset. Choose a sample; no messages have been delivered.');
      text('npMessageTitle', 'Ready for review'); text('npMessageBody', 'Use the sample controls to review official-alert messages, forecast heads-ups, and Guest Safety behavior.');
      text('npEffective', 'Not received'); text('npExpires', 'Not received');
      text('npMessageSource', 'No current weather condition is represented by these examples.');
      text('npSafetySummaryText', 'Guest Safety · no simulated warning received'); renderHistory(); return snapshot();
    }
    byId('npReceive').addEventListener('click', () => receive(sample(scenario.value)));
    byId('npRepeat').addEventListener('click', () => receive(lastSample || sample(scenario.value)));
    byId('npUpdated').addEventListener('click', () => {
      const value = lastSample ? copy(lastSample) : sample(scenario.value);
      // NWS/shared-check versions may be opaque fingerprints. Keep their value
      // intact and issue a distinct review version for each material update.
      value.previewBaseVersion = value.previewBaseVersion || String(value.version ?? '1');
      value.version = value.previewBaseVersion + ':preview-update:' + (++materialUpdateSequence);
      value.expires += 15 * MINUTE;
      value.headline = (value.headline || value.event) + ' · material update'; receive(value);
    });
    byId('npReset').addEventListener('click', reset);
    document.addEventListener('cmpri:simulated-alert', (event) => {
      const value = event.detail || {};
      receive({ ...value, source: 'official', simulated: true, applies: true,
        freshness: 'fresh', sourceTimestamp: value.virtualNow || baseTime,
        headline: value.event, message: 'Shared-check official-alert sample: ' + value.event + '. ' + safetyInstruction(value) });
    });
    window.notificationPreview = { initialized: true, receive, sample, snapshot, reset, closeSafety };
    renderHistory(); return window.notificationPreview;
  };
}());
