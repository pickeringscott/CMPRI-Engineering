/* Same-origin preference bridge for standalone modal documents. */
(function () {
  'use strict';
  const supported = (value) => value === '12h' || value === '24h';
  const query = new URLSearchParams(window.location.search);
  const initial = query.get('timeFormat');
  let timeFormat = supported(initial) ? initial : query.get('clock') === '24' ? '24h' : '12h';
  const changeEvent = 'cmpri-time-format-change';

  function options(format = timeFormat) {
    return format === '24h'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' };
  }

  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin
      || event.data?.type !== 'cmpri-time-format-updated' || !supported(event.data.timeFormat)
      || event.data.timeFormat === timeFormat) return;
    timeFormat = event.data.timeFormat;
    window.dispatchEvent(new CustomEvent(changeEvent, { detail: timeFormat }));
  });

  window.cmpriTimeFormat = Object.freeze({
    get value() { return timeFormat; },
    options,
    subscribe(callback) {
      const listener = (event) => callback(event.detail);
      window.addEventListener(changeEvent, listener);
      return () => window.removeEventListener(changeEvent, listener);
    },
  });
}());
