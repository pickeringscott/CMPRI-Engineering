

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
const total=(key,value,expected,hotel=h)=>`select cmpri_receive_po_total('${hotel}','${actor}','${id(key)}','${line}',${value},${expected},'2026-10-22')`;
const stock=async()=>Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand);
await q(total(100,2,0)); assert.equal(await stock(),6);
await q(total(100,2,0)); assert.equal(await stock(),6);
await assert.rejects(q(total(101,3,0)),/changed/); assert.equal(await stock(),6);
await q(total(102,2,2)); assert.equal(await stock(),6);
await assert.rejects(q(total(100,3,0)),/different details/);
await assert.rejects(q(total(103,11,2)),/exceeds/); assert.equal(await stock(),6);
await assert.rejects(q(total(104,1,2)),/Invalid/);
await assert.rejects(q(total(105,3,2,id(999))),/not found/);
await q(total(106,5,2)); assert.equal(await stock(),9);
await q('set role authenticated'); await assert.rejects(q(total(107,6,5)),/permission denied/); await q('reset role');
assert.equal(Number((await db.query('select count(*) n from cmpri_po_receipts')).rows[0].n),2);
console.log('PASS cumulative partial receipts, exact retry, stale second session count, unchanged blur, conflicting retry, overreceipt, reductions, hotel isolation and browser-role denial');
await db.close();
