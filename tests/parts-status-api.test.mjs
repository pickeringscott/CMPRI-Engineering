import test from 'node:test';import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
function fixture(enabled=true,failed=false){
 const calls=[];
 const {attachPartsStatuses}=loadTs('src/lib/server/work-order-parts-status.ts',{'@/lib/constants':{HOTEL_ID:'hotel'}},{process:{env:{CMPRI_PO_ENABLED:enabled?'true':'false'}}});
 const admin={rpc:async(name,args)=>{calls.push({name,args});return {data:args.p_jobs.map(id=>({work_order_id:id,status:'Need to Order'})),error:failed?{message:'Unavailable'}:null};}};
 return {calls,run:orders=>attachPartsStatuses(admin,orders)};
}
test('parts summary batches only authorized ticket IDs and retains ordinary fields',async()=>{
 const f=fixture();const result=await f.run(Array.from({length:501},(_,i)=>({id:String(i),priority:'High'})));
 assert.equal(f.calls.length,2);assert.equal(f.calls[0].args.p_jobs.length,500);assert.equal(f.calls[1].args.p_jobs.length,1);
 assert.ok(f.calls.every(call=>call.args.p_hotel==='hotel'));assert.equal(result[0].parts_status,'Need to Order');assert.equal(result[0].priority,'High');
});
test('disabled/empty parts summaries make no inventory calls; unavailable records are not mislabeled',async()=>{
 const f=fixture(false);assert.equal((await f.run([{id:'job'}]))[0].parts_status,null);assert.equal(f.calls.length,0);
 const empty=fixture();assert.equal((await empty.run([])).length,0);assert.equal(empty.calls.length,0);
 await assert.rejects(fixture(true,true).run([{id:'job'}]),/Parts status/);
});
