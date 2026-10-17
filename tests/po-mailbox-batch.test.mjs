import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';import ts from 'typescript';import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table cmpri_inventory_items(quantity_on_hand int);insert into cmpri_inventory_items values(7);create table cmpri_po_receipts(id int);create table cmpri_purchase_orders(id int);');
await db.exec(fs.readFileSync('supabase/migrations/20261016214526_cmpri_purchasing_history.sql','utf8'));
const hotel='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002';
let allowed=false;globalThis.__historySafe=false;
globalThis.__historyAuth=async(_r,cap)=>allowed&&cap==='operate_integrations'?{principal:{identity:{id:actor}},admin:{rpc:async(name,p)=>{assert.equal(name,'cmpri_import_purchasing_history');try{return {data:(await db.query('select cmpri_import_purchasing_history($1,$2,$3,$4,$5::jsonb) result',[p.p_hotel,p.p_actor,p.p_account,p.p_digest,JSON.stringify(p.p_plan)])).rows[0].result};}catch(e){return {error:{message:e.message}};}}}}:null;
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
async function route(name){let source=fs.readFileSync('src/app/api/engineering/'+name+'/route.ts','utf8');
const mappings={'@/lib/server/auth':data('export const requireCapability=(...a)=>globalThis.__historyAuth(...a);'),'@/lib/server/integrations-safe-mode':data('export const isIntegrationsSafeMode=()=>globalThis.__historySafe;'),'@/lib/constants':data('export const HOTEL_ID='+JSON.stringify(hotel)),'@/lib/purchasing-history':pathToFileURL(path.resolve('src/lib/purchasing-history.ts')).href,'@/lib/server/po-review-batch':pathToFileURL(path.resolve('src/lib/server/po-review-batch.ts')).href,'next/server':pathToFileURL(path.resolve('node_modules/next/server.js')).href};
for(const [name,url]of Object.entries(mappings))source=source.replaceAll("'"+name+"'",JSON.stringify(url));
return import(data(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText));}
const scan=await route('po-scan-review'),save=await route('po-import-reviewed');
Object.assign(process.env,{CMPRI_PO_ENABLED:'true',CMPRI_PO_IMPORT_ENABLED:'true',CMPRI_PO_REVIEW_SCAN_ENABLED:'true',CMPRI_EMAIL_PROVIDER:'gmail',CMPRI_GMAIL_ADDRESS:'fixture@example.test',CMPRI_GMAIL_CLIENT_ID:'fixture',CMPRI_GMAIL_CLIENT_SECRET:'fixture',CMPRI_GMAIL_REFRESH_TOKEN:'fixture'});
const excerpts=JSON.parse(fs.readFileSync('tests/fixtures/po-supplier-excerpts.json','utf8')),pdf=fs.readFileSync('tests/fixtures/po-pdf-runtime.pdf');
const page1=Array.from({length:25},(_,i)=>i<excerpts.length?excerpts[i]:{id:(0x1000000000000000n+BigInt(i)).toString(16),from:'fixture@example.test',subject:'Unrelated greeting',text:'Hello'});
let attachmentMode='invalid',changed=false,calls=[];
globalThis.fetch=async(input,init)=>{
 const u=new URL(String(input));calls.push(u.href);
 if(u.hostname==='oauth2.googleapis.com'){assert.equal(init.method,'POST');return Response.json({access_token:'fixture-only'});}
 assert.equal(u.hostname,'gmail.googleapis.com');assert.ok(!init.method||init.method==='GET');
 if(u.pathname.endsWith('/attachments/discovered-id')){assert.equal(init.redirect,'error');if(attachmentMode==='oversize')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(14*1024*1024+1));c.close();}}));return Response.json({data:(attachmentMode==='valid'?pdf:Buffer.from('bad')).toString('base64url')});}
 if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('q'),'in:anywhere');assert.equal(u.searchParams.get('includeSpamTrash'),'true');assert.equal(u.searchParams.get('maxResults'),'25');const next=u.searchParams.get('pageToken');assert.ok(next===null||next==='page-2');return Response.json(next?{messages:[{id:'ffffffffffffffff'}]}:{messages:page1.map(m=>({id:m.id})),nextPageToken:'page-2'});}
 const id=u.pathname.split('/').at(-1),m=page1.find(m=>m.id===id)||{id,from:'notice@example.test',subject:'PO attachment',text:'Invoice attachment for review'};
 const text=changed&&id===page1[0].id?m.text.replace('QTY Shipped 1','QTY Shipped 9'):m.text;
 return Response.json({threadId:id,internalDate:'1792190000000',payload:{headers:[{name:'From',value:m.from},{name:'Subject',value:m.subject}],parts:[{mimeType:'text/plain',body:{data:Buffer.from(text).toString('base64url')}},...(id==='ffffffffffffffff'?[{partId:'1',filename:'invoice.pdf',mimeType:'application/pdf',body:{attachmentId:'discovered-id',size:pdf.length}}]:[])]}});
};
const post=(r,b)=>r.POST(new Request('http://fixture',{method:'POST',body:JSON.stringify(b)}));
assert.equal((await post(scan,{})).status,403);assert.equal(calls.length,0);allowed=true;
assert.equal((await post(scan,{pageToken:'x'.repeat(9000)})).status,400);assert.equal(calls.length,0);
globalThis.__historySafe=true;assert.equal((await post(scan,{})).status,409);globalThis.__historySafe=false;
const first=await (await post(scan,{})).json();assert.equal(first.sourceCount,25);assert.equal(first.complete,false);assert.equal(first.nextPageToken,'page-2');
const count=async()=>Number((await db.query('select count(*) n from cmpri_purchasing_history_records')).rows[0].n);assert.equal(await count(),0);
assert.equal((await post(save,{digest:'0'.repeat(64),importReviewed:true})).status,409);
changed=true;assert.equal((await post(save,{digest:first.digest,importReviewed:true})).status,409);changed=false;
assert.equal((await post(save,{digest:first.digest,importReviewed:true})).status,200);const n=await count();assert.ok(n>0);
assert.equal((await post(save,{digest:first.digest,importReviewed:true})).status,200);assert.equal(await count(),n);
const second=await (await post(scan,{pageToken:'page-2'})).json();assert.equal(second.complete,true);assert.equal(second.sourceCount,1);assert.equal(second.plan.review[0].evidence.pdfEvidence[0].status,'failed');
assert.equal((await post(save,{pageToken:'page-2',digest:second.digest,importReviewed:true})).status,200);
attachmentMode='valid';assert.equal((await post(save,{pageToken:'page-2',digest:second.digest,importReviewed:true})).status,409);
const retry=await (await post(scan,{pageToken:'page-2'})).json();assert.equal(retry.plan.review[0].evidence.pdfEvidence[0].status,'needs-review');
assert.equal((await post(save,{pageToken:'page-2',digest:retry.digest,importReviewed:true})).status,200);
const pdfRows=(await db.query("select record from cmpri_purchasing_history_records where kind='pdf-document'")).rows;assert.equal(pdfRows.length,2);
attachmentMode='oversize';const held=await (await post(scan,{pageToken:'page-2'})).json();assert.equal(held.plan.review[0].evidence.pdfEvidence[0].status,'failed');
assert.equal((await db.query('select quantity_on_hand from cmpri_inventory_items')).rows[0].quantity_on_hand,7);
for(const table of ['cmpri_po_receipts','cmpri_purchase_orders'])assert.equal(Number((await db.query('select count(*) n from '+table)).rows[0].n),0);
console.log('PASS real scan/import routes -> mocked Gmail MIME attachments -> isolated PostgreSQL: authorization/safe-mode/body limits, 25-message continuation, changed digest denial, replay, failed-to-readable PDF retry, bounded attachment stream, no external URLs, no stock/receipts/active orders.');
await db.close();
