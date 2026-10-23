import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {bindOfflinePoDocument,offlineRecoveryDigest,persistReviewedOfflineRecovery} from '../src/lib/server/po-offline-recovery.ts';
const url='https://www.ibuyefficient.com/webhook/getemailpotransmission?data=fixture&token=fixture';
const source={account:'buyer@example.test',id:'email-1',messageAt:'2026-10-16T22:00:00Z',from:'iBuyEfficientOrders@avendra.com',subject:'New PO',text:`Click here to accept and retrieve this purchase order <${url}>`};
// Synthetic document with the real template's column coordinates; no private PDF committed.
function pdfBytes(po='12345678901'){
 const texts=[['Purchase Order #'+po,52,778],['Accepted 10/16/2026 2:58:44 PM',52,766],['Supplier',300,781],['HAWKEYE ORDERING',300,770],['PO Type:',52,583],['Offline',87,583],['Subject:',305,583],['Fixture supplies',336,583]];
 const headers=['#','Qty','UOM','Item #','Description','GL Code','Price','Total'],hx=[59.25,80.75,106.5,147.7,272.525,430.7625,500.775,534.875],x=[59.75,85.25,112,134.5,191.6375,403.2125,501.5375,535.75];
 headers.forEach((t,i)=>texts.push([t,hx[i],568.25]));
 for(const [r,values] of [['1','2','EA','Product NAME','https://www.amazon.com/dp/B000I1VF64','113280','$23.99','$47.98'],['2','1','BX','Second NAME','Unchanged description','113280','$2.00','$2.00']].entries())values.forEach((t,i)=>texts.push([t,x[i],520-r*40]));
 for(const [i,[name,value]] of [['Subtotal','$49.98'],['Discount','$0.00'],['Taxes','$0.00'],['Shipping','$0.00'],['Grand Total','$49.98']].entries())texts.push([name,410,400-i*14],[value,535,400-i*14]);
 const stream=texts.map(([t,x,y])=>`BT /F1 2 Tf 1 0 0 1 ${x} ${y} Tm (${t.replace(/[\\()]/g,'\\$&')}) Tj ET`).join('\n');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const offset=pdf.length;
 pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
 return new Uint8Array(Buffer.from(pdf));
}
const bytes=pdfBytes(),input={sourceUrl:url,expectedPo:'12345678901'};
const doc=await bindOfflinePoDocument(source,bytes,input);
assert.equal(doc.order.lines.length,2);assert.equal(doc.sourceMessageId,source.id);
await assert.rejects(bindOfflinePoDocument(source,bytes,{...input,sourceUrl:url+'x'}),/original email/);
await assert.rejects(bindOfflinePoDocument(source,bytes,{...input,expectedPo:'999'}),/target/);
await assert.rejects(bindOfflinePoDocument(source,bytes,{...input,expectedSha256:'0'.repeat(64)}),/bytes changed/);
const db=new PGlite(),id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`,hotel=id(1),actor=id(2),recoveryActor=id(3),item=id(4);
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table work_orders(id uuid primary key,hotel_id uuid);');
const baseline=readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
for(const table of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements']){const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`);await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3));await db.exec(`alter table ${table} add primary key(id);grant all on ${table} to service_role;`);}
for(const file of ['20261016211655_cmpri_po_receiving.sql','20261017184618_cmpri_reviewed_po_identities.sql','20261020040540_cmpri_offline_po_recovery.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
await db.exec(readFileSync('supabase/migrations/20261020040540_cmpri_offline_po_recovery.sql','utf8')); // Migration replay.
await db.exec(readFileSync('docs/PO-IMPORT-FIELDS-PROPOSAL.sql','utf8'));
const admin={rpc:async(name,args)=>{assert.equal(name,'cmpri_recover_offline_po_lines_v2');try{return {data:(await db.query('select cmpri_recover_offline_po_lines_v2($1,$2,$3::jsonb) result',[args.p_hotel,args.p_actor,JSON.stringify(args.p_document)])).rows[0].result};}catch(error){return {error:{message:error.message}};}}};
const recover=(d=doc,h=hotel,a=recoveryActor)=>persistReviewedOfflineRecovery(admin,h,a,[d],offlineRecoveryDigest([d]));
await assert.rejects(persistReviewedOfflineRecovery(admin,hotel,recoveryActor,[doc],'wrong'),/exact recovery/);
const original={externalPo:doc.order.externalPo,supplier:null,lines:[],evidence:[{account:source.account,messageId:'acceptance-email',kind:'company-accepted',externalPo:doc.order.externalPo}],accepted:true,vendorOrders:[],shipments:{}};
await db.query('select cmpri_import_po_order($1,$2,$3::jsonb)',[hotel,actor,JSON.stringify(original)]);
const snapshot=async table=>(await db.query(`select * from ${table} order by id`)).rows;
const header=await snapshot('cmpri_po_orders'),history=await snapshot('cmpri_po_sources');
await db.exec('set role service_role');
const first=await recover();assert.equal(first.results[0].result.insertedLines,2);
assert.equal((await recover()).results[0].result.insertedLines,0);
assert.equal((await recover(doc,hotel,actor)).results[0].result.insertedLines,0);
await db.exec('reset role');
assert.deepEqual(await snapshot('cmpri_po_orders'),header);
assert.deepEqual((await snapshot('cmpri_po_sources')).filter(s=>s.message_id==='acceptance-email'),history);
const allImported=await snapshot('cmpri_po_lines');
const normalized=allImported.find(l=>l.sku==='Product NAME');
assert.equal(normalized.description,'Product NAME');assert.equal(normalized.product_url,doc.order.lines[0].description);assert.equal(normalized.supplier_sku,null);assert.equal(normalized.source_item_number,'Product NAME');assert.equal(normalized.source_description,doc.order.lines[0].description);
const line=allImported[0];
await db.exec(`insert into cmpri_inventory_items(id,hotel_id,item_name,quantity_on_hand) values('${item}','${hotel}','Mapped supply',4);update cmpri_po_lines set inventory_item_id='${item}',units_per_order_unit=1,backorder_note='Keep me' where id='${line.id}';`);
await db.query('select cmpri_receive_po($1,$2,$3,$4,1,$5,$6)',[hotel,actor,id(10),line.id,'2026-10-16','Counted original receipt']);
const protectedTables=['cmpri_po_orders','cmpri_po_lines','cmpri_po_receipts','cmpri_inventory_items','cmpri_inventory_movements','cmpri_po_sources'];
const before=await Promise.all(protectedTables.map(snapshot));
assert.equal((await recover()).results[0].result.insertedLines,0);
assert.deepEqual(await Promise.all(protectedTables.map(snapshot)),before);
for(const change of [
 d=>{d.order.lines[0].quantity=9;},d=>{d.order.lines.pop();},d=>{d.order.supplier='Other supplier';},
 d=>{d.documentSha256='b'.repeat(64);},d=>{d.order.externalPo='999999999';},
 d=>{d.order.lines[1].unitPriceCents=NaN;}
]){
 const changed=structuredClone(doc);change(changed);assert.ok((await recover(changed)).results[0].error);
 assert.deepEqual(await Promise.all(protectedTables.map(snapshot)),before);
}
assert.ok((await recover(doc,id(99))).results[0].error);
// Existing partial record: enrich a separate PO without modifying its existing line.
const partial=await bindOfflinePoDocument({...source,id:'email-partial'},pdfBytes('22222222222'),{sourceUrl:url,expectedPo:'22222222222'});
const partialOrder={...original,externalPo:partial.order.externalPo,supplier:'HAWKEYE ORDERING',lines:[partial.order.lines[0]],evidence:[{...original.evidence[0],messageId:'acceptance-partial',externalPo:partial.order.externalPo}]};
await db.query('select cmpri_import_po_order($1,$2,$3::jsonb)',[hotel,actor,JSON.stringify(partialOrder)]);
const partialLine=(await db.query('select l.* from cmpri_po_lines l join cmpri_po_orders o on o.id=l.order_id where o.external_reference=$1',[partial.order.externalPo])).rows[0];
assert.equal((await recover(partial)).results[0].result.insertedLines,1);
assert.deepEqual((await db.query('select * from cmpri_po_lines where id=$1',[partialLine.id])).rows[0],partialLine);
await db.query("update cmpri_po_orders set acceptance='submitted',cancelled=true,acceptance_note='Preserve manual decision' where external_reference=$1",[partial.order.externalPo]);
const decision=(await db.query('select * from cmpri_po_orders where external_reference=$1',[partial.order.externalPo])).rows;
assert.equal((await recover(partial)).results[0].result.insertedLines,0);
assert.deepEqual((await db.query('select * from cmpri_po_orders where external_reference=$1',[partial.order.externalPo])).rows,decision);
const anotherSource={...doc,sourceMessageId:'forwarded-copy'};
const priorLines=await snapshot('cmpri_po_lines');
assert.equal((await recover(anotherSource)).results[0].result.insertedLines,0);
assert.deepEqual(await snapshot('cmpri_po_lines'),priorLines);
await assert.rejects(recover({...doc,sourceUrlSha256:'0'.repeat(64)}),/binding/);
await db.query('insert into cmpri_po_lines(hotel_id,order_id,sku,description,ordered,uom,purchase_unit_price_cents) select hotel_id,order_id,sku,description,ordered,uom,purchase_unit_price_cents from cmpri_po_lines where id=$1',[partialLine.id]);
assert.match((await recover(partial)).results[0].error,/duplicate item identity/);
await db.exec('set role anon');assert.ok((await recover()).results[0].error);await db.exec('reset role;set role authenticated');assert.ok((await recover()).results[0].error);await db.exec('reset role');
await db.close();
console.log('PASS obtained PDF -> exact email/link/SHA/PO binding -> reviewed recovery RPC; empty/partial/full records, replay, conflicts, atomic rollback, roles and hotel isolation; acceptance/mapping/receipts/stock/history unchanged.');
