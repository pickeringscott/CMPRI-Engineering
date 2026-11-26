/* Same-origin review form. The native dashboard owns permission and preview state. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const form = $('alertPanel');
  const query = new URLSearchParams(location.search);
  const modalToken = query.get('modalToken');
  if (!form || !modalToken || query.get('embedded') !== '1' || window.parent === window) return;
  let permitted = false;

  function inputValue(time) {
    const { year, month, day, hour, minute, second } = window.cmpriWeatherClock.parts(time);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }

  function utcFromCentral(value) {
    if (!value) return NaN;
    const normalized = value.length === 16 ? value + ':00' : value;
    const desired = Date.parse(normalized + 'Z');
    if (!Number.isFinite(desired)) return NaN;
    let guess = desired;
    for (let attempt = 0; attempt < 4; attempt++) {
      const shown = inputValue(guess);
      if (shown === normalized) return guess;
      guess += desired - Date.parse(shown + 'Z');
    }
    return NaN;
  }

  function bindPositionedPicker(anchor) {
    const picker = anchor.popoverTargetElement;
    function positionPicker() {
      if (!picker.matches(':popover-open')) return;
      const rect = anchor.getBoundingClientRect();
      const row = anchor.closest('.manual-alert-controls').getBoundingClientRect();
      const body = anchor.closest('.window-body').getBoundingClientRect();
      if (rect.right <= row.left || rect.left >= row.right || rect.bottom <= body.top || rect.top >= body.bottom) {
        picker.hidePopover();
        return;
      }
      const margin = 8;
      const height = picker.offsetHeight;
      const availableTop = window.innerHeight - height - margin;
      const idealTop = rect.bottom + margin <= availableTop ? rect.bottom + margin : rect.top - height - margin;
      picker.style.left = Math.max(margin, Math.min(rect.left, window.innerWidth - picker.offsetWidth - margin)) + 'px';
      picker.style.top = Math.max(margin, Math.min(idealTop, availableTop)) + 'px';
    }
    picker.addEventListener('toggle', positionPicker);
    document.addEventListener('scroll', positionPicker, true);
    window.addEventListener('resize', positionPicker);
    new ResizeObserver(positionPicker).observe(picker);
    return picker;
  }

  function bindBannerColor(swatch) {
    const picker = bindPositionedPicker(swatch);
    const map = picker.querySelector('.manual-color-map');
    const hue = picker.querySelector('.manual-hue');
    const [red, green, blue] = swatch.value.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255);
    let brightness = Math.max(red, green, blue);
    const spread = brightness - Math.min(red, green, blue);
    let saturation = brightness ? spread / brightness : 0;
    const sector = spread === 0 ? 0
      : brightness === red ? (green - blue) / spread
      : brightness === green ? 2 + (blue - red) / spread
      : 4 + (red - green) / spread;
    hue.value = ((sector + 6) % 6) * 60;

    function paintSelection() {
      map.style.setProperty('--picker-hue', hue.value);
      map.style.setProperty('--picker-x', saturation * 100 + '%');
      map.style.setProperty('--picker-y', (1 - brightness) * 100 + '%');
    }

    function chooseColor() {
      const sector = Number(hue.value) / 60;
      const chroma = brightness * saturation;
      const middle = chroma * (1 - Math.abs(sector % 2 - 1));
      const base = brightness - chroma;
      const channels = [
        [chroma, middle, 0], [middle, chroma, 0], [0, chroma, middle],
        [0, middle, chroma], [middle, 0, chroma], [chroma, 0, middle],
      ][Math.floor(sector)];
      swatch.value = '#' + channels.map(channel => Math.round((channel + base) * 255).toString(16).padStart(2, '0')).join('');
      swatch.style.setProperty('--swatch', swatch.value);
      paintSelection();
    }

    function clampColor(value) {
      return Math.max(0, Math.min(1, value));
    }

    function pickFromPointer(event) {
      const rect = map.getBoundingClientRect();
      saturation = clampColor((event.clientX - rect.left) / rect.width);
      brightness = 1 - clampColor((event.clientY - rect.top) / rect.height);
      chooseColor();
    }

    map.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      map.setPointerCapture(event.pointerId);
      pickFromPointer(event);
    });
    map.addEventListener('pointermove', event => {
      if (map.hasPointerCapture(event.pointerId)) pickFromPointer(event);
    });
    map.addEventListener('keydown', event => {
      const step = event.shiftKey ? .1 : .025;
      const changes = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
      }[event.key];
      if (!changes) return;
      event.preventDefault();
      saturation = clampColor(saturation + changes[0]);
      brightness = clampColor(brightness + changes[1]);
      chooseColor();
    });
    hue.addEventListener('input', chooseColor);
    paintSelection();
  }

  function bindExpirationPicker() {
    const input = $('expiresAt');
    const toggle = $('expiryPickerToggle');
    const picker = bindPositionedPicker(toggle);
    const days = $('expiryDays');
    const fields = [$('expiryHour'), $('expiryMinute'), $('expirySecond')];
    const period = $('expiryPeriod');
    const periodButtons = [...period.querySelectorAll('button')];
    const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const dayFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });
    const localParts = () => (input.value || inputValue(Date.now())).split('T');
    const dateKey = date => date.toISOString().split('T')[0];
    const hour12 = () => window.cmpriTimeFormat.value === '12h';
    const pad = number => String(number).padStart(2, '0');
    let cursor;
    let evening;

    function save(date, time) {
      input.value = date + 'T' + time;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function paintCalendar() {
      const start = new Date(cursor);
      start.setUTCDate(1);
      const end = new Date(start);
      end.setUTCMonth(start.getUTCMonth() + 1);
      const selected = input.value.split('T')[0];
      const active = dateKey(cursor);
      const cells = [];
      for (const day = new Date(start); day < end; day.setUTCDate(day.getUTCDate() + 1)) {
        const key = dateKey(day);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.date = key;
        button.textContent = day.getUTCDate();
        button.tabIndex = key === active ? 0 : -1;
        button.setAttribute('aria-label', dayFormat.format(day));
        button.setAttribute('aria-pressed', String(key === selected));
        if (!cells.length) button.style.gridColumnStart = day.getUTCDay() + 1;
        cells.push(button);
      }
      $('expiryMonth').textContent = monthFormat.format(start);
      days.replaceChildren(...cells);
    }

    function focusDay() {
      days.querySelector('button[tabindex="0"]')?.focus({ preventScroll: true });
    }

    function moveMonth(delta) {
      const next = new Date(cursor);
      next.setUTCMonth(next.getUTCMonth() + delta, 1);
      const monthEnd = new Date(next);
      monthEnd.setUTCMonth(next.getUTCMonth() + 1, 0);
      next.setUTCDate(Math.min(cursor.getUTCDate(), monthEnd.getUTCDate()));
      if (next.getUTCFullYear() < 1 || next.getUTCFullYear() > 9999) return;
      cursor = next;
      paintCalendar();
    }

    function paintPeriod() {
      periodButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === Number(evening))));
    }

    function paintTime() {
      const [hour, minute, second = 0] = localParts()[1].split(':').map(Number);
      const twelveHour = hour12();
      fields[0].min = twelveHour ? 1 : 0;
      fields[0].max = twelveHour ? 12 : 23;
      fields[0].value = twelveHour ? hour % 12 || 12 : pad(hour);
      fields[1].value = pad(minute);
      fields[2].value = pad(second);
      period.hidden = !twelveHour;
      evening = hour >= 12;
      paintPeriod();
    }

    function saveTime() {
      if (fields.some(field => !Number.isFinite(field.valueAsNumber) || !field.validity.valid)) return;
      const [hour, minute, second] = fields.map(field => field.valueAsNumber);
      const hourOfDay = hour12() ? hour % 12 + (evening ? 12 : 0) : hour;
      save(localParts()[0], [hourOfDay, minute, second].map(pad).join(':'));
    }

    $('expiryPrevMonth').addEventListener('click', () => moveMonth(-1));
    $('expiryNextMonth').addEventListener('click', () => moveMonth(1));
    days.addEventListener('click', ({ target }) => {
      const date = target.dataset.date;
      if (!date) return;
      save(date, localParts()[1]);
      cursor = new Date(date + 'T00:00:00Z');
      paintCalendar();
      focusDay();
    });
    days.addEventListener('keydown', (event) => {
      const day = cursor.getUTCDay();
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -day, End: 6 - day };
      if (event.key in move) {
        const next = new Date(cursor);
        next.setUTCDate(next.getUTCDate() + move[event.key]);
        if (next.getUTCFullYear() >= 1 && next.getUTCFullYear() <= 9999) cursor = next;
        paintCalendar();
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        moveMonth((event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
      } else {
        return;
      }
      event.preventDefault();
      focusDay();
    });
    fields.forEach(field => {
      field.addEventListener('input', saveTime);
      field.addEventListener('blur', paintTime);
    });
    periodButtons.forEach((button, index) => button.addEventListener('click', () => {
      evening = index === 1;
      saveTime();
      paintPeriod();
    }));
    picker.addEventListener('beforetoggle', ({ newState }) => {
      if (newState !== 'open') return;
      cursor = new Date(localParts()[0] + 'T00:00:00Z');
      if (!Number.isFinite(cursor.getTime())) cursor = new Date(inputValue(Date.now()).slice(0, 10) + 'T00:00:00Z');
      paintCalendar();
      paintTime();
    });
    picker.addEventListener('toggle', ({ newState }) => {
      if (newState === 'open' && picker.matches(':popover-open')) focusDay();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'F4' && !(event.altKey && event.key === 'ArrowDown')) return;
      event.preventDefault();
      toggle.click();
    });
    window.cmpriTimeFormat.subscribe(() => {
      if (picker.matches(':popover-open')) paintTime();
    });
  }

  $('expiresAt').value = inputValue(Date.now() + 3_600_000);
  const severity = $('severity');
  function makeRoomForSeverity() {
    if (!CSS.supports('selector(select:open)') || !severity.matches(':open')) return;
    const menuHeight = [...severity.options].reduce((height, option) => height + option.offsetHeight, 2);
    const missing = severity.getBoundingClientRect().bottom + menuHeight + 8 - window.innerHeight;
    if (missing > 0) $('windowBody').scrollTop += missing;
  }
  severity.addEventListener('click', makeRoomForSeverity);
  severity.addEventListener('keydown', () => requestAnimationFrame(makeRoomForSeverity));
  severity.addEventListener('change', () => {
    $('radarOverride').disabled = severity.value === 'notice';
  });
  if ('popoverTargetElement' in HTMLButtonElement.prototype) {
    form.querySelectorAll('.manual-color-swatch').forEach(bindBannerColor);
    bindExpirationPicker();
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const picker = form.querySelector('[popover]:popover-open');
      if (picker) {
        event.preventDefault();
        picker.hidePopover();
      } else if (CSS.supports('selector(select:open)') && severity.matches(':open')) {
        event.stopImmediatePropagation();
      }
    });
  } else {
    $('expiryPickerToggle').hidden = true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.modalToken !== modalToken) return;
    if (event.data.type === 'cmpri-weather-manual-alert-access') {
      permitted = event.data.allowed === true;
      form.hidden = !permitted;
    }
    if (!permitted || (event.data.type === 'cmpri-weather-view-state' && event.data.visible !== true)) {
      if (CSS.supports('selector(:popover-open)')) form.querySelector('[popover]:popover-open')?.hidePopover();
    }
  });
  window.parent.postMessage({ type: 'cmpri-weather-manual-alert-request-access', modalToken }, location.origin);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!permitted) return;
    const mode = event.submitter?.value;
    if (mode !== 'preview' && mode !== 'publish') return;
    const custom = $('customEnabled').checked;
    const text = $('bannerText').value.trim();
    const selectedSeverity = severity.value || 'advisory';
    const override = selectedSeverity !== 'notice' && $('radarOverride').checked;
    const now = Date.now();
    const expires = utcFromCentral($('expiresAt').value);
    const error = custom && !text ? 'Enter banner text or turn the custom banner off.'
      : (custom || override) && (!Number.isFinite(expires) || expires <= now) ? 'Choose a future expiration.' : '';
    const message = $('formMessage');
    message.hidden = !error;
    message.textContent = error;
    if (error) return;
    window.parent.postMessage({
      type: 'cmpri-weather-manual-alert-submit', modalToken, mode,
      payload: {
        custom, text, severity: selectedSeverity, override,
        expires: Number.isFinite(expires) && expires > now ? expires : now + 3_600_000,
        color: $('bannerColor').value, textColor: $('bannerTextColor').value,
      },
    }, location.origin);
  });
})();
