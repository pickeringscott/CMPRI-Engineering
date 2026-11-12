import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

test('local PO OCR is presented as review-only and cannot import through its callback', () => {
 const source = readFileSync(new URL('../src/app/engineering/purchasing/PoSourceReview.tsx', import.meta.url), 'utf8');
 const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText;
 const exports = {}, requireModule = createRequire(import.meta.url);
 let imports = 0, propsSeen;
 vm.runInNewContext(code, {exports, require(name) {
  if (name === 'react' || name === 'react/jsx-runtime') return requireModule(name);
  if (name === '@/lib/auth/client-session') return {authorizationHeaders: async () => ({})};
  if (name === '@/lib/import-response') return {readImportResponse: () => {throw Error('Rendering must not download review results');}};
  if (name === '@/lib/import-upload') return {uploadImportFile: () => {throw Error('Rendering must not upload evidence');}};
  if (name === '@/components/LocalOcrReview') return {default: props => {propsSeen = props; return React.createElement('div', {'data-test': 'ocr'});}};
  if (name.endsWith('.module.css')) return {default: {}};
  throw Error(`Unexpected import: ${name}`);
 }});
 const markup = renderToStaticMarkup(React.createElement(exports.default, {onImported: async () => {imports++;}}));
 assert.match(markup, /Review a scanned PO locally/);
 assert.match(markup, /unverified reference only/);
 assert.match(markup, /does not import a purchase order, record acceptance, or change inventory or receipts/);
 assert.match(markup, /data-test="ocr"/);
 assert.equal(propsSeen.onUseText, undefined, 'OCR cannot invoke a PO import or inventory update');
 assert.equal(imports, 0);
});
