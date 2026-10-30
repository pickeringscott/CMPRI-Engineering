import fs from 'node:fs';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const root='../pm-corporate-review/full-program-plan/';
const plan=JSON.parse(fs.readFileSync(root+'local-candidate.json','utf8'));
const sql=fs.readFileSync(root+'proposed-apply.sql','utf8');
const db=new PGlite();
try {
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create table cmpri_pm_proposals(id uuid primary key,hotel_id uuid,template_id text,period_start date,scope_key text,payload jsonb,proposed_cells jsonb,status text,submitted_by uuid,submitted_by_name text,reviewed_by uuid,reviewed_at timestamptz,review_note text,revision int default 1);`);
await db.exec(fs.readFileSync('supabase/migrations/20261027235814_cmpri_room_pm_history.sql','utf8'));
for(const p of plan.expected_snapshot.proposals)await db.query('insert into cmpri_pm_proposals(id,hotel_id,template_id,period_start,scope_key,payload,status,revision) values($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,plan.hotel_id,p.template_id,p.period_start,p.scope_key,JSON.stringify(p.payload),p.status,p.revision]);
for(const r of plan.expected_snapshot.room_history)await db.query('insert into cmpri_room_pm_history(hotel_id,room,period_start,completed_on,source_id,source_name,source_reference,import_digest,confirmed_by,confirmed_by_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[plan.hotel_id,r.room,r.period_start,r.completed_on,'snapshot','Existing snapshot','Preserved local test fixture','a'.repeat(64),'750f77bf-7d5d-4ca6-8421-e025edea87ba','Local validation fixture']);
const before=await db.query('select id,payload,revision,status from cmpri_pm_proposals order by id');
await db.exec(sql);await db.exec(sql);
const records=(await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n;
const rooms=(await db.query('select count(*)::int n from cmpri_room_pm_history')).rows[0].n;
assert.equal(records,plan.expected_snapshot.proposals.length+95);
assert.equal(rooms,plan.expected_snapshot.room_history.length+952);
for(const p of before.rows){const now=(await db.query('select id,payload,revision,status from cmpri_pm_proposals where id=$1',[p.id])).rows[0];assert.deepEqual(now,p);}
const report={stage:'Local PGlite only',routineAdded:95,roomsAdded:952,recordsAfter:records,roomsAfter:rooms,identicalReplay:'no duplicates',existingProposals:'unchanged',productionWrites:0};
fs.writeFileSync(root+'exact-transaction-validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await db.close();}
