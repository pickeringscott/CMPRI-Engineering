import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadTs} from './helpers/load-ts.mjs';
import {scannedPdf} from './helpers/scanned-pdf.mjs';
import * as ocr from '../src/lib/server/manual-ocr.ts';
import {ocrManualActions} from '../src/lib/server/manual-ocr-actions.ts';
import {guideRulesForIssue} from '../src/lib/work-orders/guide-selection.ts';

test('an attached image-only PDF becomes source-linked OCR checks through the real OCR engine',async()=>{
 const bytes=scannedPdf(),sha=createHash('sha256').update(bytes).digest('hex');const hotel='hotel',asset='asset',path='hotel/asset/manual.pdf';
 const job={hotel_id:hotel,asset_id:asset,source_path:path,source_sha256:sha,total_pages:1,next_page:1,attempts:1,lease_token:'lease'};
 const state={pages:[],status:''};
 const admin={rpc:async()=>({data:[job],error:null}),from(table){
  if(table==='assets'){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{id:asset,hotel_id:hotel,active:true},error:null})};return q;}
  if(table==='cmpri_asset_manual_ocr_pages')return {upsert:async rows=>{state.pages.push(...rows);return {error:null}}};
  assert.equal(table,'cmpri_asset_manual_ocr_jobs');const q={update(values){state.status=values.status;return q},eq(){return q},select:async()=>({data:[{asset_id:asset}],error:null})};return q;
 },storage:{from(){return {download:async()=>({data:new Blob([bytes]),error:null})}}}};
 const queue=loadTs('src/lib/server/manual-ocr-queue.ts',{'node:crypto':{createHash},'./manual-ocr':ocr,'./asset-file-register':{listRegisteredAssetFiles:async()=>({data:[{id:'file',storage_path:path}],error:null})}});
 assert.equal(await queue.processManualOcrJob(admin,hotel),'processed');assert.equal(state.status,'complete');assert.equal(state.pages.length,1);
 const pages=state.pages.map(row=>({page:row.page_number,text:row.text,confidence:row.confidence}));
 const found=guideRulesForIssue({source:{verified:true},symptom_rules:ocrManualActions(pages)},'no hot water');assert.equal(found.length,1);assert.equal(found[0].steps.length,2);assert.ok(found[0].steps.every(step=>step.startsWith('OCR — ')));assert.deepEqual(found[0].source_pages,[1]);
});
