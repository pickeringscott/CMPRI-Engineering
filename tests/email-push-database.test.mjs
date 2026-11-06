import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
test('email queue is service-only, deduplicates delivery identities and serializes renewable leases',async()=>{
 const db=new PGlite(),hotel='00000000-0000-4000-8000-000000000001',owner='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
 try{await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table hotels(id uuid primary key);');await db.exec(readFileSync('supabase/migrations/20261106074238_email_push.sql','utf8'));
 await db.query('insert into hotels values($1)',[hotel]);await db.query("insert into cmpri_email_push_state(hotel_id,provider,mailbox) values($1,'gmail','synthetic@example.test')",[hotel]);
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query('select * from cmpri_email_push_state'),/permission denied/);await assert.rejects(db.query('select * from cmpri_email_push_events'),/permission denied/);await assert.rejects(db.query("select cmpri_claim_email_push($1,'gmail',$2)",[hotel,owner]),/permission denied/);await db.exec('reset role')}
 await db.exec('set role service_role');
 const claim=async who=>(await db.query("select cmpri_claim_email_push($1,'gmail',$2) claimed",[hotel,who])).rows[0].claimed;
 assert.equal(await claim(owner),true);assert.equal(await claim(other),false);assert.equal(await claim(null),false);
 await db.query("update cmpri_email_push_state set lease_until=now()-interval '1 second' where hotel_id=$1",[hotel]);assert.equal(await claim(other),true);
 const wrong=await db.query('update cmpri_email_push_state set history_id=$1 where hotel_id=$2 and lease_owner=$3 returning provider',['999',hotel,owner]);assert.equal(wrong.rows.length,0);
 for(let i=0;i<2;i++)await db.query("insert into cmpri_email_push_events(hotel_id,provider,event_key,history_id) values($1,'gmail','delivery','120') on conflict(hotel_id,provider,event_key) do nothing",[hotel]);assert.equal((await db.query('select count(*)::int n from cmpri_email_push_events')).rows[0].n,1);
 await assert.rejects(db.query("insert into cmpri_email_push_events(hotel_id,provider,event_key) values($1,'gmail','other')",[owner]),/foreign key/);
 }finally{await db.close()}
});
