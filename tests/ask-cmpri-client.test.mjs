import * as notepadClose from "../src/lib/ui/notepad-close.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

async function fixture({ actualUploads = false } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const requests = [];
  const lookups = [];
  const answers = [];
  const navigated = [];
  const openedModules = [];
  const invalidations = [];
  const preferenceUpdates = [];
  dom.window.postMessage = (message, origin) => { preferenceUpdates.push({ message, origin }); };
  const stagedOriginals = [], removedOriginals = [];
  const uploadRequests = [], revokedFiles = new Set();
  let attachmentPicker, selectedFiles, stageGate;
  const moduleOpened = event => openedModules.push(event.detail.href);
  window.addEventListener("cmpri-open-modal", moduleOpened);
  const session = { hotelId: "hotel-fixture", user: { id: "chief-fixture", role: "Chief Engineer" }, capabilities: [] };
  const history = new Map();
  let sessionGate;
  let confirmationGate;
  let docs = { documents: [] };
  let documentsStatus = 200;
  let profile = { profile: { id: "chief-fixture" }, preferences: { language: "en", appearance: "dark" }, profile_settings_available: true };
  let popupBlocked = false;
  const popups = [];
  const empty = () => null;
  const spoken = [];
  let voiceOptions;
  const voice = { active: false, microphone: { text: "Microphone" }, refreshMicrophone: async () => {},
    stop() { this.active = false; }, start() { this.active = true; }, speak(text) { spoken.push(text); }, newTopic() {}, endFromText: () => false };
  dom.window.open = () => {
    if (popupBlocked) return null;
    const popup = { closed: false, opener: dom.window, location: { replace: url => navigated.push(url) },
      close() { this.closed = true; } };
    popups.push(popup);
    return popup;
  };
  const globals = {
    window, document, HTMLElement, Element, CustomEvent, URL, AbortController, AbortSignal, DOMException, File,
    crypto: { randomUUID: () => crypto.randomUUID(), subtle: { digest: async (_algorithm, bytes) => {
      const digest = createHash("sha256").update(Buffer.from(bytes)).digest();
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
    } } },
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
      if (url === "/api/profile") return Response.json(profile);
      if (actualUploads && url === "/api/ask-cmpri/files") {
        const body = JSON.parse(options.body);
        uploadRequests.push({ method: options.method, body });
        if (options.method === "DELETE") {
          revokedFiles.add(body.token || body.descriptor.id);
          return Response.json({ ok: true });
        }
        if (options.method === "POST") return Response.json({ descriptor: body,
          signedUrl: "https://storage.example.invalid/storage/v1/object/upload/sign/private/original?token=fixture", contentType: body.type });
        assert.equal(options.method, "PUT");
        return Response.json({ file: { ...body, token: `private-original-${body.id}`, expiresAt: Date.now() + 86400000 } });
      }
      if (actualUploads && url.startsWith("https://storage.example.invalid/")) {
        assert.equal(options.method, "PUT");
        assert.ok(options.body instanceof File);
        return new Response(null, { status: 200 });
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
      return typeof response === "function" ? response(body) : await response;
    },
  };
  const component = loadTs("src/components/ask-cmpri/AskCmpri.tsx", {
    react: React, "react/jsx-runtime": jsx, "next/navigation": { usePathname: () => "/engineering" },
    "@/components/UiLanguageProvider": { useUiLanguage: () => ({ language: "en", t: value => value }) },
    "@/lib/auth/client-session": { authorizationHeaders: async () => ({ Authorization: "Bearer fixture" }) },
    "@/lib/auth/session-storage": { SESSION_KEY: "fixture-session" },
    "@/lib/server/roles": loadTs("src/lib/server/roles.ts"),
    "@/lib/data-cache/browser": { invalidateCachedResources: async topics => { invalidations.push(topics); } },
    "@/components/beginners-guide/ask-cmpri-practice": {},
    "@/lib/ui/desktop-windows": { RESIZE_EDGES: [] },
    "@/lib/ui/window-telescope": { animateWindowTelescope: () => null, captureWindowLauncher: () => undefined },
    "@/lib/work-order-media": { workOrderMediaDigest: async () => "f".repeat(64) }, "@/lib/work-order-attachment-upload": {},
    "./AskCmpriAnswer": loadTs("src/components/ask-cmpri/AskCmpriAnswer.tsx", { "react/jsx-runtime": jsx }),
    "./AskCmpriFiles": { ASK_MAX_FILES: 20, ASK_MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024,
      isAskCmpriTicketMedia: file => file.type.startsWith("image/"), readAskCmpriFileExcerpt: file => file.text(),
      AskCmpriFiles: props => { selectedFiles = props; return null; } },
    "./original-file-upload": actualUploads ? loadTs("src/components/ask-cmpri/original-file-upload.ts", {}, globals) : { createAskOriginalFileStore: () => ({
      stage: async (original, scope, _authorize, signal) => {
        stagedOriginals.push({ original, scope });
        if (stageGate) await stageGate.promise;
        signal.throwIfAborted();
        return { id: crypto.randomUUID(), name: original.name, type: original.type || "application/octet-stream", size: original.size,
          sha256: "f".repeat(64), token: "fixture-private-file-token", expiresAt: Date.now() + 86400000 };
      },
      remove: async original => { removedOriginals.push(original); }, clear: async () => {},
    }) },
    "./AskCmpriAttachments": { AskCmpriAttachments: props => { attachmentPicker = props; return null; }, AskCmpriAttachmentDrafts: empty, AskCmpriFileList: empty,
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
    "./useAskCmpriLiveVoice": { useAskCmpriLiveVoice: options => { voiceOptions = options; return voice; } }, "./ask-cmpri.css": {},
  }, globals).default;
  await act(async () => { root.render(React.createElement(component)); await flush(); });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("cmpri-ask-open", { detail: {} }));
    await flush(); await flush();
  });
  const button = label => [...container.querySelectorAll("button")].find(item => item.textContent === label);
  return {
    container, requests, lookups, navigated, popups, button, openedModules, spoken, invalidations, stagedOriginals, removedOriginals, preferenceUpdates, uploadRequests, revokedFiles,
    profile: value => { profile = value; },
    async attach(files) { await act(async () => { attachmentPicker.onSelect(files); await flush(); }); },
    async select(files) { await act(async () => { selectedFiles.onFilesChange(files, { pending: 0, error: null }); await flush(); }); },
    holdStage: () => { stageGate = deferred(); return () => stageGate.resolve(); },
    queue: (body, status = 200) => answers.push(typeof body === "function" ? request => Response.json(body(request), { status }) : Response.json(body, { status })),
    holdSession: () => { sessionGate = deferred(); return () => { sessionGate.resolve(); sessionGate = undefined; }; },
    holdConfirmation: () => { confirmationGate = deferred(); return (body, status = 200) => confirmationGate.resolve(Response.json(body, { status })); },
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
    async type(value) {
      await act(async () => {
        const field = container.querySelector("#ask-cmpri-query");
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(field, value);
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await flush();
      });
    },
    async startVoice() {
      await act(async () => { container.querySelector('[aria-label="Start voice call"]').click(); await flush(); await flush(); });
    },
    async transcript(text) {
      await act(async () => { voiceOptions.onTranscript(text); await flush(); await flush(); });
    },
    async reopen(detail = {}) {
      await act(async () => {
        container.querySelector('[aria-label="Close Ask CMPRI"]').click();
        await flush();
        window.dispatchEvent(new CustomEvent("cmpri-ask-open", { detail }));
        await flush(); await flush();
      });
    },
    async remount(detail = {}) {
      await act(async () => { root.unmount(); await flush(); });
      root = createRoot(container);
      await act(async () => { root.render(React.createElement(component)); await flush(); });
      await act(async () => {
        window.dispatchEvent(new CustomEvent("cmpri-ask-open", { detail }));
        await flush(); await flush();
      });
    },
    async close() { await act(async () => { root.unmount(); await flush(); }); window.removeEventListener("cmpri-open-modal", moduleOpened); container.remove(); },
  };
}

test("ordinary reopen selects Search even with history and explicit History remains available", async () => {
  const h = await fixture();
  try {
    h.queue({ title: "Recorded answer", summary: "Existing history" });
    await h.submit("Find room 212.");
    await h.reopen();
    assert.equal(h.container.querySelector('#ask-cmpri-search-tab').getAttribute("aria-selected"), "true");
    assert.equal(h.container.querySelector('#ask-cmpri-search-view .ask-sample-question'), null);
    await h.reopen({ tab: "history" });
    assert.equal(h.container.querySelector('#ask-cmpri-history-tab').getAttribute("aria-selected"), "true");
  } finally { await h.close(); }
});

test("OpenAI picker stays attached and hides for any text until the composer is cleared", async () => {
  const h = await fixture();
  try {
    const picker = h.container.querySelector('.ask-search-pill .ask-voice-picker');
    const selector = picker.querySelector('select');
    assert.equal(picker.hidden, false);
    assert.equal(selector.options.length, 10);
    await act(async () => {
      selector.value = "cedar";
      selector.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await flush();
    });
    assert.equal(selector.value, "cedar");
    await h.type("A question");
    assert.equal(picker.hidden, true);
    await h.type(" ");
    assert.equal(picker.hidden, true, "whitespace is still composer text");
    await h.type("");
    assert.equal(picker.hidden, false);
    await h.reopen();
    assert.equal(h.container.querySelector('.ask-voice-picker select').value, "cedar");
  } finally { await h.close(); }
});

test("CMPRI module references open their native window and external module targets are ignored", async () => {
  const h = await fixture();
  try {
    h.queue({ title: "PM schedule", summary: "Remaining PMs", items: [{ id: "pm", title: "Preventive maintenance", source: "CMPRI",
      record: { kind: "module", id: "/engineering/preventive-maintenance", label: "Open PMs" } }] });
    await h.submit("Show PMs.");
    await h.click("Open PMs");
    assert.deepEqual(h.openedModules, ["/engineering/preventive-maintenance"]);
    await h.reopen();
    h.queue({ title: "Weather", summary: "", items: [{ id: "weather", title: "Weather", source: "CMPRI",
      record: { kind: "module", id: "/previews/cmpri-weather-preview.html", label: "Open weather" } }] });
    await h.submit("Show weather.");
    await h.click("Open weather");
    assert.deepEqual(h.openedModules, ["/engineering/preventive-maintenance", "/previews/cmpri-weather-preview.html"]);
    await h.reopen();
    const invalidPaths = ["//external.example/path", "https://external.example/path", "/../api/users", "/weather-preview.html", "/previews/cmpri-weather-preview.html/../api/users", "/api/users", "/api", "/unregistered.html"];
    h.queue({ title: "Invalid target", summary: "", items: invalidPaths.map((id, index) => ({ id: String(index), title: "Bad", source: "CMPRI",
      record: { kind: "module", id, label: `Invalid module ${index}` } })) });
    await h.submit("Show module.");
    for (const [index] of invalidPaths.entries()) await h.click(`Invalid module ${index}`);
    assert.equal(h.openedModules.length, 2);
  } finally { await h.close(); }
});

test("modal microphone replies use the chosen speech path and typed searches stay silent", async () => {
  const h = await fixture();
  try {
    h.queue({ title: "Room", summary: "The recorded room details." });
    await h.submit("Show room 212.");
    assert.equal(h.spoken.length, 0);
    await h.startVoice();
    h.queue({ title: "PM schedule", summary: "There are four PMs remaining." });
    await h.transcript("How many PMs remain?");
    assert.deepEqual(h.spoken, ["There are four PMs remaining."]);
  } finally { await h.close(); }
});

test("all twenty explicitly attached originals reach native Ask as private references without browser File objects", async () => {
  const h = await fixture();
  try {
    const files = Array.from({ length: 20 }, (_, index) => new File([`Original ${index}`], `Original-${index}.pdf`, { type: "application/pdf" }));
    await h.attach(files);
    h.queue({ title: "Originals received", summary: "Ready for the requested native review." });
    await h.submit("Review these files for a Staff Note.");
    assert.equal(h.stagedOriginals.length, 20);
    assert.ok(h.stagedOriginals.every((entry, index) => entry.original === files[index]));
    const request = h.requests.find(body => body.question);
    assert.equal(request.files.length, 20);
    assert.ok(request.files.every(file => file.file.token === "fixture-private-file-token" && !("original" in file)));
    assert.equal(request.attachments.length, 0, "PDFs are native originals, not invented legacy work-order photo metadata");
  } finally { await h.close(); }
});

test("Files selections upload only their original and retain submitted evidence for follow-ups", async () => {
  const h = await fixture();
  try {
    const selected = new File(["original spreadsheet"], "Selected.xlsx", { type: "application/octet-stream" });
    await h.select([{ id: "selected-local-file", name: selected.name, type: selected.type, size: selected.size, text: "", original: selected }]);
    h.queue({ title: "Selected source", summary: "Ready" });
    await h.submit("Import this selected original.");
    assert.equal(h.stagedOriginals.length, 1);
    assert.equal(h.stagedOriginals[0].original, selected);
    assert.equal(h.requests[0].files[0].file.name, selected.name);
    await h.select([]);
    assert.deepEqual(h.removedOriginals, [], "clearing a selection cannot revoke evidence needed by a pending confirmation");
    h.queue({ title: "Next question", summary: "Ready" });
    await h.submit("What is the pool status?");
    assert.equal(h.requests.at(-1).files[0].file.name, selected.name, "the same conversation keeps its explicitly supplied original");
  } finally { await h.close(); }
});

test("saved History resumes its original after a normal modal close or full unmount without revocation or reupload", async () => {
  for (const mode of ["close", "unmount"]) {
    const h = await fixture({ actualUploads: true });
    try {
      let original;
      await h.attach([new File(["original vendor source"], "Original.pdf", { type: "application/pdf" })]);
      h.queue(request => {
        original = request.files[0].file;
        return { title: "Original received", summary: "The attached original is available for this conversation.",
          context: { native: { files: [original] } } };
      });
      await h.submit("Review the original manual.");
      assert.ok(original?.token, "the real staging helper must finish before closing");
      assert.equal(h.uploadRequests.filter(call => call.method === "POST").length, 1);
      if (mode === "unmount") await h.remount({ tab: "history" });
      else await h.reopen({ tab: "history" });
      await h.click("Resume search");
      assert.equal(h.revokedFiles.size, 0, `${mode} must preserve originals referenced by retained History`);
      h.queue(request => {
        assert.deepEqual(request.previous.native.files, [original]);
        assert.equal(h.revokedFiles.has(original.token), false);
        return { title: "Original available", summary: "Follow-up used the same original.", context: request.previous };
      });
      await h.submit("Continue with that same original manual.");
      assert.match(h.container.textContent, /Follow-up used the same original/);
      assert.equal(h.uploadRequests.filter(call => call.method === "POST").length, 1, "resuming does not require selecting the original again");
      assert.equal(h.uploadRequests.some(call => call.method === "DELETE"), false);
    } finally { await h.close(); }
  }
});

test("closing an Ask task during original-file upload cannot send a late search", async () => {
  const h = await fixture();
  try {
    const release = h.holdStage();
    await h.attach([new File(["original"], "Manual.pdf", { type: "application/pdf" })]);
    await h.submit("Review this manual.");
    assert.equal(h.requests.length, 0);
    await h.reopen();
    await act(async () => { release(); await flush(); await flush(); });
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test("native CMPRI proposals use neutral confirmation and the existing confirmation lifecycle", async () => {
  const h = await fixture();
  try {
    h.queue({ title: "Review change", summary: "Review the proposed operation.", proposal: {
      token: "fixture-native-change-token", id: "pool-fixture", field: "cmpri", label: "Pool operation", from: "Open", to: "Closed", effects: [],
    } });
    await h.submit("Close the pool for maintenance.");
    assert.equal(h.invalidations.length, 0, "reviewing a proposal does not refresh other modules");
    assert.equal(h.preferenceUpdates.length, 0);
    h.profile({ profile: { id: "chief-fixture" }, preferences: { language: "es", appearance: "light" } });
    assert.ok(h.button("Confirm change"));
    const finish = h.holdConfirmation();
    await h.click("Confirm change");
    await act(async () => { finish({ title: "Change saved", summary: "Fixture saved" }); await flush(); await flush(); });
    assert.equal(h.button("Confirm change"), undefined);
    assert.equal(h.requests.filter(body => body.confirmationToken === "fixture-native-change-token").length, 1);
    assert.deepEqual(h.invalidations, [undefined], "a native change invalidates every affected CMPRI resource, including pool status");
    assert.deepEqual(JSON.parse(JSON.stringify(h.preferenceUpdates)), [{ origin: "https://cmpri.test", message: {
      type: "cmpri-profile-preferences-updated", preferences: { language: "es", appearance: "light" },
    } }], "only the current native profile readback updates the mounted language/theme");
  } finally { await h.close(); }
});

test("a failed native confirmation still refreshes resources because earlier batch operations may have saved", async () => {
  const h = await fixture();
  try {
    h.queue({ title: "Review changes", summary: "Review two operations.", proposal: {
      token: "native.fixture-batch", id: "fixture", field: "cmpri", label: "CMPRI operations", from: "", to: "Two changes", effects: [],
    } });
    await h.submit("Update the work order and pool.");
    h.profile({ profile: { id: "another-user" }, preferences: { language: "es", appearance: "light" } });
    const finish = h.holdConfirmation();
    await h.click("Confirm change");
    assert.equal(h.invalidations.length, 0, "do not refresh before the native attempt returns");
    await act(async () => {
      finish({ title: "Partly saved", summary: "One operation saved; the next was rejected." }, 409);
      await flush(); await flush();
    });
    assert.deepEqual(h.invalidations, [undefined]);
    assert.equal(h.preferenceUpdates.length, 0, "a different account's profile cannot change this window's language/theme");
    assert.match(h.container.textContent, /One operation saved/);
  } finally { await h.close(); }
});

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
    assert.deepEqual(Array.from(h.invalidations[0]), ["orders", "rooms", "reference"], "existing work-order confirmations keep their resource refresh");
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
    assert.equal(h.invalidations.length, 0, "cancelling does not invalidate CMPRI resources");
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

test("Ask has no embedded Notepad and legacy notebook requests open the standalone note window", async () => {
  const h = await fixture();
  try {
    assert.equal(h.button("Staff Notes"), undefined);
    assert.equal(h.button("Notepad"), undefined);
    assert.deepEqual([...h.container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent), ["Search", "History", "Files"]);
    assert.equal(h.container.querySelector(".cmpri-notepad-host,#ask-cmpri-staff-view"), null);
    for (const tab of ["notepad", "staff"]) {
      const noteId = tab === "notepad" ? "shared-project" : "legacy-staff-note";
      await h.remount({ tab, noteId });
      assert.equal(h.container.querySelector("#ask-cmpri").open, false);
      assert.equal(h.openedModules.at(-1), "/notepad?note=" + noteId);
    }
    await h.remount({ tab: "notepad" });
    assert.equal(h.openedModules.at(-1), "/notepad");
  } finally { await h.close(); }
});

test("Ask note results open the exact standalone Notepad record while authorized search remains available", async () => {
  const h = await fixture();
  try {
    for (const kind of ["staffNote", "personalNote"]) {
      await h.remount();
      const id = kind === "staffNote" ? "shared-project" : "private";
      h.queue({ title: "Saved note", summary: "Your saved note", items: [{ id: "note:" + id, title: "Note title", source: "CMPRI · Notepad", sourceType: "internal", record: { kind, id, label: "Open Notepad note" } }] });
      await h.submit("Find my note.");
      await h.click("Open Notepad note");
      assert.equal(h.openedModules.at(-1), "/notepad?note=" + id);
      assert.equal(h.container.querySelector("#ask-cmpri").open, false);
    }
  } finally { await h.close(); }
});

test("closing Ask does not flush or close the independent Notepad window", async () => {
  const h = await fixture();
  const host = document.createElement("div");host.className = "cmpri-notepad-host";document.body.append(host);
  try {
    let flushes = 0;
    host.addEventListener(notepadClose.NOTEPAD_CLOSE_REQUEST, event => { event.preventDefault(); flushes++; });
    await act(async () => { h.container.querySelector('[aria-label="Close Ask CMPRI"]').click(); await flush(); });
    assert.equal(flushes, 0);
    assert.equal(h.container.querySelector("#ask-cmpri").open, false);
    assert.equal(host.isConnected, true);
  } finally { host.remove(); await h.close(); }
});
