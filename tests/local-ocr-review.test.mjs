import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://cmpri.example/'});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', {value:dom.window.navigator, configurable:true});
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/components/LocalOcrReview.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;

function harness(recognize, props = {}, overrides = {}) {
 const revoked = [], applied = [], copied = [];
 let counter = 0, requests = 0, authCallback, unsubscribed = false;
 const mockUrl = {createObjectURL:()=>`blob:cmpri-test-${++counter}`,revokeObjectURL:url=>revoked.push(url)};
 const exports = {};
 const fakeNavigator = {clipboard:{writeText:async value=>copied.push(value)}};
 const authClient={auth:{onAuthStateChange(callback){authCallback=callback;queueMicrotask(()=>callback('INITIAL_SESSION',{user:{id:'user-a'}}));return {data:{subscription:{unsubscribe(){unsubscribed=true;}}}};}}};
 vm.runInNewContext(compiled, {exports, URL:mockUrl, Blob:dom.window.Blob, navigator:fakeNavigator, AbortController, console,
  fetch:()=>{requests++;throw Error('OCR review must not initiate network requests');},
  require(name){if(name==='react')return require('react');if(name==='react/jsx-runtime')return require('react/jsx-runtime');if(name==='@/lib/supabase/client')return {createClient:()=>authClient};if(name==='@/lib/ocr/local-ocr')return {recognizeLocalDocument:recognize,localOcrFileKind:overrides.validateFile || (async file=>{if(file.name.startsWith('renamed-html'))throw Error('Invalid signature');return file.name.endsWith('.pdf')?'pdf':'image';}),localOcrImageDimensions:async file=>{if(file.name==='huge.png')throw Error('Image dimensions are too large');return {width:100,height:100};}};throw Error(name);}});
 const parent=document.createElement('div');document.body.appendChild(parent);const root=createRoot(parent);
 const render=()=>React.act(async()=>root.render(React.createElement(exports.default,{...props,onUseText:props.onUseText===false?undefined:result=>applied.push(result)})));
 const choose=async(name='report.png',type='image/png')=>{const input=parent.querySelector('input[type=file]');const file=new dom.window.File(['image'],name,{type});Object.defineProperty(input,'files',{configurable:true,value:[file]});await React.act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})));return file;};
 const button=label=>[...parent.querySelectorAll('button')].find(item=>item.textContent.trim()===label);
 const click=async el=>React.act(async()=>el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));
 const dispose=async()=>{await React.act(async()=>root.unmount());parent.remove();};
 const auth=async(event,id)=>React.act(async()=>authCallback(event,id?{user:{id}}:null));
 return {parent,render,choose,button,click,dispose,revoked,applied,copied,auth,unsubscribed:()=>unsubscribed,urlsCreated:()=>counter,requests:()=>requests};
}

test('OCR requires an explicit review before applying text; edits require review again', async()=>{
 const seen=[];
 const h=harness(async(file,options)=>{seen.push({file,options});return {fileName:file.name,pages:[{page:1,text:'Room 101',confidence:91,words:[]},{page:2,text:'Room 102',confidence:87,words:[]}]};});
 try {
  await h.render();await h.choose();
  assert.ok(h.parent.querySelector('img[alt="Original document: report.png"]'));
  await h.click(h.button('Read text'));
  assert.equal(seen.length,1);assert.equal(seen[0].options.maxPages,10);
  assert.equal(h.parent.querySelectorAll('textarea').length,2);
  assert.ok(h.button('Use reviewed text').disabled);
  const checkbox=h.parent.querySelector('input[type=checkbox]');await h.click(checkbox);
  assert.equal(h.button('Use reviewed text').disabled,false);
  await h.click(h.button('Use reviewed text'));
  assert.equal(h.applied.length,1);assert.equal(h.applied[0].fileName,'report.png');assert.equal(h.applied[0].pages[1].text,'Room 102');
  const input=h.parent.querySelector('textarea');
  const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set;
  await React.act(async()=>{setter.call(input,'corrected');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
  assert.ok(h.button('Use reviewed text').disabled,'editing invalidates prior review');
  assert.equal(h.requests(),0);
 } finally {await h.dispose();}
});

test('stopping or unmounting aborts recognition, discards late results, and revokes previews', async()=>{
 let resolve,signal;
 const h=harness((_file,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});},{onUseText:false});
 await h.render();await h.choose('report.pdf','application/pdf');
 assert.equal(h.parent.querySelector('iframe'),null,'untrusted PDF is never embedded');
 assert.ok(h.parent.querySelector('a[download="report.pdf"]'),'original is available for local comparison');
 await h.click(h.button('Read text'));assert.ok(h.button('Stop reading'));
 await h.click(h.button('Stop reading'));assert.equal(signal.aborted,true);
 await React.act(async()=>resolve({pages:[{page:1,text:'late result',confidence:99,words:[]}]}));
 assert.equal(h.parent.querySelectorAll('textarea').length,0);
 await h.click(h.button('Clear document'));assert.deepEqual(h.revoked,['blob:cmpri-test-1']);
 await h.choose();await h.click(h.button('Read text'));const secondSignal=signal;await h.dispose();
 assert.equal(secondSignal.aborted,true);assert.deepEqual(h.revoked,['blob:cmpri-test-1','blob:cmpri-test-2']);
});

test('recognition failures stay visible and never apply or save extracted text', async()=>{
 const h=harness(async()=>{throw Error('Recognition failed locally.');});
 try{await h.render();await h.choose();await h.click(h.button('Read text'));assert.match(h.parent.querySelector('[role=alert]').textContent,/could not be read|failed locally/i);assert.equal(h.applied.length,0);assert.equal(h.requests(),0);}
 finally{await h.dispose();}
});

test('reference-only use exposes reviewed copy without an import or save action', async()=>{
 const h=harness(async(file)=>({fileName:file.name,pages:[{page:1,text:'Inspect pump',confidence:95,words:[]}]}),{onUseText:false});
 try {
  await h.render();await h.choose();await h.click(h.button('Read text'));
  assert.equal(h.button('Use reviewed text'),undefined);
  assert.ok(h.button('Copy reviewed text').disabled);
  await h.click(h.parent.querySelector('input[type=checkbox]'));
  await h.click(h.button('Copy reviewed text'));
  assert.deepEqual(h.copied,['Page 1\nInspect pump']);
  assert.equal(h.applied.length,0);assert.equal(h.requests(),0);
 } finally {await h.dispose();}
});

test('renamed HTML and oversized images are rejected before creating a preview or starting OCR', async()=>{
 let reads=0;
 const h=harness(async()=>{reads++;return {pages:[]};});
 try {
  await h.render();
  for (const name of ['renamed-html.png','renamed-html.pdf','huge.png']) {
   await h.choose(name,'text/html');
   assert.equal(h.parent.querySelector('img'),null,name);
   assert.equal(h.parent.querySelector('iframe'),null,name);
   assert.equal(h.parent.querySelector('a[download]'),null,name);
   assert.ok(h.button('Read text').disabled,name);
   assert.ok(h.parent.querySelector('[role=alert]'),name);
  }
  assert.equal(reads,0);assert.equal(h.urlsCreated(),0);assert.equal(h.requests(),0);
 } finally {await h.dispose();}
});

test('long PDFs use an explicit bounded page range and review describes only that pass', async()=>{
 const calls=[];
 const h=harness(async(file,options)=>{calls.push(options);return {fileName:file.name,pages:[{page:11,text:'Manual page 11',confidence:90,words:[]}]};});
 try {
  await h.render();await h.choose('manual.pdf','application/pdf');
  const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
  async function change(label,value){const input=h.parent.querySelector(`input[aria-label="${label}"]`);await React.act(async()=>{setter.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});}
  await change('First PDF page','11');await change('Last PDF page','22');
  await h.click(h.button('Read text'));
  assert.equal(calls.length,0);assert.match(h.parent.querySelector('[role=alert]').textContent,/up to 10 pages/i);
  await change('Last PDF page','20');await h.click(h.button('Read text'));
  assert.equal(calls.length,1);assert.equal(calls[0].pageRange.start,11);assert.equal(calls[0].pageRange.end,20);
  assert.match(h.parent.textContent,/pages outside 11–20 were not read/i);
  await change('First PDF page','12');assert.equal(h.parent.querySelectorAll('textarea').length,0,'changing range clears prior results');
 } finally {await h.dispose();}
});

test('account switch or sign-out clears source and OCR text, aborts work, and revokes previews', async()=>{
 let signal,resolve;
 const h=harness((_file,options)=>{signal=options.signal;return new Promise(r=>{resolve=r;});},{onUseText:false});
 await h.render();await h.choose();await h.click(h.button('Read text'));
 await h.auth('TOKEN_REFRESHED','user-a');assert.equal(signal.aborted,false,'same-user refresh retains work');
 await h.auth('SIGNED_IN','user-b');
 assert.equal(signal.aborted,true);assert.equal(h.parent.querySelector('img'),null);assert.deepEqual(h.revoked,['blob:cmpri-test-1']);
 await React.act(async()=>resolve({pages:[{page:1,text:'previous user secret',confidence:90,words:[]}]}));
 assert.equal(h.parent.querySelector('textarea'),null,'late prior-user result is discarded');
 await h.choose();await h.click(h.button('Read text'));const nextSignal=signal;
 await h.auth('SIGNED_OUT',null);
 assert.equal(nextSignal.aborted,true);assert.equal(h.parent.querySelector('img'),null);
 assert.ok(h.parent.querySelector('input[type=file]').disabled);
 assert.deepEqual(h.revoked,['blob:cmpri-test-1','blob:cmpri-test-2']);
 await h.dispose();assert.equal(h.unsubscribed(),true);
});

test('sign-out during file validation cannot create a late preview', async()=>{
 let finishValidation;
 const h=harness(async()=>{throw Error('must not start');},{onUseText:false},{validateFile:()=>new Promise(resolve=>{finishValidation=resolve;})});
 try {
  await h.render();await h.choose();await h.auth('SIGNED_OUT',null);
  await React.act(async()=>finishValidation('image'));
  assert.equal(h.urlsCreated(),0);assert.equal(h.parent.querySelector('img'),null);
  assert.ok(h.parent.querySelector('input[type=file]').disabled);
 } finally {await h.dispose();}
});
