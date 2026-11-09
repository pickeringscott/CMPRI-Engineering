import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React, {act} from 'react';
import * as jsx from 'react/jsx-runtime';
import {JSDOM} from 'jsdom';

test('report file import accepts CSV only; images remain in the separate local OCR review path', async () => {
 const dom = new JSDOM('<div id="root"></div>', {url:'https://cmpri.test', pretendToBeVisual:true});
 const previous={window:globalThis.window,document:globalThis.document,HTMLElement:globalThis.HTMLElement,fetch:globalThis.fetch,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT};
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=await import('react-dom/client');
 const source=readFileSync('src/app/engineering/room-operations/GuestReportsImport.tsx','utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 const exports={}, requests=[];
 const fakeFetch=async(url,options)=>{
  requests.push({url,body:JSON.parse(options.body)});
  return {ok:true,json:async()=>({date:'2026-11-09',rows:[],previousId:'previous',import_id:'imported'})};
 };
 const env={exports,fetch:fakeFetch,FormData,Set,Error,Array,JSON,Promise,Number,String,RegExp,console,
  require(name){
   if(name==='react')return React;
   if(name==='react/jsx-runtime')return jsx;
   if(name==='@/lib/auth/client-session')return {authorizationHeaders:async()=>({Authorization:'Bearer fixture'})};
   if(name==='@/lib/room-guest-reports')return {guestReportName:name=>({kind:/In House/i.test(name)?'guests':/Departures/i.test(name)?'departures':'arrivals'})};
   if(name==='@/components/LocalOcrReview')return {__esModule:true,default:()=>React.createElement('div',{'data-testid':'local-ocr-review'},'Local OCR review')};
   if(name.endsWith('.module.css'))return {__esModule:true,default:{}};
   throw Error(`Unexpected dependency: ${name}`);
  }};
 vm.runInNewContext(output,env);
 const root=createRoot(document.getElementById('root'));
 try {
  const commits=[];
  await act(async()=>root.render(React.createElement(exports.default,{open:true,date:'2026-11-09',onDateChange:()=>{},onCommitted:(...args)=>commits.push(args)})));
  const input=document.querySelector('input[type=file]');assert.equal(input.getAttribute('accept'),'.csv,text/csv');
  assert.equal(document.querySelector('[data-testid=local-ocr-review]'),null);
  const summary=document.querySelector('summary');
  await act(async()=>{summary.click();await new Promise(resolve=>setTimeout(resolve,0));});
  assert.ok(document.querySelector('[data-testid=local-ocr-review]'));
  await act(async()=>{summary.click();await new Promise(resolve=>setTimeout(resolve,0));});
  assert.equal(document.querySelector('[data-testid=local-ocr-review]'),null,'closing OCR must clear the reference tool');
  await act(async()=>{summary.click();await new Promise(resolve=>setTimeout(resolve,0));});
  assert.ok(document.querySelector('[data-testid=local-ocr-review]'));
  await act(async()=>root.render(React.createElement(exports.default,{open:false,date:'2026-11-09',onDateChange:()=>{},onCommitted:(...args)=>commits.push(args)})));
  assert.equal(document.querySelector('[data-testid=local-ocr-review]'),null,'hiding the importer must clear the reference tool');
  await act(async()=>root.render(React.createElement(exports.default,{open:true,date:'2026-11-09',onDateChange:()=>{},onCommitted:(...args)=>commits.push(args)})));
  const image={name:'In House Guest List Details_CMPRI_2026-11-09_10-00-00.png',size:123,text:async()=>{throw Error('Image must not be read as CSV')}};
  Object.defineProperty(input,'files',{configurable:true,value:[image]});
  await act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})));
  assert.match(document.querySelector('[role=alert]').textContent,/Choose CSV report files/);assert.equal(requests.length,0);
  const drop=new dom.window.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[image]}});
  await act(async()=>document.querySelector('[aria-label="Report files"]').dispatchEvent(drop));
  assert.match(document.querySelector('[role=alert]').textContent,/local OCR tool/);assert.equal(requests.length,0);
  const csv={name:'In House Guest List Details_CMPRI_2026-11-09_10-00-00.csv',size:77,text:async()=> 'ROOM NUMBER,GUEST NAME,ARRIVAL,DEPARTURE,NIGHTS\n101,Example Guest,2026-11-09,2026-11-10,1'};
  Object.defineProperty(input,'files',{configurable:true,value:[csv]});
  await act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})));
  const button=Array.from(document.querySelectorAll('button')).find(element=>element.textContent==='Submit');
  await act(async()=>button.click());
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/room-operations/guest-reports');assert.equal(requests[0].body.validateOnly,true);
  assert.equal(requests[0].body.files[0].name,csv.name);
  const confirm=Array.from(document.querySelectorAll('button')).find(element=>element.textContent==='Confirm Import');assert.ok(confirm);
  await act(async()=>confirm.click());
  assert.equal(requests.length,2);assert.equal(requests[1].body.validateOnly,false);assert.equal(requests[1].body.previousId,'previous');assert.equal(commits.length,1);
 } finally {
  await act(async()=>root.unmount());dom.window.close();
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
 }
});
