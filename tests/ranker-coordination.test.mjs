import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
const hotel='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
test('ranker writer and watch migrations serialize, fence revisions and reject unauthorized use',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table hotels(id uuid primary key);insert into hotels values('${hotel}'),('${other}');
 create table work_orders(id uuid primary key,hotel_id uuid,room text,issue text,status text,display_id text);
 create table cmpri_room_ranker_sync_queue(id uuid primary key default gen_random_uuid(),hotel_id uuid,work_order_id uuid,attempts integer,next_attempt_at timestamptz,processed_at timestamptz,last_error text,created_at timestamptz,updated_at timestamptz,unique(hotel_id,work_order_id));
 create table invalidations(hotel_id uuid,resource text);
 create function cmpri_invalidate(p_hotel uuid,p_resource text,p_scope text default '*') returns void language sql as $$insert into public.invalidations values(p_hotel,p_resource)$$;`);
 for(const name of ['20261027200000_cmpri_ranker_writer_coordination.sql','20261027210000_cmpri_ranker_watch.sql'])await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.exec('create trigger ranker_enqueue after insert or update on work_orders for each row execute function cmpri_enqueue_room_ranker_sync()');
 const call=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const {owner}=await call('select cmpri_ranker_claim($1) owner',[hotel]);assert.ok(owner);
 assert.equal((await call('select cmpri_ranker_claim($1) owner',[hotel])).owner,null);
 assert.equal((await call('select cmpri_ranker_owned($1,$2) owned',[other,owner])).owned,false);
 await db.query('select cmpri_ranker_release($1,$2)',[hotel,other]);assert.equal((await call('select cmpri_ranker_owned($1,$2) owned',[hotel,owner])).owned,true);
 await db.query("update cmpri_ranker_writer set expires_at=now()-interval '1 second' where hotel_id=$1",[hotel]);
 const replacement=(await call('select cmpri_ranker_claim($1) owner',[hotel])).owner;assert.notEqual(owner,replacement);
 await db.query('select cmpri_ranker_release($1,$2)',[hotel,owner]);assert.equal((await call('select cmpri_ranker_owned($1,$2) owned',[hotel,replacement])).owned,true);
 await db.query("insert into work_orders values($1,$2,'409','first','Open','WO-1')",[other,hotel]);
 const revision=(await call('select revision from cmpri_room_ranker_sync_queue')).revision;
 await db.exec("update work_orders set issue='newer'");
 await db.query('update cmpri_room_ranker_sync_queue set processed_at=now() where revision=$1',[revision]);
 assert.equal((await call('select processed_at from cmpri_room_ranker_sync_queue')).processed_at,null);
 assert.equal((await call("select cmpri_ranker_reserve_watch($1,'sheet',$2,now()+interval '23 hours') ok",[hotel,other])).ok,true);
 assert.equal((await call("select cmpri_ranker_reserve_watch($1,'sheet',gen_random_uuid(),now()+interval '23 hours') ok",[hotel])).ok,false);
 assert.equal((await call("select cmpri_ranker_bind_watch($1,$2,'resource',now()+interval '22 hours') ok",[hotel,other])).ok,true);
 assert.equal((await call("select cmpri_ranker_bind_watch($1,$2,'attacker-resource',now()+interval '21 hours') ok",[hotel,other])).ok,false);
 for(const [version,expected] of [['9',true],['9',false],['8',false],['10',true]])assert.equal((await call("select cmpri_ranker_observe_version($1,'sheet',$2) changed",[hotel,version])).changed,expected);
 assert.equal((await call('select count(*)::int n from invalidations')).n,2);
 await db.exec('set role authenticated');await assert.rejects(()=>db.query('select cmpri_ranker_claim($1)',[hotel]),/permission denied/);await assert.rejects(()=>db.query('select * from cmpri_ranker_watch_channels'),/permission denied/);
 }finally{await db.close();}
});
test('writer retains uncertain lease and only releases successful verified work',async()=>{
 const exports={};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/server/room-ranker-write.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,AbortSignal,require:()=>({HOTEL_ID:hotel})});
 const calls=[];const admin={rpc:async name=>{calls.push(name);return {data:name==='cmpri_ranker_claim'?'owner':true,error:null};}};
 await assert.rejects(exports.withRankerWrite(admin,async()=>{throw Error('uncertain write');}));assert.ok(!calls.includes('cmpri_ranker_release'));
 calls.length=0;assert.equal(await exports.withRankerWrite(admin,async write=>{await write.assertOwner();return 'verified';}),'verified');assert.deepEqual(calls.slice(-2),['cmpri_invalidate','cmpri_ranker_release']);
});
