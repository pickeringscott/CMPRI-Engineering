import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as references from '../src/lib/work-order-reference.js';

test('presentation preserves every existing digit, date and sequence without padding or renumbering',()=>{
  for(const [input,expected] of [['261015001','WO#261015001'],['261014001','WO#261014001'],['0007','WO#0007'],['7','WO#7'],['wo#261015001','WO#261015001'],['WO-261015001','WO#261015001'],['@work order 261015001','WO#261015001']]) assert.equal(references.formatWorkOrder(input),expected);
  for(const value of [null,undefined,'Room 101','not-an-id','00000000-0000-4000-8000-000000000001',1.5]) assert.equal(references.formatWorkOrder(value),'Work order');
});
test('explicit ticket references accept canonical and legacy forms; room numbers stay room numbers',()=>{
  const text='Room 101; Room #102; 261015001; WO#261015001, @WO#261014001, @261013001, #261012001, @work order 261011001, WO-261010001';
  assert.deepEqual(references.workOrderReferences(text).map(r=>r.number),['261015001','261014001','261013001','261012001','261011001','261010001']);
  assert.equal(references.formatWorkOrderReferences('Room 101, @WO-261014001'),'Room 101, WO#261014001');
  for(const query of ['WO#261015001','@WO#261015001','WO-261015001','#261015001','261015001']) assert.equal(references.workOrderReferenceMatches('261015001',query),true);
  assert.equal(references.workOrderReferenceMatches('261015001','Room 101'),false);
});
test('existing notification copies format only their ticket slot and preserve room details',()=>{
  const item={work_order_id:'unchanged-internal-id',message:'261015001 (101) corrected by Scott: Room/Location 101 → 102'};
  assert.equal(references.formatWorkOrderNotification(item),'WO#261015001 (101) corrected by Scott: Room/Location 101 → 102');
  assert.equal(item.message,'261015001 (101) corrected by Scott: Room/Location 101 → 102');
  assert.equal(references.formatWorkOrderNotification({work_order_id:'id',message:'Room 101 needs attention'}),'Room 101 needs attention');
  assert.equal(references.formatWorkOrderNotification({message:'101 was cleaned'}),'101 was cleaned');
});
test('real work-order list renders WO#261015001 and room 101 as distinct values',()=>{
  const require=createRequire(import.meta.url),cache=new Map();
  function load(relative){
    if(cache.has(relative))return cache.get(relative);
    const exports={};cache.set(relative,exports);
    const source=readFileSync(new URL('../src/'+relative,import.meta.url),'utf8');
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require(name){
      if(name==='next/image')return {default:props=>React.createElement('img',props)};
      if(name.endsWith('work-order-reference.js'))return references;
      if(name.startsWith('@/')) { const path=name.slice(2);return load(path+(path.startsWith('components/')?'.tsx':'.ts')); }
      return require(name);
    },Intl,Date,console,process:{env:{}}});return exports;
  }
  const Component=load('components/desktop/WorkOrderListWindow.tsx').default;
  const html=renderToStaticMarkup(React.createElement(Component,{orders:[{id:'internal-id',display_id:'261015001',room:'101',issue:'Lamp',status:'Open'}],loading:false,onOpenWorkOrder(){}}));
  if(process.env.CMPRI_REVIEW_HTML)writeFileSync(process.env.CMPRI_REVIEW_HTML, `<!doctype html><html lang="en"><meta charset="utf-8"><title>CMPRI candidate examples</title><style>body{background:#020617;color:#e2e8f0;font:16px system-ui;max-width:960px;margin:40px auto;padding:20px}h1,h2{color:#facc15}button,input{background:#0f172a;color:#e2e8f0;border:1px solid #475569;border-radius:6px;padding:8px;margin:3px}svg{width:18px;height:18px}p{line-height:1.5}section{border:1px solid #475569;padding:20px;margin:20px 0;border-radius:12px}code{color:#7dd3fc}</style><h1>CMPRI local candidate</h1><p>Static HTML from the real work-order list component with mock data. Review content here; this is not a live app or a screenshot.</p><section>${html}</section><h2>Exact format examples</h2><p>Today: <code>${references.formatWorkOrder("261015001")}</code><br>Historical: <code>${references.formatWorkOrder("261014001")}</code><br>Room: 101</p><h2>Mention examples checked locally</h2><p><code>@ma</code>: no automatic completion when Matt and Maintenance match.<br>Selected Scott Reed: <code>@Scott</code>; the stored identity remains Scott Reed’s account.<br>Role: <code>@Chief Engineer</code>.</p></html>`);
  assert.match(html,/WO#261015001/);assert.match(html,/101/);assert.doesNotMatch(html,/WO#101(?:\D|$)/);assert.doesNotMatch(html,/internal-id/);
});
