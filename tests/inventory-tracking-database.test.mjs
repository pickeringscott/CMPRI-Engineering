import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hotel=id(1),actor=id(2),poolRoom=id(3),otherRoom=id(4),job=id(5);
const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table profiles(id uuid primary key,full_name text,role text);
create table work_orders(id uuid primary key,hotel_id uuid,notes text not null default '',status text default 'Open',history_actor_user_id uuid,history_source text,unique(id,hotel_id));
create table locations(id uuid primary key,hotel_id uuid,name text,room_number text,area text,active boolean);
create table assets(id uuid primary key,hotel_id uuid,name text,asset_type text,location_id uuid,active boolean);
create table pool_daily_logs(id uuid primary key,hotel_id uuid,log_date date,updated_by uuid,remarks text);`);
for(const name of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements','cmpri_order_ideas','cmpri_vendors','cmpri_vendor_contacts','cmpri_vendor_proposals','cmpri_asset_inventory_compatibility']){
 const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);assert.ok(start>=0,name);
 await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3));
 if(name!=='cmpri_asset_inventory_compatibility')await db.exec(`alter table ${name} add primary key(id);`);
 await db.exec(`grant all on ${name} to service_role;`);
}
await db.exec(`alter table cmpri_asset_inventory_compatibility add unique(asset_id,inventory_item_id);alter table cmpri_order_ideas add work_order_id uuid;
insert into profiles values('${actor}','Scott P.','Chief Engineer');insert into work_orders(id,hotel_id) values('${job}','${hotel}');
insert into locations values('${poolRoom}','${hotel}','Pool Pump Room',null,'Pool',true),('${otherRoom}','${hotel}','Pool HVAC Room',null,'Pool',true);`);
for(const file of ['20261017181855_cmpri_po_receiving.sql','20261017181912_cmpri_manual_order_receiving.sql','20261022070416_cmpri_cumulative_receipt_guard.sql','20261022070436_cmpri_po_package_units.sql','20261109105237_ticket_parts_workflow.sql','20261109113001_pool_log_chemical_usage.sql','20261109143549_inventory_tracking_schema.sql','20261109143600_inventory_tracking_mutations.sql','20261109143605_inventory_tracking_ideas.sql','20261109143609_inventory_tracking_reads.sql','20261109143614_inventory_tracking_pool_scope.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
const draft=(name='Bromine',unit='LB',type='Chemical',location=poolRoom,quantity=25)=>({item_name:name,item_type:type,unit_of_measure:unit,storage_location_id:location,quantity_on_hand:quantity,reason:'Physical shelf count',manufacturer:'',vendor_sku:'',preferred_vendor_id:null});
const mutate=(key,action='create',item=null,data=draft(),expected=null,scope=hotel)=>db.query('select cmpri_inventory_mutate($1,$2,$3,$4,$5,$6,$7) result',[scope,actor,id(key),action,item,data,expected]).then(r=>r.rows[0].result);
const get=key=>db.query('select * from cmpri_inventory_items where id=$1',[id(key)]).then(r=>r.rows[0]);
const notes=key=>db.query('select * from cmpri_inventory_notes where inventory_item_id=$1 order by recorded_at,id',[id(key)]).then(r=>r.rows);
await test('opening stock, managed location and immutable note commit together; retries cannot duplicate',async()=>{
 const first=await mutate(10);assert.equal(first.inventory_item.id,id(10));assert.equal(first.inventory_item.storage_location_id,poolRoom);assert.equal(first.inventory_item.quantity_on_hand,25);assert.equal(first.note.kind,'Opening balance');assert.equal(first.note.quantity_before,0);assert.equal(first.note.quantity_after,25);assert.equal(first.note.actor_name,'Scott P.');assert.ok(first.note.recorded_at);
 const replay=await mutate(10);assert.equal(replay.replayed,true);assert.equal((await notes(10)).length,1);
 await assert.rejects(mutate(11),/Matching inventory/);
 await assert.rejects(mutate(10,'create',null,draft('Changed name')),/different details/);
});
await test('Each fractions, wrong property, inactive locations and missing reasons are rejected atomically',async()=>{
 await assert.rejects(mutate(12,'create',null,draft('Each fraction','EA','Part',poolRoom,.5)),/whole counts/);
 await assert.rejects(mutate(13,'create',null,draft('No location','LB','Chemical',id(999))),/managed Storage/);
 await assert.rejects(mutate(14,'create',null,draft(),null,id(999)),/managed Storage/);
 await assert.rejects(mutate(15,'create',null,{...draft('No note'),reason:''}),/count note/);
 assert.equal(await get(12),undefined);
});
await test('adjustments preserve reservations, reject stale revision and append before/after notes',async()=>{
 await db.query('update cmpri_inventory_items set quantity_reserved=2 where id=$1',[id(10)]);
 const current=await get(10);const result=await mutate(20,'adjust',id(10),{quantity:24,reason:'Count correction'},Number(current.inventory_revision));
 assert.equal(result.inventory_item.quantity_reserved,2);assert.equal(result.note.quantity_before,25);assert.equal(result.note.quantity_after,24);
 await mutate(20,'adjust',id(10),{quantity:24,reason:'Count correction'},Number(current.inventory_revision));assert.equal(Number((await get(10)).quantity_on_hand),24);
 await assert.rejects(mutate(21,'adjust',id(10),{quantity:25,reason:'Stale count'},Number(current.inventory_revision)),/Inventory changed/);
 await assert.rejects(mutate(22,'adjust',id(10),{quantity:1,reason:'Cannot consume reserved'},Number(result.inventory_item.inventory_revision)),/unreserved/);
});
await test('detail edits protect stock units and count history; return is a guarded additive transaction',async()=>{
 const current=await get(10);
 await assert.rejects(mutate(23,'edit',id(10),{...draft(),unit_of_measure:'KG'},Number(current.inventory_revision)),/Stock unit cannot change/);
 const changed=await mutate(24,'edit',id(10),{...draft(),storage_location_id:otherRoom,reorder_level:5},Number(current.inventory_revision));
 assert.equal(changed.inventory_item.storage_location_id,otherRoom);assert.equal(changed.inventory_item.quantity_on_hand,24);assert.equal(changed.note.kind,'Item details');
 const returned=await mutate(25,'return',id(10),{quantity:2,reason:'Unused stock returned'},Number(changed.inventory_item.inventory_revision));assert.equal(returned.inventory_item.quantity_on_hand,26);assert.equal(returned.note.kind,'Return');
});
await test('pool list contains only active Chemical records in the exact configured room; forged use rolls back',async()=>{
 await mutate(30,'create',null,draft('Eligible chemical'));await mutate(31,'create',null,draft('Cartridge','EA','Part'));await mutate(32,'create',null,draft('Wrong room','LB','Chemical',otherRoom));
 const snapshot=(await db.query('select cmpri_pool_inventory($1) result',[hotel])).rows[0].result;
 assert.equal(snapshot.location.id,poolRoom);assert.deepEqual(snapshot.items.map(i=>i.id),[id(30)]);
 const use=key=>db.query(`insert into pool_daily_logs(id,hotel_id,log_date,updated_by,remarks,chemical_uses) values($1,$2,'2026-11-09',$3,'Routine check',$4) returning *`,[id(key),hotel,actor,[{id:id(key+100),item:id(key===40?30:31),quantity:16,unit:'OZ'}]]);
 await assert.rejects(use(41),/active chemical stored/);assert.equal(Number((await get(31)).quantity_on_hand),25);
 const row=(await use(40)).rows[0];assert.match(row.remarks,/Chemical used/);assert.equal(Number((await get(30)).quantity_on_hand),24);
 const note=(await notes(30)).find(n=>n.pool_log_id===id(40));assert.equal(Number(note.quantity_before),25);assert.equal(Number(note.quantity_after),24);assert.ok(note.source_date);
 await db.query('update cmpri_inventory_items set active=false where id=$1',[id(30)]);assert.equal((await db.query('select cmpri_pool_inventory($1) result',[hotel])).rows[0].result.items.length,0);
});
await test('snapshot includes more than API row limits and history pagination has no overlaps',async()=>{
 await db.exec(`insert into cmpri_inventory_items(hotel_id,item_name,name,unit_of_measure) select '${hotel}','Bulk '||n,'Bulk '||n,'EA' from generate_series(1,1001) n`);
 const snapshot=(await db.query('select cmpri_inventory_snapshot($1,false) result',[hotel])).rows[0].result;assert.ok(snapshot.inventory.length>1000);assert.equal(snapshot.locations.length,2);
 const stockOnly=(await db.query('select cmpri_inventory_snapshot($1,true) result',[hotel])).rows[0].result;assert.equal(stockOnly.vendors,undefined);
 await db.exec(`insert into cmpri_inventory_notes(hotel_id,inventory_item_id,actor_name,kind,message,recorded_at) select '${hotel}','${id(10)}','Scott','Audit','Check '||n,'2026-11-09T10:00:00Z' from generate_series(1,60) n`);
 const page=(await db.query('select cmpri_inventory_history($1,$2,$3,null,null) result',[hotel,id(10),'Check'])).rows[0].result;assert.equal(page.notes.length,50);assert.equal(page.has_more,true);
 const last=page.notes.at(-1),next=(await db.query('select cmpri_inventory_history($1,$2,$3,$4,$5) result',[hotel,id(10),'Check',last.recorded_at,last.id])).rows[0].result;assert.equal(next.notes.length,10);assert.equal(new Set([...page.notes,...next.notes].map(n=>n.id)).size,60);
});
await test('one open order idea per item; Ordered/Received require linked physical receiving facts',async()=>{
 const save=(operation,idea=null,data={item_text:'Need chemical',inventory_item_id:id(10),source:'inventory_reorder',quantity:2})=>db.query('select cmpri_inventory_idea_mutate($1,$2,$3,$4,$5) result',[hotel,actor,id(operation),idea,data]).then(r=>r.rows[0].result);
 const first=await save(60),second=await save(61);assert.equal(first.idea.id,second.idea.id);
 await assert.rejects(save(62,first.idea.id,{status:'Received'}),/physical receiving/);
 const order=id(70),line=id(71);await db.query(`insert into cmpri_po_orders(id,hotel_id,supplier,origin,created_by) values($1,$2,'Supplier','manual',$3)`,[order,hotel,actor]);
 await db.query(`insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit) values($1,$2,$3,'Bromine',2,'LB',$4,1)`,[line,hotel,order,id(10)]);
 const linked=await save(63,first.idea.id,{status:'Link PO',po_line_id:line});assert.equal(linked.idea.status,'Ordered');
 await db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',[hotel,actor,id(72),line,2,'2026-11-09','Physical delivery']);
 const snapshot=(await db.query('select cmpri_inventory_snapshot($1) result',[hotel])).rows[0].result;assert.equal(snapshot.ideas.find(i=>i.id===first.idea.id).status,'Received');
 assert.ok((await notes(10)).some(n=>n.po_order_id===order&&n.kind==='PO receipt'));
});
await test('work-order use updates the same ledger; mass/volume cannot be interchanged',async()=>{
 const before=Number((await get(10)).quantity_on_hand);
 await db.query('select cmpri_use_supply_unit($1,$2,$3,$4,$5,$6,$7,$8)',[hotel,actor,id(75),job,id(10),16,'OZ','Physical repair usage']);
 assert.equal(Number((await get(10)).quantity_on_hand),before-1);
 const entry=(await notes(10)).find(n=>n.work_order_id===job);assert.ok(entry);assert.equal(Number(entry.quantity_before),before);assert.equal(Number(entry.quantity_after),before-1);
 await mutate(76,'create',null,draft('Liquid chemical','GAL','Chemical',poolRoom,2));
 await db.query(`insert into pool_daily_logs(id,hotel_id,log_date,updated_by,remarks,chemical_uses) values($1,$2,'2026-11-09',$3,'Liquid usage',$4)`,[id(77),hotel,actor,[{id:id(78),item:id(76),quantity:16,unit:'FLOZ'}]]);
 assert.equal(Number((await get(76)).quantity_on_hand),1.875);
 await assert.rejects(db.query(`insert into pool_daily_logs(id,hotel_id,log_date,updated_by,remarks,chemical_uses) values($1,$2,'2026-11-09',$3,'Wrong dimension',$4)`,[id(79),hotel,actor,[{id:id(179),item:id(76),quantity:16,unit:'OZ'}]]),/unit does not match/);
});
await test('zero-stock legacy units can be corrected before movement history exists; aliases are not unit conversions',async()=>{
 await db.query(`insert into cmpri_inventory_items(id,hotel_id,item_name,unit_of_measure,quantity_on_hand) values($1,$2,'Legacy each','Each',0)`,[id(81),hotel]);
 const changed=await mutate(82,'edit',id(81),{...draft('Legacy each','LB','Chemical'),quantity_on_hand:undefined},1);assert.equal(changed.inventory_item.unit_of_measure,'LB');
 await db.query(`insert into cmpri_inventory_items(id,hotel_id,item_name,unit_of_measure,quantity_on_hand) values($1,$2,'Legacy whole','Each',2)`,[id(83),hotel]);
 const alias=await mutate(84,'edit',id(83),draft('Legacy whole','EA','Part'),1);assert.equal(alias.inventory_item.quantity_on_hand,2);
});
await test('downstream note failure rolls back all stock and replay records; browser roles have no direct grants',async()=>{
 const before=await get(10);await db.exec(`create function reject_stock_note() returns trigger language plpgsql as $$begin raise exception 'note rejected';end$$;create trigger reject_stock_note before insert on cmpri_inventory_notes for each row execute function reject_stock_note();`);
 await assert.rejects(mutate(85,'adjust',id(10),{quantity:20,reason:'Note failure'},Number(before.inventory_revision)),/note rejected/);assert.equal((await get(10)).quantity_on_hand,before.quantity_on_hand);
 assert.equal((await db.query('select count(*)::int n from cmpri_inventory_operations where id=$1',[id(85)])).rows[0].n,0);await db.exec('drop trigger reject_stock_note on cmpri_inventory_notes');
 for(const role of ['anon','authenticated']){assert.equal((await db.query("select has_function_privilege($1,'cmpri_inventory_mutate(uuid,uuid,uuid,text,uuid,jsonb,bigint)','execute') allowed",[role])).rows[0].allowed,false);assert.equal((await db.query("select has_table_privilege($1,'cmpri_inventory_notes','insert') allowed",[role])).rows[0].allowed,false);}
});
await db.close();
