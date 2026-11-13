import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {loadTs} from './helpers/load-ts.mjs';
import {JSDOM} from 'jsdom';
import * as manualHtml from '../src/lib/manual-document-html.ts';
import * as diagramTheme from '../src/lib/work-orders/diagram-theme.ts';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://cmpri.test'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');const {createRoot}=await import('react-dom/client');const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/WorkOrderSourcePages.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const exports={};vm.runInNewContext(code,{exports,require(name){if(name==='./PdfHtmlPreview')return {default:props=>React.createElement('div',{'data-pdf-html-preview':true},props.pageNumbers.map(page=>React.createElement('div',{key:page},props.renderPage(page,React.createElement('div',{'data-pdf-html-page':page})))))};if(name==='react'||name==='react/jsx-runtime')return require(name);
      if(name==='./ManualSourceLink')return loadTs('src/components/ManualSourceLink.tsx',{'react':require('react'),'react/jsx-runtime':require('react/jsx-runtime'),'@/lib/supabase/client':{getValidSession:async()=>null}},{window,URL});if(name==='@/lib/manual-document-html')return manualHtml;if(name==='@/lib/work-orders/diagram-theme')return diagramTheme;if(name==='@/lib/supabase/client')return {getValidSession:async()=>null};throw Error(name);}});

test('source pages are continuous in original order and reset with their documents',async()=>{
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 const passages=[{page:4,text:'Troubleshooting water leak',kind:'troubleshooting'},{page:8,text:'Diagnostic cooling noise',kind:'diagnostic'}];
 const render=async props=>React.act(async()=>root.render(React.createElement(exports.default,{passages:[...passages].reverse(),sourceUrl:'https://cmpri.test/manual.pdf?token=one',...props})));
 try {
  await render({});assert.equal(parent.querySelector('select'),null);
  assert.deepEqual([...parent.querySelectorAll('[data-continuous-source-page]')].map(page=>Number(page.dataset.continuousSourcePage)),[4,8]);
  assert.deepEqual([...parent.querySelectorAll('a')].map(link=>link.getAttribute('href')),['https://cmpri.test/manual.pdf?token=one#page=4','https://cmpri.test/manual.pdf?token=one#page=8']);
  await render({passages:[passages[1]]});assert.match(parent.textContent,/Diagnostic cooling noise/);assert.doesNotMatch(parent.textContent,/Troubleshooting water leak/);
  await render({passages:[]});assert.equal(parent.querySelector('[data-continuous-source-page]'),null);
 }finally{await React.act(async()=>root.unmount());parent.remove();}
});

test('everyday wording finds source pages without claiming they are instructions', async()=>{
 const {manualSourcePassages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const pages=manualSourcePassages('PAGE 1\nTROUBLESHOOTING CHART\nValve leaks when shut off. Replace washers.\n\nPAGE 2\nTROUBLESHOOTING\nInspect the fan if noisy.');
 assert.deepEqual(relevantSourcePassages(pages,'shower leaking').map(page=>page.page),[1]);
 assert.deepEqual(relevantSourcePassages(pages,'unit makes noise').map(page=>page.page),[2]);
 assert.deepEqual(relevantSourcePassages(pages,'door stuck').map(page=>page.page),[]);
});

test('parts lists and their matching illustrated pages remain source references',async()=>{
 const {manualPartsPassages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const text='PAGE 1\nDoor Lock drawing\n\nPAGE 2\nDoor Lock\nREF PART NO. DESCRIPTION\n1 1234 Door Lock Cover\n\nPAGE 3\nElectrical safety\n\nPAGE 4\nDrain\nREF PART NO. DESCRIPTION\n1 5678 Drain Valve';
 const pages=manualPartsPassages(text);
 assert.deepEqual(pages.map(page=>page.page),[1,2,4]);
 assert.deepEqual(relevantSourcePassages(pages,'door lock broken').map(page=>page.page),[1,2]);
});

test('unlabelled source pages from future manuals remain searchable without becoming repair instructions',async()=>{
 const {manualReferencePages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const pages=manualReferencePages('PAGE 1\nTable of Contents\nWater pressure..........2\n\nPAGE 2\nWater pressure valve assembly and installation.\n\nPAGE 3\nDoor lock wiring diagram.');
 assert.deepEqual(pages.map(page=>page.page),[2,3]);assert.ok(pages.every(page=>page.kind==='reference'));
 assert.deepEqual(relevantSourcePassages(pages,'door lock broken').map(page=>page.page),[3]);
 const {normalizeManualKnowledge}=await import('../src/lib/manual-knowledge.ts');
 assert.equal(normalizeManualKnowledge({source_passages:pages})?.source_passages?.length,2);
});

test('source discovery handles ordinary word endings across unrelated equipment',async()=>{
 const {manualReferencePages,relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const pages=manualReferencePages('PAGE 1\nHinge squeals during operation.\n\nPAGE 2\nSprinkler leaks at the valve.\n\nPAGE 3\nVacuum brushes need cleaning.');
 assert.deepEqual(relevantSourcePassages(pages,'hinge squealing').map(page=>page.page),[1]);
 assert.deepEqual(relevantSourcePassages(pages,'sprinkler leaking').map(page=>page.page),[2]);
 assert.deepEqual(relevantSourcePassages(pages,'brush is dirty').map(page=>page.page),[3]);
});

test('source-page search updates if a source entry changes',async()=>{
 const {relevantSourcePassages}=await import('../src/lib/manual-source.ts');
 const page={page:1,kind:'reference',text:'Door latch diagram'};
 assert.equal(relevantSourcePassages([page],'door latch').length,1);
 page.text='Sprinkler valve diagram';
 assert.equal(relevantSourcePassages([page],'door latch').length,0);
 assert.equal(relevantSourcePassages([page],'sprinkler valve').length,1);
});


test('the work-order viewer renders semantic source HTML and never trusts supplied markup', async () => {
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 try {
  await React.act(async()=>root.render(React.createElement(exports.default,{sourceUrl:'https://cmpri.test/manual.pdf',passages:[{page:6,kind:'reference',origin:'ocr',text:'Door lock stuck\n1. Inspect the latch.\n2. Check <script>alert(1)</script> wiring.',html:'<img src=x onerror=alert(2)>'}]})));
  assert.equal(parent.querySelector('[data-source-page="6"]').getAttribute('data-source-origin'),'ocr');
  assert.equal(parent.querySelector('h3').textContent,'Door lock stuck');
  assert.equal(parent.querySelectorAll('ol li').length,2);
  assert.equal(parent.querySelector('script,img,svg'),null);
  assert.match(parent.textContent,/<script>alert\(1\)<\/script>/);
  assert.match(parent.textContent,/OCR text: compare with the original source page/);
  assert.equal(parent.querySelector('a').getAttribute('href'),'https://cmpri.test/manual.pdf#page=6');
 } finally {await React.act(async()=>root.unmount());parent.remove();}
});
