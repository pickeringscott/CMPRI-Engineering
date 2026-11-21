/* Catalogue-only localization for CMPRI's vanilla iframe documents; never mounted in React trees. */
(function () {
  'use strict';
  if (window.parent === window) return;
  const scope = document.currentScript?.dataset.uiScope || 'general';
  const SKIP = 'script,style,code,pre,kbd,samp,textarea,input,[translate="no"],[data-user-content],#npSafetySummary,.np-live-notification,.np-inbox-message';
  const ATTRS = ['title', 'aria-label', 'placeholder'];
  const TIPS = '[role="tooltip"],[data-weather-tooltip],.weather-tooltip,.wx-tooltip,svg title';
  const texts = new Map(), attributes = new Map();
  let language = 'en', catalogue = null, loading = null, pending = false, disposed = false;

  function compile(source) {
    const exact = new Map(Object.entries(source || {})), folded = new Map();
    for (const [key, value] of exact) folded.set(key.toLocaleLowerCase('en-US'), value);
    const patterns = [...exact].flatMap(([key, value]) => {
      const names = [...key.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
      const parts = key.split(/\{\w+\}/g);
      if (!names.length || !/[\p{L}]/u.test(parts[0])) return [];
      const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [{ prefix: parts[0].toLocaleLowerCase('en-US'), literalLength: parts.reduce((length, part) => length + part.length, 0), names, value, pattern: new RegExp('^' + parts.map(escape).join('([\\s\\S]+?)') + '$', 'i') }];
    }).sort((a, b) => b.prefix.length - a.prefix.length || b.literalLength - a.literalLength);
    return { exact, folded, patterns };
  }
  function translated(input) {
    if (language !== 'es' || !catalogue) return input;
    const match = input.match(/^(\s*)([\s\S]*?)(\s*)$/), core = match[2].replace(/\s+/g, ' '), lower = core.toLocaleLowerCase('en-US');
    for (const table of catalogue) {
      let value = table.exact.get(input) ?? table.exact.get(core) ?? table.folded.get(lower);
      if (value === undefined && core.endsWith(':')) value = table.folded.get(lower.slice(0, -1)) === undefined ? undefined : table.folded.get(lower.slice(0, -1)) + ':';
      if (value !== undefined) return match[1] + value.trim() + match[3];
      if (core.length <= 2000) for (const template of table.patterns) {
        if (!lower.startsWith(template.prefix)) continue;
        const found = template.pattern.exec(core); if (!found) continue;
        const values = Object.fromEntries(template.names.map((name, index) => [name, found[index + 1]]));
        return match[1] + template.value.replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token) + match[3];
      }
    }
    return input;
  }
  function text(node) {
    if (!node.parentElement || node.parentElement.closest(SKIP)) return;
    const raw = node.nodeValue || '', saved = texts.get(node);
    const original = saved && raw === saved.last ? saved.original : raw;
    let value = translated(original);
    if (value !== original && node.parentElement.closest(TIPS)) value = window.cmpriWeatherTooltips?.titleCase(value) || value;
    if (value !== original || saved) texts.set(node, { original, last: value });
    if (value !== raw) node.nodeValue = value;
  }
  function element(node) {
    if (node.closest(SKIP)) return;
    let saved = attributes.get(node);
    for (const attribute of ATTRS) {
      const raw = node.getAttribute(attribute); if (raw === null) continue;
      const previous = saved?.get(attribute), original = previous && raw === previous.last ? previous.original : raw;
      let value = translated(original);
      if (attribute === 'title' && value !== original) value = window.cmpriWeatherTooltips?.titleCase(value) || value;
      if (value !== original || previous) {
        if (!saved) { saved = new Map(); attributes.set(node, saved); }
        saved.set(attribute, { original, last: value });
      }
      if (value !== raw) node.setAttribute(attribute, value);
    }
  }
  function scan() {
    pending = false;
    if (disposed || !document.body) return;
    for (const node of texts.keys()) if (!node.isConnected) texts.delete(node);
    for (const node of attributes.keys()) if (!node.isConnected) attributes.delete(node);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) text(walker.currentNode);
    document.querySelectorAll('[title],[aria-label],[placeholder]').forEach(element);
  }
  function schedule() { if (!disposed && !pending) { pending = true; queueMicrotask(scan); } }
  async function setLanguage(next) {
    if (disposed) return;
    language = next;
    document.documentElement.lang = next;
    if (next === 'es' && !catalogue) {
      loading ||= fetch('/ui-language.es.json', { cache: 'no-store', credentials: 'same-origin' })
        .then(response => { if (!response.ok) throw Error('Language catalogue unavailable'); return response.json(); })
        .then(data => { catalogue = scope === 'weather' ? [compile(data.weather), compile(data.common)] : [compile(data.common)]; })
        .catch(() => { loading = null; });
      await loading;
    }
    schedule();
  }
  const receive = event => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'cmpri-ui-language') return;
    if (event.data.language === 'en' || event.data.language === 'es') void setLanguage(event.data.language);
  };
  const observer = new MutationObserver(schedule);
  function start() {
    disposed = false;
    pending = false;
    addEventListener('message', receive);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    try { void setLanguage(parent.document.documentElement.lang === 'es' ? 'es' : 'en'); }
    catch { schedule(); }
  }
  addEventListener('pagehide', () => {
    disposed = true; pending = false;
    observer.disconnect(); removeEventListener('message', receive);
  });
  addEventListener('pageshow', event => { if (event.persisted && disposed) start(); });
  start();
  window.cmpriUiLanguage = Object.freeze({ diagnostics: () => ({ language, loaded: Boolean(catalogue), textNodes: texts.size }) });
})();
