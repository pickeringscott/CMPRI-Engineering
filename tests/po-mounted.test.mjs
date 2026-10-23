import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import {poOrderBadge,wholePoCount,receiptBlock,stockAdded,recordedPoValue,poHotelDate,receivedPoSpending} from '../src/lib/po-workflow.ts';
assert.equal(poOrderBadge({origin:'manual',acceptance:'unresolved'}),'Recorded · Manually Entered');
assert.equal(poOrderBadge({origin:'manual',acceptance:'accepted'}),'Accepted · Manually Entered');
assert.equal(poOrderBadge({origin:'ibuy',acceptance:'submitted'}),'Submitted');
assert.equal(poOrderBadge({origin:'ibuy',acceptance:'unresolved'}),'Awaiting Acceptance');
assert.equal(poOrderBadge({origin:'manual',acceptance:'unresolved',cancelled:true}),'Cancelled · Manually Entered');
for(const n of [0,-1,0.5,NaN,Infinity,1000000000])assert.throws(()=>wholePoCount(n));
assert.equal(wholePoCount(12),12);
assert.equal(stockAdded(2,0.5),1);
assert.equal(stockAdded(3,0.001),0.003);
assert.equal(stockAdded(0.5,1),null);
assert.match(receiptBlock({ordered:2.5,received:0,accepted:true,mapped:true,active:true}),/fractional/);
assert.match(receiptBlock({ordered:2,received:0,accepted:false,mapped:false,active:false}),/company approval.*inventory/);
assert.match(receiptBlock({ordered:2,received:0,accepted:true,mapped:true,active:false}),/active/);
assert.equal(receiptBlock({ordered:2,received:0,accepted:true,mapped:true,active:true}),'');
assert.equal(receiptBlock({ordered:2,received:0,origin:'manual',accepted:false,mapped:true,active:true}),'');
assert.match(receiptBlock({ordered:2,received:0,origin:'manual',accepted:false,mapped:false,active:false}),/inventory/);
assert.match(receiptBlock({ordered:2,received:0,origin:'ibuy',accepted:false,mapped:true,active:true}),/company approval/);
assert.deepEqual(recordedPoValue([{id:'a',ordered:2,purchase_unit_price_cents:1250},{id:'b',ordered:3,purchase_unit_price_cents:null}],[{line_id:'a',quantity:1}]),{ordered:25,received:12.5,unpricedLines:1});
assert.deepEqual(recordedPoValue([{id:'a',ordered:2}],[]),{ordered:null,received:null,unpricedLines:1});
assert.equal(recordedPoValue([{id:'a',ordered:2,purchase_unit_price_cents:0}],[]).ordered,0);

// Real API and RPCs, exclusively in an ephemeral in-memory database.
const db=new PGlite(),id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const hotel=id(1),actor=id(2),item=id(3),order=id(4);
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table work_orders(id uuid primary key,hotel_id uuid);');
const baseline=fs.readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
for(const table of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements']){
  const a=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`);
  await db.exec(baseline.slice(a,baseline.indexOf('\n);',a)+3));
  await db.exec(`alter table ${table} add primary key(id)`);
}
await db.exec(fs.readFileSync('supabase/migrations/20261016211655_cmpri_po_receiving.sql','utf8'));
const aclBefore=(await db.query("select proacl::text from pg_proc where proname='cmpri_receive_po'")).rows[0].proacl;
await db.exec(fs.readFileSync('supabase/proposals/manual-order-receiving.sql','utf8'));
assert.equal((await db.query("select proacl::text from pg_proc where proname='cmpri_receive_po'")).rows[0].proacl,aclBefore);
await db.exec(fs.readFileSync('supabase/migrations/20261022062702_cmpri_cumulative_receipt_guard.sql','utf8'));
await db.query('insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand,active) values($1,$2,$3,7,true)',[item,hotel,'Isolated supply']);
let rpcCalls=0,loseRpcResponse=false;
const admin={
  from(table){
    const filters=[];let update=null;
    const q={order(){return q;},range(){return q;},select(){return q;},eq(k,v){filters.push([k,v]);return q;},update(v){update=v;return q;},then(resolve,reject){return db.query(`select * from ${table} where ${filters.map(([k],i)=>`${k}=$${i+1}`).join(' and ')}`,filters.map(([,v])=>v)).then(r=>resolve({data:r.rows.map(row=>({...row,...(row.received_date instanceof Date?{received_date:row.received_date.toISOString().slice(0,10)}:{})})),error:null}),reject);},async single(){
      try{
        let sql,params;
        if(update){const fields=Object.entries(update);params=fields.map(([,v])=>v).concat(filters.map(([,v])=>v));sql=`update ${table} set ${fields.map(([k],i)=>`${k}=$${i+1}`).join(',')} where ${filters.map(([k],i)=>`${k}=$${fields.length+i+1}`).join(' and ')} returning *`;}
        else{params=filters.map(([,v])=>v);sql=`select * from ${table} where ${filters.map(([k],i)=>`${k}=$${i+1}`).join(' and ')}`;}
        const r=await db.query(sql,params);return {data:r.rows[0]||null,error:null};
      }catch(e){return {data:null,error:{message:e.message,code:e.code}};}
    }};return q;
  },
  async rpc(name,p){rpcCalls++;try{const args={cmpri_receive_po_total:['p_hotel','p_actor','p_id','p_line','p_total','p_expected','p_date'],cmpri_create_manual_po:['p_hotel','p_actor','p_id','p_supplier','p_reference','p_description','p_quantity','p_uom'],cmpri_link_po_line:['p_hotel','p_line','p_item','p_factor'],cmpri_receive_po:['p_hotel','p_actor','p_id','p_line','p_quantity','p_date','p_note']}[name];assert.ok(args);const r=await db.query(`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`,args.map(k=>p[k]));if(loseRpcResponse){loseRpcResponse=false;return {data:null,error:{message:"Simulated database response loss"}};}return {data:r.rows[0].result,error:null};}catch(e){return {error:{message:e.message,code:e.code}};}}
};
globalThis.__poWorkflowAuth={admin,principal:{identity:{id:actor}}};
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let source=fs.readFileSync('src/app/api/engineering/purchase-orders/route.ts','utf8');
const mappings={'@/lib/server/auth':data('export const requireCapability=async()=>globalThis.__poWorkflowAuth;'),'@/lib/constants':data(`export const HOTEL_ID=${JSON.stringify(hotel)};export const HOTEL_TIME_ZONE="America/Chicago";`),'@/lib/server/paginated-query':pathToFileURL(path.resolve('src/lib/server/paginated-query.ts')).href,'@/lib/po-workflow':pathToFileURL(path.resolve('src/lib/po-workflow.ts')).href,'next/server':pathToFileURL(path.resolve('node_modules/next/server.js')).href};
for(const [key,url]of Object.entries(mappings))source=source.replaceAll(`'${key}'`,JSON.stringify(url));
const route=await import(data(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText));
process.env.CMPRI_PO_ENABLED='true';
const post=body=>route.POST(new Request('http://isolated.test/api/engineering/purchase-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
// Mount the actual React component and send its real request bodies to the real route + PGlite.
await post({action:'manual',id:order,supplier:'Fixture supplier',reference:'FIXTURE-PO',description:'Fixture supply',quantity:15,uom:'pack'});
const line=(await db.query('select id from cmpri_po_lines where order_id=$1',[order])).rows[0].id;
await post({action:'link',id:line,itemId:item,factor:2});
await db.query('update cmpri_po_lines set purchase_unit_price_cents=125 where id=$1',[line]);
await db.query('insert into cmpri_po_sources(hotel_id,order_id,account,message_id,kind,source_note) values($1,$2,$3,$4,$5,$6)',[hotel,order,'fixture','fixture-source','company-accepted',JSON.stringify({sourceSubject:'Fixture PO subject',messageAt:'2026-10-19T12:00:00Z'})]);
const {JSDOM}=await import('jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'http://isolated.test/engineering/purchasing',pretendToBeVisual:true});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
window.matchMedia=()=>({matches:false});globalThis.ResizeObserver=class{observe(){}disconnect(){}};
const React=await import('react');const {createRoot}=await import('react-dom/client');const {act}=React;
const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);const vm=await import('node:vm');
const presentation=await import('../src/lib/po-presentation.ts');const workflow=await import('../src/lib/po-workflow.ts');const selection=await import('../src/lib/po-selection.ts');
const review=await import('../src/lib/po-line-review.ts');
const css=new Proxy({},{get:(_,key)=>String(key)});
function component(file){const exports={};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{exports,require(name){if(name==='react'||name==='react/jsx-runtime')return require(name);if(name.endsWith('.module.css'))return css;if(name==='@/lib/po-presentation')return presentation;if(name==='@/lib/po-workflow')return workflow;if(name==='@/lib/po-selection')return selection;if(name==='@/lib/po-line-review')return review;if(name==='@/lib/auth/client-session')return {authorizationHeaders:async()=>({})};if(name==='./PoPaneDivider')return {default:component('src/app/engineering/purchasing/PoPaneDivider.tsx'),__esModule:true};if(name==='./PoCompactMenu')return {default:component('src/app/engineering/purchasing/PoCompactMenu.tsx'),__esModule:true};if(name==='@/components/PlainTextLinks')return {default:({text})=>React.createElement('span',null,text),__esModule:true};if(['./PoSourceReview','./PurchasingHistory','./AddItem','./EditPoItem','./EditPoItems'].includes(name))return {default:()=>null,__esModule:true};throw Error(name);},window,document,ResizeObserver:globalThis.ResizeObserver,crypto:globalThis.crypto,URL,fetch:(...args)=>globalThis.fetch(...args),console});return exports.default;}
const payloads=[];let loseResponse=false;
globalThis.fetch=async(_url,options={})=>{if(options.method==='POST'){const body=JSON.parse(options.body);payloads.push(body);const response=await post(body);if(loseResponse){loseResponse=false;throw Error('Simulated lost response');}return response;}return route.GET(new Request('http://isolated.test/api/engineering/purchase-orders'));};
const App=component('src/app/engineering/purchasing/PurchaseOrders.tsx');const root=createRoot(document.getElementById('root'));
await act(async()=>{root.render(React.createElement(App));});
assert.equal(document.querySelector('h2[title="Fixture PO subject"]').textContent,'Fixture supplier');assert.ok(!document.body.textContent.includes('Physical receipt:'));
const field=()=>document.querySelector('input[aria-label="Received total for Fixture supply"]');
const editButton=()=>document.querySelector('button[aria-label="Edit received total for Fixture supply"]');
const button=()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Retry saved attempt');
async function blur(){await act(async()=>{field().dispatchEvent(new window.FocusEvent('focusout',{bubbles:true}));});}
async function type(value){if(!field())await act(async()=>editButton().click());await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(field(),value);field().dispatchEvent(new window.Event('input',{bubbles:true}));});}
await type('5');await act(async()=>{field().dispatchEvent(new window.FocusEvent('focusout',{bubbles:true}));field().dispatchEvent(new window.FocusEvent('focusout',{bubbles:true}));});
assert.equal(payloads.length,1);assert.equal(payloads[0].total,5);assert.equal(payloads[0].expectedReceived,0);assert.equal(payloads[0].physicallyReceived,true);assert.ok(!('date' in payloads[0]));
assert.match(document.body.textContent,/MTD \$6\.25/);assert.equal(editButton().textContent,'5');assert.equal(document.querySelector('tbody tr').children[3].textContent,'10');
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),17);
assert.equal((await db.query('select count(*)::int n from cmpri_po_receipts')).rows[0].n,1);
await type('7');loseResponse=true;await blur();assert.match(document.body.textContent,/Outcome may already be saved/);assert.ok(button());
await act(async()=>button().click());assert.equal(payloads.at(-1).id,payloads.at(-2).id);assert.match(document.body.textContent,/MTD \$8\.75/);assert.equal(editButton().textContent,'7');assert.equal(document.querySelector('tbody tr').children[3].textContent,'8');
assert.equal((await db.query('select count(*)::int n from cmpri_po_receipts')).rows[0].n,2);assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),21);
await type('8');loseRpcResponse=true;await blur();assert.match(document.body.textContent,/Outcome may already be saved/);assert.ok(button());
await act(async()=>button().click());assert.equal(payloads.at(-1).id,payloads.at(-2).id);assert.match(document.body.textContent,/MTD \$10\.00/);assert.equal(editButton().textContent,'8');
assert.equal((await db.query('select count(*)::int n from cmpri_po_receipts')).rows[0].n,3);assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),23);
for(const n of ['0','-1','1.5','99']){const before=payloads.length;await type(n);await blur();assert.equal(payloads.length,before);}
const unchanged=payloads.length;await type('8');await blur();assert.equal(payloads.length,unchanged);
const receiveAllButton=()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Receive All');
loseResponse=true;
await act(async()=>receiveAllButton().click());
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),37);
assert.match(document.body.textContent,/Outcome may already be saved/);
const batchAttempt=payloads.at(-1).id;
await act(async()=>receiveAllButton().click());
assert.equal(payloads.at(-1).id,batchAttempt);
assert.equal(editButton().textContent,'15');
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),37);
const finishedCalls=payloads.length;
await act(async()=>receiveAllButton().click());
assert.equal(payloads.length,finishedCalls);
assert.match(document.body.textContent,/No eligible outstanding/);
assert.equal(document.querySelectorAll('[role=separator]').length,1);
const divider=document.querySelector('[role=separator]');
divider.parentElement.getBoundingClientRect=()=>({width:1000,height:700});
divider.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true}));
assert.equal(divider.getAttribute('aria-valuenow'),'750');
divider.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true}));
assert.equal(divider.getAttribute('aria-valuenow'),'720');
window.matchMedia=()=>({matches:true});
divider.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
assert.equal(divider.getAttribute('aria-orientation'),'horizontal');
assert.equal(divider.getAttribute('aria-valuenow'),'140');
let captured=null;divider.setPointerCapture=id=>{captured=id;};divider.hasPointerCapture=id=>captured===id;divider.releasePointerCapture=()=>{captured=null;};
function pointer(type,y){const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{button:0,pointerId:7,clientX:0,clientY:y,pointerType:'touch'});divider.dispatchEvent(e);}
pointer('pointerdown',100);pointer('pointermove',180);pointer('pointerup',180);
assert.equal(divider.getAttribute('aria-valuenow'),'220');assert.equal(captured,null);
const menu=document.querySelector('details');assert.ok(menu);menu.open=true;
await act(async()=>menu.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
assert.equal(menu.open,false);assert.equal(document.activeElement,menu.querySelector('summary'));
menu.open=true;document.body.dispatchEvent(new window.Event('pointerdown',{bubbles:true}));assert.equal(menu.open,false);
const filterMenu=document.querySelector('summary[aria-label="Filter orders"]').parentElement;
const choose=async(menu,label)=>act(async()=>[...menu.querySelectorAll('button')].find(b=>b.textContent===label).click());
await choose(filterMenu,'Accepted');
assert.equal(document.querySelectorAll('#po-orders-pane button > span').length,0);
await choose(filterMenu,'All orders');assert.match(document.getElementById('po-orders-pane').textContent,/FIXTURE-PO/);
const filterLedger=JSON.stringify((await db.query('select (select jsonb_agg(r) from cmpri_po_receipts r) receipts,(select jsonb_agg(i) from cmpri_inventory_items i) inventory')).rows);
await choose(filterMenu,'Unresolved item lines');
assert.equal(document.querySelectorAll('#po-orders-pane button > span').length,0);
await db.query('update cmpri_po_lines set description=$1 where id=$2',['12 inch',line]);
await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh').click());
assert.match(document.getElementById('po-orders-pane').textContent,/FIXTURE-PO/);
await choose(filterMenu,'No item lines recorded');
assert.equal(document.querySelectorAll('#po-orders-pane button > span').length,0);
assert.equal(JSON.stringify((await db.query('select (select jsonb_agg(r) from cmpri_po_receipts r) receipts,(select jsonb_agg(i) from cmpri_inventory_items i) inventory')).rows),filterLedger);
await act(async()=>root.unmount());await db.close();dom.window.close();delete globalThis.__poWorkflowAuth;
console.log('PASS mounted real React received-total input/blur -> real API -> isolated PostgreSQL -> refreshed counts/history/stock, duplicate blur, lost-response exact retry, invalid quantities. DOM simulation, not a browser render.');
