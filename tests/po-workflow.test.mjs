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
await db.query('insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand,active) values($1,$2,$3,7,true)',[item,hotel,'Isolated supply']);
let rpcCalls=0;
const admin={
  from(table){
    const filters=[];let update=null;
    const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},update(v){update=v;return q;},then(resolve,reject){return db.query(`select * from ${table} where ${filters.map(([k],i)=>`${k}=$${i+1}`).join(' and ')}`,filters.map(([,v])=>v)).then(r=>resolve({data:r.rows.map(row=>({...row,...(row.received_date instanceof Date?{received_date:row.received_date.toISOString().slice(0,10)}:{})})),error:null}),reject);},async single(){
      try{
        let sql,params;
        if(update){const fields=Object.entries(update);params=fields.map(([,v])=>v).concat(filters.map(([,v])=>v));sql=`update ${table} set ${fields.map(([k],i)=>`${k}=$${i+1}`).join(',')} where ${filters.map(([k],i)=>`${k}=$${fields.length+i+1}`).join(' and ')} returning *`;}
        else{params=filters.map(([,v])=>v);sql=`select * from ${table} where ${filters.map(([k],i)=>`${k}=$${i+1}`).join(' and ')}`;}
        const r=await db.query(sql,params);return {data:r.rows[0]||null,error:null};
      }catch(e){return {data:null,error:{message:e.message,code:e.code}};}
    }};return q;
  },
  async rpc(name,p){rpcCalls++;try{const args={cmpri_create_manual_po:['p_hotel','p_actor','p_id','p_supplier','p_reference','p_description','p_quantity','p_uom'],cmpri_link_po_line:['p_hotel','p_line','p_item','p_factor'],cmpri_receive_po:['p_hotel','p_actor','p_id','p_line','p_quantity','p_date','p_note']}[name];assert.ok(args);const r=await db.query(`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) result`,args.map(k=>p[k]));return {data:r.rows[0].result,error:null};}catch(e){return {error:{message:e.message,code:e.code}};}}
};
globalThis.__poWorkflowAuth={admin,principal:{identity:{id:actor}}};
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let source=fs.readFileSync('src/app/api/engineering/purchase-orders/route.ts','utf8');
const mappings={'@/lib/server/auth':data('export const requireCapability=async()=>globalThis.__poWorkflowAuth;'),'@/lib/constants':data(`export const HOTEL_ID=${JSON.stringify(hotel)};export const HOTEL_TIME_ZONE="America/Chicago";`),'@/lib/server/paginated-query':data('export const fetchAllPages=()=>{throw Error("Unused GET");};'),'@/lib/po-workflow':pathToFileURL(path.resolve('src/lib/po-workflow.ts')).href,'next/server':pathToFileURL(path.resolve('node_modules/next/server.js')).href};
for(const [key,url]of Object.entries(mappings))source=source.replaceAll(`'${key}'`,JSON.stringify(url));
const route=await import(data(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText));
process.env.CMPRI_PO_ENABLED='true';
const post=body=>route.POST(new Request('http://isolated.test/api/engineering/purchase-orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
const manual={action:'manual',id:order,supplier:'Fixture',reference:'',description:'Fixture item',quantity:2,uom:'EA'};
assert.equal((await post({...manual,quantity:0.5})).status,400);assert.equal(rpcCalls,0);
assert.equal((await post(manual)).status,200);
const line=(await db.query('select id from cmpri_po_lines where order_id=$1',[order])).rows[0].id;
const receipt={action:'receive',id:id(5),lineId:line,quantity:2,date:'2026-10-17',note:'Isolated count',physicallyReceived:true};
assert.equal((await post(receipt)).status,400); // Manual still requires mapping.
assert.equal((await post({action:'link',id:line,itemId:item,factor:0.5})).status,200);
assert.equal((await post({action:'accept',id:order,note:'Must not invent approval'})).status,400);
const provenance=(await db.query('select acceptance,accepted_by,accepted_at,acceptance_note from cmpri_po_orders where id=$1',[order])).rows[0];
assert.deepEqual(provenance,{acceptance:'unresolved',accepted_by:null,accepted_at:null,acceptance_note:null});
// Persisted nonmanual origin still enforces approval; client-supplied origin cannot bypass it.
await db.query("update cmpri_po_orders set origin='ibuy' where id=$1",[order]);
assert.match(await (await post({...receipt,origin:'manual'})).text(),/Company acceptance required/);
assert.equal((await post({action:'accept',id:order,note:'Isolated source approval'})).status,200);
await db.exec('begin');
assert.equal((await post(receipt)).status,200); // Approved nonmanual order remains receivable.
await db.exec('rollback');
await db.query("update cmpri_po_orders set origin='manual',acceptance='unresolved',accepted_by=null,accepted_at=null,acceptance_note=null where id=$1",[order]);
const before=rpcCalls;assert.equal((await post({...receipt,quantity:1.5})).status,400);assert.equal(rpcCalls,before);
assert.equal((await post(receipt)).status,200);
assert.equal((await post(receipt)).status,200); // Exact replay adds stock only once.
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[item])).rows[0].quantity_on_hand),8);
assert.equal(Number((await db.query('select stock_quantity from cmpri_po_receipts')).rows[0].stock_quantity),1);
assert.equal((await post({...receipt,id:id(6),quantity:1})).status,400);
await db.query('update cmpri_po_lines set ordered=2.5 where id=$1',[line]); // Existing legacy data, isolated only.
assert.equal((await post({...receipt,id:id(7),quantity:1})).status,400);
assert.equal(Number((await db.query('select ordered from cmpri_po_lines where id=$1',[line])).rows[0].ordered),2.5);
await db.query('update cmpri_po_lines set ordered=3 where id=$1',[line]);
await db.query('update cmpri_po_receipts set quantity=1.5 where line_id=$1',[line]);
assert.equal((await post({...receipt,id:id(8),quantity:1})).status,400);
assert.equal(Number((await db.query('select quantity from cmpri_po_receipts where line_id=$1',[line])).rows[0].quantity),1.5);
// New inline Confirm: real route and atomic database contract, no manual date/note.
const autoOrder=id(50);assert.equal((await post({...manual,id:autoOrder,quantity:15})).status,200);
const autoLine=(await db.query('select id from cmpri_po_lines where order_id=$1',[autoOrder])).rows[0].id;
assert.equal((await post({action:'link',id:autoLine,itemId:item,factor:2})).status,200);
const stockBefore=Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[item])).rows[0].quantity_on_hand);
const auto={action:'receive',id:id(51),lineId:autoLine,quantity:5,receiveNow:true,physicallyReceived:true};
const simultaneous=await Promise.all([post(auto),post(auto)]);assert.deepEqual(simultaneous.map(r=>r.status),[200,200]);assert.equal((await post(auto)).status,200);
let rows=(await db.query('select * from cmpri_po_receipts where line_id=$1',[autoLine])).rows;
assert.equal(rows.length,1);assert.equal(Number(rows[0].quantity),5);assert.equal(new Date(rows[0].received_date).toISOString().slice(0,10),poHotelDate(new Date(),"America/Chicago"));
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[item])).rows[0].quantity_on_hand),stockBefore+10);
const historical=rows[0];
for(const quantity of [0,-1,1.5,16])assert.equal((await post({...auto,id:id(52),quantity})).status,400);
assert.equal((await post({...auto,quantity:4})).status,400);
assert.equal((await post({...auto,id:id(53),quantity:3})).status,200);
rows=(await db.query('select * from cmpri_po_receipts where line_id=$1 order by created_at',[autoLine])).rows;
assert.equal(rows.length,2);assert.deepEqual(rows[0],historical);assert.equal(15-rows.reduce((n,r)=>n+Number(r.quantity),0),7);
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[item])).rows[0].quantity_on_hand),stockBefore+16);
assert.equal((await db.query('select count(*)::int n from cmpri_inventory_movements where id in($1,$2)',[id(51),id(53)])).rows[0].n,2);
console.log('PASS inline Confirm: server date, 5 received / 10 outstanding, exact replay, immutable partial history and stock movements');
await db.close();delete globalThis.__poWorkflowAuth;
console.log('PASS real isolated API → manual order → fractional mapping → approval → whole receipt → stock; replay, over-receipt, legacy fractional hold, and known/unknown item values');
