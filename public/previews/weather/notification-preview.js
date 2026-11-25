/* Guest Safety for the Weather branch preview. Official alert responses are
 * foreground reads supplied by nws-live-view. No delivery permission, push,
 * persistence, database client, or background weather scheduler is used. */
(function () {
  'use strict';
  window.initNotificationPreview = function initNotificationPreview() {
    if (window.notificationPreview?.initialized) return window.notificationPreview;
    const host = document.getElementById('notificationPreviewHost');
    if (!host) return null;
    const $ = id => document.getElementById(id);
    const MINUTE = 60000;
    const baseTime = Math.floor(Date.now() / MINUTE) * MINUTE;
    const token = new URLSearchParams(location.search).get('modalToken');
    const embedded = window.parent !== window && Boolean(token);
    const central = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: new URLSearchParams(location.search).get('clock') === '24' ? 'h23' : 'h12', timeZoneName: 'short' });
    const instructions = {
      tornado: 'Staff and guests go immediately to the first-floor interior hallways, away from windows and exterior doors.',
      severe: 'Staff and guests stay indoors and away from windows.',
      flood: 'Monitor low spots and access routes. For a flash flood warning, move anyone threatened by rising water to higher ground and keep guests clear of flooded walkways and roads.',
      winterWatch: 'Check entrances and walkways and get ice melt ready.',
      winter: 'Check guest walkways for snow and ice. Share travel impacts with guests. Ice melt is in the boiler room. Available staff, including front desk and housemen, can treat sidewalks as needed.',
      freeze: 'Check guest walkways for ice. Ice melt is in the boiler room. Available staff can treat sidewalks as needed.',
      squall: 'Warn guests about sudden whiteouts and deteriorating roads. Advise delaying departures until the squall passes.',
      heat: 'Direct guests to air-conditioned areas and make drinking water available.',
      cold: 'Provide a warm indoor waiting area for guests and minimize time outdoors.',
      wind: 'Bring people indoors, keep guests clear of exposed entrances, and secure loose outdoor items before winds arrive if safe.',
      visibility: 'Notify departing guests of poor visibility. Advise delaying departures if a dust storm warning affects their route.'
    };
    let history = [], active = new Map(), versions = new Map(), delivered = new Set(), autoOpened = new Set();
    let simulationNow = baseTime, lastSample = null, activeSafety = null, safetyOpens = 0, updateSequence = 0;
    let expiryTimeout = null, priorFocus = null;
    let feed = { status: 'unavailable', checkedAt: null, source: null, error: 'Waiting for the official alert response.' };
    const definitions = [
      ['tornado-warning', 'Tornado Warning'], ['severe-warning', 'Severe Thunderstorm Warning'],
      ['flash-flood-warning', 'Flash Flood Warning'], ['flood-watch', 'Flood Watch'],
      ['tornado-watch', 'Tornado Watch'], ['severe-watch', 'Severe Thunderstorm Watch'],
      ['winter-advisory', 'Winter Weather Advisory'], ['winter-watch', 'Winter Storm Watch'],
      ['winter-storm-warning', 'Winter Storm Warning'], ['ice-storm-warning', 'Ice Storm Warning'],
      ['blizzard-warning', 'Blizzard Warning'], ['snow-squall-warning', 'Snow Squall Warning'],
      ['freeze-agriculture', 'Freeze Warning'], ['heat-warning', 'Extreme Heat Warning'],
      ['cold-warning', 'Extreme Cold Warning'], ['wind-warning', 'High Wind Warning'],
      ['fog-advisory', 'Dense Fog Advisory'], ['dust-warning', 'Dust Storm Warning'],
      ['other-advisory', 'Special Weather Statement'],
      ...['snow', 'freezing', 'storms', 'heat', 'wind'].flatMap(hazard => [24, 12].map(lead => [hazard + lead, 'Weather Prep', hazard, lead])),
      ['freeze-risk', 'Forecast walkway icing risk', 'walkway icing', 4],
      ['stale-forecast', 'Weather Prep', 'snow', 12], ['missing-forecast', 'Weather Prep', 'freezing rain', 12],
      ['outside-property', 'Tornado Warning'], ['expired-warning', 'Tornado Warning']
    ];
    host.innerHTML = `<div class="np-intro row between"><div><h2>Guest Safety notifications</h2><p class="muted small">All applicable official NWS alerts appear in-app. No email, phone, or push delivery.</p></div><span class="badge neutral">In-app only</span></div>
      <div class="np-actions"><button id="npClearNotifications" type="button">Clear notifications</button></div><p id="npClearStatus" class="np-note" role="status">Clears messages only. Active NWS alerts remain in the ticker until they end or are canceled.</p>
      <div class="np-layout"><section class="panel np-settings"><h3>Official alerts for the hotel</h3><p class="np-note">Every applicable official watch, warning, advisory, and statement is included, including county or zone alerts without polygons. Warnings open full-screen Guest Safety. Watches and other advisories remain standard in-app notifications. Each message includes the official summary and the hotel’s hazard-specific action.</p><div id="npOfficialStatus" class="np-result" role="status"></div><div id="npLiveInbox" class="np-live-inbox"></div>
      <h3 class="np-section-title">Forecast preparation examples</h3><span class="badge">Simulation settings</span><label class="np-check"><input id="npWeatherPrep" type="checkbox"><span><strong>Weather Prep · 24-hour and 12-hour heads-ups</strong><small>Simulation-only opt-in for supported snow, freezing rain, severe storms, heat, or strong wind. Heads-ups use standard in-app messages.</small></span></label><label class="np-check"><input id="npWinterPrep" type="checkbox"><span><strong>Winter Prep · within 12 hours</strong><small>Separate simulation-only opt-in for snow or freezing rain, even without an NWS advisory. Overlapping preparation settings create one message.</small></span></label><p class="np-note">The agreed forecast walkway-icing example opens full-screen Guest Safety and is clearly labeled as a simulation. It does not diagnose ice from an agricultural Freeze Warning. No new forecast-freeze algorithm is running.</p></section>
      <section class="panel np-demo"><div class="row between"><h3>Review simulated messages</h3><span class="badge">SIMULATION ONLY</span></div><label class="np-select-label" for="npScenario">Choose a simulated event</label><select id="npScenario" class="np-scenario"></select><div class="np-actions"><button id="npReceive" class="primary" type="button">Receive sample</button><button id="npRepeat" type="button">Repeat unchanged</button><button id="npUpdated" type="button">Receive material update</button><button id="npCancel" type="button">Cancel sample</button><button id="npExpire" type="button">Expire sample</button><button id="npReset" type="button">Reset samples</button></div><p id="npResult" class="np-result" role="status">Choose a sample. These controls do not issue official alerts.</p><article class="np-message"><span class="np-app-name">CMPRI ENGINEERING · SIMULATED MESSAGE</span><h3 id="npMessageTitle">Ready for review</h3><p id="npMessageBody">Warnings and the forecast freeze example open full-screen Guest Safety.</p><dl class="np-times"><div><dt>Effective / expected</dt><dd id="npEffective">Not received</dd></div><div><dt>Expires</dt><dd id="npExpires">Not received</dd></div></dl><p id="npMessageSource" class="np-note">No current weather condition is represented by these examples.</p></article><div class="np-demo-counts"><span>In-app messages <strong id="npRegularCount">0</strong></span><span>Safety auto-opens <strong id="npSafetyCount">0</strong></span></div><details class="np-inbox" open><summary>Guest Safety notification history</summary><ol id="npInbox"></ol></details><p class="np-note">Repeating an unchanged event does not create another notification or reopen dismissed details. Canceling or expiring an alert removes its ticker entry. Sample reset preserves official alerts.</p></section></div>`;
    definitions.forEach(([key, event, hazard, lead]) => { const option = document.createElement('option'); option.value = key; option.textContent = (hazard ? 'Forecast sample · ' + (hazard === 'freezing' ? 'freezing rain' : hazard) + (lead ? ' · ' + lead + 'h' : '') : 'Official-alert sample · ' + event); $('npScenario').append(option); });
    const dialog = document.createElement('dialog'); dialog.id = 'guestSafetyDialog'; dialog.className = 'np-safety-dialog'; dialog.setAttribute('aria-labelledby', 'npSafetyTitle');
    dialog.innerHTML = `<div class="np-safety-top"><span id="npSafetyLabel" class="badge warning"></span><button id="npSafetyClose" type="button" class="np-safety-close" aria-label="Close Guest Safety">×</button></div><h2 id="npSafetyTitle">Guest Safety</h2><p id="npSafetyDisclaimer" class="np-safety-disclaimer"></p><h3 id="npSafetyEvent" class="np-safety-event"></h3><p id="npSafetySummary"></p><p id="npSafetyInstruction" class="np-safety-instruction"></p><dl class="np-times"><div><dt>Effective / expected</dt><dd id="npSafetyEffective"></dd></div><div><dt>Expires</dt><dd id="npSafetyExpires"></dd></div></dl><p id="npSafetySource" class="np-note"></p><button id="npSafetyAcknowledge" type="button" class="primary np-safety-ack">Close details</button>`;
    ($('guestSafetyHost') || document.body).append(dialog);
    if ($('guestSafetySummary')) { const summary = $('guestSafetySummary'); summary.classList.add('np-safety-summary'); summary.innerHTML = '<span id="npSafetySummaryText">Guest Safety · waiting for official alerts</span><button id="npOpenInbox" type="button">Open notifications</button><button id="npTestGuestSafety" type="button">Test Guest Safety</button>'; $('npOpenInbox').addEventListener('click', () => { window.weatherPreview?.setTab('notifications'); }); $('npTestGuestSafety').addEventListener('click', () => receive(sample('tornado-warning'))); }
    function text(id, value) { if ($(id)) $(id).textContent = value; }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function date(value) { if (typeof value === 'number') return Number.isFinite(value) ? value : null; const parsed = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
    function stamp(value) { const parsed = date(value); return parsed === null ? 'Unavailable' : window.cmpriWeatherClock?.format(parsed, { month: 'short', day: 'numeric', timeZoneName: 'short' }) || central.format(new Date(parsed)); }
    function canonical(value) { let result = String(value || ''); if (result.includes('/alerts/')) result = result.split('/alerts/').pop(); try { return decodeURIComponent(result); } catch { return result; } }
    function officialLink(value) { try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'weather.gov' || url.hostname.endsWith('.weather.gov')) ? url.href : null; } catch { return null; } }
    function level(value) { return /warning$/i.test(value.event) ? 'warning' : /watch$/i.test(value.event) ? 'watch' : 'advisory'; }
    function hotelInstruction(value) {
      const event = value.event.toLowerCase();
      if (value.walkwayIceRisk || /freeze|frost/.test(event)) return instructions.freeze;
      if (/tornado.*warning/.test(event)) return instructions.tornado;
      if (/severe thunderstorm.*warning/.test(event)) return instructions.severe;
      if (/flood/.test(event)) return instructions.flood;
      if (/snow squall/.test(event)) return instructions.squall;
      if (/winter storm.*watch/.test(event)) return instructions.winterWatch;
      if (/winter weather|winter storm|ice storm|blizzard/.test(event)) return instructions.winter;
      if (/heat/.test(event)) return instructions.heat;
      if (/cold|wind chill/.test(event)) return instructions.cold;
      if (/high wind|wind advisory|extreme wind/.test(event)) return instructions.wind;
      if (/fog|dust/.test(event)) return instructions.visibility;
      return value.officialInstruction || value.description || 'The NWS bulletin did not provide action instructions. Read the official bulletin for updates.';
    }
    function nowFor(value) { return value.simulated ? simulationNow : Date.now(); }
    function isActive(value) { const now = nowFor(value), until = value.activeUntil ?? value.expires; return value.status === 'active' && value.effective !== null && value.effective <= now && until !== null && until > now; }
    function autoEligible(value) { return isActive(value) && !value.stale && (level(value) === 'warning' && value.sourceType === 'official' || value.walkwayIceRisk === true); }
    function record(input) {
      const value = { ...input, effective: date(input.effective), expires: date(input.expires), ends: date(input.ends), simulated: input.simulated === true, stale: input.stale === true };
      value.activeUntil = value.expires !== null && value.ends !== null ? Math.min(value.expires, value.ends) : value.expires ?? value.ends;
      value.hotelInstruction = hotelInstruction(value); value.level = level(value);
      const signature = JSON.stringify([value.version || '', value.event, value.effective, value.expires, value.ends, value.headline, value.summary, value.officialInstruction, value.hotelInstruction]);
      let first = 2166136261, second = 5381;
      for (let i = 0; i < signature.length; i++) { first = Math.imul(first ^ signature.charCodeAt(i), 16777619); second = Math.imul(second, 33) ^ signature.charCodeAt(i); }
      const revision = (first >>> 0).toString(16) + (second >>> 0).toString(16);
      versions.set(value.id, { signature, revision }); value.key = value.id + '::' + revision;
      return value;
    }
    function post(type, extra = {}) { if (embedded) window.parent.postMessage({ type, modalToken: token, ...extra }, location.origin); }
    function payload() { const alerts = Array.from(active.values()).filter(isActive).map(value => ({ ...value })); return { ...feed, alerts, notifications: history.slice(-100), autoOpenKeys: alerts.filter(autoEligible).map(value => value.key) }; }
    function publish() { post('cmpri-weather-safety-state', { payload: payload() }); document.dispatchEvent(new CustomEvent('cmpri:guest-safety-state', { detail: payload() })); }
    function showLocal(value) { const current = isActive(value); dialog.dataset.fullscreen = String(current && (level(value) === 'warning' || value.walkwayIceRisk === true)); dialog.dataset.level = current ? level(value) : 'history'; text('npSafetyLabel', (current ? '' : 'PAST NOTIFICATION · ') + (value.simulated ? 'SIMULATED GUEST SAFETY' : 'OFFICIAL NWS ALERT')); text('npSafetyDisclaimer', !current ? 'Past notification · ' + value.status + '. This is not the current alert state.' : value.simulated ? 'Simulation only · this is not a current NWS warning.' : 'Official NWS alert applying to Residence Inn Champaign.'); text('npSafetyEvent', value.event); text('npSafetySummary', value.summary); text('npSafetyInstruction', value.hotelInstruction); text('npSafetyEffective', stamp(value.effective)); text('npSafetyExpires', stamp(value.expires)); text('npSafetySource', value.sourceType === 'forecast' ? 'Forecast walkway-icing example · simulation only; no walkway ice observation is implied.' : (value.simulated ? 'Official-alert format sample · simulation only.' : 'Read the official NWS bulletin for the complete alert.')); if (value.bulletinUrl) { const link = document.createElement('a'); link.href = value.bulletinUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = ' Read official NWS bulletin ↗'; $('npSafetySource').append(link); } if (!dialog.open) { priorFocus = document.activeElement; dialog.showModal(); } }
    function openDetails(key) { const value = Array.from(active.values()).find(item => item.key === key) || history.find(item => item.key === key); if (!value) return false; activeSafety = { id: value.id, key, current: isActive(value) }; if (embedded) { publish(); post('cmpri-weather-safety-open', { key }); } else showLocal(value); return true; }
    function closeSafety() { if (dialog.open) dialog.close(); activeSafety = null; post('cmpri-weather-safety-close'); }
    dialog.addEventListener('close', () => { activeSafety = null; if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true }); });
    $('npSafetyClose').addEventListener('click', closeSafety); $('npSafetyAcknowledge').addEventListener('click', closeSafety);
    function render() {
      if (activeSafety?.current) { const current = active.get(activeSafety.id); if (!current || !isActive(current)) closeSafety(); else if (current.key !== activeSafety.key) { activeSafety = { id: current.id, key: current.key, current: true }; if (!embedded) showLocal(current); } }
      text('npOfficialStatus', feed.status === 'live' ? 'Official NWS response · checked ' + stamp(feed.checkedAt) : (feed.status === 'stale' ? 'STALE official alert response' : 'Official alert status unavailable') + (feed.error ? ' · ' + feed.error : '') + '. No all-clear is implied.');
      const list = $('npInbox'); list.replaceChildren();
      if (!history.length) { const item = document.createElement('li'); item.textContent = 'No Guest Safety notifications received.'; list.append(item); }
      history.slice(-30).reverse().forEach(value => { const li = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.dataset.guestSafetyKey = value.key; button.dataset.level = isActive(value) ? level(value) : 'history'; button.textContent = (value.simulated ? 'SIMULATION · ' : 'NWS · ') + value.event + ' · ' + value.status + ' · expires ' + stamp(value.expires); button.addEventListener('click', () => openDetails(value.key)); const p = document.createElement('p'); p.textContent = value.summary + ' ' + value.hotelInstruction; li.append(button, p); list.append(li); });
      const live = $('npLiveInbox'); live.replaceChildren();
      Array.from(active.values()).filter(value => !value.simulated && isActive(value)).forEach(value => { const button = document.createElement('button'); button.type = 'button'; button.className = 'np-live-notification'; button.dataset.level = level(value); button.textContent = value.event + ' · ' + (value.stale ? 'last verified · current status unverified' : 'active') + ' · ' + value.summary; button.addEventListener('click', () => openDetails(value.key)); live.append(button); });
      $('npClearNotifications').disabled = history.length === 0;
      text('npRegularCount', String(history.length)); text('npSafetyCount', String(safetyOpens));
      const current = Array.from(active.values()).filter(isActive), realCount = current.filter(value => !value.simulated).length, sampleCount = current.filter(value => value.simulated).length;
      text('npSafetySummaryText', 'Guest Safety · ' + (feed.status === 'live' ? realCount + ' official active alert' + (realCount === 1 ? '' : 's') : 'official alert status unavailable') + (sampleCount ? ' · ' + sampleCount + ' simulated active' : ''));
      armExpiration(); publish();
    }
    function armExpiration() { if (expiryTimeout !== null) clearTimeout(expiryTimeout); expiryTimeout = null; const times = Array.from(active.values()).filter(value => !value.simulated && (value.activeUntil ?? value.expires) !== null).map(value => value.activeUntil ?? value.expires); if (!times.length) return; /* Display cleanup only: this timer never checks a feed or calls a backend. */ expiryTimeout = setTimeout(() => { expiryTimeout = null; expireRecords(); render(); }, Math.min(2147483647, Math.max(0, Math.min(...times) - Date.now()) + 20)); }
    function resolve(id, status) { const value = active.get(id); if (!value) return; active.delete(id); history = history.map(item => item.id === id ? { ...item, status } : item); if (activeSafety?.id === id) closeSafety(); }
    function expireRecords() { Array.from(active.values()).forEach(value => { const until = value.activeUntil ?? value.expires; if (until !== null && until <= nowFor(value)) resolve(value.id, value.ends !== null && value.ends < value.expires ? 'ended' : 'expired'); }); }
    function deliver(value) { const result = { regular: false, safety: false, duplicate: delivered.has(value.key), suppressed: '' }; const previous = active.get(value.id); if (previous && previous.key !== value.key) history = history.map(item => item.id === value.id && item.status === 'active' ? { ...item, status: 'superseded' } : item); active.set(value.id, value); if (!delivered.has(value.key)) { delivered.add(value.key); history.push(value); if (history.length > 100) history.shift(); result.regular = true; } else history = history.map(item => item.key === value.key ? value : item); if (autoEligible(value) && !autoOpened.has(value.key)) { autoOpened.add(value.key); safetyOpens++; result.safety = true; activeSafety = { id: value.id, key: value.key, current: true }; if (!embedded) showLocal(value); } return result; }
    function sample(key) {
      const definition = definitions.find(item => item[0] === key); if (!definition) throw new Error('Unknown sample: ' + key);
      const [, event, rawHazard, lead] = definition, hazard = ({ freezing: 'freezing rain', storms: 'severe storms', heat: 'dangerous heat', wind: 'strong wind' })[rawHazard] || rawHazard;
      const forecast = Boolean(rawHazard), expected = forecast ? simulationNow + lead * 60 * MINUTE : simulationNow - MINUTE;
      return { id: 'SIM-NP-' + key, event, version: '1', sourceType: forecast ? 'forecast' : 'official', source: null, simulated: true, applies: key !== 'outside-property', freshness: key === 'stale-forecast' ? 'stale' : key === 'missing-forecast' ? 'missing' : 'fresh', sourceTimestamp: simulationNow - 5 * MINUTE, virtualNow: simulationNow, effective: simulationNow - MINUTE, expected, expires: key === 'expired-warning' ? simulationNow - MINUTE : expected + (forecast ? 3 * 60 : 60) * MINUTE, action: 'active', hazard, leadHours: lead || null, forecastSupported: key !== 'missing-forecast', walkwayIceRisk: key === 'freeze-risk', headline: forecast ? event + ' · ' + hazard + ' · within ' + lead + ' hours' : event, summary: forecast ? 'Forecast example: ' + hazard + ' expected within ' + lead + ' hours. No current condition or official advisory is implied.' : 'Simulated NWS summary: ' + event + ' applies to Residence Inn Champaign.', officialInstruction: key === 'other-advisory' ? 'Follow the action instructions in this simulated official bulletin.' : '', status: 'active', receivedAt: simulationNow };
    }
    function receive(input) {
      const value = { ...copy(input), simulated: true, sourceType: input.sourceType || (input.source === 'forecast' ? 'forecast' : 'official'), summary: input.summary || input.message || input.headline || input.event, officialInstruction: input.officialInstruction || '', headline: input.headline || input.event, status: 'active', receivedAt: simulationNow };
      if (Number.isFinite(input.virtualNow)) simulationNow = input.virtualNow; lastSample = value;
      let result;
      if (['canceled', 'expired'].includes(value.action)) { resolve(value.id, value.action); result = { regular: false, safety: false, duplicate: false, suppressed: 'sample ' + value.action }; }
      else if (value.applies !== true || date(value.expires) === null || date(value.expires) <= simulationNow || value.freshness === 'stale' || value.freshness === 'missing' || value.sourceType === 'forecast' && !value.forecastSupported) result = { regular: false, safety: false, duplicate: false, suppressed: 'inapplicable, expired, stale, missing, or unsupported data' };
      else { const winter = ['snow', 'freezing rain'].includes(value.hazard) && value.leadHours > 0 && value.leadHours <= 12; const prep = [12, 24].includes(value.leadHours); const wants = value.sourceType === 'official' || value.walkwayIceRisk || prep && $('npWeatherPrep').checked || winter && $('npWinterPrep').checked; result = wants ? deliver(record(value)) : { regular: false, safety: false, duplicate: false, suppressed: 'preparation example is not opted in' }; }
      text('npMessageTitle', 'SIMULATION · ' + value.headline); text('npMessageBody', value.summary + ' ' + hotelInstruction(value)); text('npEffective', stamp(value.expected || value.effective)); text('npExpires', stamp(value.expires)); text('npMessageSource', value.sourceType === 'forecast' ? 'FORECAST EXAMPLE · simulation only.' : 'OFFICIAL-ALERT FORMAT EXAMPLE · simulation only.');
      text('npResult', 'SIMULATION · ' + (result.suppressed ? 'suppressed: ' + result.suppressed : result.duplicate ? 'unchanged event: no duplicate notification or safety auto-open' : 'in-app message received' + (result.safety ? '; full-screen Guest Safety opened' : '')) + '. No push was sent.'); expireRecords(); render(); return result;
    }
    function references(value) { const refs = Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? item.split(/\s+/) : [item?.identifier, item?.id]) : typeof value === 'string' ? value.split(/\s+/) : []; return new Set(refs.filter(Boolean).flatMap(item => String(item).split(',').slice(0, 2)).map(canonical)); }
    function receiveOfficial(envelope) {
      const checked = date(envelope.checkedAt), now = Date.now(), fresh = envelope.status === 'live' && checked !== null && now - checked <= 15 * MINUTE && checked <= now + 2 * MINUTE && Array.isArray(envelope.alerts);
      feed = { status: fresh ? 'live' : envelope.status === 'stale' ? 'stale' : 'unavailable', checkedAt: checked, source: officialLink(envelope.source), error: envelope.error || (!fresh ? 'A current complete NWS response could not be verified.' : '') };
      if (!fresh) { active.forEach(value => { if (!value.simulated) value.stale = true; }); expireRecords(); render(); return snapshot(); }
      const present = new Set();
      const canceled = new Set();
      envelope.alerts.forEach(feature => {
        const p = feature?.properties || {};
        if (String(p.messageType).toLowerCase() !== 'cancel') return;
        const id = canonical(p.id || feature?.id || p['@id']); if (id) canceled.add(id);
        references(p.references).forEach(reference => canceled.add(reference));
      });
      active.forEach((value, id) => { if (id.startsWith('NWS:') && canceled.has(canonical(value.officialId))) resolve(id, 'canceled'); });
      envelope.alerts.forEach(feature => {
        const p = feature?.properties || {}, id = canonical(p.id || feature?.id || p['@id']); if (!id || !p.event) return;
        const idKey = 'NWS:' + id;
        if (String(p.messageType).toLowerCase() === 'cancel' || canceled.has(id)) return;
        const effective = date(p.effective || p.sent), expires = date(p.expires), ends = date(p.ends), until = expires !== null && ends !== null ? Math.min(expires, ends) : expires ?? ends;
        const status = effective !== null && effective <= now && until !== null && until > now ? 'active' : until !== null && until <= now ? (ends !== null && ends < expires ? 'ended' : 'expired') : 'validity unverified';
        const value = record({ id: idKey, officialId: id, event: String(p.event), headline: String(p.headline || p.event), summary: String(p.headline || p.description || p.event), description: String(p.description || ''), officialInstruction: String(p.instruction || ''), effective, expires, ends, sourceType: 'official', source: feed.source, bulletinUrl: officialLink(p['@id'] || feature.id || p.web), simulated: p.status && p.status !== 'Actual', stale: false, status, receivedAt: checked });
        if (status === 'active') { present.add(idKey); deliver(value); }
        else {
          // Resolve from the updated bulletin before comparing absent IDs. An
          // earlier ends time must not be overwritten as a cancellation using
          // the old active record's still-future expiration.
          if (status === 'ended' || status === 'expired') resolve(idKey, status);
          else if (active.has(idKey)) { active.get(idKey).stale = true; present.add(idKey); }
          if (!delivered.has(value.key)) { delivered.add(value.key); history.push(value); }
          else history = history.map(item => item.key === value.key ? value : item);
        }
      });
      active.forEach((value, id) => { if (value.sourceType === 'official' && id.startsWith('NWS:') && !present.has(id)) { const until = value.activeUntil ?? value.expires; resolve(id, until !== null && until <= now ? (value.ends !== null && value.ends < value.expires ? 'ended' : 'expired') : 'canceled'); } });
      expireRecords(); render(); return snapshot();
    }
    function advanceSimulation(minutes) { simulationNow += minutes * MINUTE; expireRecords(); render(); return snapshot(); }
    function snapshot() { return { inbox: copy(history), alerts: copy(Array.from(active.values()).filter(isActive)), safetyOpens, regularKeys: Array.from(delivered), safetyKeys: Array.from(autoOpened), activeSafety: copy(activeSafety), lastSample: copy(lastSample), feed: copy(feed), simulationNow, bridge: embedded, databaseCalls: 0, pushes: 0 }; }
    function clearNotifications() { const keys = Array.from(delivered); closeSafety(); history = []; post('cmpri-weather-safety-clear-notifications', { keys }); text('npClearStatus', 'Notifications cleared. Active NWS alerts remain in the ticker; unchanged messages stay dismissed.'); render(); return snapshot(); }
    function reset() { closeSafety(); const samples = [...history, ...active.values()].filter(value => value.simulated), sampleIds = new Set(samples.map(value => value.id)); post('cmpri-weather-safety-reset-samples', { keys: Array.from(new Set(samples.map(value => value.key))) }); history = history.filter(value => !value.simulated); active.forEach((value, id) => { if (value.simulated) active.delete(id); }); Array.from(versions.keys()).forEach(id => { if (id.startsWith('SIM') || sampleIds.has(id)) versions.delete(id); }); const keep = key => !key.startsWith('SIM') && !sampleIds.has(key.slice(0, key.lastIndexOf('::'))); delivered = new Set(Array.from(delivered).filter(keep)); autoOpened = new Set(Array.from(autoOpened).filter(keep)); simulationNow = baseTime; lastSample = null; safetyOpens = 0; text('npMessageTitle', 'Ready for review'); text('npMessageBody', 'Warnings and the forecast freeze example open full-screen Guest Safety.'); text('npEffective', 'Not received'); text('npExpires', 'Not received'); text('npMessageSource', 'No current weather condition is represented by these examples.'); text('npResult', 'All samples reset. Official alerts are preserved.'); render(); return snapshot(); }
    $('npClearNotifications').addEventListener('click', clearNotifications);
    $('npReceive').addEventListener('click', () => receive(sample($('npScenario').value))); $('npRepeat').addEventListener('click', () => receive(lastSample || sample($('npScenario').value)));
    $('npUpdated').addEventListener('click', () => { const value = lastSample ? copy(lastSample) : sample($('npScenario').value); value.previewBaseVersion ||= String(value.version ?? '1'); value.version = value.previewBaseVersion + ':preview-update:' + (++updateSequence); value.expires += 15 * MINUTE; value.headline += ' · material update'; receive(value); });
    $('npCancel').addEventListener('click', () => { if (lastSample) receive({ ...lastSample, action: 'canceled' }); }); $('npExpire').addEventListener('click', () => { if (lastSample) { simulationNow = Math.max(simulationNow, date(lastSample.expires) || simulationNow); expireRecords(); text('npResult', 'SIMULATION · sample expiration reached; no check or push was sent.'); render(); } }); $('npReset').addEventListener('click', reset);
    document.addEventListener('cmpri:official-weather-alerts', event => receiveOfficial(event.detail || {}));
    document.addEventListener('cmpri:simulated-alert', event => receive({ ...(event.detail || {}), sourceType: 'official', applies: true, freshness: 'fresh', summary: 'Shared-check simulated official alert: ' + event.detail.event, forecastSupported: true }));
    document.addEventListener('cmpri:simulated-alert-reset', reset);
    window.cmpriTimeFormat?.subscribe(() => {
      if (lastSample) {
        text('npEffective', stamp(lastSample.expected || lastSample.effective));
        text('npExpires', stamp(lastSample.expires));
      }
      if (dialog.open && activeSafety) {
        const value = active.get(activeSafety.id) || history.find(item => item.key === activeSafety.key);
        if (value) {
          text('npSafetyEffective', stamp(value.effective));
          text('npSafetyExpires', stamp(value.expires));
        }
      }
      render();
    });
    window.addEventListener('message', event => { if (!embedded || event.origin !== location.origin || event.source !== window.parent || event.data?.modalToken !== token) return; if (event.data.type === 'cmpri-weather-safety-request-state') publish(); if (event.data.type === 'cmpri-weather-safety-dismissed') activeSafety = null; });
    window.addEventListener('pagehide', () => { if (expiryTimeout !== null) clearTimeout(expiryTimeout); expiryTimeout = null; });
    window.notificationPreview = { initialized: true, receive, receiveOfficial, sample, snapshot, reset, clearNotifications, closeSafety, openDetails, advanceSimulation, instructions };
    render(); return window.notificationPreview;
  };
}());
