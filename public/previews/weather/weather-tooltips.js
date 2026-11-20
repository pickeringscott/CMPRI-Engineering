/* Presentation-only tooltip casing for the Weather document. No feed data changes. */
(function () {
  'use strict';

  const BODY_SELECTOR = '[role="tooltip"], [data-weather-tooltip], .weather-tooltip, .wx-tooltip';
  const ATTRIBUTES = ['title', 'data-tooltip', 'data-tooltip-content'];
  const SELECTOR = '[title], svg title, ' + BODY_SELECTOR + ', [data-tooltip], [data-tooltip-content]';
  const SKIP_TEXT = 'script, style, textarea, code, kbd, samp';
  // Protect machine-readable provenance and measurements before casing prose.
  // Capitalization never lowercases existing letters, including acronyms.
  const PROTECTED = [
    /\b(?:https?|ftp):\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi,
    /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi,
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi,
    /`[^`]*`/g,
    /(?<![\p{L}\p{N}])(?:\.{0,2}\/)[^\s<>"']+/gu,
    /\b(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+(?:[?#][^\s<>"']*)?/gi,
    /\b[\w.-]+\/[\w./-]*_[\w./-]*(?:[?#][^\s<>"']*)?/g,
    /\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}-]+)+\b/gu,
    /\b(?:wmoUnit|EPSG|urn|unitCode):[^\s<>"']+/g,
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
    /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g,
    /\b\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?\b/g,
    /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)\b/gi,
    /\b(?:dBZ|dB|mph|kph|kmh|mps|kt|kts|kn|mm|cm|hPa|kPa|mb|inHg|degC|degF)\b/g,
    /\b(?:m\/s|km\/h|goes-lir)\b/g,
    /[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:°[CFcf]|m\/s|km\/h|mph|kph|mm|cm|in|ft|mi|min|hr|h|s|m)\b/g,
  ];

  function prose(text) {
    return text.replace(/\p{L}[\p{L}\p{M}'’]*/gu, word => word[0].toLocaleUpperCase('en-US') + word.slice(1));
  }

  function titleCase(input) {
    const text = String(input ?? '');
    const ranges = [];
    for (const expression of PROTECTED) {
      expression.lastIndex = 0;
      for (const match of text.matchAll(expression)) ranges.push([match.index, match.index + match[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let result = '', cursor = 0;
    for (const [start, end] of ranges) {
      if (end <= cursor) continue;
      if (start > cursor) result += prose(text.slice(cursor, start));
      result += text.slice(Math.max(cursor, start), end);
      cursor = end;
    }
    return result + prose(text.slice(cursor));
  }

  let observer = null, scans = 0, writes = 0;

  function svgTitle(node) {
    return node?.nodeType === 1 && node.namespaceURI === 'http://www.w3.org/2000/svg' && node.localName === 'title';
  }
  function tooltipBody(node) {
    if (!node || node.nodeType !== 1) return null;
    return node.closest(BODY_SELECTOR + ', svg title');
  }
  function textNode(node) {
    const parent = node.parentElement;
    if (!parent || !tooltipBody(parent) || parent.closest(SKIP_TEXT)) return;
    const next = titleCase(node.nodeValue);
    if (next !== node.nodeValue) { node.nodeValue = next; writes += 1; }
  }
  function tooltip(node) {
    if (!node || node.nodeType !== 1) return;
    for (const attribute of ATTRIBUTES) {
      if (!node.hasAttribute(attribute)) continue;
      const current = node.getAttribute(attribute), next = titleCase(current);
      if (next !== current) { node.setAttribute(attribute, next); writes += 1; }
    }
    if (svgTitle(node) || node.matches(BODY_SELECTOR)) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) textNode(walker.currentNode);
    }
  }
  function scan(node) {
    if (!node) return;
    if (node.nodeType === 3) { textNode(node); return; }
    if (![1, 9, 11].includes(node.nodeType)) return;
    scans += 1;
    if (node.nodeType === 1) {
      tooltip(node);
      // A new span inside a custom tooltip inherits its tooltip context.
      if (tooltipBody(node) && !node.matches(BODY_SELECTOR) && !svgTitle(node)) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) textNode(walker.currentNode);
      }
    }
    node.querySelectorAll(SELECTOR).forEach(tooltip);
  }
  function init() {
    if (observer || !document.documentElement) return;
    scan(document.documentElement);
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') tooltip(record.target);
        else if (record.type === 'characterData') textNode(record.target);
        else for (const added of record.addedNodes) scan(added);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: [...ATTRIBUTES, 'role', 'data-weather-tooltip', 'class'] });
  }
  function disconnect() {
    observer?.disconnect(); observer = null;
    document.removeEventListener('DOMContentLoaded', init);
  }

  window.cmpriWeatherTooltips = Object.freeze({ titleCase, init, disconnect,
    getState: () => ({ observing: observer !== null, scans, writes }) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  window.addEventListener('pagehide', disconnect);
  window.addEventListener('pageshow', init);
}());
