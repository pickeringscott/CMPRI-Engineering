import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
import { validateRoomHistory, roomCompletion } from '../src/lib/pm/history.ts';

const db = new PGlite();
const hotel='00000000-0000-0000-0000-000000000001', actor='00000000-0000-0000-0000-000000000002';
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create table cmpri_pm_proposals(hotel_id uuid, template_id text, scope_key text, period_start date, status text);
grant all on cmpri_pm_proposals to service_role;`);
await db.exec(readFileSync('supabase/migrations/20261027235814_cmpri_room_pm_history.sql','utf8'));
let authenticated=true, reviewer=true, rpcCalls=0;
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync('src/app/api/preventive-maintenance/history/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {
  exports, require(name) {
    if(name==='node:crypto')return crypto;
    if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status||200})}};
    if(name==='@/lib/constants')return {HOTEL_ID:hotel};
    if(name==='@/lib/pm/catalog')return {PM_ROOM_NUMBERS:['101','102','103','104','105','106']};
    if(name==='@/lib/pm/history')return {validateRoomHistory};
    if(name==='@/lib/server/roles')return {profileHasRole:()=>reviewer};
    if(name==='@/lib/server/auth')return {requireUser:async()=>authenticated?{principal:{identity:{id:actor},profile:{full_name:'Reviewer'}},admin:{rpc:async(name,p)=>{
      rpcCalls++;
      try {return {data:(await db.query('select cmpri_import_room_pm_history($1,$2,$3,$4,$5,$6,$7) result',[p.p_hotel,p.p_actor,p.p_actor_name,p.p_input,p.p_digest,p.p_apply,p.p_expected])).rows[0].result,error:null};}
      catch(e){return {data:null,error:{message:e.message,code:e.code}};}
    }}}:null};
    throw new Error(name);
  }
});
const input=(room='101',date='2026-07-01')=>({sourceId:'scan-2026',sourceName:'Source scan',rows:[{room,periodStart:'2026-07-01',completedOn:date,sourceReference:'Page 1; user confirmed date'}]});
const call=(value,action='preview',previewDigest)=>exports.POST({text:async()=>JSON.stringify({input:value,action,previewDigest})});
authenticated=false;assert.equal((await call(input())).status,401);
authenticated=true;reviewer=false;assert.equal((await call(input())).status,403);assert.equal(rpcCalls,0);reviewer=true;
for(const date of ['2026-04-01','2026-10-01','2025-07-01','2026-09-31',''])assert.equal((await call(input('101',date))).status,400);
const missingDate=input();delete missingDate.rows[0].completedOn;assert.equal((await call(missingDate)).status,400);
assert.equal((await call(input('999'))).status,400);
const duplicate=input();duplicate.rows.push({...duplicate.rows[0]});assert.equal((await call(duplicate)).status,400);
const mixed=input();mixed.rows.push({...input('102',null).rows[0]});
await db.exec('set role service_role');
const preview=await call(mixed);assert.equal(preview.status,200);assert.equal(preview.body.rows.length,2);
assert.equal((await db.query('select count(*)::int n from cmpri_room_pm_history')).rows[0].n,0);
assert.equal((await call(mixed,'apply','0'.repeat(32))).status,409);
const applied=await call(mixed,'apply',preview.body.previewDigest);assert.equal(applied.body.inserted,2);
const retry=await call(mixed,'apply',preview.body.previewDigest);assert.equal(retry.body.inserted,0);assert.equal(retry.body.skipped,2);
const stored=(await db.query('select * from cmpri_room_pm_history order by room')).rows;
assert.equal(stored[0].confirmed_by,actor);assert.equal(stored[0].source_reference,'Page 1; user confirmed date');assert.equal(stored[1].completed_on,null);
assert.equal(roomCompletion(stored[1],undefined).status,'Complete (historical)');assert.equal(roomCompletion(stored[1],undefined).date,'');
assert.equal(roomCompletion(undefined,{status:'approved',completed_on:'2026-07-02',is_complete:true}).complete,true);
assert.equal(roomCompletion(undefined,{status:'pending',completed_on:'2026-07-02',is_complete:true}).complete,false);
assert.equal(roomCompletion(undefined,undefined).status,'Due');
const conflict=input('101','2026-07-02');conflict.rows.push(input('103').rows[0]);
assert.equal((await call(conflict)).body.conflicts,1);assert.equal((await call(conflict,'apply',preview.body.previewDigest)).status,409);
assert.equal((await db.query("select count(*)::int n from cmpri_room_pm_history where room='103'")).rows[0].n,0);
const stale=await call(input('104'));
await db.query("insert into cmpri_pm_proposals values($1,'pdf:room-pm-checklist','room:104','2026-07-01','approved')",[hotel]);
assert.equal((await call(input('104'),'apply',stale.body.previewDigest)).status,409);
await db.query("insert into cmpri_pm_proposals values($1,'pdf:room-pm-checklist','room:105','2026-07-01','pending')",[hotel]);
assert.equal((await call(input('105'))).body.conflicts,1);
await db.exec('reset role;set role authenticated');
await assert.rejects(db.query('select * from cmpri_room_pm_history'),/permission denied/);
await assert.rejects(db.query('select cmpri_import_room_pm_history($1,$2,$3,$4,$5,$6,$7)',[hotel,actor,'Reviewer',input(),'a'.repeat(64),false,null]),/permission denied/);
await db.exec('reset role');
assert.equal((await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,2);
console.log('PASS integrated authenticated API → validation → PostgreSQL preview/atomic apply → display; exact retry, unknown date, provenance, quarter validation, duplicates, stale preview, existing approved/pending conflict, all-or-nothing rollback, roles, unrelated proposals preserved');
await db.close();
