import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://cmpri.test'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react');const {createRoot}=await import('react-dom/client');const require=createRequire(import.meta.url);
const code=ts.transpileModule(readFileSync(new URL('../src/components/WorkOrderSourcePages.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const exports={};vm.runInNewContext(code,{exports,require(name){if(name==='react'||name==='react/jsx-runtime')return require(name);throw Error(name);}});

test('source page selector preserves the original PDF and resets when the issue or document changes',async()=>{
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 const passages=[{page:4,text:'Troubleshooting water leak',kind:'troubleshooting'},{page:8,text:'Diagnostic cooling noise',kind:'diagnostic'}];
 const render=async props=>React.act(async()=>root.render(React.createElement(exports.default,{passages:[passages[0]],sourceUrl:'https://cmpri.test/manual.pdf?token=one',...props}))); 
 try {
  await render({});const select=parent.querySelector('select');assert.ok(select);assert.deepEqual([...select.options].map(option=>option.value),['','4']);
  await React.act(async()=>{select.value='4';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
  assert.equal(parent.querySelector('iframe').getAttribute('src'),'https://cmpri.test/manual.pdf?token=one#page=4');
  assert.equal(parent.querySelector('a').getAttribute('href'),'https://cmpri.test/manual.pdf?token=one#page=4');
  await render({passages:[passages[1]]});assert.equal(parent.querySelector('iframe'),null);assert.deepEqual([...parent.querySelector('select').options].map(option=>option.value),['','8']);
  await render({passages:[]});assert.equal(parent.querySelector('select'),null);
 } finally {await React.act(async()=>root.unmount());parent.remove();}
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
