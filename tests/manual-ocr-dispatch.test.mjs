import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
function fixture(secret='secret'){
 let calls=0;const mod=loadTs('src/app/api/assets/documentation/ocr/dispatch/route.ts',{'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},'@/lib/constants':{HOTEL_ID:'hotel'},'@/lib/server/supabase-admin':{createSupabaseAdmin:()=>({})},'@/lib/server/manual-ocr-queue':{processManualOcrJob:async()=>{calls++;return 'processed'}}},{Response,process:{env:{CRON_SECRET:secret}}});
 return {run:authorization=>mod.GET({headers:new Headers(authorization?{authorization}: {})}),calls:()=>calls};
}
test('OCR dispatch requires the configured cron secret before claiming a job',async()=>{
 const h=fixture();assert.equal((await h.run()).status,401);assert.equal((await h.run('Bearer wrong')).status,401);assert.equal(h.calls(),0);const ok=await h.run('Bearer secret');assert.equal(ok.status,200);assert.equal((await ok.json()).status,'processed');assert.equal(h.calls(),1);const missing=fixture('');assert.equal((await missing.run('Bearer secret')).status,401);assert.equal(missing.calls(),0);
});
