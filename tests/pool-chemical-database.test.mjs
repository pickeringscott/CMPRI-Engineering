import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db = new PGlite();
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hotel=id(1),actor=id(2),item=id(3),log=id(4);
const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
for (const name of ['cmpri_inventory_items','cmpri_inventory_movements']) {
 const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
 await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3));
 await db.exec(`alter table ${name} add primary key(id);`);
}
await db.exec('alter table cmpri_inventory_items alter column quantity_on_hand type numeric; alter table cmpri_inventory_movements alter column quantity_change type numeric;');
await db.exec(`create table pool_daily_logs(id uuid primary key,hotel_id uuid,log_date date,updated_by uuid,remarks text);`);
const units=readFileSync('supabase/migrations/20261022070436_cmpri_po_package_units.sql','utf8');
const start=units.indexOf('create function public.cmpri_unit_grams');
await db.exec(units.slice(start,units.indexOf('$$;',start)+3));
await db.exec(readFileSync('supabase/migrations/20261109113001_pool_log_chemical_usage.sql','utf8'));
await db.exec(`insert into cmpri_inventory_items(id,hotel_id,item_name,unit_of_measure,quantity_on_hand,quantity_reserved) values('${item}','${hotel}','Bromine','LB',10,2);`);
const use=(key,qty=16,unit='OZ',it=item)=>({id:id(key),item:it,quantity:qty,unit});
const save=(uses,remarks='Checked pool')=>db.query(`update pool_daily_logs set chemical_uses=$1,remarks=$2 where id=$3 returning *`,[JSON.stringify(uses),remarks,log]);
const stock=async()=>Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[item])).rows[0].quantity_on_hand);
await test('pool save atomically records chemical conversion, Remarks, count delta and existing movement',async()=>{
 await db.query(`insert into pool_daily_logs(id,hotel_id,log_date,updated_by,remarks,chemical_uses) values($1,$2,'2026-11-09',$3,'Checked pool',$4)`,[log,hotel,actor,JSON.stringify([use(10)])]);
 assert.equal(await stock(),9);
 const row=(await db.query('select * from pool_daily_logs')).rows[0];
 assert.equal(row.remarks,'Checked pool\nChemical used: 16 OZ Bromine.');
 assert.equal(Number(row.chemical_uses[0].stock_quantity),1);assert.equal(Number(row.chemical_uses[0].before),10);assert.equal(Number(row.chemical_uses[0].after),9);
 const move=(await db.query('select * from cmpri_inventory_movements')).rows[0];
 assert.equal(Number(move.quantity_change),-1);assert.equal(move.movement_type,'Use');assert.equal(move.direction,'out');assert.match(move.notes,/Pool log 2026-11-09/);
});
await test('retry deduplicates inventory and generated Remarks, and later saves preserve the ledger',async()=>{
 await save([use(10)],'Checked pool\nChemical used: 16 OZ Bromine.\nChemical used: 16 OZ Bromine.');
 assert.equal(await stock(),9);
 assert.equal((await db.query('select remarks from pool_daily_logs')).rows[0].remarks,'Checked pool\nChemical used: 16 OZ Bromine.');
 await db.exec(`update pool_daily_logs set remarks='Later check'`);
 assert.equal((await db.query('select remarks from pool_daily_logs')).rows[0].remarks,'Later check\nChemical used: 16 OZ Bromine.');
});
await test('reserved stock, invalid units, fractional Each, wrong property and conflicting IDs roll back',async()=>{
 for (const usage of [use(11,8,'LB'),use(12,1,'EA'),use(10,2),use(13,1,'LB',id(99))]) await assert.rejects(save([usage]));
 assert.equal(await stock(),9);
 const before=(await db.query('select remarks from pool_daily_logs')).rows[0].remarks;
 await assert.rejects(save([use(14,1,'LB'),use(15,999,'LB')]));
 assert.equal(await stock(),9);assert.equal((await db.query('select remarks from pool_daily_logs')).rows[0].remarks,before);
 await db.exec(`update cmpri_inventory_items set unit_of_measure='Each'`);
 await assert.rejects(save([use(16,.5,'Each')]),/whole count/);
 await db.exec(`update cmpri_inventory_items set unit_of_measure='LB'`);
});
await test('later operator remarks stay after the saved Remarks prefix when another chemical is added',async()=>{
 const before=(await db.query('select remarks from pool_daily_logs')).rows[0].remarks;
 const row=(await save([use(17)],before+'\nRetested after adjustment.\nChemical used: 16 OZ Bromine.')).rows[0];
 assert.ok(row.remarks.startsWith(before));assert.match(row.remarks,/Retested after adjustment/);
 assert.equal(row.chemical_uses.length,2);assert.equal(await stock(),8);
 // Restore stock for subsequent independent failure checks, retaining the second saved usage.
 await db.exec('update cmpri_inventory_items set quantity_on_hand=9');
});
await test('a downstream pool-log failure rolls back inventory and movement',async()=>{
 await db.exec(`create function reject_log() returns trigger language plpgsql as $$begin raise exception 'log rejected';end$$;create trigger zz_reject_log before update on pool_daily_logs for each row execute function reject_log();`);
 await assert.rejects(save([use(20)]),/log rejected/);assert.equal(await stock(),9);
 assert.equal((await db.query('select count(*)::int n from cmpri_inventory_movements')).rows[0].n,2);
 await db.exec('drop trigger zz_reject_log on pool_daily_logs');
});
await test('direct authenticated chemical writes cannot bypass pool-log server authorization',async()=>{
 await db.exec('grant select,update on pool_daily_logs to authenticated; set role authenticated;');
 await assert.rejects(save([use(30)]),/through the pool log/);
 await db.exec('reset role'); assert.equal(await stock(),9);
});
await db.close();
