// This file is a function expression consumed directly by Playwright page.evaluate().
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Exporting or invoking it changes that evaluation contract.
(selector = 'html,body,body *') => {
  // Playwright passes null when evaluate() has no argument.
  selector ||= 'html,body,body *';
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const parsed = new Map();
  const channels = new Map();
  const legacy = new Set([
    '020617', '0f172a', '1e293b', '334155', '475569', '64748b', '94a3b8',
    'cbd5e1', 'e2e8f0', '111827', '101b2b', '050918', '080f1d', '182439',
    '111c2d', '101a2a', '08111f', '0b1423', '0b1422', '132239', '18304c',
    '17273d', '26354c', '34435a', '3b4b63', '29384f', '52759e',
  ]);
  const findings = [], exceptions = [];
  const stats = { elements: 0, pseudoElements: 0, paintProperties: 0 };
  function rgba(value) {
    if (channels.has(value)) return channels.get(value);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = 'transparent';
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const result = [...context.getImageData(0, 0, 1, 1).data];
    channels.set(value, result);
    return result;
  }
  function navy(value) {
    if (!value || value === 'none') return false;
    if (parsed.has(value)) return parsed.get(value);
    const [r, g, b, a] = rgba(value);
    const hex = [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
    const result = a > 8 && (legacy.has(hex) || (b > g + 2 && b - r >= 14 && b > r * 1.25 && Math.max(r, g, b) < 130));
    parsed.set(value, result);
    return result;
  }
  function inspect(element, style, pseudo = '') {
    const properties = ['backgroundColor'];
    const text = [...element.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (text || element.matches('input,select,textarea,option,optgroup')) properties.push('color');
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(style['border' + side + 'Width']) && !['none', 'hidden'].includes(style['border' + side + 'Style'])) properties.push('border' + side + 'Color');
    }
    if (parseFloat(style.outlineWidth) && style.outlineStyle !== 'none') properties.push('outlineColor');
    if (element.namespaceURI === 'http://www.w3.org/2000/svg') properties.push('fill', 'stroke');
    if (element.matches('input,textarea')) properties.push('caretColor', 'accentColor');
    if (style.textDecorationLine !== 'none') properties.push('textDecorationColor');
    const semantic = element.closest('.tier-m,.preview-group-badge,.reserved-pill,[data-preview-kpi],.staff-giphy-credit')
      || (element.matches('span.rounded-full') && element.className.includes('bg-blue-') && /^(Open|Completed|Ordered|Pending|Received)$/.test(element.textContent.trim()));
    const accent = style.getPropertyValue('--cmpri-action-rgb').trim();
    const base = style.getPropertyValue('--cmpri-modal-base').trim();
    const paletteHighlight = accent && base && element.matches('.cmpri-searchable-select-listbox [role=option]')
      && [16, 27].some(percent => rgba(style.backgroundColor).every((value, index) => Math.abs(value - rgba(`color-mix(in srgb,rgb(${accent}) ${percent}%,${base})`)[index]) <= 1));
    const emit = (property, value) => {
      const item = { tag: element.tagName, id: element.id, class: element.getAttribute('class') || '', pseudo, property, value, text: (element.textContent || '').trim().slice(0, 70) };
      const expected = semantic || (paletteHighlight && property === 'backgroundColor');
      if (expected) item.reason = semantic ? 'Intentional brand or status color' : 'Matches the assigned modal highlight palette';
      (expected ? exceptions : findings).push(item);
    };
    for (const property of properties) {
      stats.paintProperties++;
      if (navy(style[property])) emit(property, style[property]);
    }
    for (const property of ['backgroundImage', 'boxShadow', 'textShadow', 'filter']) {
      const value = style[property];
      if (!value || value === 'none') continue;
      stats.paintProperties++;
      const colors = value.match(/#[a-f\d]{3,8}\b|(?:rgba?|color|lab|oklab|lch|oklch)\([^)]*\)/gi) || [];
      if (colors.some(navy)) emit(property, value);
    }
  }
  const modes = ['rest'];
  function scan(mode) {
  for (const element of document.querySelectorAll(selector)) {
    if (['SCRIPT', 'STYLE', 'LINK', 'META'].includes(element.tagName)) continue;
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const option = element.matches('option,optgroup') && element.closest('select')?.getClientRects().length;
    if (!option && (style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height || !element.getClientRects().length)) continue;
    stats.elements++;
    const first = findings.length, firstException = exceptions.length;
    inspect(element, style);
    for (const pseudo of ['::before', '::after']) {
      const computed = getComputedStyle(element, pseudo);
      if (computed.content === 'none' || computed.content === 'normal' || computed.display === 'none') continue;
      stats.pseudoElements++;
      inspect(element, computed, pseudo);
    }
    if (element.matches('input[placeholder],textarea[placeholder]')) {
      stats.pseudoElements++;
      inspect(element, getComputedStyle(element, '::placeholder'), '::placeholder');
    }
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
      for (const pseudo of ['::-webkit-scrollbar', '::-webkit-scrollbar-track', '::-webkit-scrollbar-thumb', '::-webkit-scrollbar-corner']) {
        stats.pseudoElements++;
        inspect(element, getComputedStyle(element, pseudo), pseudo);
      }
    }
    for (let index = first; index < findings.length; index++) findings[index].state = mode;
    for (let index = firstException; index < exceptions.length; index++) exceptions[index].state = mode;
  }
  }
  scan('rest');
  // Exercise every rendered element's authored CSS states without clicking
  // buttons, changing field values, or dispatching application events.
  const originals = [], nodes = [...document.querySelectorAll(selector)];
  const statePattern = /:(hover|active|focus-visible|focus-within|focus|disabled|checked)\b/g;
  function rewrite(rules) {
    for (const rule of rules) {
      if (rule.selectorText && !rule.selectorText.includes('::-webkit-') && /:(hover|active|focus|disabled|checked)/.test(rule.selectorText)) {
        const original = rule.selectorText;
        const next = original.replace(statePattern, ':is($&,[data-cmpri-audit-$1])');
        rule.selectorText = next;
        if (rule.selectorText !== original) originals.push([rule, original]);
      } else if (rule.cssRules) rewrite(rule.cssRules);
    }
  }
  const noMotion = document.createElement('style');
  noMotion.textContent = '*{transition:none!important;animation:none!important}';
  document.head.append(noMotion);
  try {
    for (const sheet of document.styleSheets) {
      try { rewrite(sheet.cssRules); } catch { /* Cross-origin sheets cannot be inspected. */ }
    }
    for (const states of [['hover'], ['hover', 'active'], ['focus'], ['focus', 'focus-visible', 'focus-within'], ['disabled'], ['checked']]) {
      for (const node of nodes) for (const state of states) {
        if (state === 'disabled' && !node.matches('button,input,select,textarea,fieldset,option,optgroup')) continue;
        if (state === 'checked' && !node.matches('input,option')) continue;
        node.setAttribute('data-cmpri-audit-' + state, '');
      }
      const mode = states.join('+'); modes.push(mode); scan(mode);
      for (const node of nodes) for (const state of states) node.removeAttribute('data-cmpri-audit-' + state);
    }
  } finally {
    for (const [rule, original] of originals) rule.selectorText = original;
    for (const node of nodes) for (const state of ['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'disabled', 'checked']) node.removeAttribute('data-cmpri-audit-' + state);
    noMotion.remove();
  }
  return { findings, exceptions, stats, modes, stateRulesInspected: originals.length };
}

