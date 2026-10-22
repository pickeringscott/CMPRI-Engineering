

import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const h=id(1),actor=id(2),order=id(3),line=id(4),item=id(5),job=id(6);
const q=sql=>db.exec(sql);const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
await q('create role anon;create role authenticated;create role service_role bypassrls;create table work_orders(id uuid primary key,hotel_id uuid);');
for(const table of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements']){const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`);await q(baseline.slice(start,baseline.indexOf('\n);',start)+3));await q(`alter table ${table} add primary key(id);grant all on ${table} to service_role;`);}
await q(readFileSync('supabase/migrations/20261016211655_cmpri_po_receiving.sql','utf8'));
await q(`insert into work_orders values('${job}','${h}');grant select on work_orders to service_role;insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand) values('${item}','${h}','Filter',4);insert into cmpri_po_orders(id,hotel_id,supplier,origin,created_by) values('${order}','${h}','Doug','manual','${actor}');insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit) values('${line}','${h}','${order}','Filter',10,'EA','${item}',1);`);
await q(readFileSync('supabase/migrations/20261017181912_cmpri_manual_order_receiving.sql','utf8'));
await q(readFileSync('supabase/migrations/20261022062702_cmpri_cumulative_receipt_guard.sql','utf8'));

await q('alter table cmpri_po_lines add column if not exists purchase_unit_price_cents bigint');
await q(readFileSync('supabase/migrations/20261022063156_cmpri_po_package_units.sql','utf8'));
const add=(key,unit,size,content,target=null,qty=2)=>db.query('select cmpri_po_add_item($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[h,actor,id(key),order,target,'Test '+key,qty,unit,size,content,'',12.50]);
await add(200,'CS',50,'LB');
const itemRow=async key=>(await db.query('select i.* from cmpri_inventory_items i join cmpri_po_lines l on l.inventory_item_id=i.id where l.id=$1',[id(key)])).rows[0];
const receive=async(key,total,expected,attempt)=>db.query('select cmpri_receive_po_total($1,$2,$3,$4,$5,$6,$7)',[h,actor,id(attempt),id(key),total,expected,'2026-10-22']);
assert.equal(Number((await itemRow(200)).quantity_on_hand),0);
await receive(200,1,0,210);assert.equal(Number((await itemRow(200)).quantity_on_hand),50);
await receive(200,1,0,210);assert.equal(Number((await itemRow(200)).quantity_on_hand),50);
await add(201,'CS',25,'LB',(await itemRow(200)).id);await receive(201,1,0,211);assert.equal(Number((await itemRow(200)).quantity_on_hand),75);
await add(202,'OZ',null,null,(await itemRow(200)).id,1);await receive(202,1,0,212);assert.equal(Number((await itemRow(200)).quantity_on_hand),75.0625);
await add(203,'G',null,null,(await itemRow(200)).id,453.592);await receive(203,453.592,0,213);
assert.ok(Number((await itemRow(200)).quantity_on_hand)>76.06249);
await assert.rejects(add(204,'CS',null,null),/contents/);
await assert.rejects(add(205,'CS',1.5,'EA'),/whole/);
await assert.rejects(add(206,'LB',null,null,item),/unit/);
await assert.rejects(receive(201,3,1,214),/exceeds/);
await assert.rejects(receive(201,2,0,215),/changed/);
assert.equal((await db.query('select conversion_numerator::text n,conversion_denominator::text d from cmpri_po_lines where id=$1',[id(203)])).rows[0].d,'453.59237');
await add(200,'CS',50,'LB');assert.equal(Number((await itemRow(200)).quantity_on_hand)>76,true);
const beforeUse=Number((await itemRow(200)).quantity_on_hand);
const consumeSupply=()=>db.query('select cmpri_use_supply_unit($1,$2,$3,$4,$5,$6,$7,$8)',[h,actor,id(220),job,(awaitItem),'1','OZ','Used on fixture work order']);
const awaitItem=(await itemRow(200)).id;
await consumeSupply();await consumeSupply();assert.equal(Number((await itemRow(200)).quantity_on_hand),beforeUse-0.0625);
assert.match((await db.query('select note from cmpri_supply_uses where id=$1',[id(220)])).rows[0].note,/Entered usage: 1 OZ/);
await db.exec('set role authenticated');await assert.rejects(add(207,'EA',null,null),/permission denied/);await db.exec('reset role');
console.log('PASS package persistence, zero stock, stable identity, per-order package sizes, ounce/gram conversion, retained exact conversion inputs, cumulative receipts, replay, stale/overreceipt and role denial');
await db.close();

