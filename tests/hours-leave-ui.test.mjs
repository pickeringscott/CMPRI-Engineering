import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as core from '../src/lib/hours-tracker.ts';

const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'), {createRoot}=await import('react-dom/client'), runtime=await import('react/jsx-runtime');
const exports={};
const dependencies={react:React,'react/jsx-runtime':runtime,'@/lib/hours-tracker':core,'./hours.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})}};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/app/engineering/hours-tracker/HoursTracker.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,structuredClone,window,document,HTMLElement,Intl,Date,setTimeout,clearTimeout,performance,require:name=>{assert.ok(name in dependencies,name);return dependencies[name];}});
const labelInput=text=>[...document.querySelectorAll('label')].find(label=>label.textContent.trim().startsWith(text))?.querySelector('input');
const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text);
const click=async element=>{assert.ok(element);await React.act(async()=>element.click());};
const enter=async(element,value)=>{assert.ok(element);await React.act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));element.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});};
async function mounted(configurations=[]) {
  const p={start:'2026-10-02',days:core.emptyPeriod('2026-10-02'),rateCents:1900,deductionPercent:12};
  let saved={revision:3,document:{version:1,anchor:core.PAYROLL_ANCHOR,periods:[p],leaveConfigurations:configurations}};
  const saves=[];const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(React.createElement(exports.default,{owner:'Synthetic hourly user',initial:saved,today:'2026-10-14',onClose(){},persist:async body=>{saves.push(structuredClone(body));saved={revision:saved.revision+1,document:{...saved.document,leaveConfigurations:body.configuration?[...saved.document.leaveConfigurations,body.configuration]:saved.document.leaveConfigurations}};return saved;}})));
  return {saves,close:async()=>{await React.act(async()=>root.unmount());document.getElementById('root').innerHTML='';}};
}

test('mounted company setup requires personal tenure/eligibility and saves a one-time baseline without attendance',async()=>{
  const f=await mounted();
  try {
    await click([...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Company PTO')));
    assert.equal(document.activeElement,labelInput('Available hours'));
    await enter(labelInput('Available hours'),'12.5');
    await enter(labelInput('Balance includes'),'2026-10-13');
    await click(button('Save starting balance'));
    assert.equal(f.saves.length,0);assert.match(document.body.textContent,/Confirm that you are an hourly full-time/);
    await enter(labelInput('Your hire'),'2024-01-31');
    await click(labelInput('I am an hourly full-time'));
    await click(button('Save starting balance'));
    assert.equal(f.saves.length,1);
    const config=f.saves[0].configuration;
    assert.equal(config.minutes,750);assert.equal(config.date,'2026-10-14');assert.equal(config.hawkeye.hireDate,'2024-01-31');
    assert.equal(config.hawkeye.hourlyFullTime,true);assert.equal(config.policy,'hawkeye-hourly');assert.equal(config.evidence.earnedMinutes,null);
    assert.equal(f.saves[0].period,undefined);assert.equal(document.querySelector('[role="dialog"]'),null);
    assert.match(document.body.textContent,/12\.50h/);
  } finally {await f.close();}
});

test('mounted Illinois setup marks Jan 1 provisional, does not invent annual counters, and preserves statement evidence',async()=>{
  const prior={kind:'illinois-sick',policy:'unconfigured',date:'2026-10-02',coveredThrough:'2026-10-01',statementDate:'2026-10-08',minutes:960,earnedMinutesPerWorkedHour:null,note:'Synthetic statement',evidence:{earnedMinutes:2400,usedMinutes:1500,carriedInMinutes:60,benefitYearStart:null}};
  const f=await mounted([prior]);
  try {
    await click([...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Illinois Sick')));
    assert.match(document.body.textContent,/40\.00h earned/);
    await enter(labelInput('Available hours'),'16');await enter(labelInput('Balance includes'),'2026-10-13');
    await click(button('Use January 1 provisionally'));
    assert.equal(labelInput('Illinois leave-year start').value,'2026-01-01');
    assert.equal(labelInput('This leave-year date').checked,true);
    assert.equal(labelInput('Hours already earned').value,'');
    await click(button('Save starting balance'));assert.equal(f.saves.length,0);assert.match(document.body.textContent,/Enter documented hours earned/);
    await enter(labelInput('Hours already earned'),'40');
    await click(button('Save starting balance'));assert.equal(f.saves.length,1);
    const config=f.saves[0].configuration;
    assert.equal(config.policy,'illinois-accrual');assert.equal(config.provisionalYearStart,true);assert.equal(config.evidence.benefitYearStart,'2026-01-01');assert.equal(config.evidence.earnedMinutes,2400);
    assert.equal(config.evidence.carriedInMinutes,null);assert.equal(config.evidence.usedMinutes,null);
    assert.equal(prior.evidence.benefitYearStart,null);assert.equal(prior.minutes,960);
    assert.match(document.body.textContent,/Provisional Illinois leave year/);
  } finally {await f.close();}
});

test('mounted configuration cancel discards draft and does not save user hours',async()=>{
  const f=await mounted();
  try {await click([...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Company PTO')));await enter(labelInput('Available hours'),'99');await click([...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent==='Cancel'));assert.equal(f.saves.length,0);assert.equal(document.querySelector('[role="dialog"]'),null);}
  finally {await f.close();}
});
