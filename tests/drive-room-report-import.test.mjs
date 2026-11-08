import './helpers/resolve-ts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDriveRoomReportImport } from '../src/lib/server/drive-room-report-import.ts';
const files=[{name:'In House Guest List Details_CMPRI_2026-11-08_10-52-59.csv',text:'source csv'}];
const acquire=async()=>({status:200,body:{files}});
test('connected Drive import requires explicit preview/confirmation and binds confirmation to exact source bytes',async()=>{
 const calls=[];
 const save=async body=>{calls.push(body);return {status:200,body:{ok:true,previousId:'previous',rows:[],...(body.validateOnly?{}:{import_id:'saved'})}}};
 assert.equal((await runDriveRoomReportImport({source:'drive'},acquire,save)).status,400);
 assert.equal(calls.length,0);
 const preview=await runDriveRoomReportImport({source:'drive',validate_only:true},acquire,save);
 assert.equal(preview.status,200);assert.equal(calls[0].validateOnly,true);assert.equal(preview.body.previousId,'previous');assert.equal(preview.body.report_names[0],files[0].name);
 const confirm={source:'drive',validate_only:false,previousId:preview.body.previousId,source_digest:preview.body.source_digest};
 assert.equal((await runDriveRoomReportImport(confirm,async()=>({status:200,body:{files:[{...files[0],text:'changed'}]}}),save)).status,409);
 assert.equal(calls.length,1);
 const saved=await runDriveRoomReportImport(confirm,acquire,save);
 assert.equal(saved.body.import_id,'saved');assert.deepEqual(calls[1],{files,validateOnly:false,previousId:'previous'});
});
test('Drive errors and existing validation rejections remain failures without confirmation',async()=>{
 const reject=async()=>({status:422,body:{error:'Invalid report timing'}});
 assert.equal((await runDriveRoomReportImport({source:'drive',validate_only:true},acquire,reject)).status,422);
 const failure={status:503,body:{error:'Safe mode'}};
 assert.equal(await runDriveRoomReportImport({source:'drive',validate_only:true},async()=>failure,reject),failure);
 const empty=await runDriveRoomReportImport({source:'drive',validate_only:true},async()=>({status:200,body:{files:[]}}),()=>{throw Error('Unexpected import')});
 assert.equal(empty.body.imported,false);
});
