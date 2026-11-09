

import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const h=id(1),actor=id(2),order=id(3),line=id(4),item=id(5),job=id(6);
import {historicalReceiptBatch} from '../scripts/historical-receipt-batch.mjs';
const q=sql=>db.exec(sql);const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
await q('create role anon;create role authenticated;create role service_role bypassrls;create table work_orders(id uuid primary key,hotel_id uuid);');
for(const table of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements']){const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`);await q(baseline.slice(start,baseline.indexOf('\n);',start)+3));await q(`alter table ${table} add primary key(id);grant all on ${table} to service_role;`);}
await q(readFileSync('supabase/migrations/20261017181855_cmpri_po_receiving.sql','utf8'));
await q(`insert into work_orders values('${job}','${h}');grant select on work_orders to service_role;insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand) values('${item}','${h}','Filter',4);insert into cmpri_po_orders(id,hotel_id,supplier,origin,created_by) values('${order}','${h}','Doug','manual','${actor}');insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit) values('${line}','${h}','${order}','Filter',10,'EA','${item}',1);`);
await q(readFileSync('supabase/migrations/20261017181912_cmpri_manual_order_receiving.sql','utf8'));
await q(readFileSync('supabase/migrations/20261022070416_cmpri_cumulative_receipt_guard.sql','utf8'));

await q('alter table cmpri_po_lines add column if not exists purchase_unit_price_cents bigint');
await q(readFileSync('supabase/migrations/20261022070436_cmpri_po_package_units.sql','utf8'));
await q(readFileSync('supabase/migrations/20261022174010_cmpri_unknown_receipt_dates.sql','utf8'));
await q(`update cmpri_po_orders set acceptance='accepted',external_reference='TEST';update cmpri_inventory_items set quantity_on_hand=0,unit_of_measure='EA';update cmpri_po_lines set ordered=3,sku='A';insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit,sku) values('${id(7)}','${h}','${order}','Second line',2,'EA','${item}',1,'B');`);
const rows=[{line_id:line,order_id:order,inventory_item_id:item,approved:3,uom:'EA',unit_of_measure:'EA',units_per_order_unit:1,po:'TEST',sku:'A'},{line_id:id(7),order_id:order,inventory_item_id:item,approved:2,uom:'EA',unit_of_measure:'EA',units_per_order_unit:1,po:'TEST',sku:'B'}];
const sql=historicalReceiptBatch({hotel:h,actor,batch:'test-verified',rows});
await q(`update cmpri_po_lines set ordered=4 where id='${id(7)}'`);
await assert.rejects(q(sql),/evidence changed/);
assert.equal((await db.query('select count(*)::int n from cmpri_po_receipts')).rows[0].n,0);
await q(`update cmpri_po_lines set ordered=2 where id='${id(7)}';update cmpri_inventory_items set quantity_on_hand=1`);
await assert.rejects(q(sql),/evidence changed/);
await q('update cmpri_inventory_items set quantity_on_hand=0');
await q('set role authenticated');await assert.rejects(q(sql),/permission denied/);await q('reset role');
await q(sql);await q(sql);
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),5);
assert.deepEqual((await db.query("select count(*)::int n,count(received_date)::int dated,sum(quantity)::int qty from cmpri_po_receipts where receipt_kind='historical'")).rows[0],{n:2,dated:0,qty:5});
await db.query('select cmpri_use_supply_precise($1,$2,$3,$4,$5,$6,$7)',[h,actor,id(20),job,item,2,'Fixture usage']);
await q(sql);assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),3);
await assert.rejects(db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',[h,actor,id(21),line,1,'2026-10-22','Excess']),/exceeds/);
await q(`insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit) values('${id(8)}','${h}','${order}','Future receipt',1,'EA','${item}',1)`);
await assert.rejects(db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',[h,actor,id(22),id(8),1,null,'Undated normal']),/Invalid/);
await db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',[h,actor,id(23),id(8),1,'2026-10-22','Normal dated receipt']);
assert.equal(Number((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand),4);
assert.equal((await db.query("select receipt_kind from cmpri_po_receipts where id=$1",[id(23)])).rows[0].receipt_kind,'delivery');
console.log('PASS historical transaction: changed evidence rollback, role denial, same-item aggregation, null actual dates, retry after usage, overreceipt and normal dated receiving preserved');
await db.close();
