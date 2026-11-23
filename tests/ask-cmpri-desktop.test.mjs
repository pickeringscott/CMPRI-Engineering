import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

function fixture(initialWidth = 1440) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <header class="cmpri-dashboard-titlebar"><div class="cmpri-header-shelf"></div>
      <nav class="cmpri-dashboard-menu-rail"><div class="cmpri-header-v23 anchored-menu">
        <div class="anchored-groups"><fieldset class="group"><legend role="button">Daily Work</legend></fieldset></div>
      </div></nav>
    </header></body></html>`, { url: "https://cmpri.test/engineering" });
  const { window } = dom, { document } = window;
  let width = initialWidth;
  const queries = [];
  const opens = [];
  const match = query => query.split(/\s+and\s+/).every(part => {
    const size = part.match(/^\((min|max)-width:\s*(\d+)px\)$/);
    if (size) return size[1] === "min" ? width >= Number(size[2]) : width <= Number(size[2]);
    // A touch-capable installed desktop window has no primary hover device.
    if (part === "(hover: hover)") return false;
    if (part === "(hover: none)" || part === "(pointer: coarse)") return true;
    throw new Error("Unsupported fixture media query: " + query);
  });
  const matchMedia = query => {
    const media = new window.EventTarget();
    Object.defineProperty(media, "matches", { get: () => match(query) });
    queries.push(media);
    return media;
  };
  Object.defineProperty(document.documentElement, "clientWidth", { get: () => width });
  window.HTMLCanvasElement.prototype.getContext = () => null;
  const rect = (left = 0, top = 80, w = width, height = 20) => ({
    x: left, y: top, left, top, width: w, height, right: left + w, bottom: top + height,
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.tagName === "LEGEND") return rect((parseFloat(this.parentElement.style.left) || 0) + 14, 80, 90, 16);
    if (this.classList.contains("desktop-ask-search")) return rect(parseFloat(this.style.left) || 0, parseFloat(this.style.top) || 97, parseFloat(this.style.width) || 130, 24);
    if (this.tagName === "BUTTON") return rect(0, 0, 20, 20);
    if (this.hidden) return rect(0, 0, 0, 0);
    return rect();
  };
  window.Range.prototype.getBoundingClientRect = function () {
    const box = this.commonAncestorContainer.getBoundingClientRect();
    return rect(box.left + 6, box.top, 70, box.height);
  };
  Object.defineProperties(window.HTMLElement.prototype, {
    offsetWidth: { get() { return this.getBoundingClientRect().width; } },
    offsetHeight: { get() { return this.getBoundingClientRect().height; } },
    scrollHeight: { get() { return 20; } },
  });
  // JSDOM supplies no native modal top layer; this fixture starts without one.
  const selectAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => selectAll(selector === "dialog:modal" ? "dialog[open]" : selector);
  const closest = window.Element.prototype.closest;
  window.Element.prototype.closest = function (selector) {
    return closest.call(this, selector === "dialog:modal" ? "dialog[open]" : selector);
  };
  const getComputedStyle = element => {
    const styles = window.getComputedStyle(element);
    return new Proxy(styles, { get(target, property) {
      if (property === "getPropertyValue") return target.getPropertyValue.bind(target);
      if (["paddingLeft", "paddingRight", "columnGap", "borderLeftWidth"].includes(property)) return target[property] || "0px";
      return target[property];
    } });
  };
  const Observer = class { observe() {} disconnect() {} };
  const root = document.querySelector(".cmpri-header-v23");
  const native = root.querySelector("fieldset");
  native.positionX = 0;
  window.addEventListener("cmpri-ask-open", event => opens.push(event.detail));
  const { mountAskDashboardLauncher } = loadTs("src/lib/ui/ask-dashboard-launcher.js", {}, {
    window, document, localStorage: window.localStorage, matchMedia, getComputedStyle,
    AbortController: window.AbortController, Event: window.Event, CustomEvent: window.CustomEvent,
    HTMLDialogElement: window.HTMLDialogElement, ResizeObserver: Observer, MutationObserver: Observer,
  });
  const launcher = mountAskDashboardLauncher(root, "fixture-user", value => value);
  assert.ok(launcher);
  return {
    window, document, opens, launcher, native,
    input: document.querySelector("#desktop-ask-query"),
    tab: document.querySelector("#desktop-ask-tab"),
    form: document.querySelector("#desktop-ask-search"),
    mobile: document.querySelector(".cmpri-ask-mobile-launcher"),
    resize(nextWidth) {
      const before = queries.map(query => query.matches);
      width = nextWidth;
      queries.forEach((query, i) => { if (query.matches !== before[i]) query.dispatchEvent(new window.Event("change")); });
    },
    close() { launcher.dispose(); window.close(); },
  };
}

test("a wide no-hover dashboard positions the full Ask launcher and submits the typed query", () => {
  const h = fixture();
  try {
    assert.equal(h.tab.getAttribute("aria-expanded"), "true");
    assert.ok(parseFloat(h.form.style.width) >= 110, "the desktop form receives its measured width");
    assert.ok(Number.isFinite(parseFloat(h.form.style.left)));
    assert.equal(h.form.hasAttribute("data-tab-offscreen"), false);
    assert.ok(parseFloat(h.document.body.style.getPropertyValue("--ask-launcher-clearance")) > 0);
    h.input.value = "Which rooms have late checkouts?";
    h.input.dispatchEvent(new h.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    h.input.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    assert.equal(h.opens.length, 1);
    assert.equal(h.opens[0].query, "Which rooms have late checkouts?");
    assert.equal(h.opens[0].tab, "search");
    assert.equal(h.launcher.getState().query, "Which rooms have late checkouts?");
  } finally { h.close(); }
});

test("switching between phone and wide touch layouts retains the draft and restores launcher state", () => {
  const h = fixture(390);
  try {
    assert.equal(h.tab.getAttribute("aria-expanded"), "false");
    assert.equal(h.form.style.width, "");
    h.mobile.click();
    assert.equal(h.opens.length, 1);
    assert.equal(h.opens[0].opener, h.mobile);
    h.resize(1440);
    assert.equal(h.tab.getAttribute("aria-expanded"), "true");
    h.input.value = "Find the Navien manual";
    h.input.dispatchEvent(new h.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    h.resize(700);
    assert.equal(h.tab.getAttribute("aria-expanded"), "false");
    assert.equal(h.launcher.getState().query, "Find the Navien manual");
    h.resize(701);
    assert.equal(h.tab.getAttribute("aria-expanded"), "true");
    assert.equal(h.input.value, "Find the Navien manual");
    assert.equal(h.launcher.getState().query, "Find the Navien manual");
    h.window.dispatchEvent(new h.window.CustomEvent("cmpri-ask-state", { detail: { open: true } }));
    assert.equal(h.form.hasAttribute("data-modal-open"), true);
    h.window.dispatchEvent(new h.window.CustomEvent("cmpri-ask-state", { detail: { open: false } }));
    assert.equal(h.form.hasAttribute("data-modal-open"), false);
    assert.equal(h.tab.getAttribute("aria-expanded"), "true");
    assert.equal(h.input.value, "Find the Navien manual");
  } finally { h.close(); }
});
