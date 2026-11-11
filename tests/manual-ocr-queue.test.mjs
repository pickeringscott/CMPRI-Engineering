import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadTs} from './helpers/load-ts.mjs';
const hotel='00000000-0000-4000-8000-000000000001',asset='00000000-0000-4000-8000-000000000002',bytes=new Uint8Array(Buffer.from('%PDF-test')),sha=createHash('sha256').update(bytes).digest('hex');
function fixture({changed=false,fail=false}={}){
 const state={downloads:0,register:0,pages:[],updates:[],claims:[]};const job={hotel_id:hotel,asset_id:asset,source_path:`${hotel}/${asset}/manual.pdf`,source_sha256:sha,total_pages:2,next_page:1,attempts:1,lease_token:'lease'};
 const admin={rpc:async(name,args)=>{state.claims.push({name,args});return {data:[job],error:null}},from(table){
  if(table==='assets'){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{id:asset,hotel_id:hotel,active:true},error:null})};return q;}
  if(table==='cmpri_asset_manual_ocr_pages')return {upsert:async rows=>{state.pages.push(...rows);return {error:null}}};
  assert.equal(table,'cmpri_asset_manual_ocr_jobs');const q={update(values){state.updates.push(values);return q},eq(){return q},select:async()=>({data:[{asset_id:asset}],error:null})};return q;
 },storage:{from(){return {download:async()=>{state.downloads++;return {data:new Blob([changed&&state.downloads===2?new Uint8Array(Buffer.from('%PDF-other')):bytes]),error:null}}}}}};
 const mod=loadTs('src/lib/server/manual-ocr-queue.ts',{'node:crypto':{createHash},'./manual-ocr':{manualOcrPageCount:async()=>2,recognizeManualPages:async(_bytes,pages)=>{if(fail)throw Error('OCR failed');return {totalPages:2,pages:pages.map(page=>({page,text:`Source ${page}`,confidence:91}))}}},'./asset-file-register':{listRegisteredAssetFiles:async()=>{state.register++;return {data:[{id:'file',storage_path:job.source_path}],error:null}}}});
 return {state,admin,mod,job};
}
test('OCR batches publish source-scoped pages only after rechecking the stored PDF',async()=>{
 const {state,admin,mod}=fixture();assert.equal(await mod.processManualOcrJob(admin,hotel),'processed');assert.equal(state.downloads,2);assert.equal(state.register,2);assert.equal(state.pages.length,2);assert.ok(state.pages.every(page=>page.source_sha256===sha));assert.equal(state.updates.at(-1).status,'complete');assert.equal(state.claims[0].args.p_hotel,hotel);
});
test('a PDF changed during OCR cannot publish pages, and a transient error is retryable',async()=>{
 const changed=fixture({changed:true});assert.equal(await changed.mod.processManualOcrJob(changed.admin,hotel),'cancelled');assert.equal(changed.state.pages.length,0);assert.equal(changed.state.updates.at(-1).status,'cancelled');
 const failed=fixture({fail:true});assert.equal(await failed.mod.processManualOcrJob(failed.admin,hotel),'retry');assert.equal(failed.state.pages.length,0);assert.equal(failed.state.updates.at(-1).status,'pending');
});


test('large manuals advance in bounded batches without marking the whole job complete',async()=>{
 const h=fixture();h.job.total_pages=25;
 // The mocked recognizer returns the requested page count for this test.
 const {loadTs}=await import('./helpers/load-ts.mjs');
 const mod=loadTs('src/lib/server/manual-ocr-queue.ts',{'node:crypto':{createHash},'./manual-ocr':{manualOcrPageCount:async()=>25,recognizeManualPages:async(_bytes,pages)=>({totalPages:25,pages:pages.map(page=>({page,text:`Source ${page}`,confidence:91}))})},'./asset-file-register':{listRegisteredAssetFiles:async()=>({data:[{id:'file',storage_path:h.job.source_path}],error:null})}});
 assert.equal(await mod.processManualOcrJob(h.admin,hotel),'processed');assert.equal(h.state.pages.length,5);assert.equal(h.state.updates.at(-1).status,'pending');assert.equal(h.state.updates.at(-1).next_page,6);
});

test('queueing is content-bound and preserves existing processing progress',async()=>{
 const writes=[];const admin={from(table){assert.equal(table,'cmpri_asset_manual_ocr_jobs');const q={upsert:async(row,options)=>{writes.push({row,options});return {error:null}},update(values){writes.push({values});return q},eq(){return q},in:async()=>({error:null})};return q;}};
 const mod=loadTs('src/lib/server/manual-ocr-queue.ts',{'node:crypto':{createHash},'./manual-ocr':{manualOcrPageCount:async()=>2}},{process:{env:{CRON_SECRET:'configured'}}});
 assert.equal(await mod.enqueueManualOcr(admin,{hotelId:hotel,assetId:asset,path:`${hotel}/${asset}/manual.pdf`,sha256:sha,bytes}),2);assert.equal(writes[0].options.ignoreDuplicates,true);assert.equal(writes[0].row.source_sha256,sha);
 await assert.rejects(mod.enqueueManualOcr(admin,{hotelId:hotel,assetId:asset,path:'wrong.pdf',sha256:'b'.repeat(64),bytes}),/fingerprint/i);assert.equal(writes.length,2);
});

test('unfinished OCR stays hidden and completed pages are source-scoped and validated',async()=>{
 let status='processing',pageReads=0;const filters=[];
 const admin={from(table){const q={select(){return q},eq(key,value){filters.push([table,key,value]);return q},maybeSingle:async()=>({data:{status},error:null}),order:async()=>{pageReads++;return {data:[{page_number:2,text:'Legitimate OCR',confidence:90},{page_number:0,text:'Invalid',confidence:90},{page_number:3,text:'Invalid confidence',confidence:150}],error:null}}};return q;}};
 const mod=loadTs('src/lib/server/manual-ocr-queue.ts',{'node:crypto':{createHash},'./manual-ocr':{}});
 const pending=await mod.readManualOcr(admin,{hotelId:hotel,assetId:asset,sha256:sha});assert.equal(pending.status,'processing');assert.equal(pending.pages.length,0);assert.equal(pageReads,0);
 status='complete';const complete=await mod.readManualOcr(admin,{hotelId:hotel,assetId:asset,sha256:sha});assert.equal(pageReads,1);assert.equal(complete.pages.length,1);assert.equal(complete.pages[0].page,2);assert.ok(filters.some(([table,key,value])=>table==='cmpri_asset_manual_ocr_pages'&&key==='source_sha256'&&value===sha));
});
