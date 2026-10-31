import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cleanScanPayload,cleanScanHistory} from '../src/lib/pm/scan-cleanup.ts';

// All business values below are fictional. Production function bodies are read verbatim.
test('cleanup with proposal stamps and committed invalidations: atomicity, preservation, guarded restoration',async()=>{
 const db=new PGlite();
 const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6', source='libfile_5860e1ae41fc81919da5f84ec1cf2ce4';
 const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const tables=['cmpri_pm_proposals','cmpri_room_pm_history','cmpri_pm_source_evidence'];
 try {
 await db.exec(`CREATE TABLE cmpri_pm_proposals(id uuid PRIMARY KEY,hotel_id uuid,payload jsonb,status text,revision integer,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE cmpri_room_pm_history(id uuid PRIMARY KEY,hotel_id uuid,room text,period_start date,source_name text,source_reference text,item_answers jsonb,status text);
 CREATE TABLE cmpri_pm_source_evidence(hotel_id uuid,source_id text,pages jsonb,PRIMARY KEY(hotel_id,source_id));
 CREATE TABLE hotel_members(hotel_id uuid,user_id uuid);
 CREATE TABLE cmpri_resource_revisions(hotel_id uuid,resource text,scope text DEFAULT '*',revision uuid DEFAULT gen_random_uuid(),transaction_id bigint DEFAULT txid_current(),PRIMARY KEY(hotel_id,resource,scope));
 CREATE TABLE cmpri_event_signals(hotel_id uuid,user_id uuid,revision uuid DEFAULT gen_random_uuid(),transaction_id bigint DEFAULT txid_current(),PRIMARY KEY(hotel_id,user_id));
 CREATE TABLE rehearsal_signal_audit(kind text,transaction_id bigint);
 CREATE FUNCTION rehearsal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.rehearsal_signal_audit VALUES(TG_TABLE_NAME,txid_current()); RETURN NEW; END $$;
 CREATE TRIGGER audit AFTER INSERT OR UPDATE ON cmpri_resource_revisions FOR EACH ROW EXECUTE FUNCTION rehearsal_audit();
 CREATE TRIGGER audit AFTER INSERT OR UPDATE ON cmpri_event_signals FOR EACH ROW EXECUTE FUNCTION rehearsal_audit();`);
 await db.query('INSERT INTO hotel_members VALUES($1,$2)',[hotel,uid(99999)]);
 for(let i=0;i<66;i++) {
  const payload={notes:i<52?'PM Scan.pdf page 1; source period: Fictional period; revisit required':'Manual fictional note',answers:{check:i%3===0?'NO':i%3===1?'YES':''},links:i<9?[uid(80000+i)]:[],form_data:{}};
  if(i<52)payload.historical_source_import={source_id:source,pages:[1],confirmed:true};
  if(i<7)payload.form_data.logEntries=Array.from({length:i===6?25:26},(_,j)=>({item:`Fictional device ${j}`,notes:'PM Scan.pdf p1, pm-source-p1-r1. Repair pending; not satisfactory',result:'NO'}));
  await db.query('INSERT INTO cmpri_pm_proposals VALUES($1,$2,$3,$4,8,$5,$5)',[uid(i+1),hotel,payload,i%2?'draft':'complete','2026-01-01T00:00:00Z']);
 }
 for(let i=0;i<1197;i++) {
  const answers=i<245?Object.fromEntries(Array.from({length:i<120?65:64},(_,j)=>[`check${j}`,{answer:j%3?'YES':'NO',evidence:'PM Scan.pdf p1 Fictional maintenance observation; revisit unresolved',sourcePage:1}])):{};
  await db.query('INSERT INTO cmpri_room_pm_history VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[uid(1000+i),hotel,`Fictional-${i}`,'2026-01-01',i<245?'PM Scan.pdf':'Workbook',i<245?`retained; scan ${source}`:'workbook source',answers,i%2?'partial':'complete']);
 }
 await db.query('INSERT INTO cmpri_pm_source_evidence VALUES($1,$2,$3)',[hotel,source,Array.from({length:150},(_,i)=>({page:i+1,text:'Fictional scan'}))]);
 const baseline=fs.readFileSync('supabase/migrations/20260930180000_cmpri_prod_baseline.sql','utf8');
 const stamp=baseline.match(/CREATE OR REPLACE FUNCTION "public"\."cmpri_pm_proposal_stamp"\(\)[\s\S]*?\$\$;/)?.[0];
 assert.ok(stamp);await db.exec(stamp);
 const migration=fs.readFileSync('supabase/migrations/20261027190000_cmpri_committed_resource_events.sql','utf8');
 for(const name of ['cmpri_invalidate','cmpri_capture_resource_revision']) {
  const body=migration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?end \\$\\$;`,'i'))?.[0];
  assert.ok(body,name);await db.exec(body);
 }
 await db.exec('CREATE TRIGGER stamp BEFORE INSERT OR UPDATE ON cmpri_pm_proposals FOR EACH ROW EXECUTE FUNCTION cmpri_pm_proposal_stamp();');
 for(const t of tables)await db.exec(`CREATE TRIGGER invalidate AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION cmpri_capture_resource_revision('pm');`);
 const state=async()=>Object.fromEntries(await Promise.all([...tables,'cmpri_resource_revisions','cmpri_event_signals','rehearsal_signal_audit'].map(async t=>[t,(await db.query(`SELECT to_jsonb(t) AS r FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows.map(x=>x.r)])));
 const before=await state();
 const hash=async t=>(await db.query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text) AS h FROM ${t} t`)).rows[0].h;
 let sql=fs.readFileSync('../pm-corporate-review/pm-scan-cleanup-removal-DRAFT.sql','utf8');
 await assert.rejects(db.exec(sql),/DRAFT/);await db.exec('ROLLBACK');
 for(const [old,q] of [
  ['22e3235f6fe29ecd0719cf82e3043754','SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) h FROM cmpri_pm_proposals p'],
  ['2d8bfa755a2322bd440f60cea5835f2e','SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.room,r.period_start)::text) h FROM cmpri_room_pm_history r'],
  ['edb9d764fe784e1190f5229a3bd909c9','SELECT md5(pages::text) h FROM cmpri_pm_source_evidence']]) sql=sql.replace(old,(await db.query(q)).rows[0].h);
 sql=sql.replace(/ RAISE EXCEPTION 'DRAFT:[^\n]+\n/,'').replace(/ROLLBACK;\s*$/,'COMMIT;');
 await assert.rejects(db.exec(sql.replace('affected<>245','affected<>246')),/Expected 245/);await db.exec('ROLLBACK');assert.deepEqual(await state(),before);
 await db.exec(sql);const cleaned=await state();
 assert.equal(cleaned.cmpri_pm_source_evidence.length,0);
 let increments=0;
 for(const row of before.cmpri_pm_proposals){
  const next=cleaned.cmpri_pm_proposals.find(r=>r.id===row.id),i=Number(row.id.slice(-12))-1;
  assert.deepEqual(next.payload,cleanScanPayload(row.payload));assert.equal(next.status,row.status);assert.equal(next.created_at,row.created_at);
  assert.equal(next.revision,row.revision+(i<7?2:i<52?1:0));increments+=next.revision-row.revision;
  if(i<52)assert.notEqual(next.updated_at,row.updated_at);else assert.deepEqual(next,row);
 }
 assert.equal(increments,59);
 for(const row of before.cmpri_room_pm_history)assert.deepEqual(cleaned.cmpri_room_pm_history.find(r=>r.id===row.id),cleanScanHistory(row));
 assert.equal(cleaned.cmpri_room_pm_history.reduce((n,r)=>n+Object.keys(r.item_answers).length,0),15800);
 assert.equal(cleaned.cmpri_resource_revisions.length,1);assert.equal(cleaned.cmpri_event_signals.length,1);
 assert.equal(cleaned.rehearsal_signal_audit.length,2,'one resource invalidation and one recipient signal despite 305 row mutations');
 assert.equal(new Set(cleaned.cmpri_pm_proposals.filter(r=>r.payload.historical_source_import).map(r=>r.updated_at)).size,1,'one transaction timestamp');
 assert.equal(cleaned.cmpri_resource_revisions[0].transaction_id,cleaned.cmpri_event_signals[0].transaction_id);
 await assert.rejects(db.exec(sql),/PM records changed/);await db.exec('ROLLBACK');assert.deepEqual(await state(),cleaned);
 // Recovery uses exact post-cleanup row guards and a single transaction. Any later edit
 // causes an atomic refusal; no stale whole-row restore or revision reset is permitted.
 const guards=Object.fromEntries(await Promise.all(tables.map(async t=>[t,await hash(t)])));
 const restore=async()=>{
  await db.exec('BEGIN; LOCK TABLE cmpri_pm_proposals,cmpri_room_pm_history,cmpri_pm_source_evidence IN SHARE ROW EXCLUSIVE MODE;');
  try {
   for(const t of tables)if(await hash(t)!==guards[t])throw new Error('Restoration conflict: '+t);
   for(const r of before.cmpri_pm_proposals.filter(r=>r.payload.historical_source_import))await db.query('UPDATE cmpri_pm_proposals SET payload=$1 WHERE id=$2',[r.payload,r.id]);
   for(const r of before.cmpri_room_pm_history.filter(r=>r.source_reference.includes(source)))await db.query('UPDATE cmpri_room_pm_history SET source_name=$1,source_reference=$2,item_answers=$3 WHERE id=$4',[r.source_name,r.source_reference,r.item_answers,r.id]);
   await db.query('INSERT INTO cmpri_pm_source_evidence VALUES($1,$2,$3)',[hotel,source,before.cmpri_pm_source_evidence[0].pages]);
   await db.exec('COMMIT');
  }catch(e){await db.exec('ROLLBACK');throw e;}
 };
 const editedHistory=cleaned.cmpri_room_pm_history.find(r=>r.source_reference.includes('retained'));
 await db.query("UPDATE cmpri_room_pm_history SET item_answers=jsonb_set(item_answers,'{check0,evidence}',to_jsonb('Later fictional maintenance edit'::text)) WHERE id=$1",[editedHistory.id]);
 const liveEdit=await state();await assert.rejects(restore(),/Restoration conflict: cmpri_room_pm_history/);assert.deepEqual(await state(),liveEdit);
 // Reset only this fictional test fixture after proving refusal; this is not a recovery operation.
 await db.query('UPDATE cmpri_room_pm_history SET item_answers=$1 WHERE id=$2',[editedHistory.item_answers,editedHistory.id]);
 await restore();const restored=await state();
 for(const r of before.cmpri_pm_proposals){const n=restored.cmpri_pm_proposals.find(x=>x.id===r.id),c=cleaned.cmpri_pm_proposals.find(x=>x.id===r.id);assert.deepEqual(n.payload,r.payload);assert.equal(n.status,r.status);assert.equal(n.created_at,r.created_at);assert.equal(n.revision,c.revision+(r.payload.historical_source_import?1:0));if(r.payload.historical_source_import)assert.notEqual(n.updated_at,c.updated_at);}
 assert.deepEqual(restored.cmpri_room_pm_history,before.cmpri_room_pm_history);assert.deepEqual(restored.cmpri_pm_source_evidence,before.cmpri_pm_source_evidence);
 assert.notEqual(restored.cmpri_resource_revisions[0].revision,cleaned.cmpri_resource_revisions[0].revision);
 await assert.rejects(restore(),/Restoration conflict/);assert.deepEqual(await state(),restored);
 await db.query("UPDATE cmpri_pm_proposals SET payload=jsonb_set(payload,'{notes}',to_jsonb('Later fictional maintenance edit'::text)) WHERE id=$1",[uid(1)]);
 const later=await state();await assert.rejects(restore(),/Restoration conflict/);assert.deepEqual(await state(),later);
 console.log('PASS: 52 proposal metadata + 7 log updates, 245 histories/15800 answers, 952 untouched workbook histories, one 150-page evidence record; real stamp/invalidation functions; atomic rollback, replay refusal, restoration and later-edit protection.');
 } finally {await db.close();}
});
