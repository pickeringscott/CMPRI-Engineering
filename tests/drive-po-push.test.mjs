import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {existingDriveToken,inspectDriveAccess,listDrivePoFiles,readDrivePoPdf,channelToken,DRIVE_PO_FOLDER as folder,DRIVE_PO_ACCOUNT as account,DRIVE_PO_ACTOR as actor} from '../src/lib/server/drive-po-api.ts';
import {receiveDriveNotification,processDriveEvents,ensureDriveWatch} from '../src/lib/server/drive-po.ts';
process.env.CRON_SECRET='isolated-test-secret';process.env.CMPRI_PO_ENABLED='true';process.env.CMPRI_PO_IMPORT_ENABLED='true';process.env.CMPRI_INTEGRATIONS_SAFE_MODE='false';
process.env.CMPRI_GMAIL_CLIENT_ID='fixture';process.env.CMPRI_GMAIL_CLIENT_SECRET='fixture';process.env.CMPRI_GMAIL_REFRESH_TOKEN='fixture';
const originalFetch=globalThis.fetch;let calls=[];
globalThis.fetch=async(url,init)=>{calls.push({url,init});assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(init.body.has('scope'),false);return Response.json({access_token:'existing-grant'});};
assert.equal(await existingDriveToken(),'existing-grant');
globalThis.fetch=async url=>{assert.match(url,/googleapis.com\/drive\/v3\//);return url.includes('about?')?Response.json({user:{emailAddress:account}}):Response.json({id:folder,name:'PO folder',mimeType:'application/vnd.google-apps.folder'});};
assert.equal((await inspectDriveAccess('token')).folderId,folder);
let page=0;
globalThis.fetch=async url=>{const q=new URL(url);assert.equal(q.searchParams.get('q'),`'${folder}' in parents and trashed = false and mimeType = 'application/pdf'`);page++;return Response.json({files:[{id:'file'+page,version:'1',mimeType:'application/pdf',parents:[folder]}],...(page===1?{nextPageToken:'opaque-next'}:{})});};
assert.equal((await listDrivePoFiles('token')).length,2);
globalThis.fetch=async()=>Response.json({files:[{id:'foreign',parents:['other'],mimeType:'application/pdf'}]});
await assert.rejects(listDrivePoFiles('token'),/inventory/);
globalThis.fetch=async()=>{throw Error('Should not fetch outside-folder bytes');};
await assert.rejects(readDrivePoPdf('token',{id:'bad',parents:['other'],mimeType:'application/pdf',version:'1',size:'5'}),/identity/);
// Minimal in-memory PostgREST boundary to exercise authentication and durable queue logic.
const channelId='00000000-0000-0000-0000-000000000001';
const tables={
 cmpri_drive_po_state:[{folder_id:folder,enabled:true}],
 cmpri_drive_po_channels:[{id:channelId,folder_id:folder,resource_id:null,status:'pending',expires_at:new Date(Date.now()+3600000).toISOString(),sync_received_at:null}],
 cmpri_drive_po_events:[]
};
function from(table){
 let filters=[],operation='select',value,options={},single=false;
 const q={
  select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},is(k,v){filters.push(r=>r[k]===v);return q;},
  in(k,v){filters.push(r=>v.includes(r[k]));return q;},gt(k,v){filters.push(r=>r[k]>v);return q;},
  order(){return q;},limit(){return q;},range(){return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
  update(v){operation='update';value=v;return q;},upsert(v,o){operation='upsert';value=v;options=o;return q;},
  then(resolve,reject){return Promise.resolve().then(()=>{
   const rows=tables[table].filter(r=>filters.every(f=>f(r)));
   if(operation==='update')rows.forEach(r=>Object.assign(r,value));
   if(operation==='upsert'&&!tables[table].some(r=>r.channel_id===value.channel_id&&r.message_number===value.message_number))tables[table].push({...value,processed_at:null});
   void options;return {data:single?rows[0]||null:rows,error:null};
  }).then(resolve,reject);}
 };return q;
}
const admin={from};
const headers=new Headers({'x-goog-channel-id':channelId,'x-goog-channel-token':channelToken(channelId),'x-goog-resource-id':'resource_1','x-goog-resource-uri':`https://www.googleapis.com/drive/v3/files/${folder}`,'x-goog-message-number':'1','x-goog-resource-state':'sync','x-goog-channel-expiration':new Date(Date.now()+3500000).toUTCString()});
const wrong=new Headers(headers);wrong.set('x-goog-channel-token','wrong');assert.equal(await receiveDriveNotification(admin,wrong),403);assert.equal(tables.cmpri_drive_po_events.length,0);
assert.equal(await receiveDriveNotification(admin,headers),202);assert.equal(tables.cmpri_drive_po_channels[0].status,'active');
assert.equal(await receiveDriveNotification(admin,headers),202);assert.equal(tables.cmpri_drive_po_events.length,1);
const foreign=new Headers(headers);foreign.set('x-goog-resource-uri','https://evil.test/');assert.equal(await receiveDriveNotification(admin,foreign),403);
tables.cmpri_drive_po_events[0].processed_at='done';
assert.equal((await processDriveEvents(admin)).status,'idle'); // No fetch at all.
tables.cmpri_drive_po_channels[0].status='pending';
assert.equal((await ensureDriveWatch(admin)).status,'pending-verification'); // Do not repeat uncertain watch.
globalThis.fetch=originalFetch;
// Real PostgreSQL preservation boundary and service-only grants.
const db=new PGlite(),hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table work_orders(id uuid primary key,hotel_id uuid);');
const baseline=fs.readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
for(const table of ['cmpri_inventory_items','cmpri_work_order_items','cmpri_inventory_movements']){const start=baseline.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${table}" (`);await db.exec(baseline.slice(start,baseline.indexOf('\n);',start)+3));await db.exec(`alter table ${table} add primary key(id);grant all on ${table} to service_role;`);}
for(const file of ['20261017181855_cmpri_po_receiving.sql','20261017184618_cmpri_reviewed_po_identities.sql','20261020065513_cmpri_drive_po_push.sql'])await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'));
const order={externalPo:'12345678901',supplier:'HAWKEYE ORDERING',lines:[{sku:'Product name',description:'https://www.amazon.com/dp/B000I1VF64',quantity:2,uom:'EA',unitPriceCents:100}],subtotalCents:200,totalCents:200};
await db.query('select cmpri_import_po_order($1,$2,$3::jsonb)',[hotel,actor,JSON.stringify({...order,lines:[],accepted:true,evidence:[{account,messageId:'original',kind:'company-accepted',externalPo:order.externalPo}],vendorOrders:[],shipments:{}})]);
const document={account,folderId:folder,fileId:'file_1',sourceMessageId:'file_1',sourceUrl:'https://drive.google.com/file/d/file_1/view',sourceUrlSha256:'a'.repeat(64),documentSha256:'b'.repeat(64),order};
const snapshot=async table=>(await db.query(`select * from ${table} order by id`)).rows;
const originalOrders=await snapshot('cmpri_po_orders');
const recover=doc=>db.query('select cmpri_recover_drive_po_lines($1,$2,$3::jsonb) result',[hotel,actor,JSON.stringify(doc)]);
assert.equal((await recover(document)).rows[0].result.insertedLines,1);
assert.equal((await recover(document)).rows[0].result.insertedLines,0);
assert.deepEqual(await snapshot('cmpri_po_orders'),originalOrders);
const old=await snapshot('cmpri_po_lines');
await assert.rejects(recover({...document,folderId:'other'}));
const changed=structuredClone(document);changed.order.lines[0].quantity=3;await assert.rejects(recover(changed));
assert.deepEqual(await snapshot('cmpri_po_lines'),old);
await db.exec('set role anon');await assert.rejects(recover(document));await assert.rejects(db.query('select * from cmpri_drive_po_state'));await db.exec('reset role');
await db.exec("update cmpri_drive_po_state set enabled=true");
assert.equal((await db.query('select cmpri_claim_drive_po($1) ok',[channelId])).rows[0].ok,true);
assert.equal((await db.query('select cmpri_claim_drive_po($1) ok',[actor])).rows[0].ok,false);
// Actual queued-event worker -> scoped Drive inventory -> cached verified PDFs -> real recovery SQL.
const nextOrder={...order,externalPo:'22222222222'};
await db.query('select cmpri_import_po_order($1,$2,$3::jsonb)',[hotel,actor,JSON.stringify({...nextOrder,lines:[],accepted:true,evidence:[{account,messageId:'second',kind:'company-accepted',externalPo:nextOrder.externalPo}],vendorOrders:[],shipments:{}})]);
tables.cmpri_po_orders=await snapshot('cmpri_po_orders');tables.cmpri_po_lines=await snapshot('cmpri_po_lines');
const files=['copyA','copyB'].map(id=>({id,version:'1',size:'100',parents:[folder],mimeType:'application/pdf',modifiedTime:'2026-10-20T00:00:00Z'}));
tables.cmpri_drive_po_files=files.map(f=>({file_id:f.id,folder_id:folder,version:'1',metadata:f,document:nextOrder,document_sha256:'c'.repeat(64),external_po:nextOrder.externalPo,reason:null}));
tables.cmpri_drive_po_events.push({channel_id:channelId,message_number:'2',processed_at:null});
globalThis.fetch=async(url,init)=>{
 if(url==='https://oauth2.googleapis.com/token'){assert.equal(init.body.has('scope'),false);return Response.json({access_token:'fixture'});}
 if(url.includes('about?'))return Response.json({user:{emailAddress:account}});
 if(url.includes(`files/${folder}?`))return Response.json({id:folder,mimeType:'application/vnd.google-apps.folder'});
 assert.equal(new URL(url).pathname,'/drive/v3/files');assert.match(new URL(url).searchParams.get('q'),new RegExp(folder));
 return Response.json({files});
};
const workerAdmin={from,rpc:async(name,args)=>name==='cmpri_claim_drive_po'?{data:true,error:null}:{data:(await db.query('select cmpri_recover_drive_po_lines($1,$2,$3::jsonb) result',[args.p_hotel,args.p_actor,JSON.stringify(args.p_document)])).rows[0].result,error:null}};
const worker=await processDriveEvents(workerAdmin);assert.equal(worker.insertedLines,1);assert.equal(worker.ordersEnriched,1);
assert.ok(tables.cmpri_drive_po_events.at(-1).processed_at);
tables.cmpri_po_lines=await snapshot('cmpri_po_lines');
tables.cmpri_drive_po_events.push({channel_id:channelId,message_number:'3',processed_at:null});
assert.equal((await processDriveEvents(workerAdmin)).insertedLines,0);
globalThis.fetch=originalFetch;
await db.close();
console.log('PASS Drive push: unchanged OAuth grant, scoped pagination, forbidden source reads, authenticated sync, durable replay, idle no-poll, uncertain-watch hold, SQL identity/preservation/roles/lease.');
