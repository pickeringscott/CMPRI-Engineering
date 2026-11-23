/**
 * The approved launcher DOM and gestures, anchored to the title line.
 * @template {{key:string, label:string, style?:Record<string,string>}} Action
 * @param {HTMLElement} root
 * @param {{label:string, items:Action[], centered?:boolean}[]} groups
 * @param {(action:Action, clickedAt:number, button:HTMLButtonElement)=>void} onLaunch
 * @param {import('../header-layout').HeaderLayout} layout
 * @param {(layout:import('../header-layout').HeaderLayout)=>void} onSave
 * @param {{canDrop?:(key:string, label:string)=>boolean, t?:(text:string, values?:Record<string,string|number>)=>string, tt?:(text:string, values?:Record<string,string|number>)=>string}} [options]
 */
export function mountAnchoredMenus(root, groups, onLaunch, layout, onSave, { canDrop = () => true, t: initialTranslate, tt: initialTooltip } = {}) {
  const identity = (text, values = {}) => text.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token);
  let translate = initialTranslate || identity, tooltip = initialTooltip || translate;
  const presentationLabels = [];
  const PRESS_MS = 320, SLIDE_MS = 240, MOUSE_DRAG_PX = 12, TOUCH_DRAG_PX = 8;
  const TAB_INSET = 15, TAB_GAP = 5, TAB_HEIGHT = 14;
  let observer, suppressedClick, cancelGesture, active = null, zIndex = 1, suppressRailClickUntil = 0;
  const ghosts = new Set(), cleanups = [], itemWidths = new WeakMap();
  root.replaceChildren();
  const preview = document.createElement('div');
  preview.className = 'preview layout-b';
  const header = document.createElement('div');
  header.className = 'header chief-mobile';
  const bar = document.createElement('div');
  bar.className = 'groups anchored-groups';
  header.append(bar);
  preview.append(header);
  root.append(preview);
  const railScroll = document.createElement('input');
  railScroll.type = 'range';
  railScroll.min = '0';
  railScroll.className = 'cmpri-menu-rail-scroll';
  const updateRailLabel = () => railScroll.setAttribute('aria-label', translate('Scroll menu tabs'));
  presentationLabels.push(updateRailLabel); updateRailLabel();
  railScroll.hidden = true;
  railScroll.oninput = () => { root.scrollLeft = railScroll.valueAsNumber; };
  root.after(railScroll);
  const label = group => group.dataset.layoutLabel || group.querySelector('legend').textContent;
  const fields = () => Array.from(bar.children).filter(field => !field.hasAttribute('data-ask-launcher-tab'));
  const isOpen = field => !field.classList.contains('collapsed');
  const emit = () => onSave({
    groups: fields().map(label),
    buttons: Object.fromEntries(fields().map(g => [label(g), [...g.querySelectorAll('.buttons>.action')].map(b => b.dataset.layoutKey)])),
    widths: Object.fromEntries(fields().filter(g => Number.isFinite(g.requestedWidth)).map(g => [label(g), g.requestedWidth])),
    tabWidths: Object.fromEntries(fields().filter(g => Number.isFinite(g.requestedTabWidth)).map(g => [label(g), g.requestedTabWidth])),
    collapsed: fields().filter(g => !isOpen(g)).map(label),
    positions: Object.fromEntries(fields().filter(g => Number.isFinite(g.requestedX)).map(g => [label(g), g.requestedX])),
    active: active ? label(active) : null,
  });
  const setActive = field => {
    if (active === field)
      return;
    active?.removeAttribute('data-active');
    active?.querySelector('legend').removeAttribute('aria-current');
    active = field;
    if (active) {
      active.dataset.active = 'true';
      active.querySelector('legend').setAttribute('aria-current', 'true');
      active.style.zIndex = String(++zIndex);
    }
  };
  const syncRailScroll = () => {
    const maximum = Math.max(0, root.scrollWidth - root.clientWidth);
    railScroll.max = String(maximum);
    railScroll.hidden = maximum === 0;
    railScroll.value = String(root.scrollLeft);
  };
  const stageHeight = () => {
    const open = fields().filter(isOpen);
    const height = open.length ? Math.max(...open.map(field => field.offsetTop + field.offsetHeight + (field.querySelector('.group-scroll').hidden ? 1 : 13))) : TAB_HEIGHT + 2;
    bar.style.height = height + 'px';
    syncRailScroll();
  };
  const listen = (name, fn, options) => { document.addEventListener(name, fn, options); return () => document.removeEventListener(name, fn, options); };
  const clearRailClick = () => { suppressRailClickUntil = 0; };
  const consumeRailClick = event => {
    if (event.detail === 0 || performance.now() > suppressRailClickUntil) return;
    clearRailClick();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // A touch tap can scroll the tab underneath the subsequent synthetic click.
  root.addEventListener('pointerdown', clearRailClick, true);
  root.addEventListener('click', consumeRailClick, true);
  cleanups.push(() => root.removeEventListener('pointerdown', clearRailClick, true),
    () => root.removeEventListener('click', consumeRailClick, true));
  const suppressFor = target => { suppressedClick = { target, until: performance.now() + 400 }; };
  const shouldSuppress = (target, event) => {
    if (!suppressedClick)
      return false;
    if (performance.now() > suppressedClick.until) {
      suppressedClick = undefined;
      return false;
    }
    if (event && event.detail !== 0 && suppressedClick.target === target) {
      suppressedClick = undefined;
      return true;
    }
    return false;
  };
  const clearMotion = nodes => nodes.forEach(n => n.getAnimations().forEach(a => a.cancel()));
  function slide(peers, change) {
    const before = new Map(peers.map(n => [n, n.getBoundingClientRect()]));
    change();
    clearMotion(peers);
    for (const n of peers) {
      const a = before.get(n), b = n.getBoundingClientRect();
      if (a.x !== b.x || a.y !== b.y)
        n.animate([{ transform: `translate(${a.x - b.x}px,${a.y - b.y}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }
  function copy(item, x, y) {
    const ghost = item.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    const originals = [item, ...item.querySelectorAll('*')], copies = [ghost, ...ghost.querySelectorAll('*')];
    originals.forEach((n, i) => { const style = getComputedStyle(n); for (const property of style)
      copies[i].style.setProperty(property, style.getPropertyValue(property), 'important'); copies[i].style.outline = 'none'; copies[i].style.animation = 'none'; copies[i].style.transition = 'none'; });
    // Root logical offsets and group margins must not shift the pointer-following copy.
    for (const property of ['inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end', 'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end'])
      ghost.style.removeProperty(property);
    const r = item.getBoundingClientRect();
    ghost.classList.add('moving-copy');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('inert', '');
    Object.assign(ghost.style, { position: 'fixed', left: x + 'px', top: y + 'px', width: r.width + 'px', height: r.height + 'px', minWidth: r.width + 'px', maxWidth: r.width + 'px', minHeight: r.height + 'px', maxHeight: r.height + 'px', margin: 0, transform: 'none', pointerEvents: 'none' });
    for (const [key, value] of Object.entries({ position: 'fixed', left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', margin: '0px', width: r.width + 'px', height: r.height + 'px', 'min-width': r.width + 'px', 'max-width': r.width + 'px', 'min-height': r.height + 'px', 'max-height': r.height + 'px', opacity: '.55', 'z-index': '10003', 'pointer-events': 'none' }))
      ghost.style.setProperty(key, value, 'important');
    document.body.append(ghost);
    originals.forEach((n, i) => { copies[i].scrollLeft = n.scrollLeft; copies[i].scrollTop = n.scrollTop; });
    ghosts.add(ghost);
    return ghost;
  }
  function startButtonDrag(event, item, container) {
    if (event.button !== 0 || event.isPrimary === false || cancelGesture)
      return;
    const captureTarget = event.currentTarget;
    // A new press is a new gesture, including when the browser emitted no click
    // after the previous drag. Keyboard activation must never be suppressed.
    suppressedClick = undefined;
    const initial = [...container.children], origin = container.closest('fieldset'), host = root;
    const start = { x: event.clientX, y: event.clientY, scroll: container.scrollLeft, hostLeft: host.scrollLeft, hostTop: host.scrollTop };
    const rect = item.getBoundingClientRect(), grab = { x: start.x - rect.left, y: start.y - rect.top };
    const position = e => event.pointerType === 'mouse' ? { x: e.clientX - grab.x, y: e.clientY - grab.y } : { x: e.clientX + 8, y: e.clientY + 8 };
    let last = event, active = false, moved = false, swipe = false, ghost, frame, slideUntil = 0, highlight = null;
    const destination = () => {
      const hit = document.elementFromPoint(last.clientX, last.clientY);
      const field = hit?.closest('fieldset.group');
      if (!field || field.parentElement !== bar || !canDrop(item.dataset.key, label(field)))
        return null;
      const tab = hit.closest('legend') === field.querySelector('legend');
      if (!tab && !isOpen(field))
        return null;
      return { field, row: field.querySelector('.buttons'), tab };
    };
    const insertion = (row) => [...row.children].find(b => {
      if (b === item || !b.matches('.action'))
        return false;
      const r = b.getBoundingClientRect();
      return last.clientX < r.left + r.width / 2;
    });
    const markDrop = (next) => {
      const field = next && next.field !== origin ? next.field : null;
      if (highlight !== field)
        highlight?.removeAttribute('data-button-drop');
      highlight = field;
      if (highlight)
        highlight.dataset.buttonDrop = next.tab ? 'tab' : 'row';
    };
    const arrange = (next = destination()) => {
      const valid = Boolean(next);
      document.body.classList.toggle('drag-invalid', !valid);
      ghost.style.setProperty('visibility', valid ? 'visible' : 'hidden', 'important');
      item.style.visibility = valid ? 'visible' : 'hidden';
      markDrop(next);
      if (!moved || !valid || next.field !== origin || next.tab || performance.now() < slideUntil)
        return;
      const peers = [...container.children].filter(n => n !== item);
      const target = insertion(container);
      if (target ? item.nextElementSibling === target : container.lastElementChild === item)
        return;
      slide(peers, () => target ? target.before(item) : container.append(item));
      captureTarget.setPointerCapture(event.pointerId);
      slideUntil = performance.now() + SLIDE_MS;
    };
    const edgeScroll = () => {
      if (!active)
        return;
      if (moved) {
        const bounds = host.getBoundingClientRect();
        if (last.clientY >= bounds.top && last.clientY <= bounds.top + TAB_HEIGHT + 2) {
          if (last.clientX >= bounds.right - 18 && last.clientX <= bounds.right)
            host.scrollLeft += 8;
          else if (last.clientX <= bounds.left + 18 && last.clientX >= bounds.left)
            host.scrollLeft -= 8;
        }
        else {
          const next = destination();
          if (next && !next.tab) {
            const r = next.row.getBoundingClientRect();
            if (last.clientX > r.right - 18)
              next.row.scrollLeft += 8;
            else if (last.clientX < r.left + 18)
              next.row.scrollLeft -= 8;
          }
        }
        arrange();
      }
      frame = requestAnimationFrame(edgeScroll);
    };
    const startedAt = performance.now();
    const activate = () => {
      active = true;
      root.dataset.buttonDragging = 'true';
      document.body.classList.add('drag-active', 'menu-reordering');
      window.getSelection()?.removeAllRanges();
      captureTarget.setPointerCapture(event.pointerId);
      const p = position(last);
      ghost = copy(item, p.x, p.y);
      item.classList.add('landing-copy');
      arrange();
      frame = requestAnimationFrame(edgeScroll);
    };
    const timer = event.pointerType === 'mouse' ? undefined : window.setTimeout(activate, PRESS_MS);
    const move = e => {
      if (e.pointerId !== event.pointerId)
        return;
      last = e;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > (event.pointerType === 'mouse' ? MOUSE_DRAG_PX : TOUCH_DRAG_PX))
        moved = true;
      if (!active) {
        if (event.pointerType === 'mouse') {
          if (!moved)
            return;
          activate();
        }
        else {
          if (moved) {
            window.clearTimeout(timer);
            swipe = true;
          }
          if (swipe && Math.abs(dx) > Math.abs(dy)) {
            e.preventDefault();
            container.scrollLeft = start.scroll - dx;
          }
          return;
        }
      }
      e.preventDefault();
      const p = position(e);
      ghost.style.setProperty('left', p.x + 'px', 'important');
      ghost.style.setProperty('top', p.y + 'px', 'important');
      arrange();
    };
    const stopTouchScroll = e => { if (active && e.cancelable)
      e.preventDefault(); };
    captureTarget.addEventListener('touchmove', stopTouchScroll, { passive: false });
    const finish = (e, cancel = false) => {
      if (e.pointerId !== event.pointerId)
        return;
      last = e;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      let changed = false, movedTo = null, droppedOn = null;
      if (active) {
        suppressFor(captureTarget);
        const next = cancel ? null : destination();
        if (!next) {
          clearMotion(initial);
          initial.forEach(n => container.append(n));
          container.scrollLeft = start.scroll;
          host.scrollLeft = start.hostLeft;
          host.scrollTop = start.hostTop;
        }
        else if (moved) {
          droppedOn = next.tab || next.field !== origin ? next.field : null;
          if (next.field !== origin) {
            const target = next.tab ? null : insertion(next.row);
            if (target)
              target.before(item);
            else
              next.row.append(item);
            movedTo = next.field;
          }
          else if (next.tab) {
            container.append(item);
          }
          changed = Boolean(movedTo) || initial.some((n, i) => container.children[i] !== n);
        }
        ghost.remove();
        ghosts.delete(ghost);
        item.style.visibility = '';
        item.classList.remove('landing-copy');
      }
      else if (event.pointerType !== 'mouse' && (moved || performance.now() - startedAt >= PRESS_MS))
        suppressFor(captureTarget);
      captureTarget.removeEventListener('touchmove', stopTouchScroll);
      if (captureTarget.hasPointerCapture(event.pointerId))
        captureTarget.releasePointerCapture(event.pointerId);
      markDrop(null);
      delete root.dataset.buttonDragging;
      document.body.classList.remove('drag-active', 'drag-invalid', 'menu-reordering');
      off.forEach(fn => fn());
      cancelGesture = undefined;
      if (movedTo) {
        refitButtonRow(origin);
        refitButtonRow(movedTo);
        place();
      }
      if (droppedOn) {
        changed ||= active !== droppedOn || !isOpen(droppedOn);
        openField(droppedOn);
        stageHeight();
        droppedOn.querySelector('legend').focus({ preventScroll: true });
      }
      if (changed)
        emit();
    };
    const off = [listen('pointermove', move, { passive: false }), listen('pointerup', e => finish(e)), listen('pointercancel', e => finish(e, true)), listen('keydown', e => { if (e.key === 'Escape') {
        e.preventDefault();
        finish(last, true);
      } })];
    cancelGesture = () => finish(last, true);
  }
  function refitButtonRow(field) {
    const buttons = field.querySelector('.buttons');
    const empty = buttons.querySelector('.menu-empty');
    if (buttons.querySelector('.action'))
      empty?.remove();
    else if (!empty) {
      const notice = document.createElement('span');
      notice.className = 'menu-empty';
      notice.textContent = translate('No buttons for this role');
      buttons.append(notice);
    }
    const widths = Array.from(buttons.children, button => {
      const width = button.getBoundingClientRect().width || itemWidths.get(button) || 0;
      if (width)
        itemWidths.set(button, width);
      return width;
    });
    field.minimumWidth = Math.max(field.tabWidth + 26, Math.ceil(Math.max(0, ...widths)) + 6);
    field.fittedWidth = Math.max(field.minimumWidth, Math.ceil(widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * (parseFloat(getComputedStyle(buttons).columnGap) || 0) + 14));
  }
  function fitTab(field) {
    const title = field.querySelector('legend');
    const max = Math.max(field.minimumTabWidth, root.clientWidth - TAB_INSET - 12);
    const requested = field.requestedTabWidth;
    title.style.width = requested === undefined ? 'max-content' : `${Math.min(max, Math.max(field.minimumTabWidth, requested))}px`;
    const width = title.offsetWidth;
    if (width !== field.tabWidth) {
      field.tabWidth = width;
      refitButtonRow(field);
    }
    field.querySelector('.tab-resize-edge').style.left = `${title.offsetLeft + width - 3}px`;
  }
  const widthLimit = field => {
    const available = root.scrollLeft + root.clientWidth - field.positionX - 3;
    return Math.max(1, Math.min(field.fittedWidth, root.clientWidth - 3, bar.clientWidth - field.positionX, Math.max(field.minimumWidth, available)));
  };
  const fitWidth = field => {
    const max = widthLimit(field);
    const min = Math.min(field.minimumWidth, max);
    const width = Math.min(max, Math.max(min, field.requestedWidth || field.fittedWidth));
    field.style.minWidth = min + 'px';
    field.style.width = width + 'px';
    field.drawOutline();
  };
  const setPosition = (field, x) => {
    field.positionX = Math.round(Math.max(0, Math.min(x, bar.clientWidth - field.tabWidth - 26)));
    field.style.left = field.positionX + 'px';
    fitWidth(field);
  };
  const place = () => {
    const items = fields();
    items.forEach(fitTab);
    const fittedTabs = items.reduce((size, field) => size + field.tabWidth + TAB_GAP, 0);
    bar.style.minWidth = Math.max(root.clientWidth, fittedTabs + TAB_INSET + 9) + 'px';
    let x = 0;
    for (const field of items) {
      setPosition(field, field.requestedX ?? x);
      x += field.tabWidth + TAB_GAP;
    }
    stageHeight();
  };
  function resizeHandle(className, title, measure, setSize, snapshot, restore) {
    const edge = document.createElement('span');
    edge.className = className;
    edge.tabIndex = 0;
    edge.setAttribute('role', 'separator');
    edge.setAttribute('aria-orientation', 'vertical');
    const updateLabel = () => { const value = title(); edge.setAttribute('aria-label', value); edge.title = tooltip(value); };
    presentationLabels.push(updateLabel); updateLabel();
    edge.onkeydown = event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setSize(measure() + (event.key === 'ArrowRight' ? 10 : -10));
      emit();
    };
    edge.oncontextmenu = event => event.preventDefault();
    edge.onpointerdown = event => {
      if (event.button !== 0 || event.isPrimary === false || cancelGesture) return;
      event.preventDefault();
      const previous = snapshot(), x = event.clientX, width = measure();
      document.body.classList.add('drag-active');
      window.getSelection()?.removeAllRanges();
      edge.setPointerCapture(event.pointerId);
      const finish = (move, cancel = false) => {
        if (move.pointerId !== event.pointerId) return;
        if (cancel) restore(previous);
        else emit();
        if (edge.hasPointerCapture(event.pointerId)) edge.releasePointerCapture(event.pointerId);
        off.forEach(remove => remove());
        document.body.classList.remove('drag-active');
        cancelGesture = undefined;
      };
      const off = [
        listen('pointermove', move => {
          if (move.pointerId !== event.pointerId) return;
          move.preventDefault();
          setSize(width + move.clientX - x);
        }, {passive: false}),
        listen('pointerup', finish),
        listen('pointercancel', move => finish(move, true)),
        listen('keydown', move => {
          if (move.key !== 'Escape') return;
          move.preventDefault();
          finish(event, true);
        }),
      ];
      cancelGesture = () => finish(event, true);
    };
    return edge;
  }
  function openField(field) {
    field.classList.remove('collapsed');
    field.querySelector('legend').setAttribute('aria-expanded', 'true');
    setActive(field);
    if (field.positionX < root.scrollLeft)
      root.scrollLeft = field.positionX;
    else if (field.positionX + field.minimumWidth > root.scrollLeft + root.clientWidth - 3)
      root.scrollLeft = field.positionX + field.minimumWidth - root.clientWidth + 3;
    fitWidth(field);
  }
  function activate(field) {
    if (isOpen(field) && active === field) {
      field.classList.add('collapsed');
      field.querySelector('legend').setAttribute('aria-expanded', 'false');
      const remaining = fields().filter(isOpen).sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
      setActive(remaining[0] || null);
    }
    else openField(field);
    stageHeight();
    emit();
  }
  function startTabDrag(event, field, title) {
    if (event.button !== 0 || event.isPrimary === false || cancelGesture)
      return;
    suppressedClick = undefined;
    const touch = event.pointerType !== 'mouse';
    const initialX = field.positionX, initialScroll = root.scrollLeft, initialZ = field.style.zIndex;
    let last = event, dragging = false, moved = false, swiping = false, frame;
    const within = () => { const { left, right, top } = root.getBoundingClientRect(); return last.clientX >= left && last.clientX <= right && last.clientY >= top - 1 && last.clientY <= top + TAB_HEIGHT + 1; };
    const displace = () => { if (within())
      setPosition(field, initialX + last.clientX - event.clientX + root.scrollLeft - initialScroll); };
    const edgeScroll = () => {
      if (!dragging)
        return;
      if (moved && within()) {
        const { left, right } = root.getBoundingClientRect();
        if (last.clientX > right - 18)
          root.scrollLeft += 8;
        else if (last.clientX < left + 18)
          root.scrollLeft -= 8;
        displace();
      }
      frame = requestAnimationFrame(edgeScroll);
    };
    const start = () => {
      dragging = true;
      title.setPointerCapture(event.pointerId);
      field.style.zIndex = '10000';
      field.classList.add('dragging');
      document.body.classList.add('drag-active', 'menu-reordering');
      window.getSelection()?.removeAllRanges();
      frame = requestAnimationFrame(edgeScroll);
    };
    const timer = touch ? window.setTimeout(start, PRESS_MS) : undefined;
    const move = e => {
      if (e.pointerId !== event.pointerId)
        return;
      last = e;
      const dx = e.clientX - event.clientX, dy = e.clientY - event.clientY;
      moved ||= Math.hypot(dx, dy) > (touch ? TOUCH_DRAG_PX : MOUSE_DRAG_PX);
      if (!dragging) {
        if (!moved)
          return;
        if (touch) {
          window.clearTimeout(timer);
          if (!swiping && Math.abs(dx) > Math.abs(dy))
            swiping = true;
          if (swiping) {
            e.preventDefault();
            root.scrollLeft = initialScroll - dx;
          }
          return;
        }
        start();
      }
      e.preventDefault();
      document.body.classList.toggle('drag-invalid', !within());
      displace();
    };
    const finish = (e, cancel = false) => {
      if (e.pointerId !== event.pointerId)
        return;
      last = e;
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      if (dragging) {
        suppressRailClickUntil = performance.now() + 400;
        if (cancel || !within()) {
          root.scrollLeft = initialScroll;
          setPosition(field, initialX);
        }
        else {
          displace();
          if (field.positionX !== initialX) {
            field.requestedX = field.positionX;
            emit();
          }
        }
        field.classList.remove('dragging');
        field.style.zIndex = initialZ;
      }
      else if (touch) {
        suppressRailClickUntil = performance.now() + 400;
        if (!cancel && !moved && within())
          activate(field);
      }
      if (title.hasPointerCapture(event.pointerId))
        title.releasePointerCapture(event.pointerId);
      document.body.classList.remove('drag-active', 'drag-invalid', 'menu-reordering');
      off.forEach(fn => fn());
      cancelGesture = undefined;
      place();
    };
    const off = [listen('pointermove', move, { passive: false }), listen('pointerup', e => finish(e)), listen('pointercancel', e => finish(e, true)), listen('keydown', e => { if (e.key === 'Escape') {
        e.preventDefault();
        finish(last, true);
      } })];
    cancelGesture = () => finish(last, true);
  }
  for (const group of groups) {
    const field = document.createElement('fieldset');
    field.className = 'group';
    field.dataset.layoutLabel = group.label;
    if (group.centered)
      field.dataset.centered = 'true';
    const title = document.createElement('legend');
    title.className = 'group-title';
    const updateTitle = () => {
      title.textContent = translate(group.label);
      title.title = tooltip('Open or close {group}; drag to move (touch: long press)', { group: translate(group.label) });
    };
    presentationLabels.push(updateTitle); updateTitle();
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    title.setAttribute('aria-expanded', 'true');
    title.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    for (const action of group.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'action';
      b.dataset.key = action.key;
      b.dataset.layoutKey = action.key + '::' + action.label.replace(/ \(\d+\)$/, '');
      b.dataset.control = action.label;
      const updateButton = () => { b.textContent = translate(action.label); b.title = tooltip('Drag to reorder or move to another tab (touch: long press)'); delete b.dataset.staffNotesBaseTitle; };
      presentationLabels.push(updateButton); updateButton();
      for (const [key, value] of Object.entries(action.style || {}))
        b.style.setProperty(key, value);
      b.oncontextmenu = e => e.preventDefault();
      b.onpointerdown = e => startButtonDrag(e, b, b.parentElement);
      b.onclick = e => { if (!shouldSuppress(b, e))
        onLaunch(action, Date.now(), b); };
      b.onkeydown = e => { if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const other = e.key === 'ArrowLeft' ? b.previousElementSibling : b.nextElementSibling;
        if (other) {
          if (e.key === 'ArrowLeft')
            other.before(b);
          else
            other.after(b);
          emit();
          b.focus();
        }
      } };
      buttons.append(b);
    }
    const saved = layout.buttons[group.label] || [], rank = b => { const specific = saved.indexOf(b.dataset.layoutKey), n = specific < 0 ? saved.indexOf(b.dataset.key) : specific; return n < 0 ? 999 : n; };
    [...buttons.children].sort((a, b) => rank(a) - rank(b)).forEach(n => buttons.append(n));
    field.append(title, buttons);
    bar.append(field);
    title.style.maxWidth = 'none';
    title.style.width = 'max-content';
    title.style.boxSizing = 'border-box';
    field.minimumTabWidth = field.tabWidth = title.offsetWidth;
    refitButtonRow(field);
    field.requestedWidth = layout.widths[group.label];
    field.requestedTabWidth = layout.tabWidths?.[group.label];
    field.requestedX = layout.positions?.[group.label];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('group-outline');
    svg.setAttribute('aria-hidden', 'true');
    field.append(svg);
    const scroll = document.createElement('input');
    scroll.type = 'range';
    scroll.min = 0;
    scroll.step = 1;
    scroll.value = 0;
    scroll.className = 'group-scroll';
    const updateScrollLabel = () => scroll.setAttribute('aria-label', translate('Scroll {group} buttons', { group: translate(group.label) }));
    presentationLabels.push(updateScrollLabel); updateScrollLabel();
    field.append(scroll);
    field.drawOutline = () => {
      if (!isOpen(field)) {
        scroll.hidden = true;
        return;
      }
      const w = field.clientWidth + 2, h = field.clientHeight + 16, l = 11, r = l + title.offsetWidth + 6;
      svg.innerHTML = `<path d="M 6 15 H ${l - 3} Q ${l} 15 ${l} 12 V 6 Q ${l} 1 ${l + 5} 1 H ${r - 5} Q ${r} 1 ${r} 6 V 12 Q ${r} 15 ${r + 3} 15 H ${w - 6} Q ${w - 1} 15 ${w - 1} 20 V ${h - 6} Q ${w - 1} ${h - 1} ${w - 6} ${h - 1} H 6 Q 1 ${h - 1} 1 ${h - 6} V 20 Q 1 15 6 15 Z" fill="none" stroke="#334155aa"/>`;
      scroll.max = Math.max(0, buttons.scrollWidth - buttons.clientWidth);
      scroll.hidden = Number(scroll.max) < 1;
      scroll.value = buttons.scrollLeft;
    };
    scroll.oninput = () => buttons.scrollLeft = Number(scroll.value);
    buttons.onscroll = () => scroll.value = buttons.scrollLeft;
    title.onclick = e => { if (!shouldSuppress(title, e))
      activate(field); };
    title.onpointerdown = e => startTabDrag(e, field, title);
    title.oncontextmenu = e => e.preventDefault();
    title.onkeydown = e => {
      if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        setPosition(field, field.positionX + (e.key === 'ArrowLeft' ? -10 : 10));
        field.requestedX = field.positionX;
        stageHeight();
        emit();
      }
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate(field);
      }
    };
    const needsWake = e => !title.contains(e.target) && e.target !== tabEdge && active !== field && isOpen(field);
    field.addEventListener('pointerdown', e => {
      if (needsWake(e)) {
        suppressedClick = undefined;
        e.stopPropagation();
      }
    }, true);
    field.addEventListener('click', e => {
      if (!needsWake(e))
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const button = e.target.closest('.action');
      if (button && shouldSuppress(button, e))
        return;
      setActive(field);
      emit();
    }, true);
    const tabEdge = resizeHandle('tab-resize-edge', () => translate('Resize {group} tab', { group: translate(group.label) }),
      () => title.offsetWidth,
      width => {
        const limit = Math.max(field.minimumTabWidth, root.clientWidth - TAB_INSET - 12);
        field.requestedTabWidth = Math.round(Math.min(limit, Math.max(field.minimumTabWidth, width)));
        place();
      },
      () => field.requestedTabWidth,
      width => { field.requestedTabWidth = width; place(); },
    );
    const rowEdge = resizeHandle('resize-edge', () => translate('Resize {group} button row', { group: translate(group.label) }),
      () => field.offsetWidth,
      width => {
        const limit = widthLimit(field);
        field.requestedWidth = Math.max(Math.min(field.minimumWidth, limit), Math.min(width, limit));
        fitWidth(field);
        stageHeight();
      },
      () => field.requestedWidth,
      width => { field.requestedWidth = width; fitWidth(field); stageHeight(); },
    );
    field.append(tabEdge, rowEdge);
    if (layout.collapsed.includes(group.label)) {
      field.classList.add('collapsed');
      title.setAttribute('aria-expanded', 'false');
    }
    else
      setActive(field);
  }
  const preferred = fields().find(field => isOpen(field) && label(field) === layout.active);
  if (preferred || layout.active === null)
    setActive(preferred || null);
  observer = new ResizeObserver(() => { if (!cancelGesture) place(); });
  observer.observe(root);
  // A ticker changes the CSS row offset, not the menu's own border-box size.
  // Recompute the existing overlay height without altering saved tab layout.
  const bulletinHost = root.closest('header.cmpri-dashboard-titlebar')?.parentElement
    ?.querySelector(':scope > [data-weather-desktop-bulletin-host]');
  const bulletinObserver = bulletinHost ? new MutationObserver(() => { if (!cancelGesture) place(); }) : null;
  bulletinObserver?.observe(bulletinHost, { childList: true });
  place();
  const adjustToScroll = () => {
    if (cancelGesture) syncRailScroll();
    else {
      fields().forEach(fitWidth);
      stageHeight();
    }
  };
  root.addEventListener('scroll', adjustToScroll, { passive: true });
  cleanups.push(() => root.removeEventListener('scroll', adjustToScroll));
  const blur = () => cancelGesture?.();
  window.addEventListener('blur', blur);
  cleanups.push(() => window.removeEventListener('blur', blur));
  const leave = e => {
    if (!active || cancelGesture || root.contains(e.target) || railScroll.contains(e.target))
      return;
    // Launching a screen moves focus into its window while the menu stays
    // selected. Clicking the desktop itself still clears menu selection.
    if (e.target instanceof Element && e.target.closest(
      '[data-cmpri-desktop-window], [data-modal-entry], [data-cmpri-ask-root], dialog[open]'
    )) return;
    setActive(null);
    emit();
  };
  cleanups.push(listen('pointerdown', leave, true), listen('focusin', leave));
  const unmount = () => { cancelGesture?.(); observer.disconnect(); bulletinObserver?.disconnect(); cleanups.forEach(fn => fn()); for (const ghost of ghosts)
    ghost.remove(); document.body.classList.remove('drag-active', 'drag-invalid', 'menu-reordering'); root.replaceChildren(); railScroll.remove(); };
  // Language changes preserve the canonical layout, controls and pending drag/save work.
  unmount.setPresentation = next => {
    translate = next.t || identity; tooltip = next.tt || translate;
    presentationLabels.forEach(update => update());
    for (const field of fields()) {
      const title = field.querySelector('legend');
      title.style.width = 'max-content';
      field.minimumTabWidth = title.offsetWidth;
      const empty = field.querySelector('.menu-empty');
      if (empty) empty.textContent = translate('No buttons for this role');
      refitButtonRow(field);
    }
    if (!cancelGesture) place();
  };
  return unmount;
}
