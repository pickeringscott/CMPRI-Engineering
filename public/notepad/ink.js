/*
 * Standalone adaptation of CMPRI's GeneralNotesInk.tsx and ink undo/redo.
 * Source: https://github.com/pickeringscott/CMPRI-Engineering/blob/main/src/components/GeneralNotesInk.tsx
 * Ink stays above transparent text in both modes; only its pointer events change.
 * Stored strokes: { id, color, size, points: [{ x, y, p }] }, page 800 x 1100.
 * Hardware barrel/inverted-eraser/pen-holder events are not implemented by the source.
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const PAGE_WIDTH = 800;
  const PAGE_HEIGHT = 1100;
  const drawingCursor = {
    pen: 'url("/notepad/pencil-cursor.svg") 3 21, crosshair',
    eraser: 'url("/notepad/eraser-cursor.svg") 5 19, crosshair',
  };
  const validMode = value => ['text', 'pen', 'eraser'].includes(value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function attach(options) {
    const { paper, textLayer, svg, getNote, getMode, getColor, getWidth,
      onSave = function () {}, onModeChange = function () {} } = options || {};
    if (!paper || !textLayer || !svg || typeof getNote !== 'function') {
      throw new TypeError('NotepadInk.attach needs paper, textLayer, svg and getNote.');
    }
    const doc = svg.ownerDocument;
    const win = doc.defaultView || global;
    let active = null;
    let finger = null;
    let destroyed = false;
    let selectedMode = validMode(getMode && getMode()) ? getMode() : 'text';

    function mode() {
      const value = typeof getMode === 'function' ? getMode() : selectedMode;
      return validMode(value) ? value : selectedMode;
    }
    function currentNote() {
      const note = getNote();
      if (!note) return null;
      if (!Array.isArray(note.ink)) note.ink = [];
      if (!Array.isArray(note.inkUndo)) note.inkUndo = [];
      if (!Array.isArray(note.inkRedo)) note.inkRedo = [];
      return note;
    }
    function capture(id) {
      try { svg.setPointerCapture(id); } catch (_) { /* Synthetic/ended pointer. */ }
    }
    function release(id) {
      try { if (svg.hasPointerCapture(id)) svg.releasePointerCapture(id); } catch (_) {}
    }
    function scrollContainer() {
      let node = paper.parentElement;
      while (node && node !== doc.documentElement) {
        if (/(auto|scroll|overlay)/.test(win.getComputedStyle(node).overflowY)) return node;
        node = node.parentElement;
      }
      return paper.parentElement || doc.scrollingElement;
    }
    function point(event, rect, pointerType) {
      const pressure = event.pointerType === 'pen' || pointerType === 'pen'
        ? (event.pressure || 0.3) : 0.5;
      return {
        x: clamp((event.clientX - rect.left) * PAGE_WIDTH / rect.width, 0, PAGE_WIDTH),
        y: clamp((event.clientY - rect.top) * PAGE_HEIGHT / rect.height, 0, PAGE_HEIGHT),
        p: clamp(pressure, 0, 1)
      };
    }
    function segment(stroke, index) {
      const a = stroke.points[Math.max(0, index - 1)];
      const b = stroke.points[index];
      const line = doc.createElementNS(NS, 'line');
      const attrs = {
        x1: a.x, y1: a.y, x2: b.x + (index === 0 ? 0.01 : 0), y2: b.y,
        stroke: stroke.color, 'stroke-width': stroke.size * (0.5 + b.p),
        'stroke-linecap': 'round'
      };
      Object.keys(attrs).forEach(key => line.setAttribute(key, String(attrs[key])));
      return line;
    }
    function strokeGroup(stroke) {
      if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return null;
      const element = doc.createElementNS(NS, 'g');
      element.setAttribute('data-stroke', stroke.id);
      const fragment = doc.createDocumentFragment();
      stroke.points.forEach((_, index) => fragment.appendChild(segment(stroke, index)));
      element.appendChild(fragment);
      return element;
    }
    function renderInk(note) {
      const fragment = doc.createDocumentFragment();
      for (const stroke of note ? note.ink : []) {
        const element = strokeGroup(stroke);
        if (element) fragment.appendChild(element);
      }
      svg.replaceChildren(fragment);
    }
    function resolveColor() {
      const marker = doc.createElementNS(NS, 'g');
      marker.style.color = typeof getColor === 'function' ? getColor() : 'currentColor';
      svg.appendChild(marker);
      const resolved = win.getComputedStyle(marker).color;
      marker.remove();
      return resolved;
    }
    function append(event) {
      const gesture = active;
      if (!gesture || !gesture.stroke || !gesture.element) return;
      const coalesced = typeof event.getCoalescedEvents === 'function'
        ? event.getCoalescedEvents() : null;
      const samples = coalesced && coalesced.length ? coalesced : [event];
      const fragment = doc.createDocumentFragment();
      for (const sample of samples) {
        const next = point(sample, gesture.rect, gesture.pointerType);
        const points = gesture.stroke.points;
        const previous = points[points.length - 1];
        if (previous && previous.x === next.x && previous.y === next.y) continue;
        points.push(next);
        fragment.appendChild(segment(gesture.stroke, points.length - 1));
      }
      gesture.element.appendChild(fragment);
    }
    function erase(event) {
      const gesture = active;
      if (!gesture) return;
      const p = point(event, gesture.rect, gesture.pointerType);
      const radius = 18 * PAGE_WIDTH / gesture.rect.width;
      const ids = new Set(gesture.note.ink.filter(stroke =>
        Array.isArray(stroke.points) && stroke.points.some((b, index) => {
          const a = stroke.points[Math.max(0, index - 1)];
          const dx = b.x - a.x, dy = b.y - a.y;
          const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) /
            (dx * dx + dy * dy || 1), 0, 1);
          return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < radius;
        })
      ).map(stroke => stroke.id));
      if (!ids.size) return;
      gesture.note.ink = gesture.note.ink.filter(stroke => !ids.has(stroke.id));
      for (const child of Array.from(svg.children)) {
        if (ids.has(child.getAttribute('data-stroke'))) child.remove();
      }
    }
    function commit(gesture) {
      if (gesture.note.ink === gesture.before) return false;
      gesture.note.inkUndo.push(gesture.before);
      gesture.note.inkRedo = [];
      onSave(gesture.note, gesture.mode === 'eraser' ? 'erase' : 'stroke');
      return true;
    }
    function finish() {
      const gesture = active;
      const touch = finger;
      active = null;
      finger = null;
      if (gesture) release(gesture.id);
      if (touch) release(touch.id);
      return gesture ? commit(gesture) : false;
    }
    function applyMode(value) {
      selectedMode = value;
      svg.style.pointerEvents = value === 'text' ? 'none' : 'auto';
      svg.style.cursor = drawingCursor[value] || 'auto';
      // Never hide the ink when text is selected.
      textLayer.setAttribute('contenteditable', String(value === 'text'));
      textLayer.style.pointerEvents = value === 'text' ? 'auto' : 'none';
      paper.classList.toggle('is-text', value === 'text');
      paper.classList.toggle('is-drawing', value !== 'text');
      if (value !== 'text' && doc.activeElement && textLayer.contains(doc.activeElement)) {
        doc.activeElement.blur();
      }
    }
    function down(event) {
      if (destroyed || mode() === 'text' || active || event.button !== 0) return;
      if (event.pointerType === 'touch') {
        if (finger) return;
        finger = { id: event.pointerId, x: event.clientX, y: event.clientY,
          lastY: event.clientY, moved: false, scroller: scrollContainer() };
        capture(event.pointerId);
        return;
      }
      const note = currentNote();
      const rect = svg.getBoundingClientRect();
      if (!note || !rect.width || !rect.height) return;
      if (finger) { const id = finger.id; finger = null; release(id); }
      event.preventDefault();
      capture(event.pointerId);
      active = { id: event.pointerId, rect, note, before: note.ink,
        pointerType: event.pointerType, mode: mode() };
      if (active.mode === 'eraser') { erase(event); return; }
      const requestedWidth = typeof getWidth === 'function' ? Number(getWidth()) : 4;
      const stroke = {
        id: global.crypto && typeof global.crypto.randomUUID === 'function'
          ? global.crypto.randomUUID()
          : 'ink-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
        color: resolveColor(), size: clamp(Number.isFinite(requestedWidth) ? requestedWidth : 4, 1, 12),
        points: [point(event, rect, event.pointerType)]
      };
      const element = strokeGroup(stroke);
      note.ink = note.ink.concat(stroke);
      active.stroke = stroke;
      active.element = element;
      svg.appendChild(element);
    }
    function move(event) {
      if (destroyed) return;
      const touch = finger;
      if (touch && touch.id === event.pointerId) {
        if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10) touch.moved = true;
        if (touch.moved && touch.scroller) {
          const top = touch.lastY - event.clientY;
          if (typeof touch.scroller.scrollBy === 'function') touch.scroller.scrollBy({ top });
          else touch.scroller.scrollTop += top;
        }
        touch.lastY = event.clientY;
        return;
      }
      if (!active || active.id !== event.pointerId) return;
      event.preventDefault();
      if (active.mode === 'eraser') erase(event);
      else append(event);
    }
    function end(event) {
      if (destroyed) return;
      const touch = finger;
      if (touch && touch.id === event.pointerId) {
        const tap = event.type === 'pointerup' && !touch.moved &&
          Math.hypot(event.clientX - touch.x, event.clientY - touch.y) <= 10;
        finger = null;
        release(touch.id);
        if (tap) {
          applyMode('text');
          onModeChange('text');
          textLayer.focus({ preventScroll: true });
        }
        return;
      }
      const gesture = active;
      if (!gesture || gesture.id !== event.pointerId) return;
      if (event.type === 'pointerup' && gesture.stroke) append(event);
      active = null;
      release(gesture.id);
      commit(gesture);
    }
    function draw() {
      if (destroyed) return;
      finish();
      renderInk(currentNote());
      applyMode(mode());
    }
    function undo() {
      if (destroyed) return false;
      finish();
      const note = currentNote();
      if (!note || !note.inkUndo.length) return false;
      note.inkRedo.push(note.ink);
      note.ink = note.inkUndo.pop();
      renderInk(note);
      onSave(note, 'undo');
      return true;
    }
    function redo() {
      if (destroyed) return false;
      finish();
      const note = currentNote();
      if (!note || !note.inkRedo.length) return false;
      note.inkUndo.push(note.ink);
      note.ink = note.inkRedo.pop();
      renderInk(note);
      onSave(note, 'redo');
      return true;
    }
    function setMode(value) {
      if (destroyed) return;
      finish();
      applyMode(validMode(value) ? value : mode());
    }
    function destroy() {
      if (destroyed) return;
      finish();
      destroyed = true;
      svg.removeEventListener('pointerdown', down);
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', end);
      svg.removeEventListener('pointercancel', end);
      svg.removeEventListener('lostpointercapture', end);
      doc.removeEventListener('cmpri-notes-finish-input', finish);
    }

    svg.setAttribute('viewBox', '0 0 800 1100');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('data-ink-layer', 'true');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Handwriting. In pen mode, fingers scroll or tap to type.');
    svg.style.touchAction = 'none';
    svg.style.userSelect = 'none';
    svg.style.zIndex = '2';
    textLayer.style.zIndex = '1';
    paper.style.isolation = 'isolate';
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('lostpointercapture', end);
    doc.addEventListener('cmpri-notes-finish-input', finish);
    renderInk(currentNote());
    applyMode(selectedMode);
    return { draw, undo, redo, destroy, setMode };
  }

  global.NotepadInk = Object.freeze({ attach });
})(window);
