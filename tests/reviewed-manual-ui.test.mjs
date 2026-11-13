import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function fixture(recognize) {
  let auth;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/LocalOcrReview.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, AbortController, Blob, Uint8Array, crypto: webcrypto, URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} }, require(name) {
    if (name === './PdfArtworkZoom') return { default: () => null };
    if(name==='./PdfHtmlPreview')return {default:()=>React.createElement('div',{'data-pdf-html-preview':true},'Original PDF preview')};if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '@/lib/supabase/client') return { createClient: () => ({ auth: { onAuthStateChange(fn) { auth = fn; return { data: { subscription: { unsubscribe() {} } } }; } } }) };
    if (name === '@/lib/ocr/local-ocr') return { localOcrFileKind: async () => 'pdf', recognizeLocalDocument: recognize || (async (_file, options) => ({ totalPages: 12, pages: [{ page: options.pageRange?.start || 1, text: 'Reviewed troubleshooting text' }] })) };
    throw new Error(name);
  }});
  return { Component: exports.default, signIn: () => auth('SIGNED_IN', { user: { id: 'user-1' } }), signOut: () => auth('SIGNED_OUT', null) };
}
const click = async label => act(async () => {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent === label);
  assert.ok(button, label); button.click();
});
async function prepare(f, root, callback) {
  await act(async () => root.render(React.createElement(f.Component, { onUseGuide: callback })));
  await act(async () => f.signIn());
  const bytes = new TextEncoder().encode('%PDF-1.7 exact selected bytes');
  const file = { name: 'manual.pdf', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  await act(async () => {
    const input = document.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await click('Read text');
  return bytes;
}

test('PDF guide handoff requires review, hashes selected bytes, and awaits success', async () => {
  const f = fixture(), root = createRoot(document.getElementById('root'));
  let resolve, captured, calls = 0;
  const bytes = await prepare(f, root, (result, signal) => { calls++; captured = { result, signal }; return new Promise(r => { resolve = r; }); });
  await click('Use reviewed text in guide');
  assert.equal(calls, 0);
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  // WebCrypto completes outside the React event microtask.
  for (let i = 0; i < 30 && !calls; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  assert.equal(calls, 1);
  assert.equal(captured.result.sha256, Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex'));
  assert.equal(captured.result.totalPages, 12);
  assert.equal(captured.result.pages[0].text, 'Reviewed troubleshooting text');
  assert.match(document.body.textContent, /Saving reviewed text/);
  assert.equal(document.querySelector('textarea').disabled, true);
  await click('Use reviewed text in guide');
  assert.equal(calls, 1);
  await act(async () => resolve('Saved reviewed guide pages.'));
  assert.match(document.body.textContent, /Saved reviewed guide pages/);
  await act(async () => root.unmount());
});

test('guide failure is shown, cancel and sign-out abort and suppress late success', async () => {
  const f = fixture(), root = createRoot(document.getElementById('root'));
  let mode = 'error', resolve, signal;
  await prepare(f, root, async (_result, s) => {
    signal = s;
    if (mode === 'error') throw new Error('Attach the same PDF first.');
    return new Promise(r => { resolve = r; });
  });
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && !document.querySelector('[role=alert]'); i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  assert.match(document.querySelector('[role=alert]').textContent, /Attach the same PDF/);
  mode = 'pending';
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && !resolve; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  await click('Cancel save');
  assert.equal(signal.aborted, true);
  await act(async () => resolve('STALE SUCCESS'));
  assert.doesNotMatch(document.body.textContent, /STALE SUCCESS/);
  resolve = null;
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && !resolve; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  await act(async () => f.signOut());
  assert.equal(signal.aborted, true);
  await act(async () => resolve('STALE SUCCESS'));
  assert.doesNotMatch(document.body.textContent, /STALE SUCCESS/);
  assert.equal(document.querySelector('textarea'), null);
  await act(async () => root.unmount());
});

test('clearing a cancelled save and unmounting suppress stale callbacks', async () => {
  const f = fixture(), root = createRoot(document.getElementById('root'));
  let resolve, signal;
  const callback = (_result, s) => { signal = s; return new Promise(r => { resolve = r; }); };
  await prepare(f, root, callback);
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && !resolve; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  await click('Cancel save');
  await click('Clear document');
  await act(async () => resolve('STALE CLEARED SUCCESS'));
  assert.doesNotMatch(document.body.textContent, /STALE CLEARED SUCCESS/);
  resolve = null;
  await prepare(f, root, callback);
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && !resolve; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  await act(async () => root.unmount());
  assert.equal(signal.aborted, true);
  await act(async () => resolve('STALE UNMOUNT SUCCESS'));
  assert.doesNotMatch(document.body.textContent, /STALE UNMOUNT SUCCESS/);
});

test('subsequent batches require fresh review and reopening starts with no stale document', async () => {
  const f = fixture(); let root = createRoot(document.getElementById('root'));
  const saved = [];
  const callback = async result => { saved.push(result); return 'Saved batch.'; };
  await prepare(f, root, callback);
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && saved.length < 1; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  await click('Read pages 2–11');
  assert.equal(document.querySelector('input[type=checkbox]').checked, false);
  await click('Use reviewed text in guide');
  assert.equal(saved.length, 1);
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && saved.length < 2; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  assert.equal(saved[1].pages[0].page, 2);
  assert.equal(saved[1].totalPages, 12);
  assert.equal(saved[1].sha256, saved[0].sha256);
  await act(async () => root.unmount());
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(f.Component, { onUseGuide: callback })));
  await act(async () => f.signIn());
  assert.equal(document.querySelector('textarea'), null);
  assert.equal([...document.querySelectorAll('button')].find(el => el.textContent === 'Read text').disabled, true);
  await act(async () => root.unmount());
});

test('switching files during hashing never sends the old PDF or its reviewed text', async () => {
  const f = fixture(), root = createRoot(document.getElementById('root'));
  let calls = 0, release;
  await prepare(f, root, async () => { calls++; return 'Saved.'; });
  await click('Clear document');
  const input = document.querySelector('input[type=file]');
  const first = { name: 'old.pdf', size: 8, arrayBuffer: () => new Promise(r => { release = r; }) };
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [first] });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await click('Read text');
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  assert.ok(release);
  // Synthetic change also covers a queued file-selection event despite disabled UI.
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'new.pdf', size: 8 }] });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    release(new TextEncoder().encode('%PDF-old').buffer);
  });
  assert.equal(calls, 0);
  assert.match(document.body.textContent, /new.pdf/);
  assert.equal(document.querySelector('textarea'), null);
  await act(async () => root.unmount());
});

test('mixed blank batches save only nonblank original page numbers and disclose skipped pages', async () => {
  const f = fixture(async () => ({ totalPages: 30, pages: [{ page: 11, text: '   ' }, { page: 12, text: 'Procedure' }] }));
  const root = createRoot(document.getElementById('root'));
  let saved;
  await prepare(f, root, async result => { saved = result; return 'Reviewed pages saved.'; });
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  for (let i = 0; i < 30 && !saved; i++) await act(async () => new Promise(r => setTimeout(r, 5)));
  assert.equal(saved.pages.length, 1);
  assert.equal(saved.pages[0].page, 12);
  assert.equal(saved.totalPages, 30);
  assert.match(document.body.textContent, /Blank pages 11 were not saved/);
  await act(async () => root.unmount());
});

test('all-blank batches cannot be sent to the guide and explain why', async () => {
  const f = fixture(async () => ({ totalPages: 30, pages: [{ page: 11, text: '\n ' }] }));
  const root = createRoot(document.getElementById('root'));
  let calls = 0;
  await prepare(f, root, async () => { calls++; return 'Saved.'; });
  await act(async () => document.querySelector('input[type=checkbox]').click());
  await click('Use reviewed text in guide');
  assert.equal(calls, 0);
  assert.match(document.body.textContent, /no nonblank text to save/);
  await act(async () => root.unmount());
});
