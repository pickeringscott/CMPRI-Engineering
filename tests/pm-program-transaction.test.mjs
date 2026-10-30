import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'pm-transaction-test-'));
const hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6', actor='00000000-0000-0000-0000-000000000002';
const plan={hotel_id:hotel,source_sha256:'a'.repeat(64),canRelease:true,conflicts:[],room_conflicts:[],unresolved_source:[],
 completion_reconciliation:{verified:true},outcome_verification:{complete:true},expected_snapshot:{proposals:[]},
 routine_records:[{template_id:'workbook:daily',period_start:'2026-01-01',scope_key:'property',payload:{responses:{'daily-7':true},source_cells:[{sheet:'JAN',cell:'M7'}],is_complete:false}}],
 room_import:{sourceId:'local-test',sourceName:'Local test',rows:[{room:'101',periodStart:'2026-01-01',completedOn:'2026-01-02',sourceReference:'Test cell'}]}};
const input=join(dir,'plan.json'),output=join(dir,'apply.sql');
writeFileSync(input,JSON.stringify({...plan,canRelease:false}));
let compiled=spawnSync(process.execPath,['scripts/compile-pm-program-transaction.mjs',input,output,actor,'Local fixture'],{encoding:'utf8'});
assert.notEqual(compiled.status,0);assert.equal(JSON.parse(readFileSync(output+'.blocked.json')).status,'NOT COMPILED');
const issue={source:{sheet:'JULY',cell:'K7'},reason:'No date'};
const retainedPlan={...plan,unresolved_source:[issue],retained_evidence:[{field:'unresolved_source',sha256:createHash('sha256').update(JSON.stringify(issue)).digest('hex'),action:'preserve_without_import'}]};
writeFileSync(input,JSON.stringify(retainedPlan));
compiled=spawnSync(process.execPath,['scripts/compile-pm-program-transaction.mjs',input,output,actor,'Local fixture'],{encoding:'utf8'});assert.equal(compiled.status,0,compiled.stderr);
writeFileSync(input,JSON.stringify({...retainedPlan,unresolved_source:[{...issue,reason:'different fact'}]}));
compiled=spawnSync(process.execPath,['scripts/compile-pm-program-transaction.mjs',input,output,actor,'Local fixture'],{encoding:'utf8'});assert.notEqual(compiled.status,0);
writeFileSync(input,JSON.stringify(plan));
compiled=spawnSync(process.execPath,['scripts/compile-pm-program-transaction.mjs',input,output,actor,'Local fixture'],{encoding:'utf8'});
assert.equal(compiled.status,0,compiled.stderr);
const sql=readFileSync(output,'utf8');
async function database(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table cmpri_pm_proposals(id uuid primary key,hotel_id uuid,template_id text,period_start date,scope_key text,payload jsonb,proposed_cells jsonb,status text,submitted_by uuid,submitted_by_name text,reviewed_by uuid,reviewed_at timestamptz,review_note text,revision int default 1);`);
 await db.exec(readFileSync('supabase/migrations/20261027235814_cmpri_room_pm_history.sql','utf8'));return db;}
const db=await database();await db.exec(sql);await db.exec(sql);
assert.equal((await db.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,1);
assert.equal((await db.query('select count(*)::int n from cmpri_room_pm_history')).rows[0].n,1);
await db.exec(`update cmpri_pm_proposals set payload='{"responses":{"daily-7":false}}'`);
await assert.rejects(()=>db.exec(sql),/Retry differs/);await db.exec('rollback');
assert.equal((await db.query('select payload from cmpri_pm_proposals')).rows[0].payload.responses['daily-7'],false);
await db.close();
const conflict=await database();
await conflict.exec(`insert into cmpri_room_pm_history(hotel_id,room,period_start,completed_on,source_id,source_name,source_reference,import_digest,confirmed_by,confirmed_by_name) values('${hotel}','101','2026-01-01','2026-01-03','manual','Manual','Original','${'b'.repeat(64)}','${actor}','Local fixture');`);
await assert.rejects(()=>conflict.exec(sql),/Room history changed/);await conflict.exec('rollback');
assert.equal((await conflict.query('select count(*)::int n from cmpri_pm_proposals')).rows[0].n,0);
assert.equal((await conflict.query('select completed_on::text d from cmpri_room_pm_history')).rows[0].d,'2026-01-03');
await conflict.close();
console.log('Local transaction verified: unresolved refusal, atomic routine+room apply, identical replay, manual-edit protection, rollback on room conflict. No production access.');
