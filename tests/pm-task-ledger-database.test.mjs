import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
test('existing production proposal schema serializes shared task ledger writes',async()=>{
 const db=new PGlite();
 try {
  const baseline=readFileSync(new URL('../supabase/migrations/20260930180000_cmpri_prod_baseline.sql',import.meta.url),'utf8');
  const table=baseline.match(/CREATE TABLE IF NOT EXISTS "public"\."cmpri_pm_proposals" \([\s\S]*?\n\);/)[0];
  const stamp=baseline.match(/CREATE OR REPLACE FUNCTION "public"\."cmpri_pm_proposal_stamp"\(\)[\s\S]*?\n\$\$;/)[0];
  const index=baseline.match(/CREATE UNIQUE INDEX "cmpri_pm_one_pending_proposal_per_scope"[^;]+;/)[0];
  const trigger=baseline.match(/CREATE OR REPLACE TRIGGER "cmpri_pm_proposal_stamp"[^;]+;/)[0];
  await db.exec(table+stamp+index+trigger);
  const insert=`INSERT INTO cmpri_pm_proposals(hotel_id,template_id,period_start,scope_key,payload,submitted_by) VALUES ('00000000-0000-4000-8000-000000000001','workbook:daily','2026-11-03','property','{}',$1) RETURNING id,revision`;
  const initial=(await db.query(insert,['00000000-0000-4000-8000-000000000002'])).rows[0];
  assert.equal(initial.revision,1);
  await assert.rejects(db.query(insert,['00000000-0000-4000-8000-000000000003']),/duplicate key/);
  const changed=await db.query(`UPDATE cmpri_pm_proposals SET payload='{"task_states":{"fire":{"status":"approved","workerName":"Alex"}}}' WHERE id=$1 AND revision=1 RETURNING revision,payload`,[initial.id]);
  assert.equal(changed.rows[0].revision,2);assert.equal(changed.rows[0].payload.task_states.fire.workerName,'Alex');
  const stale=await db.query(`UPDATE cmpri_pm_proposals SET payload='{}' WHERE id=$1 AND revision=1 RETURNING id`,[initial.id]);
  assert.equal(stale.rows.length,0);
 } finally {await db.close();}
});
