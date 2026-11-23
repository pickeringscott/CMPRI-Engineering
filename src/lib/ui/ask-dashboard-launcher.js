const hints = [
  'Work orders', 'Asset records', 'Equipment PDFs', 'Error codes',
  'Troubleshoot', 'Staff Notes', 'Safety steps', 'Find supplies',
  'Repair done?', 'Ticket closed?', 'Parts stock?', 'Find a manual',
  'Open tickets', 'Shift notes', 'Emergency plan', 'Who is on call?'
];
const compactHints = ['Orders', 'Assets', 'Manuals', 'Codes', 'Notes', 'Safety', 'Supplies', 'Repair done?', 'Ticket closed?'];
const maxLineLength = 50;
const shoulderWidth = 3;
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function nextHint(exclude, source = hints) {
  const choices = source.filter((hint) => hint !== exclude);
  return choices[Math.floor(Math.random() * choices.length)];
}

function readPosition(scope) {
  try {
    const value = localStorage.getItem('cmpri:ask-tab-offset:' + scope);
    if (value !== null && Number.isFinite(Number(value))) return Number(value);
  } catch { /* The tab can be moved for this session without storage. */ }
  return null;
}

function savePosition(scope, position) {
  try { localStorage.setItem('cmpri:ask-tab-offset:' + scope, String(position)); }
  catch { /* The reordered tab remains in its current position. */ }
}

function wrapForDisplay(source, measureLine = () => 0, widthLimit = Infinity) {
  let visual = '';
  let rawOffset = 0;
  let preferredWidth = 0;
  const breaks = [];
  for (const line of source.split('\n')) {
    if (rawOffset) visual += '\n';
    const chars = graphemes ? Array.from(graphemes.segment(line), ({ segment }) => segment) : Array.from(line);
    let cursor = 0;
    let lineOffset = rawOffset;
    while (cursor < chars.length) {
      const chunk = chars.slice(cursor, cursor + maxLineLength);
      let length = chunk.length;
      let width = measureLine(chunk.join(''));
      while (length > 1 && width > widthLimit) {
        length--;
        width = measureLine(chunk.slice(0, length).join(''));
      }
      // Retain the measured width before backing up to a word boundary so
      // adding a character cannot make the field jump narrower.
      preferredWidth = Math.max(preferredWidth, width);
      const hasMore = cursor + length < chars.length;
      if (hasMore && !/^\s$/.test(chars[cursor + length])) {
        const whitespace = chunk.slice(0, length).findLastIndex((character) => /^\s$/.test(character));
        if (whitespace > 0) length = whitespace + 1;
      }
      const text = chunk.slice(0, length).join('');
      visual += text;
      lineOffset += text.length;
      cursor += length;
      if ([' ', '\t'].includes(chars[cursor])) {
        // The existing separator becomes the display break, so the next
        // line does not begin with a blank and raw offsets stay unchanged.
        lineOffset++;
        cursor++;
        visual += '\n';
      } else if (cursor < chars.length || (length === maxLineLength && rawOffset + line.length === source.length)) {
        breaks.push({ raw: lineOffset, visual: visual.length });
        visual += '\n';
      }
    }
    rawOffset += line.length + 1;
  }
  return { visual, breaks, preferredWidth };
}

function toRaw(position, breaks) {
  return position - breaks.filter((entry) => entry.visual < position).length;
}

function toVisual(position, breaks) {
  return position + breaks.filter((entry) => entry.raw <= position).length;
}

// Draw the two shoulders and the capsule with a single outline. The real
// dashboard tab supplies the vertical sides above the start of this path.
function paintOutline(canvas, context, pill, tab, stroke, capsuleFill, tabFill, border) {
  const scale = window.devicePixelRatio || 1;
  const overlap = 1;
  const originY = tab.bottom - overlap;
  const height = pill.bottom - originY;
  canvas.width = Math.ceil(pill.width * scale);
  canvas.height = Math.ceil(height * scale);
  canvas.style.width = pill.width + 'px';
  canvas.style.height = height + 'px';
  canvas.style.left = -border + 'px';
  canvas.style.top = (originY - pill.top - border) + 'px';
  const radius = pill.height / 2;
  canvas.dataset.radius = radius;
  context.setTransform(scale, 0, 0, scale, 0, 0);

  const halfStroke = border / 2;
  const circleRadius = radius - halfStroke;
  const leftCenter = radius;
  const rightCenter = pill.width - radius;
  const centerY = pill.top - originY + radius;
  const top = centerY - circleRadius;
  const bottom = centerY + circleRadius;
  const leftTab = tab.left - pill.left + halfStroke;
  const rightTab = tab.right - pill.left - halfStroke;
  const leftShoulder = Math.max(leftCenter, leftTab - shoulderWidth);
  const rightShoulder = Math.min(rightCenter, rightTab + shoulderWidth);
  context.beginPath();
  context.moveTo(leftTab, 0);
  context.bezierCurveTo(leftTab, top / 2, leftTab, top, leftShoulder, top);
  context.lineTo(leftCenter, top);
  context.arc(leftCenter, centerY, circleRadius, -Math.PI / 2, Math.PI / 2, true);
  context.lineTo(rightCenter, bottom);
  context.arc(rightCenter, centerY, circleRadius, Math.PI / 2, -Math.PI / 2, true);
  context.lineTo(rightShoulder, top);
  context.bezierCurveTo(rightTab, top, rightTab, top / 2, rightTab, 0);
  const fill = context.createLinearGradient(0, 0, 0, Math.min(height, Math.max(4, top + 4)));
  fill.addColorStop(0, tabFill);
  fill.addColorStop(1, capsuleFill);
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = stroke;
  context.lineWidth = border;
  context.lineJoin = 'round';
  context.stroke();
}

/**
 * Attach the approved Ask CMPRI launcher to the existing dashboard rail.
 * @param {HTMLElement} root
 * @param {string} scope property and account
 * @param {(text: string) => string} translate
 * @param {{modalOpen:boolean,voiceActive:boolean,voiceStatus:string,voiceDraft:string,voiceFallback:boolean,query:string}} [initial]
 */
export function mountAskDashboardLauncher(root, scope, translate, initial) {
  const header = root.closest('header.cmpri-dashboard-titlebar');
  const rail = header?.querySelector('.cmpri-dashboard-menu-rail');
  const shelf = header?.querySelector('.cmpri-header-shelf');
  const row = root.querySelector('.anchored-groups');
  const fields = row ? [...row.querySelectorAll(':scope > fieldset.group')] : [];
  if (!fields.length || !rail || !shelf) return;
  const scroller = root;
  const desktop = matchMedia('(min-width: 701px)');
  let modalOpen = initial?.modalOpen ?? false;
  let voiceActive = initial?.voiceActive ?? false;
  let voiceStatus = initial?.voiceStatus ?? '';
  let voiceDraft = initial?.voiceDraft ?? '';
  let voiceFallback = initial?.voiceFallback ?? false;

  const events = new AbortController();
  const on = (target, type, handler, options) => target.addEventListener(type, handler, { ...options, signal: events.signal });
  const native = fields.map((field) => ({
    field,
    legend: field.querySelector('legend'),
    left: () => field.positionX ?? 0
  }));
  let position = readPosition(scope);
  let renderedPosition = 0;
  let pointer = null;
  let rawSearch = initial?.query ?? '';
  let display = wrapForDisplay('');
  let beforeEdit = null;

  const tab = document.createElement('fieldset');
  tab.className = 'group collapsed desktop-ask-tab';
  tab.dataset.layoutLabel = 'Ask CMPRI';
  tab.dataset.desktopAskTab = '';
  const legend = native[0].legend.cloneNode(false);
  legend.id = 'desktop-ask-tab';
  legend.removeAttribute('style');
  legend.style.maxWidth = 'none';
  legend.style.width = 'max-content';
  legend.style.boxSizing = 'border-box';
  tab.dataset.askLauncherTab = '';
  legend.setAttribute('aria-controls', 'desktop-ask-search');
  legend.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
  tab.append(legend);
  row.append(tab);

  const form = document.createElement('form');
  form.id = 'desktop-ask-search';
  form.className = 'desktop-ask-search';

  form.innerHTML = '<canvas class="desktop-ask-outline" aria-hidden="true"></canvas>' +
    '<button class="desktop-ask-star" type="submit" data-cmpri-ask-launcher="star" aria-haspopup="dialog"><i class="desktop-ask-gemini" aria-hidden="true"></i></button>' +
    '<div class="desktop-ask-entry"><textarea id="desktop-ask-query" rows="1" wrap="off" maxlength="700" enterkeyhint="search" autocomplete="off"></textarea>' +
    '<span class="desktop-ask-hint" aria-hidden="true"><span class="desktop-ask-hint-line"></span><span class="desktop-ask-hint-line desktop-ask-hint-incoming"></span></span>' +
    '<span class="desktop-ask-voice-draft" aria-hidden="true" hidden></span></div>' +
    '<button id="desktop-ask-mic" class="desktop-ask-mic" type="button" data-cmpri-ask-launcher="mic"><span class="desktop-ask-mic-icon" aria-hidden="true"></span></button>' +
    '<button id="desktop-ask-stop" class="desktop-ask-stop" type="button" hidden></button>' +
    '<p class="desktop-ask-voice-status sr-only" role="status" hidden></p>';
  rail.append(form);

  const mobile = document.createElement('button');
  mobile.type = 'button';
  mobile.className = 'cmpri-ask-mobile-launcher';
  mobile.dataset.cmpriAskLauncher = 'mobile';
  mobile.dataset.layoutKey = 'ask-cmpri::mobile';
  mobile.setAttribute('aria-haspopup', 'dialog');
  mobile.innerHTML = '<i class="desktop-ask-gemini" aria-hidden="true"></i><span></span>';
  shelf.append(mobile);
  const input = form.querySelector('textarea');
  const star = form.querySelector('.desktop-ask-star');
  const mic = form.querySelector('.desktop-ask-mic');
  const stop = form.querySelector('.desktop-ask-stop');
  const status = form.querySelector('.desktop-ask-voice-status');
  const draft = form.querySelector('.desktop-ask-voice-draft');
  const outline = form.querySelector('.desktop-ask-outline');
  const outlineContext = outline.getContext('2d');
  const [outgoing, incoming] = form.querySelectorAll('.desktop-ask-hint-line');
  const measure = document.createElement('canvas').getContext('2d');
  star.dataset.layoutKey = 'ask-cmpri::star';
  mic.dataset.layoutKey = 'ask-cmpri::mic';
  function setPresentation(t) {
    legend.textContent = t('Ask CMPRI');
    legend.title = t('Ask CMPRI search. Drag to move along the dashboard.');
    form.setAttribute('aria-label', t('Ask CMPRI launcher'));
    input.setAttribute('aria-label', t('Ask CMPRI search'));
    star.setAttribute('aria-label', t('Open Ask CMPRI'));
    star.title = t('Open Ask CMPRI');
    mic.setAttribute('aria-label', t('Start voice call'));
    stop.setAttribute('aria-label', t('Stop'));
    mobile.querySelector('span').textContent = t('Ask CMPRI');
  }
  setPresentation(translate);

  let hintSource = hints;
  outgoing.textContent = nextHint();
  incoming.textContent = nextHint(outgoing.textContent);

  let activeNativeDialog = null;

  function positionFormHost(dialog) {
    const canUsePopover = typeof form.showPopover === 'function';
    const host = !modalOpen && desktop.matches && canUsePopover && dialog?.id !== 'ask-cmpri' && dialog ? dialog : rail;
    if (form.parentElement === host) return;
    if (form.hasAttribute('popover')) {
      if (form.isConnected && form.matches(':popover-open')) form.hidePopover();
      form.removeAttribute('popover');
    }
    host.append(form);
    if (host !== rail) {
      form.setAttribute('popover', 'manual');
      form.showPopover();
    }
  }

  function placeForm() {
    positionFormHost(activeNativeDialog);
    if (!desktop.matches) {
      document.body.style.removeProperty('--ask-launcher-clearance');
      return;
    }
    input.style.height = 'auto';
    input.style.height = Math.min(108, input.scrollHeight) + 'px';
    const curveSpace = form.getBoundingClientRect().height / 2 + shoulderWidth;
    positionTabs(curveSpace);
    const railBounds = rail.getBoundingClientRect();
    const labelBounds = legend.getBoundingClientRect();
    const offscreen = labelBounds.right <= railBounds.left || labelBounds.left >= railBounds.right;
    form.toggleAttribute('data-tab-offscreen', offscreen);
    if (offscreen) {
      document.body.style.removeProperty('--ask-launcher-clearance');
      return;
    }
    const labelText = document.createRange();
    labelText.selectNodeContents(legend);
    const textLeft = labelText.getBoundingClientRect().left - railBounds.left;
    const formStyle = getComputedStyle(form);
    const inputStyle = getComputedStyle(input);
    const labelStyle = getComputedStyle(legend);
    const border = parseFloat(formStyle.borderLeftWidth) || 0;
    const caretOffset = border + parseFloat(formStyle.paddingLeft) + star.offsetWidth + parseFloat(formStyle.columnGap);
    const preferredLeft = textLeft - caretOffset;
    const anchorLeft = Math.max(0, Math.floor(Math.min(preferredLeft, labelBounds.left - railBounds.left - curveSpace)));
    const rightEdge = document.documentElement.clientWidth - railBounds.left - 2;
    const rightControl = mic.hidden ? stop.offsetWidth : mic.offsetWidth;
    const restingWidth = Math.min(130, Math.max(110, rightEdge - anchorLeft));
    const capsuleWidth = labelBounds.right - railBounds.left + curveSpace - anchorLeft;
    const textInsets = (parseFloat(formStyle.getPropertyValue('--desktop-ask-text-start')) || 0) + parseFloat(inputStyle.paddingRight);
    const textWidth = display.preferredWidth + caretOffset + rightControl + textInsets + 9;
    const desired = Math.ceil(Math.max(restingWidth, capsuleWidth, textWidth));
    const width = Math.min(desired, rightEdge + railBounds.left - 2);
    const left = Math.min(anchorLeft, rightEdge - width);
    form.style.width = width + 'px';
    const hosted = form.parentElement !== rail;
    form.style.left = (left + (hosted ? railBounds.left : 0)) + 'px';
    form.style.top = (labelBounds.bottom - (hosted ? 0 : railBounds.top) + 1) + 'px';
    form.style.setProperty('--desktop-ask-idle-caret-inset', Math.max(0, preferredLeft - left) + 'px');
    form.style.setProperty('--desktop-ask-border', labelStyle.borderLeftColor);
    const pillBounds = form.getBoundingClientRect();
    const radius = pillBounds.height / 2;
    form.style.setProperty('--desktop-ask-pill-radius', radius + 'px');
    if (outlineContext) {
      const surface = formStyle.getPropertyValue('--desktop-ask-surface').trim() || '#151210';
      paintOutline(outline, outlineContext, pillBounds, labelBounds, labelStyle.borderLeftColor, surface, labelStyle.backgroundColor, border);
      form.setAttribute('data-outline-joined', '');
    }
    const nextHints = width < 125 ? compactHints : hints;
    if (nextHints !== hintSource) {
      hintSource = nextHints;
      outgoing.textContent = nextHint(undefined, hintSource);
      incoming.textContent = nextHint(outgoing.textContent, hintSource);
    }
    const bottom = Math.max(pillBounds.bottom, status.getBoundingClientRect().bottom);
    document.body.style.setProperty('--ask-launcher-clearance', Math.ceil(bottom + 8) + 'px');
  }

  function updateVoice() {
    form.toggleAttribute('data-voice-active', voiceActive);
    form.toggleAttribute('data-query-empty', !input.value);
    mic.hidden = voiceActive || !!input.value;
    stop.hidden = !voiceActive;
    draft.hidden = !voiceActive || !!input.value || !voiceDraft;
    draft.textContent = voiceDraft;
    status.hidden = !voiceActive || !voiceStatus;
    status.classList.toggle('sr-only', !voiceFallback);
    status.textContent = voiceStatus;
    placeForm();
  }

  function paintSearch(selection, direction) {
    const styles = getComputedStyle(input);
    const field = getComputedStyle(form);
    const leftChrome = (parseFloat(field.borderLeftWidth) || 0) + parseFloat(field.paddingLeft) +
      (star.offsetWidth || 16) + parseFloat(field.columnGap);
    const rightChrome = (voiceActive ? stop.offsetWidth || 18 : 0) + 9;
    const widthLimit = document.documentElement.clientWidth - 4 - leftChrome - rightChrome;
    if (measure) {
      measure.font = styles.fontStyle + ' ' + styles.fontWeight + ' ' + styles.fontSize + ' ' + styles.fontFamily;
    }
    const lineWidth = (line) => measure?.measureText(line.replaceAll('\t', '        ')).width || 0;
    display = wrapForDisplay(rawSearch, lineWidth, widthLimit);
    let start = 0;
    let end = 0;
    for (let iteration = 0; iteration < 5; iteration++) {
      const lines = display.visual.split('\n').length;
      const inputHeight = Math.min(108, lines * (parseFloat(styles.lineHeight) || 18) + 2);
      const pillHeight = Math.max(inputHeight, star.offsetHeight, voiceActive ? 18 : 0) + 2;
      const radius = pillHeight / 2;
      const textTop = 5 + (pillHeight - inputHeight - 2) / 2;
      const inset = radius - Math.sqrt(Math.max(0, radius ** 2 - (radius - textTop) ** 2));
      const nextStart = Math.max(0, Math.ceil(inset - leftChrome));
      const nextEnd = Math.max(0, Math.ceil(inset - rightChrome));
      if (nextStart === start && nextEnd === end) break;
      start = nextStart;
      end = nextEnd;
      display = wrapForDisplay(rawSearch, lineWidth, widthLimit - start - end);
    }
    form.style.setProperty('--desktop-ask-text-start', start + 'px');
    form.style.setProperty('--desktop-ask-text-end', end + 'px');
    if (input.value === display.visual) return;
    input.value = display.visual;
    const [left, right] = selection.map((offset) => toVisual(Math.min(offset, rawSearch.length), display.breaks));
    input.setSelectionRange(left, right, direction);
    input.scrollLeft = 0;
  }

  function reflowSearch() {
    if (!desktop.matches || !rawSearch || input.value !== display.visual) return;
    const selection = [input.selectionStart, input.selectionEnd].map((position) => toRaw(position, display.breaks));
    paintSearch(selection, input.selectionDirection);
  }

  function updateSearch(event) {
    if (event?.isComposing) {
      updateVoice();
      return;
    }
    const current = input.value;
    const previous = display.visual;
    if (current === previous) {
      beforeEdit = null;
      updateVoice();
      return;
    }
    const selection = [input.selectionStart, input.selectionEnd];
    const direction = input.selectionDirection;
    let start = 0;
    let end = previous.length;
    let addedEnd = current.length;
    if (beforeEdit && current.startsWith(previous.slice(0, beforeEdit.start)) &&
        current.endsWith(previous.slice(beforeEdit.end)) &&
        current.length >= beforeEdit.start + previous.length - beforeEdit.end) {
      start = beforeEdit.start;
      end = beforeEdit.end;
      addedEnd = current.length - previous.length + end;
    } else {
      while (start < Math.min(end, addedEnd) && previous[start] === current[start]) start++;
      while (end > start && addedEnd > start && previous[end - 1] === current[addedEnd - 1]) {
        end--;
        addedEnd--;
      }
    }
    beforeEdit = null;
    let rawStart = toRaw(start, display.breaks);
    let rawEnd = toRaw(end, display.breaks);
    const inserted = current.slice(start, addedEnd);
    let rawSelection = selection.map((offset) => {
      if (offset <= start) return toRaw(offset, display.breaks);
      if (offset <= addedEnd) return rawStart + offset - start;
      return toRaw(end + offset - addedEnd, display.breaks) + rawStart + inserted.length - rawEnd;
    });
    // A generated line break is a visual boundary, so Backspace and Delete
    // there edit the text on the adjoining side.
    if (!inserted && start < end && rawStart === rawEnd) {
      const type = event?.inputType;
      if (type === 'deleteContentBackward' && rawStart > 0) {
        const text = rawSearch.slice(0, rawStart);
        const last = graphemes ? Array.from(graphemes.segment(text)).at(-1)?.segment : Array.from(text).at(-1);
        rawStart -= last.length;
      } else if (type === 'deleteContentForward' && rawEnd < rawSearch.length) {
        const text = rawSearch.slice(rawEnd);
        const first = graphemes ? graphemes.segment(text).containing(0)?.segment : Array.from(text)[0];
        rawEnd += first.length;
      }
      rawSelection = [rawStart, rawStart];
    }
    rawSearch = (rawSearch.slice(0, rawStart) + inserted + rawSearch.slice(rawEnd)).slice(0, 650);
    paintSearch(rawSelection, direction);
    updateVoice();
  }

  function positionTabs(curveSpace = 0) {
    const labels = native.map((entry) => entry.legend.getBoundingClientRect().width);
    const gap = native.length > 1 ? native[1].left() - native[0].left() - labels[0] : 10;
    const spacing = Math.max(6, Math.min(10, gap));
    const tabWidth = legend.getBoundingClientRect().width;
    const rowBounds = row.getBoundingClientRect();
    const tabInset = legend.getBoundingClientRect().left - rowBounds.left - (parseFloat(tab.style.left) || 0);
    const railLeft = rail.getBoundingClientRect().left;
    const railRight = scroller.getBoundingClientRect().right;
    const minimum = Math.max(0, railLeft + curveSpace - rowBounds.left - tabInset);
    const maximum = railRight - Math.max(2, curveSpace) - rowBounds.left - tabInset - tabWidth;
    const neighbors = native.map((entry, index) => ({ ...entry, width: labels[index], x: entry.left() }))
      .sort((a, b) => a.x - b.x);
    const fallback = Math.max(...neighbors.map(entry => entry.x + entry.width)) + spacing;
    const clamp = (x) => Math.max(minimum, Math.min(maximum, x));
    renderedPosition = clamp(position ?? fallback);
    // A default Ask tab follows the native tabs without changing their saved
    // positions. In a crowded rail, use the nearest open space.
    if (desktop.matches && position === null) {
      const candidates = [
        renderedPosition, minimum, maximum,
        ...neighbors.flatMap(entry => [entry.x - spacing - tabWidth, entry.x + entry.width + spacing]),
      ].map(clamp).sort((a, b) => Math.abs(a - fallback) - Math.abs(b - fallback));
      renderedPosition = candidates.find(x => neighbors.every(entry =>
        x + tabWidth + spacing <= entry.x || x >= entry.x + entry.width + spacing
      )) ?? renderedPosition;
    }
    const askEnd = renderedPosition + tabWidth;
    let occupiedEnd = askEnd + spacing;
    let followingField = null;
    let layoutChanged = false;
    neighbors.forEach(entry => {
      let left = entry.x;
      if (desktop.matches && !entry.field.classList.contains('dragging') &&
          left < occupiedEnd && left + entry.width + spacing > renderedPosition) {
        left = occupiedEnd;
        occupiedEnd = left + entry.width + spacing;
      }
      if (!followingField && left > renderedPosition) followingField = entry.field;
      const cssLeft = left + 'px';
      if (entry.field.style.left !== cssLeft) {
        entry.field.style.left = cssLeft;
        layoutChanged = true;
      }
    });
    const tabLeft = renderedPosition + 'px';
    if (tab.style.left !== tabLeft) {
      tab.style.left = tabLeft;
      layoutChanged = true;
    }
    if (desktop.matches && tab.nextElementSibling !== followingField) row.insertBefore(tab, followingField);
    if (layoutChanged) root.dispatchEvent(new Event('cmpri-menu-placement'));
  }

  function arrangeTabs() {
    if (!desktop.matches) positionTabs();
    reflowSearch();
    placeForm();
  }

  function setPosition(offset, persist = false) {
    position = offset;
    arrangeTabs();
    if (persist) savePosition(scope, renderedPosition);
  }

  function open(opener, voice = false, tab) {
    if (modalOpen) return;
    const query = opener === star ? rawSearch.trim() : '';
    window.dispatchEvent(new CustomEvent('cmpri-ask-open', {
      detail: { query: query || undefined, voice, opener, tab }
    }));
  }

  function syncVisibility() {
    const visible = desktop.matches && !modalOpen;
    legend.setAttribute('aria-expanded', String(visible));
    if (modalOpen) legend.setAttribute('aria-current', 'true');
    else legend.removeAttribute('aria-current');
    if (modalOpen) tab.dataset.active = 'true';
    else delete tab.dataset.active;
    mobile.setAttribute('aria-expanded', String(modalOpen));
    form.toggleAttribute('data-modal-open', modalOpen);
    placeForm();
  }

  function drag(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!pointer.moved && Math.abs(event.clientX - pointer.origin) < 5) return;
    if (!pointer.moved) {
      pointer.moved = true;
      tab.classList.add('dragging');
    }
    event.preventDefault();
    const relative = event.clientX - row.getBoundingClientRect().left - pointer.grab - pointer.tabInset;
    setPosition(relative);
  }

  function stopDragging(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    tab.classList.remove('dragging');
    if (pointer.moved) {
      if (event.type === 'pointerup') setPosition(renderedPosition, true);
      else setPosition(pointer.original);
    }
    pointer = null;
  }

  on(legend, 'pointerdown', (event) => {
    if (!desktop.matches || event.button !== 0) return;
    const bounds = legend.getBoundingClientRect();
    const tabInset = bounds.left - row.getBoundingClientRect().left - renderedPosition;
    pointer = { id: event.pointerId, origin: event.clientX, grab: event.clientX - bounds.left, tabInset, original: position, moved: false };
    rail.setPointerCapture(event.pointerId);
  });
  on(rail, 'pointermove', drag);
  on(rail, 'pointerup', stopDragging);
  on(rail, 'pointercancel', stopDragging);
  on(rail, 'lostpointercapture', stopDragging);
  on(legend, 'keydown', (event) => {
    if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      setPosition(renderedPosition + (event.key === 'ArrowLeft' ? -12 : 12), true);
      legend.focus({ preventScroll: true });
    } else if (['Enter', ' '].includes(event.key) && !modalOpen) {
      event.preventDefault();
      input.focus({ preventScroll: true });
    }
  });

  const stopVoice = () => window.dispatchEvent(new Event('cmpri-ask-stop-voice'));
  on(form, 'submit', (event) => { event.preventDefault(); open(star); });
  on(mobile, 'click', () => open(mobile));
  on(mic, 'click', () => open(mic, true));
  on(stop, 'click', stopVoice);
  on(window, 'cmpri-ask-state', (event) => {
    const state = event.detail;
    if (!state || typeof state.open !== 'boolean') return;
    modalOpen = state.open;
    voiceActive = state.voiceActive === true;
    voiceStatus = state.voiceStatus || '';
    voiceDraft = state.voiceDraft || '';
    voiceFallback = state.voiceFallback === true;
    reflowSearch();
    updateVoice();
    syncVisibility();
  });
  on(document, 'keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || !desktop.matches || modalOpen) return;
    if (voiceActive) {
      event.preventDefault();
      stopVoice();
    }
    if (event.target === input) {
      event.preventDefault();
      input.blur();
    }
  });
  on(input, 'keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    open(star, false, 'search');
  });
  on(input, 'beforeinput', () => {
    beforeEdit = { start: input.selectionStart, end: input.selectionEnd };
  });
  on(input, 'input', updateSearch);
  on(input, 'compositionend', updateSearch);
  on(input, 'copy', (event) => {
    const start = toRaw(input.selectionStart, display.breaks);
    const end = toRaw(input.selectionEnd, display.breaks);
    if (start >= end || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', rawSearch.slice(start, end));
  });
  on(outgoing, 'animationiteration', () => { outgoing.textContent = nextHint(incoming.textContent, hintSource); });
  on(incoming, 'animationiteration', () => { incoming.textContent = nextHint(outgoing.textContent, hintSource); });
  on(scroller, 'scroll', placeForm);
  on(desktop, 'change', () => { arrangeTabs(); syncVisibility(); });

  const resize = new ResizeObserver(arrangeTabs);
  resize.observe(rail);
  function syncNativeDialog(preferred) {
    const dialogs = [...document.querySelectorAll('dialog:modal')];
    const focused = document.activeElement?.closest('dialog:modal');
    const next = [preferred, focused, activeNativeDialog].find(dialog => dialogs.includes(dialog)) || dialogs.at(-1);
    if (activeNativeDialog === next) return;
    activeNativeDialog = next;
    placeForm();
  }
  const nativeLayer = new MutationObserver(records => {
    const changed = records.filter(change => change.target instanceof HTMLDialogElement);
    if (changed.length || activeNativeDialog && !activeNativeDialog.isConnected) syncNativeDialog(changed.at(-1)?.target);
  });
  nativeLayer.observe(document.body, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });
  on(document, 'close', () => syncNativeDialog(), { capture: true });
  syncNativeDialog();
  const menuLayout = new MutationObserver(arrangeTabs);
  for (const { field, legend } of native) {
    menuLayout.observe(field, { attributes: true, attributeFilter: ['style', 'class'] });
    menuLayout.observe(legend, { attributes: true, attributeFilter: ['style'] });
  }
  arrangeTabs();
  if (rawSearch) paintSearch([rawSearch.length, rawSearch.length], 'none');
  syncVisibility();
  updateVoice();

  return {
    getState() { return { modalOpen, voiceActive, voiceStatus, voiceDraft, voiceFallback, query: rawSearch }; },
    setPresentation(t) { setPresentation(t); arrangeTabs(); },
    dispose() {
      events.abort();
      resize.disconnect();
      menuLayout.disconnect();
      nativeLayer.disconnect();
      document.body.style.removeProperty('--ask-launcher-clearance');
      tab.remove();
      form.remove();
      mobile.remove();
      for (const entry of native) entry.field.style.left = entry.left() + 'px';
    }
  };
}
