import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {cleanScanPayload,cleanScanHistory} from '../src/lib/pm/scan-cleanup.ts';
const read=p=>JSON.parse(fs.readFileSync(p));
test('guarded cleanup executes atomically in isolated PostgreSQL with operational parity',async()=>{
 const db=new PGlite();
 try {
 const snap=read('../pm-corporate-review/scoped-snapshot-20261030.json');
 const rooms=read('../pm-modal-preview/pm-preview-values.json').room_history.map(r=>({...snap.room_history.find(x=>x.room===r.room&&x.period_start===r.period_start),...r,hotel_id:snap.hotel_id}));
 const sources=read('../release-inputs/pm-stored-nonroom-source.json').map(r=>({...r,hotel_id:snap.hotel_id}));
 const fixtures={cmpri_pm_proposals:snap.proposals,cmpri_room_pm_history:rooms,cmpri_pm_source_evidence:sources};
 for(const [table,rows] of Object.entries(fixtures)){
  const keys=[...new Set(rows.flatMap(Object.keys))];
  const type=k=>['id','hotel_id'].includes(k)?'uuid':['payload','item_answers','pages','proposed_cells'].includes(k)?'jsonb':'text';
  await db.exec(`CREATE TABLE ${table} (${keys.map(k=>`"${k}" ${type(k)}`).join(',')});`);
  await db.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(rows)]);
 }
 const state=async()=>Object.fromEntries(await Promise.all(Object.keys(fixtures).map(async t=>[t,(await db.query(`SELECT to_jsonb(t) AS row FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.row)])));
 const before=await state();
 let sql=fs.readFileSync('../pm-corporate-review/pm-scan-cleanup-removal-DRAFT.sql','utf8');
 await assert.rejects(db.exec(sql),/DRAFT: execution blocked/);await db.exec('ROLLBACK');assert.deepEqual(await state(),before);
 const guards=[['22e3235f6fe29ecd0719cf82e3043754','SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) AS hash FROM cmpri_pm_proposals p'],['2d8bfa755a2322bd440f60cea5835f2e','SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.room,r.period_start)::text) AS hash FROM cmpri_room_pm_history r'],['edb9d764fe784e1190f5229a3bd909c9','SELECT md5(pages::text) AS hash FROM cmpri_pm_source_evidence']];
 for(const [old,q] of guards)sql=sql.replace(old,(await db.query(q)).rows[0].hash);
 sql=sql.replace(/ RAISE EXCEPTION 'DRAFT:[^\n]+\n/,'').replace(/ROLLBACK;\s*$/,'COMMIT;');
 await assert.rejects(db.exec(sql.replace('affected<>245','affected<>246')),/Expected 245/);await db.exec('ROLLBACK');assert.deepEqual(await state(),before);
 await db.exec(sql);
 const after=await state();
 assert.equal(after.cmpri_pm_source_evidence.length,0);
 for(const row of before.cmpri_pm_proposals){const next=after.cmpri_pm_proposals.find(r=>r.id===row.id);assert.deepEqual(next,{...row,payload:cleanScanPayload(row.payload)});}
 for(const row of before.cmpri_room_pm_history){const next=after.cmpri_room_pm_history.find(r=>r.room===row.room&&r.period_start===row.period_start);assert.deepEqual(next,cleanScanHistory(row));}
 assert.equal(rooms.length,1197);
 assert.equal(rooms.reduce((n,r)=>n+Object.keys(r.item_answers||{}).length,0),15800);
 await assert.rejects(db.exec(sql),/PM records changed/);await db.exec('ROLLBACK');assert.deepEqual(await state(),after);
 console.log('Isolated fixture: 66 proposals, 1197 histories, 15800 answers, 42 retained source pages; all parity checks held.');
 } finally {await db.close();}
});
