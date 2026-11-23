import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import * as jsx from "react/jsx-runtime";
import { JSDOM } from "jsdom";
import { loadTs } from "./helpers/load-ts.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://cmpri.test/engineering" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test("Files keeps explicitly selected binary originals when OCR has no text and leaves unselected files local", async () => {
  localStorageSetup();
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const selections = [];
  const { AskCmpriFiles } = loadTs("src/components/ask-cmpri/AskCmpriFiles.tsx", {
    react: React, "react/jsx-runtime": jsx,
    "@/components/UiLanguageProvider": { useUiLanguage: () => ({ locale: "en-US", t: (text, _spanish, values) => text.replace(/\{([^}]+)\}/g, (_, key) => values?.[key] || key) }) },
    "./local-file-storage": { supportsAskCmpriFolder: () => false, loadAskCmpriFolder: async () => null, setActiveAskCmpriFolder: () => {} },
    "./AskCmpriFiles.module.css": { default: {} },
    "@/lib/ocr/local-ocr": { recognizeLocalDocument: async () => { throw new Error("No text extractor for this binary original"); } },
  }, { window, document, localStorage: window.localStorage, crypto, AbortController, File, URL, queueMicrotask, Node: dom.window.Node });
  const selected = new File([new Uint8Array([0, 255, 1])], "Selected.mp4", { type: "video/mp4" });
  const untouched = new File(["local-only"], "Not-selected.txt", { type: "text/plain" });
  try {
    await act(async () => { root.render(React.createElement(AskCmpriFiles, {
      open: true, active: true, scopeKey: "hotel:actor:Chief Engineer", selectionReset: 0, onOpenFiles() {},
      onFilesChange: (files, status) => selections.push({ files, status }),
    })); await settle(); });
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { value: [selected, untouched], configurable: true });
    await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); await settle(); });
    assert.equal(selections.at(-1).files.length, 0, "making files available does not select or upload the collection");
    const checkbox = [...container.querySelectorAll('input[type="checkbox"]')].find(control => control.getAttribute("aria-label")?.includes(selected.name));
    await act(async () => { checkbox.click(); await settle(); });
    const chosen = selections.at(-1);
    assert.equal(chosen.status.pending, 0); assert.equal(chosen.status.error, null);
    assert.equal(chosen.files.length, 1);
    assert.equal(chosen.files[0].original, selected);
    assert.equal(chosen.files[0].text, "");
    assert.match(container.textContent, /Original selected; no readable text preview/);
    assert.match(container.textContent, /1 \/ 20/);
    await act(async () => { checkbox.click(); await settle(); });
    assert.equal(selections.at(-1).files.length, 0);
  } finally {
    await act(async () => { root.unmount(); await settle(); }); container.remove();
  }
});

function localStorageSetup() {
  window.localStorage.clear();
  window.localStorage.setItem("cmpri:ask-files-consent:v1", "1");
}
