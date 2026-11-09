import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const hotel=id(1),actor=id(2),job=id(3),item=id(4),order=id(5),line=id(6);
const migration=readFileSync('supabase/migrations/20261109105237_ticket_parts_workflow.sql','utf8');
const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table public.work_orders(id uuid primary key,hotel_id uuid,notes text not null default '',status text default 'Open',history_actor_user_id uuid,history_source text,unique(id,hotel_id));
create table public.profiles(id uuid primary key,full_name text,role text);`);
for(const name of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements','cmpri_order_ideas']) {
 const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
 await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3));
 await db.exec(`alter table public.${name} add primary key(id);grant all on public.${name} to service_role;`);
}
await db.exec('alter table cmpri_order_ideas add work_order_id uuid;');
for(const file of ['20261017181855_cmpri_po_receiving.sql','20261017181912_cmpri_manual_order_receiving.sql','20261022070416_cmpri_cumulative_receipt_guard.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
await db.exec('alter table cmpri_po_lines add column if not exists purchase_unit_price_cents bigint');
await db.exec(readFileSync('supabase/migrations/20261022070436_cmpri_po_package_units.sql','utf8'));
await db.exec(migration);
await db.exec(readFileSync('supabase/migrations/20261109113005_work_order_parts_pills.sql','utf8'));
await db.exec(`insert into profiles values('${actor}','Scott','engineer');insert into work_orders(id,hotel_id) values('${job}','${hotel}');
insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand,quantity_reserved,unit_of_measure) values('${item}','${hotel}','Replacement bulb',12,2,'EA');
insert into cmpri_po_orders(id,hotel_id,supplier,origin,created_by) values('${order}','${hotel}','Fixture supplier','manual','${actor}');
insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit) values('${line}','${hotel}','${order}','Replacement bulb',3,'EA','${item}',1);
grant select,update on work_orders to service_role;grant select on profiles to service_role;`);
const notes=async()=>(await db.query('select notes from work_orders where id=$1',[job])).rows[0].notes;
const stock=async()=>Number((await db.query('select quantity_on_hand from cmpri_inventory_items where id=$1',[item])).rows[0].quantity_on_hand);
const save=(key,status='In-House',rev=0,po=null,qty=2,scope=hotel,inventory=item)=>db.query('select cmpri_save_ticket_part($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[scope,actor,id(key),job,'Replacement bulb',inventory,status,qty,po,rev]);
await test('In-House part records a single ticket note without consuming stock; replay is stable',async()=>{
 await save(10);const before=await notes();await save(10);assert.equal(await stock(),12);assert.equal(await notes(),before);assert.match(before,/CMPRI2\|.*\|Scott\|engineer\|note\|\[Parts\]/);
});
await test('Need to Order creates an existing Order Idea and posts it only to ticket notes',async()=>{
 await save(11,'Need to Order');const ideas=(await db.query('select * from cmpri_order_ideas where id=$1',[id(11)])).rows;
 assert.equal(ideas.length,1);assert.equal(ideas[0].work_order_id,job);assert.equal(ideas[0].notes,'');assert.equal(await stock(),12);
 const before=await notes();await save(11,'Need to Order');assert.equal(await notes(),before);assert.match(before,/\[Order idea\].*Replacement bulb/);
});
await test('conflicting revision and cross-property records fail without partial writes',async()=>{
 const before=await notes();await assert.rejects(save(10,'Need to Order',99),/changed/);await assert.rejects(save(15,'In-House',0,null,2,id(99)),/unavailable/);assert.equal(await notes(),before);
});
await test('PO status cannot be set by hand or linked to mismatched inventory',async()=>{
 await assert.rejects(save(16,'Received'),/Invalid/);await assert.rejects(save(16,'Need to Order',0,line,2,hotel,null),/mapped/);
 await assert.rejects(db.query('select cmpri_update_idea_ticket_status($1,$2,$3,$4)',[hotel,actor,id(11),'Received']),/Link/);
});
await test('linking accepted manual PO creates context without adding inventory',async()=>{
 await save(11,'Need to Order',1,line);assert.equal(await stock(),12);assert.match(await notes(),/Linked PO Fixture supplier/);
 assert.equal((await db.query('select status from cmpri_order_ideas where id=$1',[id(11)])).rows[0].status,'Ordered');
});
const use=(key,qty=1,unit='EA')=>db.query('select cmpri_use_supply_unit($1,$2,$3,$4,$5,$6,$7,$8)',[hotel,actor,id(key),job,item,qty,unit,'Recorded from Labor & Parts']);
await test('usage atomically deducts, records count change, and never double deducts on replay',async()=>{
 await use(20);assert.equal(await stock(),11);const before=await notes();await use(20);assert.equal(await stock(),11);assert.equal(await notes(),before);assert.match(before,/Used 1 EA Replacement bulb.*On hand 12 → 11 EA/);
 assert.equal((await db.query('select count(*)::int n from cmpri_inventory_movements where id=$1',[id(20)])).rows[0].n,1);
});
await test('overdraw, wrong units and downstream note failure roll back the entire usage transaction',async()=>{
 const before=await notes();await assert.rejects(use(21,10),/Insufficient/);await assert.rejects(use(22,1,'LB'),/unit/);
 assert.equal(await stock(),11);assert.equal(await notes(),before);
 await db.exec(`create function reject_parts_note() returns trigger language plpgsql as $$begin raise exception 'note rejected';end$$;create trigger reject_parts_note before update on work_orders for each row execute function reject_parts_note();`);
 await assert.rejects(use(23),/note rejected/);assert.equal(await stock(),11);assert.equal((await db.query('select count(*)::int n from cmpri_supply_uses where id=$1',[id(23)])).rows[0].n,0);
 await db.exec('drop trigger reject_parts_note on work_orders;');
});
await test('physical receiving adds stock once and appends receiving details to the linked ticket',async()=>{
 const args=[hotel,actor,id(30),line,1,'2026-11-09','Confirmed physical receipt'];
 await db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',args);assert.equal(await stock(),12);const before=await notes();
 await db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',args);assert.equal(await notes(),before);assert.equal(await stock(),12);assert.match(before,/Physical receipt: 1(?:\.000)? EA Replacement bulb.*Confirmed physical receipt/);
});
await test('final receipt synchronizes Order Idea and exact ticket status together',async()=>{
 await db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',[hotel,actor,id(31),line,1,'2026-11-09','Second physical delivery']);
 assert.equal((await db.query('select status from cmpri_order_ideas where id=$1',[id(11)])).rows[0].status,'Received');
 const result=(await db.query('select cmpri_read_ticket_parts($1,$2) result',[hotel,job])).rows[0].result;
 assert.equal(result.parts.find(p=>p.id===id(11)).status,'Received');
});
await test('default-unit each usage rejects fractional counts without changing notes or stock',async()=>{
 const before=await stock(),history=await notes();
 await assert.rejects(db.query('select cmpri_use_supply($1,$2,$3,$4,$5,$6,$7)',[hotel,actor,id(32),job,item,0.5,'Used half bulb']),/whole count/);
 assert.equal(await stock(),before);assert.equal(await notes(),history);
});
await test('PO cancellation posts to ticket; direct browser roles cannot mutate parts',async()=>{
 await save(12,'Need to Order',0,line,3);
 await db.query('update cmpri_po_orders set cancelled=true where id=$1',[order]);assert.match(await notes(),/\[PO\].*Cancelled/);assert.equal((await db.query('select status from cmpri_order_ideas where id=$1',[id(11)])).rows[0].status,'Received');assert.equal((await db.query('select status from cmpri_order_ideas where id=$1',[id(12)])).rows[0].status,'Idea');
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(save(40),/permission denied/);await assert.rejects(db.query('select * from cmpri_ticket_parts'),/permission denied/);await db.exec('reset role');}
});
await test('PO item correction invalidates links and requires explicit review, preserving original supply identity',async()=>{
 await db.query('insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand,unit_of_measure) values($1,$2,$3,0,$4)',[id(60),hotel,'Different supply','EA']);
 await db.query('update cmpri_po_lines set inventory_item_id=$1 where id=$2',[id(60),line]);
 const part=(await db.query('select * from cmpri_ticket_parts where id=$1',[id(11)])).rows[0];
 assert.equal(part.po_line_id,null);assert.equal(part.inventory_item_id,item);assert.equal(part.requested_status,'Need to Order');
 assert.match(await notes(),/Review the part and relink the corrected PO item/);
});
await test('decimal split receipts use exact SQL numeric for both PO and ticket status',async()=>{
 await db.query('insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand,unit_of_measure) values($1,$2,$3,0,$4)',[id(61),hotel,'Sealant','LB']);
 await db.query('insert into cmpri_po_lines(id,hotel_id,order_id,description,ordered,uom,inventory_item_id,units_per_order_unit) values($1,$2,$3,$4,1,$5,$6,1)',[id(62),hotel,order,'Sealant','LB',id(61)]);
 await db.query('update cmpri_po_orders set cancelled=false where id=$1',[order]);
 await db.query('select cmpri_save_ticket_part($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[hotel,actor,id(63),job,'Sealant',id(61),'Need to Order',0.8,id(62),0]);
 for(const [key,amount] of [[64,0.1],[65,0.7]])await db.query('select cmpri_receive_po($1,$2,$3,$4,$5,$6,$7)',[hotel,actor,id(key),id(62),amount,'2026-11-09','Physical weight']);
 const result=(await db.query('select cmpri_read_ticket_parts($1,$2) result',[hotel,job])).rows[0].result;
 assert.equal(result.parts.find(p=>p.id===id(63)).status,'Received');assert.equal(result.receiptTotals.find(t=>t.line_id===id(62)).received,'0.8');
 assert.equal((await db.query('select status from cmpri_order_ideas where id=$1',[id(63)])).rows[0].status,'Received');
});
await test('batch pill summary uses authoritative PO/receipt states, mixed precedence and property scope',async()=>{
 const context=(await db.query('select cmpri_read_ticket_parts($1,$2) result',[hotel,job])).rows[0].result;
 const rank=['Need to Order','On Order','In-House','Received'];
 const expected=[...context.parts].sort((a,b)=>rank.indexOf(a.status)-rank.indexOf(b.status))[0].status;
 const result=await db.query('select * from cmpri_ticket_parts_statuses($1,$2)',[hotel,[job,id(999)]]);
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].status,expected);
 assert.equal((await db.query('select * from cmpri_ticket_parts_statuses($1,$2)',[id(999),[job]])).rows.length,0);
 // Isolate each recorded stage to prove the summary equals the parts editor, including decimal receipt totals.
 for(const part of context.parts){
  await db.exec('begin');
  await db.query('delete from cmpri_ticket_parts where work_order_id=$1 and id<>$2',[job,part.id]);
  assert.equal((await db.query('select * from cmpri_ticket_parts_statuses($1,$2)',[hotel,[job]])).rows[0].status,part.status);
  await db.exec('rollback');
 }
 assert.equal((await db.query("select has_function_privilege('authenticated','cmpri_ticket_parts_statuses(uuid,uuid[])','execute') allowed")).rows[0].allowed,false);
});
await db.close();
