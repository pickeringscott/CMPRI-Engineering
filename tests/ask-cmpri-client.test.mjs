import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import * as jsx from "react/jsx-runtime";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const requests = [];
  const lookups = [];
  const answers = [];
  const navigated = [];
  const session = { hotelId: "hotel-fixture", user: { id: "chief-fixture", role: "Chief Engineer" }, capabilities: [] };
  const history = new Map();
  let sessionGate;
  let confirmationGate;
  let docs = { documents: [] };
  let documentsStatus = 200;
  let popupBlocked = false;
  const popups = [];
  const empty = () => null;
  const voice = { active: false, microphone: { text: "Microphone" }, refreshMicrophone: async () => {},
    stop() {}, start() {}, speak() {}, newTopic() {}, endFromText: () => false };
  dom.window.open = () => {
    if (popupBlocked) return null;
    const popup = { closed: false, opener: dom.window, location: { replace: url => navigated.push(url) },
      close() { this.closed = true; } };
    popups.push(popup);
    return popup;
  };
  const globals = {
    window, document, HTMLElement, Element, CustomEvent, URL, AbortController, DOMException, File, crypto,
    innerWidth: 1200, innerHeight: 900, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: callback => { queueMicrotask(() => callback(Date.now())); return 1; },
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url, options = {}) => {
      if (url === "/api/session") {
        if (sessionGate) await sessionGate.promise;
        return Response.json(session);
      }
      if (url.startsWith("/api/assets/documentation?")) {
        lookups.push({ url, headers: options.headers });
        return Response.json(docs, { status: documentsStatus });
      }
      assert.equal(url, "/api/ask-cmpri", "no media bytes or unrelated API may be fetched");
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.cancel) return Response.json({ title: "Change cancelled", summary: "No change saved." });
      if (body.confirmationToken) {
        assert.ok(confirmationGate, "unexpected work-order confirmation");
        return await confirmationGate.promise;
      }
      const response = answers.shift();
      assert.ok(response, "the test must supply each answer");
      return await response;
    },
  };
  const component = loadTs("src/components/ask-cmpri/AskCmpri.tsx", {
    react: React, "react/jsx-runtime": jsx, "next/navigation": { usePathname: () => "/engineering" },
    "@/components/StaffNotes": { default: empty },
    "@/components/UiLanguageProvider": { useUiLanguage: () => ({ language: "en", t: value => value }) },
    "@/lib/auth/client-session": { authorizationHeaders: async () => ({ Authorization: "Bearer fixture" }) },
    "@/lib/auth/session-storage": { SESSION_KEY: "fixture-session" },
    "@/components/beginners-guide/ask-cmpri-practice": {},
    "@/lib/ui/desktop-windows": { RESIZE_EDGES: [] },
    "@/lib/ui/window-telescope": { animateWindowTelescope: () => null, captureWindowLauncher: () => undefined },
    "@/lib/work-order-media": {}, "@/lib/work-order-attachment-upload": {},
    "./AskCmpriAnswer": loadTs("src/components/ask-cmpri/AskCmpriAnswer.tsx", { "react/jsx-runtime": jsx }),
    "./AskCmpriFiles": { ASK_MAX_FILES: 8, ASK_MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024, AskCmpriFiles: empty },
    "./AskCmpriAttachments": { AskCmpriAttachments: empty, AskCmpriAttachmentDrafts: empty,
      AskCmpriDownloadList: empty, useAskCmpriAttachmentDrop: () => ({ dropProps: {}, dragging: false }) },
    "./ask-history": {
      readAskHistory: () => [...history.values()], savedAskTurn: turn => turn,
      updateAskHistoryEntry: (_scope, id, change) => {
        const next = change(history.get(id));
        if (next) history.set(id, next);
        return [...history.values()];
      },
    },
    "./ask-attachment-recovery": { readAskAttachmentRecoveries: async () => [] },
    "./useAskCmpriVoice": { useAskCmpriVoice: () => voice }, "./ask-cmpri.css": {},
  }, globals).default;
  await act(async () => { root.render(React.createElement(component)); await flush(); });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("cmpri-ask-open", { detail: {} }));
    await flush(); await flush();
  });
  const button = label => [...container.querySelectorAll("button")].find(item => item.textContent === label);
  return {
    container, requests, lookups, navigated, popups, button,
    queue: (body, status = 200) => answers.push(Response.json(body, { status })),
    holdSession: () => { sessionGate = deferred(); return () => { sessionGate.resolve(); sessionGate = undefined; }; },
    holdConfirmation: () => { confirmationGate = deferred(); return body => confirmationGate.resolve(Response.json(body)); },
    documents: (value, status = 200) => { docs = value; documentsStatus = status; },
    blockPopup: () => { popupBlocked = true; },
    async submit(question) {
      await act(async () => {
        const field = container.querySelector("#ask-cmpri-query");
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(field, question);
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        container.querySelector(".ask-search-pill").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        await flush(); await flush();
      });
    },
    async click(label) {
      await act(async () => { assert.ok(button(label), label); button(label).click(); await flush(); await flush(); });
    },
    async close() { await act(async () => { root.unmount(); await flush(); }); container.remove(); },
  };
}

const proposal = {
  title: "Review proposed change", summary: "Create work order",
  proposal: { token: "fixture-proposal-token", id: "location-319", field: "create", label: "Create work order", to: "319 · Toilet issue" },
  context: { rooms: ["319"], pending: { field: "create", needs: "review", value: "Toilet issue" } },
};

test("a correcting follow-up retires the old review before authorization and after a failed reply", async () => {
  const h = await fixture();
  try {
    h.queue(proposal);
    await h.submit("Create a work order for room 319: toilet issue.");
    assert.ok(h.button("Confirm submission"));
    const release = h.holdSession();
    h.queue({ error: "Synthetic reply failure" }, 502);
    await h.submit("The toilet will not flush.");
    assert.equal(h.button("Confirm submission"), undefined, "old confirmation disappears before network authorization completes");
    await act(async () => { release(); await flush(); await flush(); });
    assert.equal(h.button("Confirm submission"), undefined, "failed replacement cannot restore an outdated review");
    assert.ok(h.requests.some(body => body.cancel && body.confirmationToken === proposal.proposal.token));
    const followUp = h.requests.find(body => body.question === "The toilet will not flush.");
    assert.deepEqual(followUp.previous.rooms, ["319"], "retiring the control preserves the selected room for the correction");
    assert.equal(followUp.previous.pending.field, "create");
    assert.equal(h.requests.filter(body => body.confirmationToken && !body.cancel).length, 0);
  } finally { await h.close(); }
});

test("a question cannot race a confirmation that is already saving", async () => {
  const h = await fixture();
  try {
    h.queue(proposal);
    await h.submit("Create a work order for room 319: toilet issue.");
    const finish = h.holdConfirmation();
    await h.click("Confirm submission");
    await h.submit("The toilet will not flush.");
    assert.equal(h.requests.filter(body => body.question).length, 1);
    assert.equal(h.requests.filter(body => body.cancel).length, 0);
    await act(async () => { finish({ title: "Work order created", summary: "Fixture saved" }); await flush(); await flush(); });
    assert.equal(h.button("Confirm submission"), undefined);
  } finally { await h.close(); }
});

test("a typed cancellation retires the review without sending a new model request", async () => {
  const h = await fixture();
  try {
    h.queue(proposal);
    await h.submit("Create a work order for room 319: toilet issue.");
    await h.submit("Cancel that");
    assert.equal(h.button("Confirm submission"), undefined);
    assert.equal(h.requests.filter(body => body.question).length, 1);
    assert.equal(h.requests.filter(body => body.cancel).length, 1);
    assert.match(h.container.textContent, /Change cancelled/);
  } finally { await h.close(); }
});

const manualAnswer = {
  title: "Equipment manual", summary: "Registered manual",
  items: [{ id: "asset-fixture", title: "Laundry equipment", source: "CMPRI · Assets",
    links: [{ kind: "file", id: "wanted-document", assetId: "exact-asset", label: "Service manual.pdf" }] }],
};

test("a registered manual resolves its exact authorized document and does not prefetch PDF bytes", async () => {
  const h = await fixture();
  try {
    h.documents({ documents: [
      { id: "other-document", name: "Other.pdf", url: "https://files.example/other.pdf" },
      { id: "wanted-document", name: "Service manual.pdf", url: "https://files.example/manual.pdf" },
    ] });
    h.queue(manualAnswer);
    await h.submit("Find the registered manual.");
    await h.click("Service manual.pdf");
    assert.deepEqual(h.navigated, ["https://files.example/manual.pdf"]);
    assert.equal(h.lookups.length, 1);
    assert.equal(h.lookups[0].url, "/api/assets/documentation?asset_id=exact-asset");
    assert.equal(h.lookups[0].headers.Authorization, "Bearer fixture");
    assert.equal(h.popups[0].opener, null);
  } finally { await h.close(); }
});

test("a missing document closes the pending tab and a blocked popup gives a usable manual link", async () => {
  const h = await fixture();
  try {
    h.queue(manualAnswer);
    await h.submit("Find the registered manual.");
    await h.click("Service manual.pdf");
    assert.equal(h.popups[0].closed, true);
    assert.match(h.container.textContent, /manual is no longer available/);
    h.blockPopup();
    h.documents({ documents: [{ id: "wanted-document", name: "Service manual.pdf", url: "https://files.example/manual.pdf" }] });
    await h.click("Service manual.pdf");
    assert.equal(h.container.querySelector('a[href="https://files.example/manual.pdf"]')?.target, "_blank");
    assert.equal(h.navigated.length, 0);
  } finally { await h.close(); }
});
