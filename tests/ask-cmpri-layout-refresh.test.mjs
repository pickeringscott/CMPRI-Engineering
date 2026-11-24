import * as notepadNavigation from "../src/lib/ui/notepad-navigation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import * as jsx from "react/jsx-runtime";
import { JSDOM } from "jsdom";
import * as layouts from "../src/lib/header-layout.ts";
import { loadTs } from "./helpers/load-ts.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const layout = width => layouts.normalizeHeaderLayout({ groups: ["Account"], widths: { Account: width } });

async function fixture(askEnabled = false) {
  window.localStorage.clear();
  document.body.classList.remove("drag-active");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), calls = [], mounted = [], launches = [];
  let server = layout(200), notify, save, element, readGate, writeGate, stopped = false, launch;
  const translator = value => value;
  const mount = (host, _groups, _launch, value, changed) => {
    launch = _launch;
    element = host; save = changed; host.textContent = JSON.stringify(value); mounted.push(value);
    const dispose = () => { host.replaceChildren(); }; dispose.setPresentation = () => {};
    return dispose;
  };
  const Component = loadTs("src/components/desktop/ApprovedDashboardMenus.tsx", {
    react: React, "react/jsx-runtime": jsx, "@/lib/ui/notepad-navigation": notepadNavigation,
    "@/components/UiLanguageProvider": { useUiLanguage: () => ({ t: translator, tt: translator }) },
    "@/lib/ui/approved-header-menus": { mountApprovedMenus: mount }, "@/lib/ui/anchored-dashboard-menus": { mountAnchoredMenus: mount },
    "@/lib/ui/ask-dashboard-launcher": {}, "@/lib/ui/header-palette": { modalLauncherStyle: () => ({}) },
    "@/lib/header-layout": layouts, "@/lib/staff-notes-unread": { useStaffNotesSummary: () => null },
    "@/lib/supabase/client": { getValidSession: async () => ({ user: { id: "actor" }, access_token: "current-session" }) },
    "@/lib/events/browser": { subscribeResources: (topics, callback, initial) => {
      assert.deepEqual(Array.from(topics), ["session"]); assert.equal(initial, false);
      notify = callback; return () => { stopped = true; };
    } }, "@/app/ask-dashboard-launcher.css": {},
  }, { window, document, HTMLElement, MutationObserver, localStorage: window.localStorage, CustomEvent: dom.window.CustomEvent,
    fetch: async (url, options) => {
      assert.equal(url, "/api/profile/header-layout"); assert.equal(options.headers.Authorization, "Bearer current-session");
      const method = options.method || "GET"; calls.push(method);
      if (method === "PUT") {
        const next = JSON.parse(options.body).layout; if (writeGate) await writeGate.promise;
        server = next; return Response.json({ layout: next });
      }
      const snapshot = structuredClone(server); if (readGate) await readGate.promise;
      return Response.json({ layout: snapshot });
    },
  }).default;
  await act(async () => {
    root.render(React.createElement(Component, { groups: [{ label: "Account", items: [{ key: "/profile", label: "Manage Profile" }] }],
      onLaunch: (...args) => launches.push(args), askEnabled, userId: "actor", hotelId: "hotel" })); await flush(); await flush();
  });
  return { calls, mounted, launches, launch: (...args) => launch(...args), displayed: () => JSON.parse(element.textContent), server: width => { server = layout(width); },
    holdRead: () => { readGate = deferred(); return readGate; }, holdWrite: () => { writeGate = deferred(); return writeGate; },
    async release(gate) { await act(async () => { gate.resolve(); await flush(); await flush(); }); },
    async signal(count = 1) { await act(async () => { for (let index = 0; index < count; index++) void notify(); await flush(); await flush(); }); },
    async edit(width) { await act(async () => { const next = layout(width); element.textContent = JSON.stringify(next); save(next); await flush(); }); },
    async gesture(active) { await act(async () => { document.body.classList.toggle("drag-active", active); await flush(); await flush(); }); },
    async close() { await act(async () => { root.unmount(); await flush(); }); assert.equal(stopped, true); container.remove(); },
  };
}

test("the Notepad button launches its own window even when Ask CMPRI is enabled", async () => {
  const f = await fixture(true), asks = [];
  const onAsk = event => asks.push(event.detail);
  window.addEventListener("cmpri-ask-open", onAsk);
  try {
    const action = { key: "/notepad", label: "Notepad" }, opener = document.createElement("button");
    f.launch(action, 100, opener);
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0][0], action);
    assert.equal(f.launches[0][1], 100);
    assert.equal(f.launches[0][2], opener);
    assert.deepEqual(asks, []);
  } finally { window.removeEventListener("cmpri-ask-open", onAsk); await f.close(); }
});

test("a confirmed Ask resource event applies the current saved dashboard layout without a focus/reload event", async () => {
  const f = await fixture();
  try {
    assert.equal(f.displayed().widths.Account, 200);
    f.server(350); await f.signal();
    assert.equal(f.displayed().widths.Account, 350);
    assert.deepEqual(f.calls, ["GET", "GET"]);
  } finally { await f.close(); }
});

test("layout refresh waits for unsaved gestures and queued saves, then coalesces the pending resource events", async () => {
  const f = await fixture();
  try {
    await f.gesture(true); f.server(350); await f.signal(3);
    assert.deepEqual(f.calls, ["GET"]);
    assert.equal(f.displayed().widths.Account, 200);
    await f.gesture(false);
    assert.equal(f.displayed().widths.Account, 350);
    const write = f.holdWrite(); await f.edit(420); await f.signal(3);
    assert.deepEqual(f.calls, ["GET", "GET", "PUT"]);
    assert.equal(f.displayed().widths.Account, 420, "the pending local layout stays visible");
    await f.release(write);
    assert.deepEqual(f.calls, ["GET", "GET", "PUT", "GET"]);
    assert.equal(f.displayed().widths.Account, 420);
  } finally { await f.close(); }
});

test("late layout reads cannot replace a new local edit or remount an unmounted menu", async () => {
  const f = await fixture();
  const read = f.holdRead(); f.server(350); await f.signal();
  await f.edit(480); await f.release(read);
  assert.equal(f.displayed().widths.Account, 480);
  const pending = f.holdRead(); f.server(550); await f.signal();
  const count = f.mounted.length; await f.close(); await f.release(pending);
  assert.equal(f.mounted.length, count);
});
